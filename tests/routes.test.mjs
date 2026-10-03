/**
 * Tests for the settings section shape and the HTTP surface.
 *
 * The routes are exercised through a fake `webServer`, so these assert the
 * exact envelope, guards, and payloads the settings page will receive without
 * booting the harness.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mount } from '../src/routes.js'
import { DEFAULT_PORT, ROUTE_BASE, normalizeSettings } from '../src/settings.js'
import { fakeWebServer } from './support.mjs'

/** One account as the gateway's `/accounts` reports it. */
function account(overrides = {}) {
  return {
    uid: 'uid-1',
    nickname: 'user@example.com',
    realm: 'intl',
    enabled: true,
    inCooldown: false,
    lastError: '',
    ...overrides,
  }
}

/**
 * Route tests need the gateway's HTTP answers, not just its state.
 *
 * `globalThis.fetch` is stubbed for the duration of one test and restored after,
 * so `node:test`'s concurrency cannot leak the stub into another file.
 *
 * @param {(url: string) => {status?: number, body?: object}} respond - per-URL answer.
 * @returns {{calls: string[], restore: Function}} recorded URLs and the restorer.
 */
function stubGatewayFetch(respond) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const text = String(url)
    calls.push(text)
    const { status = 200, body = {} } = respond(text) ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return JSON.stringify(body) },
    }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** A gateway stand-in with just the surface the routes read. */
function fakeGateway({ running = true, baseUrl = 'http://127.0.0.1:18088/v1' } = {}) {
  return {
    running,
    baseUrl,
    snapshot: () => ({
      state: running ? 'running' : 'stopped',
      running,
      baseUrl,
      pid: running ? 1234 : null,
      uptimeMs: running ? 5000 : null,
      lastError: null,
      port: 18088,
      accountStore: 'C:/home/workbuddy/accounts',
      usageStore: 'C:/home/workbuddy/usage',
      log: [],
    }),
    start: async () => ({ ok: true, state: 'running', baseUrl, error: null }),
    stop: async () => ({ ok: true, state: 'stopped' }),
    restart: async () => ({ ok: true, state: 'running', baseUrl, error: null }),
  }
}

/** Build the routes over a fake web server. */
function harness({ gateway = fakeGateway(), credentials, settings, syncProvider, providerState } = {}) {
  const server = fakeWebServer()
  const updates = []
  let current = {
    port: DEFAULT_PORT,
    autoStart: true,
    providerSync: true,
    gatewayDir: 'C:/gw',
    pythonPath: '',
    realm: null,
    ...settings,
  }
  const mounted = mount({ webServer: server }, {
    gateway,
    settings: () => current,
    updateSettings: async (patch) => {
      updates.push(patch)
      current = { ...current, ...patch }
    },
    credentials: () => credentials,
    syncProvider: syncProvider ?? (async () => ({ written: true, routes: ['sub', 'workbuddy'] })),
    providerState: providerState ?? (() => ({ present: true, providerId: 'workbuddy', routes: ['sub', 'workbuddy'], modelCount: 3 })),
  })
  return { server, mounted, updates, getSettings: () => current }
}

/** A credentials stand-in backed by a map. */
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    resolve: async (ref) => store.has(ref) ? { value: store.get(ref), source: 'file' } : undefined,
    set: async (ref, value) => { store.set(ref, value) },
    unset: async (ref) => { store.delete(ref) },
  }
}

