/** client bundle 测试:__ModuleLoader__ 握手、悬浮球构建、弹窗开关行为。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 构建带最小 DOM mock 的沙箱并执行 bundle,返回 { sandbox, loads }。 */
function loadClient() {
  const sandbox = {
    loads: [],
    appended: [],
    removed: [],
    listeners: {},
    storage: new Map(),
    appended: [],
    innerWidth: 1280,
    innerHeight: 720,
  }
  sandbox.document = {
    getElementById: (id) => sandbox.appended.find((el) => el.id === id) ?? null,
    createElement: makeElement.bind(sandbox),
    head: { appendChild() {} },
    body: { appendChild(el) { sandbox.appended.push(el) } },
    addEventListener(type, fn) { sandbox.listeners[type] = fn },
  }
  sandbox.localStorage = {
    getItem: (k) => (sandbox.storage.has(k) ? sandbox.storage.get(k) : null),
    setItem: (k, v) => { sandbox.storage.set(k, String(v)) },
  }
  sandbox.window = {
    __ModuleLoader__: { load: (spec) => sandbox.loads.push(spec) },
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener(type, fn) { sandbox['win:' + type] = fn },
  }
  function makeElement() {
    const el = {
      sandbox,
      id: '',
      attrs: {},
      listeners: {},
      style: {},
      rect: { left: 14, top: 618, right: 52, bottom: 656, width: 38, height: 38 },
      innerHTML: '',
      src: '',
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c) },
        remove(c) { this._set.delete(c) },
        contains(c) { return this._set.has(c) },
      },
      setAttribute(k, v) { this.attrs[k] = v },
      addEventListener(type, fn) { this.listeners[type] = fn },
      getBoundingClientRect() { return this.rect },
      setPointerCapture() {},
      querySelector(selector) {
        if (selector === 'iframe') {
          if (!this._iframe) this._iframe = makeElement.call(this.sandbox)
          return this._iframe
        }
        if (!this._close) this._close = makeElement.call(this.sandbox)
        return this._close
      },
      appendChild() {},
      remove() { this.sandbox.removed.push(el) },
    }
    return el
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  assert.equal(sandbox.loads.length, 1, '应恰好调用一次 __ModuleLoader__.load')
  return sandbox
}

test('client bundle:ModuleLoader 握手与导出形状', () => {
  const sandbox = loadClient()
  const exports = sandbox.loads[0].factory(() => ({}))
  assert.equal(sandbox.loads[0].id, 'dsh-usage-stats')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], [])
})

test('apply:挂载悬浮球与弹窗,dispose 时移除', () => {
  const sandbox = loadClient()
  const exports = sandbox.loads[0].factory(() => ({}))
  const disposers = []
  const ctx = { effect(fn) { disposers.push(fn()) } }
  exports.apply(ctx)
  // 悬浮球 + 弹窗都挂到 body;再次 apply 幂等(已存在则跳过)。
  assert.equal(sandbox.appended.length, 2)
  assert.equal(sandbox.appended[0].id, 'us-fab')
  assert.equal(sandbox.appended[1].id, 'us-modal')
  assert.equal(disposers.length, 1)
  exports.apply(ctx)
  assert.equal(sandbox.appended.length, 2, '重复 apply 不重复挂载')
  disposers[0]()
  assert.equal(sandbox.removed.length, 2)
})

