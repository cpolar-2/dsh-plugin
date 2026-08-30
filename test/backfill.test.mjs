/** 历史回填测试:zstd 读取、事件回放去重、全量重建幂等。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { Ledger } from '../lib/ledger.js'
import { scanZstdFrames, readSessionRecords, replaySessionUsage, rebuildFromSessions, isWrapperProviderId } from '../lib/backfill.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** 造一份合成会话事件流。 */
function sessionEvents() {
  const createdAt = new Date(2026, 7, 20, 9, 0, 0).getTime()
  const inSession = (dayOffset, h, m) => createdAt + dayOffset * DAY_MS + h * 3600000 + m * 60000
  return [
    { type: 'session', id: 'sess-1', createdAt },
    { type: 'session/title', data: { title: '测试会话' } },
    // fork 种子事件(时间早于 createdAt):必须跳过。
    { type: 'request/header', time: createdAt - 5000, data: { header: { config: { provider: 'deepseek', model: 'glm-5.2' } } } },
    { type: 'assistant/message', time: createdAt - 4000, data: { usage: { inputTokens: 999, outputTokens: 999 }, turn: 0, step: 0 } },
    // 正式第一轮:流式 chunk + 最终 message 同键同值,只记一次。
    { type: 'request/header', time: inSession(0, 9, 1), data: { header: { config: { provider: 'deepseek', model: 'glm-5.3' } } } },
    { type: 'assistant/chunk', time: inSession(0, 9, 2), data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 } }, turn: 1, step: 0 } },
    { type: 'assistant/message', time: inSession(0, 9, 3), data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 }, turn: 1, step: 0 } },
    // 第二轮换模型;随后 modlens 包装层 provider 的事件跳过(只记上游真实流)。
    { type: 'request/header', time: inSession(1, 10, 0), data: { header: { config: { provider: 'deepseek', model: 'glm-5.3-flash' } } } },
    { type: 'assistant/chunk', time: inSession(1, 10, 1), data: { chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }, turn: 2, step: 0 } },
    { type: 'request/header', time: inSession(1, 10, 2), data: { header: { config: { provider: 'modlens-opencode-go', model: 'upstream-m' } } } },
    { type: 'assistant/chunk', time: inSession(1, 10, 3), data: { chunk: { type: 'usage', usage: { inputTokens: 55, outputTokens: 55 } }, turn: 3, step: 0 } },
    // 零 token 事件不入账。
    { type: 'assistant/chunk', time: inSession(1, 10, 4), data: { chunk: { type: 'usage', usage: { inputTokens: 0 } }, turn: 4, step: 0 } },
    // 打包行在解析入口丢弃(不参与回放)。
    { type: 'text-chunks', time: inSession(1, 10, 5), data: {} },
  ]
}

test('scanZstdFrames + readSessionRecords 支持 zstd 与明文两种日志', () => {
  const lines = sessionEvents().map((e) => JSON.stringify(e)).join('\n') + '\n'
  const plain = Buffer.from(lines, 'utf8')
  // 打包行(text-chunks)在解析入口被丢弃,记录数比事件数少一。
  const expectedRecords = sessionEvents().filter((e) => e.type !== 'text-chunks')
  assert.equal(readTempLog(plain, 'session.jsonl').length, expectedRecords.length)
  // zlib.zstdCompressSync 产出的单 frame 应能被扫描并解压。
  if (typeof zlib.zstdCompressSync === 'function') {
    const compressed = zlib.zstdCompressSync(plain)
    assert.equal(scanZstdFrames(compressed).length, 1)
    assert.deepEqual(readTempLog(compressed, 'session.jsonl.zstd').map((r) => r.type), expectedRecords.map((e) => e.type))
  }
  function readTempLog(buf, name) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-us-log-'))
    const path = join(dir, name)
    writeFileSync(path, buf)
    try { return readSessionRecords(path) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('replaySessionUsage:种子跳过、同键去重、包装层跳过、打包行忽略、标题提取', () => {
  const { samples } = replaySessionUsage(sessionEvents())
  // 第一轮 1 次(chunk+message 去重)+ 第二轮 flash 1 次(modlens 跳过)。
  assert.equal(samples.length, 2)
  assert.equal(samples[0].model, 'glm-5.3')
  assert.deepEqual(samples[0].usage, { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, reasoning: 0 })
  assert.equal(samples[1].model, 'glm-5.3-flash')
  assert.deepEqual(samples[1].usage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  // 种子里那个 999/999 不允许出现。
  assert.ok(samples.every((s) => s.usage.input !== 999))
})

test('replaySessionUsage 提取会话标题', () => {
  const { titles } = replaySessionUsage(sessionEvents())
  assert.equal(titles.get('sess-1'), '测试会话')
})

test('isWrapperProviderId 识别 modlens 包装层', () => {
  assert.equal(isWrapperProviderId('modlens-opencode-go'), true)
  assert.equal(isWrapperProviderId('deepseek-modlens'), true)
  assert.equal(isWrapperProviderId('deepseek'), false)
})

test('rebuildFromSessions 全量重建且幂等', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-usage-backfill-'))
  const project = join(home, 'sessions', '--test-project--', 'sess-1')
  mkdirSync(project, { recursive: true })
  const lines = sessionEvents().map((e) => JSON.stringify(e)).join('\n') + '\n'
  writeFileSync(join(project, 'session.jsonl'), lines, 'utf8')

  const ledger = new Ledger(home)
  const first = rebuildFromSessions(ledger, join(home, 'sessions'))
  assert.equal(first.sessions, 1)
  assert.equal(first.calls, 2)
  assert.equal(first.tokens, 100 + 50 + 10 + 7 + 3)
  const summary1 = ledger.summary()
  assert.equal(summary1.totals.tokens, 170)
  assert.equal(summary1.models.length, 2)
  assert.equal(summary1.models[0].name, 'glm-5.3')
  assert.ok(summary1.longestChatMs > DAY_MS) // 两轮跨两天
  // 会话榜:标题来自 session/title 事件,按用量排序的 Top 5。
  assert.equal(summary1.sessions.total, 1)
  const top = summary1.sessions.byTokens[0]
  assert.equal(top.title, '测试会话')
  assert.equal(top.tokens, 170)
  assert.equal(top.requests, 2)
  assert.equal(top.topModel, 'glm-5.3')

  // 幂等:再次重建结果一致。
  const second = rebuildFromSessions(ledger, join(home, 'sessions'))
  assert.equal(second.tokens, first.tokens)
  assert.equal(ledger.summary().totals.tokens, 170)
  ledger.close()
  rmSync(home, { recursive: true, force: true })
})