test('normalizeSettings defaults a bad port and keeps valid fields', () => {
  assert.equal(normalizeSettings({}).port, DEFAULT_PORT)
  assert.equal(normalizeSettings({ port: 'nonsense' }).port, DEFAULT_PORT)
  assert.equal(normalizeSettings({ port: 70000 }).port, DEFAULT_PORT)
  assert.equal(normalizeSettings({ port: 0 }).port, DEFAULT_PORT)
  assert.equal(normalizeSettings({ port: 19000 }).port, 19000)
  assert.equal(normalizeSettings({ autoStart: false }).autoStart, false)
  assert.equal(normalizeSettings({ autoStart: 'yes' }).autoStart, true)
  assert.equal(normalizeSettings({ realm: 'cn' }).realm, 'cn')
  assert.equal(normalizeSettings({ realm: 'mars' }).realm, null)
  // An empty gatewayDir is meaningful — it selects the bundled gateway — so it
  // must survive normalization rather than be replaced by a default path.
  assert.equal(normalizeSettings({ gatewayDir: '' }).gatewayDir, '')
  assert.equal(normalizeSettings({}).gatewayDir, '')
  assert.equal(normalizeSettings({ gatewayDir: '  D:/gw  ' }).gatewayDir, 'D:/gw')
  assert.equal(normalizeSettings({ gatewayDir: 7 }).gatewayDir, '')
})

test('normalizeSettings treats a non-object section as the defaults', () => {
  for (const value of [null, undefined, 'x', 7, []]) {
    assert.equal(normalizeSettings(value).port, DEFAULT_PORT)
  }
})

test('every route is mounted under the plugin prefix', () => {
  const { server } = harness()
  assert.equal(server.routes.size >= 10, true)
  for (const key of server.routes.keys()) {
    assert.ok(key.includes(ROUTE_BASE), `route ${key} is outside ${ROUTE_BASE}`)
  }
})

test('health reports the plugin marker and the gateway reading', async () => {
  const { server } = harness()
  const response = await server.call(`${ROUTE_BASE}/health`)
  assert.equal(response.statusCode, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.data.plugin.routeBase, ROUTE_BASE)
  assert.equal(response.payload.data.gateway.state, 'running')
})

test('state reports keyConfigured from the credential store', async () => {
  const credentials = fakeCredentials({ WORKBUDDY_API_KEY: 'stored' })
  const { server } = harness({ credentials })
  const response = await server.call(`${ROUTE_BASE}/state`)
  assert.equal(response.payload.data.settings.keyConfigured, true)
})

/**
 * The gateway counts `usable` across every realm but filters its account list to
 * one. Relaying both produced a panel reading "2 usable of 1 account" on a
 * machine with one account per realm. Both numbers must come from one array.
 */
test('the account listing and its usable count are scoped to one realm', async () => {
  const stub = stubGatewayFetch((url) => {
    if (url.includes('/accounts')) {
      return { body: { accounts: [account({ realm: 'intl' })], usable: 9, storage: 'C:/store' } }
    }
    return { body: { data: [] } }
  })
  try {
    const { server } = harness()
    const reading = (await server.call(`${ROUTE_BASE}/state`)).payload.data

    assert.equal(reading.account.accounts.length, 1)
    // The gateway's cross-realm `usable: 9` must be ignored in favour of the
    // count derived from the listing that was actually returned.
    assert.equal(reading.account.usable, 1)
    assert.equal(reading.reads.accounts, null)
  } finally {
    stub.restore()
  }
})

test('the account request carries the configured realm', async () => {
  const stub = stubGatewayFetch((url) => (url.includes('/accounts')
    ? { body: { accounts: [], usable: 0 } }
    : { body: { data: [] } }))
  try {
    const { server } = harness({ settings: { realm: 'cn' } })
    await server.call(`${ROUTE_BASE}/state`)
    const accountCall = stub.calls.find((url) => url.includes('/accounts'))
    assert.ok(accountCall !== undefined)
    assert.match(accountCall, /\?realm=cn$/)
  } finally {
    stub.restore()
  }
})

test('an unset realm omits the query so the gateway keeps its own default', async () => {
  const stub = stubGatewayFetch((url) => (url.includes('/accounts')
    ? { body: { accounts: [], usable: 0 } }
    : { body: { data: [] } }))
  try {
    const { server } = harness()
    await server.call(`${ROUTE_BASE}/state`)
    const accountCall = stub.calls.find((url) => url.includes('/accounts'))
    assert.ok(accountCall !== undefined)
    assert.equal(accountCall.includes('realm='), false)
  } finally {
    stub.restore()
  }
})

