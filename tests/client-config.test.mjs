/** Settings interactions, including writes racing with background polling. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** The client source, read once: every test mounts the same artifact. */
const CLIENT_SOURCE = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

/**
 * Load the client factory with `react` and `window` stood in.
 *
 * @param {object} [options] - harness options.
 * @param {object} [options.state] - initial page data.
 * @param {Function} [options.respond] - response envelope for each fetch.
 * @returns {{Section: Function, h: Function, calls: object[], restore: Function}}
 */
function loadClient({ state, respond } = {}) {
  const registrations = []
  const globalWindow = { open: () => {}, __ModuleLoader__: { load: (entry) => registrations.push(entry) } }
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = globalWindow

  // A `react` stand-in that records the element tree instead of rendering it.
  const h = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  })
  const effects = []
  const hooks = []
  let cursor = 0
  const React = {
    createElement: h,
    useState: (initial) => {
      const index = cursor++
      if (hooks[index] === undefined) {
        // The section's first hook is its data state, which starts as
        // `{ phase: 'loading' }` and is filled by the polling effect. Effects
        // do not run here, so that slot is seeded with the payload under test —
        // otherwise every test would assert against the loading placeholder.
        hooks[index] = index === 0 && state !== undefined
          ? { phase: 'ready', data: state, error: null }
          : typeof initial === 'function' ? initial() : initial
      }
      return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
    },
    useRef: (initial) => {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    // Rendering tests leave effects idle; race tests explicitly start polling.
    useEffect: (callback) => { effects.push(callback) },
    // Memoisation is an optimization; returning the new value keeps the render
    // faithful because nothing here asserts on identity across renders.
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }

  const calls = []
  const requests = []
  globalThis.fetch = async (url, options) => {
    const text = String(url)
    calls.push(text)
    requests.push({ url: text, options })
    const body = respond ? await respond(text, options) : text.endsWith('/state') && state !== undefined
      ? { ok: true, data: state }
      : { ok: true, data: {} }
    return { ok: true, status: 200, async json() { return body } }
  }

  // The module is an IIFE that registers into the loader; reading the captured
  // registration is how its factory is reached.
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', CLIENT_SOURCE)(globalWindow, (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })

  assert.equal(registrations.length, 1, 'the client must register exactly one module')
  const exported = registrations[0].factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })

  // Reach the Section component by mounting the plugin and reading what it
  // registers into the settings slot.
  let registered = null
  exported.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (_spec, component) => { registered = component; return () => {} },
    },
  })
  assert.notEqual(registered, null, 'the client must register a settings section')

  return {
    Section: registered,
    render: () => { cursor = 0; effects.length = 0; return expand(registered({})) },
    startPolling: () => effects[1](),
    h,
    calls,
    requests,
    restore: () => {
      globalThis.window = previousWindow
      globalThis.fetch = previousFetch
    },
  }
}

/**
 * Expand one element by invoking it when it is a component.
 *
 * The stand-in records `h(AccountCard, props)` as data, but the real renderer
 * would call the component and substitute its output. Expanding here is what
 * makes the assertions below able to see inside a card at all.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  // A host element is a lowercase string; a component is a function.
  if (typeof node.type === 'function') {
    const props = { ...node.props }
    // `h(Component, props, childA, childB)` passes children positionally.
    if (node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children
    return expand(node.type(props))
  }
  return { ...node, children: node.children.map(expand) }
}

/** Collect every element of one type from a rendered tree. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

/** Depth-first text of a rendered tree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children ?? []).map(textOf).join(' ')
}

/** A full `/state` payload with the given accounts. */
function stateWith(accounts, settings = {}) {
  return {
    gateway: { state: 'running', log: [], port: 18088 },
    settings: { port: 18088, realm: null, keyConfigured: true, ...settings },
    account: { accounts, usable: accounts.filter((entry) => entry.enabled !== false).length, storage: 'C:/store' },
    models: [],
    provider: { present: true, modelCount: 0, routes: [] },
    reads: { accounts: null, models: null },
  }
}

