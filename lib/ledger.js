/**
 * dsh-usage-stats 账本:存储与统计聚合。
 *
 * 数据模型($DSH_HOME/storages/usage-stats/ledger.json):
 *   days[localDayKey] = { requests, tokens:{input,output,cacheRead,cacheWrite,reasoning},
 *                         models[model] = { requests, tokens:{...} } }
 *   sessions[sessionId] = { firstAt, lastAt }   // 活动首/末时刻(ms),用于聊天时长
 *
 * token 总量口径:五桶之和(input + output + cacheRead + cacheWrite + reasoning),
 * 与 dsh-cost-meter 的记账桶一致。
 */

import fs from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DAY_MS = 24 * 60 * 60 * 1000

/** token 五桶的零值。 */
export function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** token 五桶求和。 */
export function sumTokens(tokens) {
  return (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.cacheRead ?? 0)
    + (tokens?.cacheWrite ?? 0) + (tokens?.reasoning ?? 0)
}

/**
 * 本地时区日期键(YYYY-MM-DD)。与 cost-meter 同口径:按本地日切分,不用 UTC。
 * @param {number} ms - 时刻。
 * @returns {string}
 */
export function localDayKey(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 解析 DSH home(与 @deepseek-ai/dsh-home-paths 同规则,内联以零依赖):
 * $DSH_HOME(空串视为未设)→ ~/.dsh。
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return join(selected)
}

/**
 * 从 usage 块提取五桶(缺失桶按 0)。
 * @param {object} usage - llm/stream usage 块。
 */
export function tokensOf(usage) {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens ?? 0,
    cacheWrite: usage?.cacheWriteTokens ?? 0,
    reasoning: usage?.reasoningTokens ?? 0
  }
}

/**
 * 打开(或创建)账本。写入为防抖落盘:account 只标脏,1s 后异步写;
 * close()/进程退出前同步落盘。
 */
