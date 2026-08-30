/**
 * dsh-usage-stats 宿主插件。
 *
 * 单一 Loader 行(见 cordis.patch.yml)挂载本模块,职责:
 *  1. 打开/维护用量账本($DSH_HOME/storages/usage-stats/ledger.json);
 *  2. 包裹 `llm/stream` 瀑布,捕获每次模型调用的 usage 块记账;
 *  3. 注册 `GET /usage-stats` 仪表盘页面与 `GET /api/usage-stats/summary` 数据端点。
 *
 * 不导入 cordis/dsh-* 运行时包:仅用 ctx API 与 Node 内建能力,零依赖、零构建。
 */

import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ledger, resolveDshHome } from './ledger.js'
import { createUsageCollector } from './collector.js'
import { rebuildFromSessions } from './backfill.js'

/** Cordis 插件名(与 cordis.patch.yml 行 id 对应)。 */
export const name = 'usage-stats'

/** 需要等待的服务。 */
export const inject = ['webServer']

const PAGE_PATH = '/usage-stats'
const API_PREFIX = '/api/usage-stats'

/**
 * 插件入口。
 * @param {any} ctx - 宿主插件上下文。
 * @param {object} [config] - 用户配置(keepDays:账本保留天数,默认 400)。
 */
export function apply(ctx, config = {}) {
  const keepDays = Number.isFinite(config.keepDays) && config.keepDays > 0 ? Math.floor(config.keepDays) : 400
  const ledger = new Ledger(resolveDshHome(), { })
  console.log(`[dsh-usage-stats] 已加载,账本:${ledger.path}`)
  const pagePath = join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html')

  ctx.effect(() => () => ledger.close(), 'usage-stats: ledger close')

  // 启动后延迟执行历史回填:全量回放会话日志重建账本(幂等,整体替换),
  // 避免拖慢宿主启动。会话日志是用量事实来源,重建不丢运行期已记账数据。
  const sessionsRoot = join(resolveDshHome(), 'sessions')
  const backfillTimer = setTimeout(() => {
    try {
      const stats = rebuildFromSessions(ledger, sessionsRoot)
      console.log(`[dsh-usage-stats] 历史回填完成:${stats.sessions} 个会话 / ${stats.calls} 次调用 / ${stats.tokens} tokens`)
    } catch (error) {
      console.warn(`[dsh-usage-stats] 历史回填失败: ${String(error?.message ?? error)}`)
    }
  }, 3000)
  backfillTimer.unref?.()
  ctx.effect(() => () => clearTimeout(backfillTimer), 'usage-stats: backfill timer')

  // 包裹 llm/stream:捕获 usage 块(位于 finish 之前)记账。仅透传数据块,不改流协议。
  ctx.on('llm/stream', createUsageCollector({
    account: (usage, model, sessionId, atMs) => {
      ledger.account(usage, model, sessionId, atMs)
    },
  }))

  const json = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== `${API_PREFIX}/summary` || req.method !== 'GET') {
          return json(res, 404, { error: 'not found' })
        }
        const trendDays = clampInt(url.searchParams.get('trendDays'), 7, 90, 30)
        const heatmapDays = clampInt(url.searchParams.get('heatmapDays'), 30, 400, Math.min(keepDays, 371))
        try {
          json(res, 200, ledger.summary({ trendDays, heatmapDays }))
        } catch (error) {
          json(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }),
  'usage-stats: api route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: PAGE_PATH,
      handler: (req, res) => {
        // /usage-stats 与 /usage-stats/… 都回同一页(纯静态单页,无子资源)。
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          return res.end()
        }
        let html
        try {
          html = fs.readFileSync(pagePath, 'utf8')
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end(`dashboard page missing: ${String(error)}`)
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : html)
      },
    }),
  'usage-stats: page route')
}

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
