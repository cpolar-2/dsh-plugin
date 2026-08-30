/** dsh-usage-stats 单元测试:账本记账/汇总 与 llm/stream 采集器。运行:node --test test/ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger, localDayKey, streaksOf, sumTokens, zeroTokens } from '../lib/ledger.js'
import { createUsageCollector } from '../lib/collector.js'

const DAY_MS = 24 * 60 * 60 * 1000

function tempLedger(now = Date.now()) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-usage-stats-test-'))
  const ledger = new Ledger(home, { now: () => now, writeDelayMs: 5 })
  return { home, ledger }
}

test('localDayKey 按本地时区切日', () => {
  // 2026-08-29 23:59:59.999 与次日 00:00:00 分属两天(以本地时区为准)。
  const a = new Date(2026, 7, 29, 23, 59, 59, 999).getTime()
  const b = new Date(2026, 7, 30, 0, 0, 0, 0).getTime()
  assert.equal(localDayKey(a), '2026-08-29')
  assert.equal(localDayKey(b), '2026-08-30')
})

test('account 累计五桶、按模型拆分并落盘', async () => {
  const { home, ledger } = tempLedger()
  const at = new Date(2026, 7, 29, 10, 0, 0).getTime()
  ledger.account({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 }, 'glm-5.3', 's1', at)
  ledger.account({ inputTokens: 10, outputTokens: 5 }, 'glm-5.3-flash', 's1', at + 1000)
  ledger.account({ inputTokens: 1, outputTokens: 2 }, 'glm-5.3', 's2', at + 2000)
  ledger.close()

  const raw = JSON.parse(readFileSync(join(home, 'storages', 'usage-stats', 'ledger.json'), 'utf8'))
  const day = raw.days['2026-08-29']
  assert.equal(day.requests, 3)
  assert.equal(sumTokens(day.tokens), 100 + 50 + 20 + 10 + 5 + 1 + 2)
  assert.equal(raw.sessions.s1.firstAt, at)
  assert.equal(raw.sessions.s1.lastAt, at + 1000)
  assert.equal(sumTokens(raw.sessions.s1.tokens), 100 + 50 + 20 + 10 + 5)
  assert.equal(raw.sessions.s1.title, null)
  assert.equal(day.models['glm-5.3'].requests, 2)
  rmSync(home, { recursive: true, force: true })
})

test('summary 输出累计/峰值/时长/连续天数/趋势/热力图/模型占比', () => {
  const now = new Date(2026, 7, 29, 12, 0, 0).getTime()
  const { ledger } = tempLedger(now)
  // 今天:s1 一笔 1500;s3 跨 90 分钟两笔 150+15。
  ledger.account({ inputTokens: 1000, outputTokens: 500 }, 'glm-5.3', 's1', now)
  ledger.account({ inputTokens: 100, outputTokens: 50 }, 'glm-5.3-flash', 's3', now - 90 * 60000)
  ledger.account({ inputTokens: 10, outputTokens: 5 }, 'glm-5.3-flash', 's3', now)
  // 三天前:一笔 5000(峰值日)。
  ledger.account({ inputTokens: 4000, outputTokens: 1000 }, 'glm-5.3', 's2', now - 3 * DAY_MS)

  const summary = ledger.summary({ trendDays: 30, heatmapDays: 371 })
  assert.equal(summary.totals.tokens, 1500 + 150 + 15 + 5000)
  assert.equal(summary.peak.tokens, 5000)
  assert.equal(summary.peak.day, localDayKey(now - 3 * DAY_MS))
  assert.equal(summary.longestChatMs, 90 * 60000)
  assert.equal(summary.streaks.current, 1)
  assert.equal(summary.streaks.longest, 1)
  assert.equal(summary.trend.days.length, 30)
  assert.equal(summary.trend.series['glm-5.3'].length, 30)
  assert.equal(summary.heatmap[localDayKey(now)], 1500 + 150 + 15)
  assert.equal(summary.models[0].name, 'glm-5.3')
  ledger.close()
})

test('summary 会话榜:按用量 Top 5 与最近 5 个两种排序', () => {
  const now = new Date(2026, 7, 29, 12, 0, 0).getTime()
  const { ledger } = tempLedger(now)
  // 三个会话:用量 300 > 200 > 100;最近活动顺序与用量顺序相反。
  ledger.account({ inputTokens: 100, outputTokens: 200 }, 'm', 's-big', now - 3 * DAY_MS)
  ledger.account({ inputTokens: 80, outputTokens: 120 }, 'm', 's-mid', now - 2 * DAY_MS)
  ledger.account({ inputTokens: 40, outputTokens: 60 }, 'm', 's-new', now)
  const summary = ledger.summary()
  assert.equal(summary.sessions.total, 3)
  assert.deepEqual(summary.sessions.byTokens.map((s) => s.id), ['s-big', 's-mid', 's-new'])
  assert.deepEqual(summary.sessions.byTokens.map((s) => s.tokens), [300, 200, 100])
  assert.deepEqual(summary.sessions.byRecent.map((s) => s.id), ['s-new', 's-mid', 's-big'])
  assert.equal(summary.sessions.byRecent[0].topModel, 'm')
  ledger.close()
})

test('streaksOf:今天未活跃时从昨天回数;跨断档取最长', () => {
  const active = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-20', '2026-08-21']
  assert.deepEqual(streaksOf(active, '2026-08-21'), { current: 2, longest: 3 })
  // 今天(08-22)还没用不算断,从昨天回数;明天(08-23)仍未用即断。
  assert.deepEqual(streaksOf(active, '2026-08-22'), { current: 2, longest: 3 })
  assert.deepEqual(streaksOf(active, '2026-08-23'), { current: 0, longest: 3 })
})

test('采集器:捕获 usage 块并在流结束时记账一次', async () => {
  const calls = []
  const collect = createUsageCollector({ account: (...args) => calls.push(args), now: () => 1234 })
  async function* downstream() {
    yield { type: 'text', text: 'hi' }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }
    yield { type: 'finish' }
  }
  const options = { model: 'glm-5.3', sessionId: 's9', provider: 'p' }
  const stream = collect(options, downstream)
  for await (const chunk of stream) { /* 消费全部 */ }
  assert.deepEqual(calls, [[{ inputTokens: 7, outputTokens: 3 }, 'glm-5.3', 's9', 1234, 'p']])
})

