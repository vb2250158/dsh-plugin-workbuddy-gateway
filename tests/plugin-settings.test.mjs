/**
 * Regressions for the host half's settings source.
 *
 * `installSection` hands `setSource` a thunk and calls it only when the settings
 * provider attaches or detaches; a committed change afterwards fires `onChange`
 * alone. The plugin used to evaluate that thunk immediately and cache the value,
 * so the section froze at mount time: the realm picker never echoed a switch, the
 * account and model reads kept querying the old realm, and the CN-only buttons
 * never appeared. These tests fail if that caching returns.
 *
 * @module dsh-plugin-workbuddy-gateway/tests/plugin-settings
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../src/index.js'
import { fakeWebServer } from './support.mjs'

const ROUTE = '/dsh-workbuddy-gateway/api/v1'

/** A minimal host: captures the section hooks and lets `/config` really commit. */
function makeHost({ autoStart = false } = {}) {
  const webServer = fakeWebServer()
  const state = {
    resolved: {
      realm: 'cn',
      port: 18088,
      autoStart,
      providerSync: true,
      gatewayDir: '',
      pythonPath: '',
    },
    hooks: null,
    patches: [],
  }

  const settingsService = {
    configure: () => () => {},
    describe: () => [],
    update: async (_ns, patch) => {
      state.patches.push(patch)
      state.resolved = { ...state.resolved, ...patch }
      // A real provider notifies its watchers after committing.
      state.hooks?.onChange()
    },
  }

  // Answering the credential lookup keeps `waitForService` from starting its
  // 10s retry timer, which would otherwise hold the test process open.
  const credentials = { resolve: async () => undefined, set: async () => {} }

  const webCtx = {
    webServer,
    settings: settingsService,
    get: (name) => (name === 'credentials' ? credentials : undefined),
    effect: () => () => {},
  }

  const ctx = {
    settings: settingsService,
    on: (_event, fn) => { state.hooks = { onChange: () => fn("workbuddy-gateway") } },
    logger: { warn() {}, info() {}, error() {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    effect: () => () => {},
    inject: (deps, callback) => {
      if (deps.includes('settings')) callback({ settings: settingsService })
      if (deps.includes('webServer')) callback(webCtx)
    },
  }

  return { ctx, state, webServer }
}

/** Mount the plugin and prime the section with its own source thunk. */
function mountPlugin(options) {
  const host = makeHost(options)
  apply(host.ctx, { get: () => host.state.resolved })
  assert.ok(host.state.hooks, 'apply() must install the settings section')
  host.state.hooks.onChange()
  return host
}

test('a committed realm change reaches /state without a remount', async () => {
  const { state, webServer } = mountPlugin()

  const committed = await webServer.call(`${ROUTE}/config`, { method: 'POST', body: { realm: 'intl' } })
  assert.equal(committed.payload.ok, true)
  assert.deepEqual(state.patches, [{ realm: 'intl' }])

  // The response snapshot and a later read must both reflect the new realm.
  assert.equal(committed.payload.data.settings.realm, 'intl')
  const reading = await webServer.call(`${ROUTE}/state`)
  assert.equal(reading.payload.data.settings.realm, 'intl')
})

test('the source thunk is re-read when the settings service reports a change', async () => {
  const { state, webServer } = mountPlugin()

  const before = await webServer.call(`${ROUTE}/state`)
  assert.equal(before.payload.data.settings.realm, 'cn')

  // Something outside this plugin (another tab, or a hand edit) commits a value.
  state.resolved = { ...state.resolved, realm: 'intl' }
  state.hooks.onChange()

  const after = await webServer.call(`${ROUTE}/state`)
  assert.equal(after.payload.data.settings.realm, 'intl')
})

test('the cached section is corrected after a commit even before onChange fires', async () => {
  const { state, webServer } = mountPlugin()

  // Simulate a provider whose watcher has not run yet by muting it for one write.
  const hooks = state.hooks
  state.hooks = null
  const committed = await webServer.call(`${ROUTE}/config`, { method: 'POST', body: { realm: 'intl' } })
  state.hooks = hooks

  assert.equal(committed.payload.data.settings.realm, 'intl')
  const reading = await webServer.call(`${ROUTE}/state`)
  assert.equal(reading.payload.data.settings.realm, 'intl')
})