test('usable counts only accounts that can actually serve a request', async () => {
  const stub = stubGatewayFetch((url) => (url.includes('/accounts')
    ? {
        body: {
          accounts: [
            account({ uid: 'a' }),
            account({ uid: 'b', enabled: false }),
            account({ uid: 'c', inCooldown: true }),
            account({ uid: 'd', available: false, lastError: 'token expired' }),
            account({ uid: 'e' }),
          ],
        },
      }
    : { body: { data: [] } }))
  try {
    const { server } = harness()
    const reading = (await server.call(`${ROUTE_BASE}/state`)).payload.data
    assert.equal(reading.account.accounts.length, 5, 'every account is still listed')
    assert.equal(reading.account.usable, 2, 'only the healthy ones count as usable')
  } finally {
    stub.restore()
  }
})

test('historical errors do not hide eligible accounts after cooldown', async () => {
  for (const [entry, expected] of [
    [account({ uid: 'restored', available: true, lastError: 'HTTP 403' }), 1],
    [account({ uid: 'missing-token', available: false }), 0],
    [account({ uid: 'legacy-restored', lastError: 'old SSL failure' }), 1],
    [account({ uid: 'legacy-expired', expiresAt: 1, hasRefreshToken: false }), 0],
  ]) {
    const stub = stubGatewayFetch((url) => (url.includes('/accounts')
      ? { body: { accounts: [entry] } }
      : { body: { data: [] } }))
    try {
      const { server } = harness()
      const reading = (await server.call(`${ROUTE_BASE}/state`)).payload.data
      assert.equal(reading.account.usable, expected, entry.uid)
    } finally {
      stub.restore()
    }
  }
})

test('a per-account read failure degrades without dropping the list', async () => {
  const stub = stubGatewayFetch((url) => (url.includes('/accounts')
    ? { status: 500, body: { error: { message: 'upstream refused' } } }
    : { body: { data: [{ id: 'm1' }] } }))
  try {
    const { server } = harness()
    const reading = (await server.call(`${ROUTE_BASE}/state`)).payload.data
    assert.deepEqual(reading.account.accounts, [])
    assert.equal(reading.account.usable, 0)
    assert.match(reading.reads.accounts, /upstream refused/)
    // The model read still succeeded, so the page keeps half its data.
    assert.equal(reading.models.length, 1)
  } finally {
    stub.restore()
  }
})

test('state reports keyConfigured false when nothing is stored', async () => {
  const { server } = harness({ credentials: fakeCredentials() })
  const response = await server.call(`${ROUTE_BASE}/state`)
  assert.equal(response.payload.data.settings.keyConfigured, false)
})

test('state explains that a stopped gateway cannot supply accounts or models', async () => {
  const { server } = harness({ gateway: fakeGateway({ running: false, baseUrl: null }) })
  const response = await server.call(`${ROUTE_BASE}/state`)
  const data = response.payload.data
  assert.deepEqual(data.models, [])
  assert.deepEqual(data.account.accounts, [])
  assert.match(data.reads.models, /not running/)
})

test('a mutating route refuses a cross-origin request', async () => {
  const { server } = harness()
  const response = await server.call(`${ROUTE_BASE}/gateway/start`, {
    method: 'POST',
    headers: { origin: 'http://evil.example' },
  })
  assert.equal(response.statusCode, 403)
  assert.equal(response.payload.error.code, 'cross-origin')
})

test('account operations forward the selected uid and keep upstream results', async (t) => {
  const { server } = harness()
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({
      results: [{ uid: 'selected', ok: false, error: 'upstream unavailable' }],
    }) }
  })
  for (const suffix of ['/accounts/credits', '/accounts/checkin']) {
    const response = await server.call(`${ROUTE_BASE}${suffix}`, { method: 'POST', body: { uid: 'selected' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.payload.data.result.results[0].error, 'upstream unavailable')
    assert.deepEqual(calls.at(-1), { url: `http://127.0.0.1:18088${suffix}`, method: 'POST', body: { uid: 'selected' } })
  }
})

