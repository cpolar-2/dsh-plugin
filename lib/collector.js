/**
 * llm/stream usage 采集器。
 *
 * 宿主的 `llm/stream` 是一条监听器瀑布:每次 ctx.llm.stream() 都把全部监听器
 * 按注册序串起来。modlens / vision-router 这类包装路由会在自身 stream() 体内
 * 再次发起 ctx.llm.stream(),导致同一请求沿包装链被记录多次。与 dsh-cost-meter
 * 同款修复:AsyncLocalStorage 深度标记识别嵌套调用,内层直接透传 next(),
 * usage 只由最外层记一次;ALS 按异步上下文隔离,并发流互不误伤。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const llmStreamDepth = new AsyncLocalStorage()

/**
 * 创建 llm/stream 采集监听器。
 * @param {object} deps
 * @param {(usage: object, model: string, sessionId: string, atMs: number, provider: string) => void} deps.account
 *   流结束时以捕获的 usage 块回调(五参签名与 Ledger.account 对齐)。
 * @param {() => number} [deps.now] - 时钟源(默认 Date.now),测试注入用。
 * @returns {(options: object, next: () => AsyncIterable) => AsyncIterable} 宿主监听器。
 */
export function createUsageCollector({ account, now = Date.now }) {
  return (options, next) => {
    const downstream = next()
    // 嵌套内层(包装路由在外层采集流的消费上下文中再发起的 llm/stream):外层已记账,透传。
    if (llmStreamDepth.getStore() !== undefined) return downstream
    // 按请求发起时刻归日:一次流式调用可能跨本地日边界。
    const startedAtMs = now()
    return (async function* usageStatsStream() {
      let usage = null
      const iterator = downstream[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          // 深度标记内拉取:下游适配器体内再发起的 ctx.llm.stream() 继承标记,判定为嵌套。
          const result = await llmStreamDepth.run(1, () => iterator.next())
          if (result.done) break
          const chunk = result.value
          if (chunk !== null && chunk !== undefined && chunk.type === 'usage' && chunk.usage != null) {
            usage = chunk.usage
          }
          yield chunk
        }
        completed = true
      } finally {
        // 提前中断(break/return/throw)时显式向下游传播 return(),避免上游流悬挂。
        if (!completed) {
          try { await iterator.return?.() } catch {}
        }
        if (usage !== null) {
          try {
            account(usage, options?.model, options?.sessionId, startedAtMs, options?.provider)
          } catch (error) {
            console.warn(`[dsh-usage-stats] 记账失败: ${String(error)}`)
          }
        }
      }
    })()
  }
}