export class Ledger {
  /**
   * @param {string} [home] - DSH home 覆盖(测试注入)。
   * @param {object} [deps] - now/写延迟注入。
   */
  constructor(home = resolveDshHome(), { now = Date.now, writeDelayMs = 1000 } = {}) {
    this.dir = join(home, 'storages', 'usage-stats')
    this.path = join(this.dir, 'ledger.json')
    this.now = now
    this.writeDelayMs = writeDelayMs
    this.data = this.#load()
    this.dirty = false
    this.writeTimer = null
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.version === 1) {
        parsed.days ??= {}
        parsed.sessions ??= {}
        return parsed
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 损坏账本不静默覆盖:留档后从零开始,便于用户抢救。
        try { fs.copyFileSync(this.path, `${this.path}.corrupt-${Date.now()}`) } catch {}
        console.warn(`[dsh-usage-stats] 账本读取失败,已留档并重建: ${String(error)}`)
      }
    }
    return { version: 1, days: {}, sessions: {} }
  }

  /** 防抖落盘。 */
  scheduleWrite() {
    this.dirty = true
    if (this.writeTimer !== null) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.flush()
    }, this.writeDelayMs)
    this.writeTimer.unref?.()
  }

  /** 同步落盘(仅在脏时)。 */
  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.path}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data))
      fs.renameSync(tmp, this.path)
    } catch (error) {
      console.warn(`[dsh-usage-stats] 账本写入失败: ${String(error)}`)
    }
  }

  /** 关闭:清掉防抖定时器并立即落盘。 */
  close() {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.flush()
  }

  /**
   * 记一次模型调用。
   * @param {object} usage - usage 五桶(input/output/cacheRead/cacheWrite/reasoning)。
   * @param {string} model - 模型名。
   * @param {string} sessionId - 会话 id(可为空)。
   * @param {number} atMs - 请求发起时刻。
   */
  account(usage, model, sessionId, atMs) {
    const tokens = tokensOf(usage)
    if (sumTokens(tokens) <= 0) return
    const day = this.data.days[localDayKey(atMs)] ?? { requests: 0, tokens: zeroTokens(), models: {} }
    this.data.days[localDayKey(atMs)] = day
    day.requests += 1
    for (const key of Object.keys(tokens)) day.tokens[key] += tokens[key]
    const entry = day.models[model] ?? { requests: 0, tokens: zeroTokens() }
    day.models[model] = entry
    entry.requests += 1
    for (const key of Object.keys(tokens)) entry.tokens[key] += tokens[key]
    if (sessionId) {
      // 会话级记录:活动跨度 + token 五桶 + 按模型拆分 + 标题(回填时补全)。
      const session = this.data.sessions[sessionId] ?? {
        firstAt: atMs, lastAt: atMs, requests: 0, tokens: zeroTokens(), models: {}, title: null,
      }
      this.data.sessions[sessionId] = session
      if (atMs < session.firstAt) session.firstAt = atMs
      if (atMs > session.lastAt) session.lastAt = atMs
      session.requests += 1
      for (const key of Object.keys(tokens)) session.tokens[key] += tokens[key]
      const sessionModel = session.models[model] ?? 0
      session.models[model] = sessionModel + sumTokens(tokens)
    }
    this.prune()
    this.scheduleWrite()
  }

  /** 超期天数/废弃会话清理(保留窗口由 summary 读取端决定,这里按硬上限裁)。 */
  prune(keepDays = 400) {
    const cutoff = localDayKey(this.now() - keepDays * DAY_MS)
    for (const key of Object.keys(this.data.days)) {
      if (key < cutoff) delete this.data.days[key]
    }
    const cutoffMs = this.now() - keepDays * DAY_MS
    for (const [id, session] of Object.entries(this.data.sessions)) {
      if ((session.lastAt ?? 0) < cutoffMs) delete this.data.sessions[id]
    }
  }

  /**
   * 全量重建(历史回填用):整体替换 days/sessions 后立即落盘。
   * 会话日志是用量的事实来源,重放结果幂等;运行期实时记账的调用同样
   * 存在于会话日志中,因此重建不会丢失已记账数据。
   * @param {{ days: object, sessions: object }} data
   */
  rebuildFrom(data) {
    this.data = { version: 1, days: data.days ?? {}, sessions: data.sessions ?? {} }
    this.prune()
    this.dirty = true
    this.flush()
  }

  /**
   * 汇总统计(仪表盘唯一数据端点)。
   * @param {object} [options]
   * @param {number} [options.trendDays] - 趋势窗口长度(服务端固定给 30 天,客户端自行截 7)。
   * @param {number} [options.heatmapDays] - 热力图回溯天数(对齐到整周由客户端处理)。
   * @param {number} [options.topSessions] - 会话榜单返回条数上限(默认 100;客户端默认只展示前 5,其余在滚动区展开)。
   */
  summary({ trendDays = 30, heatmapDays = 371, topSessions = 100 } = {}) {
    const nowMs = this.now()
    const days = this.data.days

    // ── 累计/峰值 ────────────────────────────────────────────────
    let totalTokens = 0
    let totalRequests = 0
    let peakDay = null
    let peakTokens = 0
    for (const [key, day] of Object.entries(days)) {
      const total = sumTokens(day.tokens)
      totalTokens += total
      totalRequests += day.requests
      if (total > peakTokens) {
        peakTokens = total
        peakDay = key
      }
    }

    // ── 聊天时长:会话活动跨度 ────────────────────────────────────
    let longestChatMs = 0
    for (const session of Object.values(this.data.sessions)) {
      const span = (session.lastAt ?? 0) - (session.firstAt ?? 0)
      if (span > longestChatMs) longestChatMs = span
    }

    // ── 连续天数 ─────────────────────────────────────────────────
    const activeDays = Object.keys(days)
      .filter((key) => sumTokens(days[key].tokens) > 0)
      .sort()
    const { current, longest } = streaksOf(activeDays, localDayKey(nowMs))

    // ── 趋势:近 trendDays 天 × 模型 ─────────────────────────────
    const trendKeys = []
    for (let i = trendDays - 1; i >= 0; i--) trendKeys.push(localDayKey(nowMs - i * DAY_MS))
    const modelTotals = new Map()
    const trend = {}
    for (const key of trendKeys) {
      const day = days[key]
      if (!day) continue
      for (const [model, entry] of Object.entries(day.models)) {
        modelTotals.set(model, (modelTotals.get(model) ?? 0) + sumTokens(entry.tokens))
        const series = trend[model] ?? (trend[model] = new Array(trendDays).fill(0))
        series[trendKeys.indexOf(key)] += sumTokens(entry.tokens)
      }
    }
    // 模型按总量降序,取前 7,其余并入「其他」。
    const ranked = [...modelTotals.entries()].sort((a, b) => b[1] - a[1])
    const topModels = ranked.slice(0, 7).map(([model]) => model)
    const restModels = ranked.slice(7).map(([model]) => model)
    const trendSeries = {}
    for (const model of topModels) trendSeries[model] = trend[model]
    if (restModels.length > 0) {
      const rest = new Array(trendDays).fill(0)
      for (const model of restModels) {
        trend[model].forEach((value, index) => { rest[index] += value })
      }
      trendSeries['其他'] = rest
    }

    // ── 热力图:近 heatmapDays 天日总量 ──────────────────────────
    const heatmap = {}
    const firstKey = localDayKey(nowMs - heatmapDays * DAY_MS)
    for (const [key, day] of Object.entries(days)) {
      if (key >= firstKey) heatmap[key] = sumTokens(day.tokens)
    }

    // ── 模型用量占比(全期) ─────────────────────────────────────
    const models = ranked.map(([model, tokens]) => ({ name: model, tokens }))

    // ── 会话榜:用量 Top N 与最近 N 个 ──────────────────────────
    const sessionRows = Object.entries(this.data.sessions).map(([id, s]) => {
      let topModel = null
      let topModelTokens = 0
      for (const [name, tokens] of Object.entries(s.models ?? {})) {
        if (tokens > topModelTokens) {
          topModelTokens = tokens
          topModel = name
        }
      }
      return {
        id,
        title: s.title ?? null,
        tokens: sumTokens(s.tokens),
        requests: s.requests ?? 0,
        firstAt: s.firstAt ?? 0,
        lastAt: s.lastAt ?? 0,
        topModel,
      }
    })
    const byTokens = [...sessionRows].sort((a, b) => b.tokens - a.tokens).slice(0, topSessions)
    const byRecent = [...sessionRows].sort((a, b) => b.lastAt - a.lastAt).slice(0, topSessions)

    return {
      totals: { tokens: totalTokens, requests: totalRequests },
      peak: { day: peakDay, tokens: peakTokens },
      longestChatMs,
      streaks: { current: current, longest },
      trend: { days: trendKeys, series: trendSeries },
      heatmap,
      models,
      sessions: { total: sessionRows.length, byTokens, byRecent },
      generatedAt: nowMs
    }
  }
}

/**
 * 由活跃日序列计算当前/最长连续天数。
 * 当前连续天数:若今天活跃从今天往回数,否则从昨天往回数(今天还没用不算断)。
 * @param {string[]} activeDays - 升序 YYYY-MM-DD。
 * @param {string} todayKey - 本地今天。
 */
export function streaksOf(activeDays, todayKey) {
  const present = new Set(activeDays)
  const shiftDay = (key, delta) => localDayKey(Date.parse(`${key}T00:00:00`) + delta * DAY_MS)
  let current = 0
  let cursor = present.has(todayKey) ? todayKey : shiftDay(todayKey, -1)
  while (present.has(cursor)) {
    current += 1
    cursor = shiftDay(cursor, -1)
  }
  let longest = 0
  let run = 0
  let prev = null
  for (const key of activeDays) {
    run = prev !== null && shiftDay(prev, 1) === key ? run + 1 : 1
    if (run > longest) longest = run
    prev = key
  }
  return { current, longest }
}
