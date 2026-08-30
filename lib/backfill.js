/**
 * 历史回填:从 $DSH_HOME/sessions 的会话日志重建用量账本。
 *
 * 会话日志(<项目>/<会话>/session.jsonl[.zstd])记录了每次模型调用的完整
 * 事件流(与 dsh-cost-meter 的 costUsage 投影同源),因此它是用量的事实来源:
 * 启动时全量回放重建 days/sessions,幂等且能自愈——运行期 llm/stream 实时
 * 记的账在下次重启时会被重放结果整体替换,不会重复计数。
 *
 * 回放规则(与 dsh-cost-meter 的 replaySessionRecords 对齐,token 口径):
 *  - `request/header` 切换当前 provider/model;
 *  - usage 取自 `assistant/chunk`(chunk.type==='usage')与 `assistant/message`
 *    (data.usage),按 (turn, step) + provider:model + 五桶逐位相同去重
 *    (流式样本与最终消息同键同值时只记一次);
 *  - fork 种子事件(time < 会话 createdAt)跳过:父会话日志已计过;
 *  - modlens 等包装层 provider(modlens-* / deepseek-modlens)的 usage 跳过,
 *    只记上游真实流;
 *  - 打包行(text/reasoning/tool-call-chunks)在解析入口丢弃。
 *
 * zstd 逐帧解压:每个追加批次一个独立 frame,长会话可达数万帧,逐帧解压
 * 控制峰值内存(与 cost-meter 同款扫描器)。
 */

import zlib from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { localDayKey, sumTokens } from './ledger.js'

const ZSTD_MAGIC = 0xfd2fb528
const PACKED_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** modlens 等包装路由的 provider id:其 usage 与上游流重复,跳过。 */
export function isWrapperProviderId(provider) {
  return typeof provider === 'string' && (provider.startsWith('modlens-') || provider === 'deepseek-modlens')
}

/**
 * 结构化扫描拼接的 Zstandard frame 边界(不解压块内容),与宿主
 * dsh-session-persistence-jsonl 的容器格式一致。残缺尾帧直接忽略。
 * @param {Buffer} buffer - 会话日志原始字节。
 * @returns {Array<{start: number, end: number}>} 完整 frame 字节区间。
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return frames // 保留位:结构非法,停止扫描
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * 读取一份会话日志的全部事件行(zstd 逐帧解压;明文直接按行)。
 * 逐帧解压、逐帧按行切片:任一时刻只保留单帧解压结果,行缓冲跨帧拼接兜底半行。
 * @param {string} path - session.jsonl.zstd 或 session.jsonl 路径。
 * @returns {object[]} 逐行 JSON.parse 后的记录(坏行跳过)。
 */
export function readSessionRecords(path) {
  const buffer = readFileSync(path)
  const records = []
  let pending = ''
  const consumeText = (text) => {
    if (text.length === 0) return
    const lines = text.split('\n')
    lines[0] = pending + lines[0]
    pending = lines[lines.length - 1]
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]
      if (line.length === 0) continue
      try {
        const rec = JSON.parse(line)
        if (rec !== null && typeof rec === 'object' && !PACKED_ROW_TYPES.has(rec.type)) records.push(rec)
      } catch { /* 坏行跳过:回放是尽力而为 */ }
    }
  }
  if (path.endsWith('.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') return []
    for (const f of scanZstdFrames(buffer)) {
      consumeText(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8'))
    }
  } else {
    consumeText(buffer.toString('utf8'))
  }
  if (pending.length > 0) {
    try {
      const rec = JSON.parse(pending)
      if (rec !== null && typeof rec === 'object' && !PACKED_ROW_TYPES.has(rec.type)) records.push(rec)
    } catch { /* 末尾残行兜底 */ }
  }
  return records
}

/**
 * 枚举会话根目录下全部会话日志路径(<root>/<项目>/<会话>/session.jsonl[.zstd])。
 * @param {string} root - 会话根目录。
 * @returns {string[]}
 */
export function listSessionLogs(root) {
  const paths = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return paths
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = readdirSync(join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const path = join(root, project.name, session.name, name)
        try {
          if (statSync(path).isFile()) {
            paths.push(path)
            break // 同一会话两种编码互斥,取先命中者
          }
        } catch { /* 尝试另一后缀 */ }
      }
    }
  }
  return paths
}

/**
 * 回放单个会话的事件流,产出逐次用量样本与会话标题。
 * @param {object[]} records - readSessionRecords 的输出。
 * @returns {{ samples: Array<{atMs: number, model: string, sessionId: string, usage: object}>, titles: Map<string, string> }}
 */