test('new account and task operations reject cross-origin requests and GET', async () => {
  const { server } = harness()
  for (const suffix of ['/accounts/credits', '/accounts/checkin', '/accounts/set', '/accounts/set-all', '/tasks/run']) {
    const crossOrigin = await server.call(`${ROUTE_BASE}${suffix}`, {
      method: 'POST', headers: { origin: 'http://evil.example' }, body: {},
    })
    assert.equal(crossOrigin.statusCode, 403)
    const read = await server.call(`${ROUTE_BASE}${suffix}`)
    assert.equal(read.statusCode, 405)
  }
})

test('a read route rejects the wrong verb', async () => {
  const { server } = harness()
  const response = await server.call(`${ROUTE_BASE}/state`, { method: 'POST' })
  assert.equal(response.statusCode, 405)
  assert.equal(response.payload.error.code, 'method-not-allowed')
})

test('config persists only recognized keys and rejects the rest', async () => {
  const { server, updates } = harness()
  const ok = await server.call(`${ROUTE_BASE}/config`, { method: 'POST', body: { port: 19000, autoStart: false } })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(updates[0], { port: 19000, autoStart: false })

  const bad = await server.call(`${ROUTE_BASE}/config`, { method: 'POST', body: { nonsense: 1 } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.payload.error.code, 'invalid-input')
})

test('config rejects an out-of-range port rather than writing it', async () => {
  const { server, updates } = harness()
  const response = await server.call(`${ROUTE_BASE}/config`, { method: 'POST', body: { port: 99999 } })
  assert.equal(response.statusCode, 400)
  assert.equal(updates.length, 0)
})

test('key generation stores a token under the plugin\'s credential reference', async () => {
  const credentials = fakeCredentials()
  const { server } = harness({ credentials })
  const response = await server.call(`${ROUTE_BASE}/key`, { method: 'POST', body: { action: 'generate' } })
  assert.equal(response.payload.data.configured, true)
  assert.equal(response.payload.data.keyRef, 'WORKBUDDY_API_KEY')
  assert.equal(credentials.store.get('WORKBUDDY_API_KEY'), response.payload.data.value)
  assert.equal(response.payload.data.value.length > 20, true)
})

test('key clearing removes the credential', async () => {
  const credentials = fakeCredentials({ WORKBUDDY_API_KEY: 'stored' })
  const { server } = harness({ credentials })
  const response = await server.call(`${ROUTE_BASE}/key`, { method: 'POST', body: { action: 'clear' } })
  assert.equal(response.payload.data.configured, false)
  assert.equal(credentials.store.has('WORKBUDDY_API_KEY'), false)
})

test('a key action without a credential service is a 400, not a crash', async () => {
  const { server } = harness()
  const response = await server.call(`${ROUTE_BASE}/key`, { method: 'POST', body: {} })
  assert.equal(response.statusCode, 400)
  assert.match(response.payload.error.message, /credential service/)
})

test('gateway start surfaces a failure as an error envelope', async () => {
  const gateway = fakeGateway({ running: false })
  gateway.start = async () => ({ ok: false, state: 'failed', baseUrl: null, error: 'python not found' })
  const { server } = harness({ gateway })
  const response = await server.call(`${ROUTE_BASE}/gateway/start`, { method: 'POST' })
  assert.equal(response.statusCode, 500)
  assert.match(response.payload.error.message, /python not found/)
})

test('provider removal calls the sync collaborator with null', async () => {
  const calls = []
  const { server } = harness({ syncProvider: async (value) => { calls.push(value); return { removed: true } } })
  const response = await server.call(`${ROUTE_BASE}/provider/sync`, { method: 'POST', body: { action: 'remove' } })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(calls, [null])
})

test('the login poll route keeps its query string (prefix registration)', async () => {
  const { server } = harness({ gateway: fakeGateway({ running: false }) })
  const response = await server.call(`${ROUTE_BASE}/accounts/login/poll`, {})
  // It must reach the handler rather than 404, and the handler must reject the
  // missing state rather than silently polling nothing.
  assert.equal(response.statusCode, 400)
  assert.match(response.payload.error.message, /state/)
})

test('import validates its payload before calling the gateway', async () => {
  const { server } = harness({ gateway: fakeGateway({ running: false }) })
  const response = await server.call(`${ROUTE_BASE}/accounts/import`, { method: 'POST', body: {} })
  assert.equal(response.statusCode, 400)
  assert.match(response.payload.error.message, /path is required/)
})

test('unmounting disposes every registered route', () => {
  const { server, mounted } = harness()
  const before = server.routes.size
  assert.equal(mounted.length, before)
  for (const dispose of mounted) dispose()
  assert.equal(server.routes.size, 0)
})

test('model reads and manual provider sync use the selected realm', async () => {
  const synced = []
  const stub = stubGatewayFetch((url) => {
    const realm = new URL(url).searchParams.get('realm') ?? 'intl'
    if (url.endsWith('/realm')) return { body: { current: 'intl' } }
    return { body: { realm, data: [{ id: `${realm}-model` }], accounts: [] } }
  })
  try {
    const { server } = harness({ settings: { realm: 'cn' }, syncProvider: async models => { synced.push(models); return {} } })
    const state = await server.call(`${ROUTE_BASE}/state`)
    assert.equal(state.payload.data.models[0].id, 'cn-model')
    assert.equal(state.payload.data.modelsRealm, 'cn')
    assert.equal(state.payload.data.activeRealm, 'intl')
    await server.call(`${ROUTE_BASE}/provider/sync`, { method: 'POST', body: {} })
    assert.deepEqual(synced, [[{ id: 'cn-model' }]])
  } finally { stub.restore() }
})

test('switching realms refreshes the displayed catalog and the automatic provider route', async () => {
  const previous = globalThis.fetch
  let active = 'intl'
  const synced = []
  globalThis.fetch = async (url, options) => {
    const path = new URL(url)
    if (path.pathname === '/realm' && options.method === 'POST') active = JSON.parse(options.body).realm
    const realm = path.searchParams.get('realm') ?? active
    return { ok: true, status: 200, text: async () => JSON.stringify(
      path.pathname === '/realm' ? { current: active } : { realm, data: [{ id: `${realm}-model` }], accounts: [] }
    ) }
  }
  try {
    const { server } = harness({ syncProvider: async models => { synced.push(models); return {} } })
    for (const realm of ['cn', 'intl']) {
      const result = await server.call(`${ROUTE_BASE}/config`, { method: 'POST', body: { realm } })
      assert.equal(result.payload.ok, true)
      assert.equal(result.payload.data.activeRealm, realm)
      assert.equal(result.payload.data.modelsRealm, realm)
      assert.deepEqual(result.payload.data.models, [{ id: `${realm}-model` }])
      assert.deepEqual(synced.at(-1), [{ id: `${realm}-model` }])
    }
    await server.call(`${ROUTE_BASE}/config`, { method: 'POST', body: { providerSync: false, realm: 'cn' } })
    assert.equal(synced.length, 2)
  } finally { globalThis.fetch = previous }
})

test('an unconfirmed gateway realm switch is reported and does not save the requested realm', async () => {
  const stub = stubGatewayFetch(() => ({ body: { current: 'intl' } }))
  try {
    const { server, updates } = harness({ settings: { realm: 'intl' } })
    const response = await server.call(`${ROUTE_BASE}/config`, { method: 'POST', body: { realm: 'cn' } })
    assert.equal(response.payload.ok, false)
    assert.match(response.payload.error.message, /did not confirm/)
    assert.deepEqual(updates, [])
  } finally { stub.restore() }
})