test('交互:点击悬浮球打开弹窗并懒加载 iframe,ESC/关闭/遮罩点击关闭', () => {
  const sandbox = loadClient()
  const exports = sandbox.loads[0].factory(() => ({}))
  exports.apply({ effect(fn) { fn() } })
  const [fab, modal] = sandbox.appended
  const iframe = modal.querySelector('iframe')
  const closeBtn = modal.querySelector('.us-panel-close')

  // 未拖动的按下-抬起 = 点击打开。
  fab.listeners.pointerdown({ button: 0, clientX: 20, clientY: 630, pointerId: 1 })
  fab.listeners.pointerup()
  assert.equal(modal.classList.contains('open'), true, '点击悬浮球打开')
  assert.equal(iframe.src, '/usage-stats', '首次打开加载仪表盘')

  closeBtn.listeners.click()
  assert.equal(modal.classList.contains('open'), false, '关闭按钮生效')
  assert.equal(iframe.src, 'about:blank', '关闭后停掉 iframe(轮询停止)')

  fab.listeners.pointerdown({ button: 0, clientX: 20, clientY: 630, pointerId: 1 })
  fab.listeners.pointerup()
  assert.equal(modal.classList.contains('open'), true)
  modal.listeners.click({ target: modal })
  assert.equal(modal.classList.contains('open'), false, '点击遮罩关闭')
  fab.listeners.pointerdown({ button: 0, clientX: 20, clientY: 630, pointerId: 1 })
  fab.listeners.pointerup()
  sandbox.listeners.keydown({ key: 'Escape' })
  assert.equal(modal.classList.contains('open'), false, 'ESC 关闭')
})

test('拖拽:移动改位置并记忆,点击(位移<4px)不误触发,越界钳回', () => {
  const sandbox = loadClient()
  const exports = sandbox.loads[0].factory(() => ({}))
  exports.apply({ effect(fn) { fn() } })
  const [fab, modal] = sandbox.appended

  // 拖动 dx=100,dy=30:位置 = 原坐标(14,618) + 位移,并持久化;弹窗不打开。
  fab.listeners.pointerdown({ button: 0, clientX: 20, clientY: 630, pointerId: 1 })
  fab.listeners.pointermove({ clientX: 120, clientY: 660 })
  fab.listeners.pointerup()
  assert.equal(fab.style.left, '114px')
  assert.equal(fab.style.top, '648px')
  assert.equal(fab.style.bottom, 'auto')
  assert.deepEqual({ ...JSON.parse(sandbox.localStorage.getItem('us-fab-pos')) }, { x: 114, y: 648 })
  assert.equal(modal.classList.contains('open'), false, '拖动不触发弹窗')

  // 微动 3px:仍视为点击,打开弹窗。
  fab.listeners.pointerdown({ button: 0, clientX: 114, clientY: 648, pointerId: 1 })
  fab.listeners.pointermove({ clientX: 117, clientY: 649 })
  fab.listeners.pointerup()
  assert.equal(modal.classList.contains('open'), true, '位移小于阈值按点击处理')

  // 越界拖动被钳回可视区。
  modal.querySelector('.us-panel-close').listeners.click()
  fab.listeners.pointerdown({ button: 0, clientX: 120, clientY: 688, pointerId: 1 })
  fab.listeners.pointermove({ clientX: -500, clientY: 99999 })
  fab.listeners.pointerup()
  assert.equal(fab.style.left, '0px')
  assert.equal(fab.style.top, (sandbox.window.innerHeight - 44) + 'px')
})

test('位置恢复:上次记忆的位置在挂载时还原并钳回可视区', () => {
  const sandbox = loadClient()
  sandbox.storage.set('us-fab-pos', JSON.stringify({ x: 300, y: 400 }))
  const exports = sandbox.loads[0].factory(() => ({}))
  exports.apply({ effect(fn) { fn() } })
  const [fab] = sandbox.appended
  assert.equal(fab.style.left, '300px')
  assert.equal(fab.style.top, '400px')
  assert.equal(fab.style.bottom, 'auto')

  // 记忆越界(超出窗口)时钳回。
  const sandbox2 = loadClient()
  sandbox2.storage.set('us-fab-pos', JSON.stringify({ x: 9999, y: -50 }))
  sandbox2.loads[0].factory(() => ({})).apply({ effect(fn) { fn() } })
  const [fab2] = sandbox2.appended
  assert.equal(fab2.style.left, (sandbox2.window.innerWidth - 44) + 'px')
  assert.equal(fab2.style.top, '0px')
})