/** Render the section over one state payload, with components expanded. */
function render(state) {
  const client = loadClient({ state })
  try {
    const tree = expand(client.Section({}))
    return { tree, text: textOf(tree), client }
  } finally {
    // The tree is plain data, so the globals can be restored immediately.
    client.restore()
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('growth activity confirmation is separate from billing check-in in the account card', () => {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  for (const [status, expected] of [['pending', /awaiting official|待官方确认/],
    ['confirmed', /confirmed today|今日已确认/], ['failed', /unconfirmed today|今日未确认/]]) {
    const { text } = render(stateWith([{ uid: 'cn', realm: 'cn', enabled: true,
      checkinClaimed: true, lastCheckin: `${date} 08:00:00`,
      growthCheckin: { status, reason: status === 'failed' ? 'not_recorded' : '' } }],
    { autoGrowthCheckin: true }))
    assert.match(text, expected)
    assert.match(text, /Checked in|已签到/)
  }
})

test('the independent growth checkbox saves and displays the confirmed setting', async () => {
  let state = stateWith([], { autoGrowthCheckin: false })
  const client = loadClient({ state, respond: (url, options) => {
    if (url.endsWith('/config')) {
      assert.deepEqual(JSON.parse(options.body), { autoGrowthCheckin: true })
      state = { ...state, settings: { ...state.settings, autoGrowthCheckin: true } }
      return { ok: true, data: { settings: state.settings, gateway: state.gateway } }
    }
    return { ok: true, data: state }
  } })
  try {
    const findSwitch = () => {
      const label = findAll(client.render(), n => n.type === 'label' && /Automatic growth|自动成长打卡/.test(textOf(n)))[0]
      return findAll(label, n => n.type === 'input')[0]
    }
    assert.equal(findSwitch().props.checked, false)
    findSwitch().props.onChange({ target: { checked: true } })
    await settle()
    assert.equal(findSwitch().props.checked, true)
  } finally { client.restore() }
})

test('desktop scan explains encrypted credentials and an empty result without hiding settings', async () => {
  for (const detected of [[], [{ path: 'desktop.info', file: 'desktop.info', valid: false,
    errorCode: 'desktop_credentials_encrypted', nickname: { $wbEncrypted: 1 } }]]) {
    const state = stateWith([])
    const client = loadClient({ state, respond: (url) => ({ ok: true, data: url.endsWith('/accounts/scan')
      ? { scan: { detected } } : state }) })
    try {
      findAll(client.render(), n => n.type === 'button' && /Scan desktop accounts|扫描桌面端账号/.test(textOf(n)))[0].props.onClick()
      await settle()
      const scanRequest = client.requests.find(({ url }) => url.endsWith('/accounts/scan'))
      assert.equal(scanRequest?.options?.headers?.['X-DSH-WorkBuddy-Request'], 'desktop')
      const tree = client.render()
      assert.match(textOf(tree), detected.length ? /encrypted|加密/ : /No desktop credentials found|未找到桌面端凭证/)
      assert.ok(findAll(tree, n => n.props.key === 'providerCard').length)
      if (detected.length) {
        const imports = findAll(tree, n => n.type === 'button' && /^(Import|导入)$/.test(textOf(n)))
        assert.equal(imports.length, 1)
        assert.equal(imports[0].props.disabled, true)
      }
    } finally { client.restore() }
  }
})

test('configuration controls apply saved values and submit the displayed port', async () => {
  let saved = stateWith([], { autoStart: true, providerSync: true, realm: 'intl' })
  const patches = []
  const client = loadClient({ state: saved, respond: async (_url, options) => {
    const patch = JSON.parse(options.body)
    patches.push(patch)
    saved = { ...saved, settings: { ...saved.settings, ...patch } }
    return { ok: true, data: { settings: saved.settings } }
  } })
  try {
    for (const index of [0, 1]) {
      for (const checked of [false, true]) {
        const checkbox = findAll(client.render(), n => n.props.type === 'checkbox')[index]
        checkbox.props.onChange({ target: { checked } })
        await settle()
        assert.equal(findAll(client.render(), n => n.props.type === 'checkbox')[index].props.checked, checked)
      }
    }
    for (const value of ['cn', 'intl', '']) {
      findAll(client.render(), n => n.type === 'select')[0].props.onChange({ target: { value } })
      await settle()
      assert.equal(findAll(client.render(), n => n.type === 'select')[0].props.value, value)
    }
    findAll(client.render(), n => n.type === 'button' && /Apply port|应用端口/i.test(textOf(n)))[0].props.onClick()
    await settle()
    assert.deepEqual(patches.at(-1), { port: 18088 })
  } finally { client.restore() }
})

test('a state read started before a config write cannot restore the old checkbox', async () => {
  const old = stateWith([], { autoStart: true })
  let finishRead
  const client = loadClient({ state: old, respond: (url) => url.endsWith('/state')
    ? new Promise(resolve => { finishRead = resolve })
    : { ok: true, data: { settings: { autoStart: false } } } })
  let stop
  try {
    const tree = client.render()
    stop = client.startPolling()
    findAll(tree, n => n.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } })
    await settle()
    finishRead({ ok: true, data: old })
    await settle()
    assert.equal(findAll(client.render(), n => n.props.type === 'checkbox')[0].props.checked, false)
  } finally { stop?.(); client.restore() }
})