test('采集器:嵌套 llm/stream 只由最外层记一次账', async () => {
  const calls = []
  const collect = createUsageCollector({ account: (...args) => calls.push(args) })
  async function* upstream() {
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  }
  // 包装路由(如 modlens):在自身 stream() 体内(外层流的消费上下文中)
  // 再发起一次 ctx.llm.stream(),内层 collect 透传不包裹。
  async function* wrapperStream() {
    const inner = collect({ model: 'upstream-m', sessionId: 's' }, upstream)
    for await (const chunk of inner) yield chunk
  }
  const stream = collect({ model: 'm', sessionId: 's' }, wrapperStream)
  for await (const chunk of stream) { /* 消费全部 */ }
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][0], { inputTokens: 1, outputTokens: 1 })
})

test('采集器:消费方提前中断时向下游传播 return', async () => {
  let closed = false
  const calls = []
  const collect = createUsageCollector({ account: (u) => calls.push(u) })
  async function* downstream() {
    try {
      yield { type: 'text', text: 'a' }
      yield { type: 'usage', usage: { inputTokens: 9 } }
    } finally {
      closed = true
    }
  }
  const stream = collect({ model: 'm' }, downstream)
  let seen = 0
  for await (const chunk of stream) {
    seen += 1
    if (seen === 2) break // 消费完 text + usage 后中断(finish 之前)
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(closed, true)
  // usage 块已到达:照常记账(与 cost-meter 语义一致)。
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { inputTokens: 9 })
})

test('零 token 的 usage 不产生天数记录', () => {
  const { ledger } = tempLedger()
  ledger.account({ inputTokens: 0, outputTokens: 0 }, 'm', 's', Date.now())
  assert.deepEqual(Object.keys(ledger.data.days), [])
  assert.deepEqual(ledger.data.sessions, {})
  ledger.close()
})