export function replaySessionUsage(records) {
  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  let sessionId = ''
  let createdAt = 0
  let provider = 'deepseek'
  let model = 'default'
  let last = null // { key, providerKey, buckets }
  let title = null
  const titles = new Map()
  const samples = []
  for (const event of records) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'session' && typeof event.id === 'string') {
      sessionId = event.id
      const created = Number(event.createdAt)
      if (Number.isFinite(created) && created > 0) createdAt = created
      continue
    }
    // 会话标题(宿主生成的 session/title 事件;同名多次取最后一次)。
    if (event.type === 'session/title') {
      const nextTitle = event.data?.title
      if (typeof nextTitle === 'string' && nextTitle.trim().length > 0 && sessionId) {
        title = nextTitle.trim()
        titles.set(sessionId, title)
      }
      continue
    }
    if (PACKED_ROW_TYPES.has(event.type)) continue
    const eventMs = Number(event.time)
    // fork 种子事件:时间戳早于会话创建时刻 = 从父会话拷来的历史,父会话已计过。
    const isSeed = createdAt > 0 && Number.isFinite(eventMs) && eventMs > 0 && eventMs < createdAt
    if (event.type === 'request/header') {
      const nextModel = event.data?.header?.config?.model
      const nextProvider = event.data?.header?.config?.provider
      model = typeof nextModel === 'string' && nextModel.length > 0 ? nextModel : 'default'
      provider = typeof nextProvider === 'string' && nextProvider.length > 0 ? nextProvider : 'deepseek'
      continue
    }
    let usage = null
    let turn = 0
    let step = 0
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage' && event.data.chunk.usage != null) {
      usage = event.data.chunk.usage
      turn = event.data.turn ?? 0
      step = event.data.step ?? 0
    } else if (event.type === 'assistant/message' && event.data?.usage != null) {
      usage = event.data.usage
      turn = event.data.turn ?? 0
      step = event.data.step ?? 0
    } else {
      continue
    }
    const atMs = eventMs
    if (!Number.isFinite(atMs) || atMs <= 0 || isSeed) continue
    if (isWrapperProviderId(provider)) continue
    const buckets = {
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadTokens),
      cacheWrite: num(usage.cacheWriteTokens),
      reasoning: num(usage.reasoningTokens),
    }
    if (buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite + buckets.reasoning <= 0) continue
    const key = `${turn}:${step}`
    const providerKey = `${provider}:${model}`
    const prev = last !== null && last.key === key ? last : null
    if (prev !== null && prev.providerKey === providerKey
      && prev.buckets.input === buckets.input && prev.buckets.output === buckets.output
      && prev.buckets.cacheRead === buckets.cacheRead && prev.buckets.cacheWrite === buckets.cacheWrite
      && prev.buckets.reasoning === buckets.reasoning) {
      continue // 流式样本与最终消息重复
    }
    last = { key, providerKey, buckets }
    samples.push({ atMs, model, sessionId, usage: buckets })
  }
  return { samples, titles }
}

/**
 * 全量重建账本:回放所有会话日志,整体替换 days/sessions。
 * @param {import('./ledger.js').Ledger} ledger
 * @param {string} sessionsRoot - $DSH_HOME/sessions。
 * @returns {{ sessions: number, calls: number, tokens: number }}
 */
export function rebuildFromSessions(ledger, sessionsRoot) {
  const days = {}
  const sessions = {}
  let calls = 0
  let tokens = 0
  for (const path of listSessionLogs(sessionsRoot)) {
    let records
    try {
      records = readSessionRecords(path)
    } catch (error) {
      console.warn(`[dsh-usage-stats] 会话日志读取失败(${path}): ${String(error?.message ?? error)}`)
      continue
    }
    const { samples, titles } = replaySessionUsage(records)
    for (const sample of samples) {
      const dayKey = localDayKey(sample.atMs)
      const day = days[dayKey] ?? (days[dayKey] = { requests: 0, tokens: zeroTokensView(), models: {} })
      day.requests += 1
      const t = sample.usage
      for (const k of Object.keys(t)) day.tokens[k] += t[k]
      const entry = day.models[sample.model] ?? (day.models[sample.model] = { requests: 0, tokens: zeroTokensView() })
      entry.requests += 1
      for (const k of Object.keys(t)) entry.tokens[k] += t[k]
      if (sample.sessionId) {
        const session = sessions[sample.sessionId] ?? (sessions[sample.sessionId] = {
          firstAt: sample.atMs, lastAt: sample.atMs, requests: 0, tokens: zeroTokensView(), models: {}, title: null,
        })
        if (sample.atMs < session.firstAt) session.firstAt = sample.atMs
        if (sample.atMs > session.lastAt) session.lastAt = sample.atMs
        session.requests += 1
        for (const k of Object.keys(t)) session.tokens[k] += t[k]
        session.models[sample.model] = (session.models[sample.model] ?? 0) + sumTokens(t)
      }
      calls += 1
      tokens += sumTokens(t)
    }
    // 标题来自 session/title 事件;无标题的会话(如子代理)保持 null。
    for (const [id, title] of titles) {
      const session = sessions[id]
      if (session !== undefined) session.title = title
    }
  }
  ledger.rebuildFrom({ days, sessions })
  return { sessions: Object.keys(sessions).length, calls, tokens }
}

function zeroTokensView() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}
