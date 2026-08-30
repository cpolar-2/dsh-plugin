/**
 * 本地预览/冒烟脚本(不属于插件运行时):
 * 先向隔离的演示账本($DSH_HOME 指向临时目录)注入仿截图的种子数据,
 * 再以 mock ctx 走一遍 apply() 的注册路径,用 node:http 挂上注册的
 * /usage-stats 与 /api/usage-stats 路由,便于浏览器直接查看仪表盘效果。
 *
 * 运行:node scripts/preview.mjs [port]
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const importFromRoot = (relative) => import(pathToFileURL(join(pluginRoot, relative)).href)

// 隔离的演示账本(不碰真实 ~/.dsh)。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-usage-stats-preview-'))

const { Ledger, localDayKey } = await importFromRoot('lib/ledger.js')
const { apply } = await importFromRoot('lib/index.js')

// ── 种子数据:仿截图的 8 天用量 ───────────────────────────────────
const DAY = 86400000
const now = Date.now()
{
  const seed = new Ledger(process.env.DSH_HOME)
  const plan = [
    [-7, [5_000_000, 200_000, 400_000, 100_000, 300_000]],
    [-6, [30_000_000, 900_000, 300_000, 60_000, 150_000]],
    [-5, [55_000_000, 2_000_000, 200_000, 30_000, 90_000]],
    [-4, [18_000_000, 500_000, 100_000, 20_000, 40_000]],
    [-3, [4_000_000, 300_000, 80_000, 15_000, 20_000]],
    [-2, [1_000_000, 200_000, 60_000, 10_000, 10_000]],
    [-1, [9_000_000, 5_100_000, 300_000, 190_000, 500_000]],
    [0, [30_000_000, 3_000_000, 100_000, 50_000, 100_000]],
  ]
  const models = ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5-Turbo', 'GLM-5.2', 'deepseek-v4-pro']
  for (const [offset, amounts] of plan) {
    const at = now + offset * DAY
    amounts.forEach((total, mi) => {
      // 拆成两次请求,让 requests 也非零。
      for (const fraction of [0.6, 0.4]) {
        seed.account(
          { inputTokens: Math.round(total * fraction * 0.7), outputTokens: Math.round(total * fraction * 0.3) },
          models[mi],
          `demo-${offset}-${mi}`,
          at + (fraction < 0.5 ? 60000 : 0)
        )
      }
    })
  }
  // 一个 4h28m 的会话跨度。
  seed.data.sessions['demo-long'] = { firstAt: now - 2 * DAY, lastAt: now - 2 * DAY + (4 * 60 + 28) * 60000 }
  seed.close()
}

// ── mock 宿主 ctx,走一遍 apply() 注册路径 ────────────────────────
const routes = []
const effects = []
const ctx = {
  on(event, listener) {
    if (event === 'llm/stream') ctx.llmStream = listener
  },
  effect(fn) { effects.push(fn()) }, // cordis 语义:立即执行 setup,返回值作为 dispose
  webServer: { register(route) { routes.push(route) } },
}
apply(ctx, {})
console.log(`已注册路由: ${routes.map((r) => `${r.kind} ${r.path}`).join(', ')}`)

// ── llm/stream 冒烟:确认采集器记账进入 apply 内部账本 ───────────
async function* downstream() {
  yield { type: 'text', text: 'ok' }
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } }
}
for await (const chunk of ctx.llmStream({ model: 'GLM-5.3', sessionId: 'smoke' }, downstream)) { /* 消费 */ }

// ── HTTP 服务:完全按 webserver 的匹配顺序(精确→最长前缀)分发 ──
const port = Number(process.argv[2] ?? 8787)
function matchRoute(pathname) {
  let best = null
  for (const route of routes) {
    if (route.kind === 'exact' && route.path === pathname) return route
    if (route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(route.path + '/'))) {
      if (best === null || route.path.length > best.path.length) best = route
    }
  }
  return best
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/') { res.writeHead(302, { location: '/usage-stats' }); return res.end() }
  const route = matchRoute(url.pathname)
  if (route) return route.handler(req, res)
  res.writeHead(404)
  res.end('not found')
}).listen(port, () => {
  console.log(`预览地址: http://127.0.0.1:${port}/usage-stats`)
})