test('failed saves preserve the value, release controls, and report the error', async () => {
  let finishWrite
  let writes = 0
  const client = loadClient({ state: stateWith([], { autoStart: true }), respond: () => {
    writes += 1
    return new Promise(resolve => { finishWrite = resolve })
  } })
  try {
    const before = client.render()
    const checkbox = findAll(before, n => n.props.type === 'checkbox')[0]
    checkbox.props.onChange({ target: { checked: false } })
    checkbox.props.onChange({ target: { checked: false } })
    const pending = client.render()
    assert.equal(writes, 1)
    assert.equal(findAll(pending, n => n.props.type === 'checkbox')[0].props.disabled, true)
    finishWrite({ ok: false, error: { message: 'save failed' } })
    await settle()
    const after = client.render()
    assert.equal(findAll(after, n => n.props.type === 'checkbox')[0].props.checked, true)
    assert.equal(findAll(after, n => n.props.type === 'checkbox')[0].props.disabled, false)
    assert.match(textOf(after), /save failed/)
  } finally { client.restore() }
})

test('realm status distinguishes the selected realm from the gateway and model catalog', () => {
  const state = stateWith([], { realm: 'cn' })
  state.activeRealm = 'intl'
  state.modelsRealm = 'cn'
  state.models = [{ id: 'china-model' }]
  const { text } = render(state)
  assert.match(text, /Active gateway realm: Global|网关当前区域: 国际版/)
  assert.match(text, /Model catalog realm: China|模型清单所属区域: 国内版/)
})

test('switching realms replaces the old models together with the saved selection', async () => {
  const state = stateWith([], { realm: 'intl' })
  state.models = [{ id: 'old-global-model' }]
  const client = loadClient({ state, respond: () => ({ ok: true, data: {
    ...state, settings: { ...state.settings, realm: 'cn' },
    activeRealm: 'cn', modelsRealm: 'cn', models: [{ id: 'new-china-model' }],
  } }) })
  try {
    findAll(client.render(), n => n.type === 'select')[0].props.onChange({ target: { value: 'cn' } })
    await settle()
    const text = textOf(client.render())
    assert.match(text, /new-china-model/)
    assert.doesNotMatch(text, /old-global-model/)
  } finally { client.restore() }
})
