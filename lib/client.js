/**
 * dsh-usage-stats 浏览器端 bundle(__ModuleLoader__ 握手格式,手写无构建)。
 *
 * 一个左下角悬浮球(悬浮标):点击在当前页弹出「使用统计」弹窗(iframe 内嵌
 * 宿主 webServer 上的 /usage-stats 仪表盘),不跳转、不依赖侧边栏槽位——
 * 避免与 dsh-cost-meter 等插件的侧边栏底部队列挤在一起。ESC / 点击遮罩 /
 * 关闭按钮均可关闭;iframe 首次打开才加载。样式走 --dsw-* 主题变量,跟随亮/暗主题。
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-stats',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ── 样式(注入一次) ────────────────────────────────────────────────────

    const CSS = [
      /* 悬浮球:固定在左下角,避开侧边栏底部一行(设置约在最后 40px)。 */
      '#us-fab{position:fixed;left:14px;bottom:64px;z-index:9998;width:38px;height:38px;',
      'border-radius:50%;border:1px solid var(--dsw-alias-border-l1,transparent);cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary);',
      'box-shadow:0 2px 8px rgba(0,0,0,.14);transition:transform .12s ease,box-shadow .12s ease;color-scheme:inherit}',
      '#us-fab:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.2);color:var(--dsw-alias-label-primary)}',
      '#us-fab:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
      /* 弹窗:遮罩 + 居中面板 + 内嵌 iframe。 */
      '#us-modal{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,.45)}',
      '#us-modal.open{display:flex}',
      '.us-panel{position:relative;width:min(1040px,94vw);height:min(88vh,900px);',
      'background:var(--dsw-alias-bg-layer-1,#fff);border-radius:14px;overflow:hidden;',
      'box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column}',
      '.us-panel-head{flex:none;display:flex;align-items:center;justify-content:space-between;',
      'padding:10px 14px 10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#ececf0)}',
      '.us-panel-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.us-panel-close{border:0;background:transparent;cursor:pointer;width:26px;height:26px;border-radius:6px;',
      'display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:14px}',
      '.us-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.us-panel iframe{flex:1;width:100%;border:0}',
    ].join('')

    let cssInjected = false
    function injectCss() {
      if (cssInjected) return
      cssInjected = true
      const style = document.createElement('style')
      style.setAttribute('data-dsh-usage-stats', '')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ── 悬浮球 + 弹窗(纯 DOM,不依赖 React/slots) ────────────────────────

    const POS_KEY = 'us-fab-pos'

    /** 把坐标钳回可视区内(留出球体直径余量)。 */
    function clampPos(x, y) {
      return {
        x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 44)),
        y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 44)),
      }
    }

    /** 恢复上次拖拽记忆的位置(越界/损坏则保持默认)。 */
    function restorePos(fab) {
      try {
        const raw = localStorage.getItem(POS_KEY)
        if (!raw) return
        const pos = JSON.parse(raw)
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return
        const p = clampPos(pos.x, pos.y)
        fab.style.left = p.x + 'px'
        fab.style.top = p.y + 'px'
        fab.style.bottom = 'auto'
      } catch { /* 忽略损坏的存储 */ }
    }

    /**
     * 拖拽移动:按住拖动改位置并记忆;位移 <4px 视为点击(打开弹窗)。
     * @param {HTMLElement} fab
     * @param {() => void} open - 点击(非拖动)时的回调。
     */
    function makeDraggable(fab, open) {
      let drag = null
      fab.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        const rect = fab.getBoundingClientRect()
        drag = { startX: event.clientX, startY: event.clientY, origX: rect.left, origY: rect.top, moved: false }
        fab.setPointerCapture?.(event.pointerId)
      })
      fab.addEventListener('pointermove', (event) => {
        if (drag === null) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (!drag.moved && Math.hypot(dx, dy) < 4) return
        drag.moved = true
        const p = clampPos(drag.origX + dx, drag.origY + dy)
        fab.style.left = p.x + 'px'
        fab.style.top = p.y + 'px'
        fab.style.bottom = 'auto'
      })
      fab.addEventListener('pointerup', () => {
        if (drag === null) return
        const moved = drag.moved
        drag = null
        if (moved) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify({
              x: Number.parseFloat(fab.style.left) || 0,
              y: Number.parseFloat(fab.style.top) || 0,
            }))
          } catch { /* 存储不可用时位置不记忆 */ }
        } else {
          open()
        }
      })
      // 窗口缩放后把球拉回可视区。
      window.addEventListener('resize', () => {
        const x = Number.parseFloat(fab.style.left)
        const y = Number.parseFloat(fab.style.top)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        const p = clampPos(x, y)
        fab.style.left = p.x + 'px'
        fab.style.top = p.y + 'px'
      })
    }

    const CHART_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="2.4" stroke-linecap="round" aria-hidden="true">'
      + '<path d="M4 20V11"/><path d="M12 20V4"/><path d="M20 20v-6"/></svg>'
    const CLOSE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="2.4" stroke-linecap="round" aria-hidden="true">'
      + '<path d="M5 5l14 14"/><path d="M19 5L5 19"/></svg>'

    function buildUi() {
      const fab = document.createElement('button')
      fab.id = 'us-fab'
      fab.title = '使用统计'
      fab.setAttribute('aria-label', '使用统计')
      fab.innerHTML = CHART_ICON

      const modal = document.createElement('div')
      modal.id = 'us-modal'
      modal.setAttribute('role', 'dialog')
      modal.setAttribute('aria-label', '使用统计')
      modal.innerHTML =
        '<div class="us-panel">'
        + '<div class="us-panel-head"><span class="us-panel-title">使用统计</span>'
        + '<button class="us-panel-close" title="关闭" aria-label="关闭">' + CLOSE_ICON + '</button></div>'
        + '<iframe title="使用统计"></iframe>'
        + '</div>'
      const iframe = modal.querySelector('iframe')

      const open = () => {
        // 懒加载:首次打开才载入仪表盘;每次打开刷新到最新数据。
        iframe.src = '/usage-stats'
        modal.classList.add('open')
      }
      const close = () => {
        modal.classList.remove('open')
        iframe.src = 'about:blank' // 关闭即停掉仪表盘的轮询定时器
      }
      makeDraggable(fab, open)
      modal.querySelector('.us-panel-close').addEventListener('click', close)
      modal.addEventListener('click', (event) => { if (event.target === modal) close() })
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('open')) close()
      })

      return { fab, modal, open, close }
    }

    // ── 插件主体 ───────────────────────────────────────────────────────────

    const inject = []

    function apply(ctx) {
      if (document.getElementById('us-fab') !== null) return
      injectCss()
      const ui = buildUi()
      restorePos(ui.fab)
      document.body.appendChild(ui.fab)
      document.body.appendChild(ui.modal)
      ctx.effect(() => () => {
        ui.fab.remove()
        ui.modal.remove()
      }, 'usage-stats: floating entry')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
