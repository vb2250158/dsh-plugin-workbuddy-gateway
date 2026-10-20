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

import { apply, Config } from '../src/index.js'
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
    installSection: (_owner, _ns, _schema, _entry, hooks) => {
      state.hooks = hooks
      // The host supplies settings synchronously, before autostart is checked.
      hooks.setSource(() => state.resolved)
    },
    get: () => state.resolved,
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

/** Mount the plugin with the host's settings lifecycle. */
function mountPlugin(options) {
  const host = makeHost(options)
  apply(host.ctx, {})
  assert.ok(host.state.hooks, 'apply() must install the settings section')
  return host
}

test('disabled autostart is applied before web routes mount', async () => {
  const { webServer } = mountPlugin()
  const reading = await webServer.call(`${ROUTE}/state`)
  assert.ok(reading.payload.data.gateway.log.some((entry) => entry.text.includes('autostart is off')))
  assert.equal(reading.payload.data.gateway.state, 'stopped')
})

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

test('Config forms work without installSection and keep one owner listener across Settings replacements', async () => {
  const webServer = fakeWebServer()
  const config = Config({ autoStart: false, providerSync: false })
  const owner = { entry: { options: { id: 'custom-workbuddy' } } }
  const listeners = new Set()
  const childDisposers = []
  const ownerDisposers = []
  const patches = []
  let mountSettings
  const credentials = { resolve: async () => undefined }
  const listen = (disposers, event, callback) => {
    assert.equal(event, 'loader/volatile-update')
    listeners.add(callback)
    const dispose = () => listeners.delete(callback)
    disposers.push(dispose)
    return dispose
  }
  const settings = {
    configure(presentation, fiber) {
      assert.deepEqual(presentation, { auto: false })
      assert.equal(fiber, owner)
      return () => {}
    },
    async update(namespace, patch) {
      patches.push({ namespace, patch })
      config[Symbol.for('cosmokit.volatile.write')]({ ...config.get(), ...patch })
      for (const listener of listeners) listener()
    },
  }
  const ctx = {
    fiber: owner, settings, webServer,
    logger: { warn() {}, info() {}, error() {} },
    get: name => name === 'credentials' ? credentials : undefined,
    effect: factory => { const dispose = factory(); ownerDisposers.push(dispose); return dispose },
    on: (event, callback) => listen(ownerDisposers, event, callback),
    inject(deps, callback) {
      if (deps.includes('settings')) {
        mountSettings = () => callback({
          settings,
          effect: factory => { const dispose = factory(); childDisposers.push(dispose); return dispose },
          on: (event, listener) => listen(childDisposers, event, listener),
        })
        mountSettings()
      }
      if (deps.includes('webServer')) callback(ctx)
    },
  }
  try {
    apply(ctx, config)
    const committed = await webServer.call(`${ROUTE}/config`, { method: 'POST', body: { realm: 'intl' } })
    assert.equal(committed.statusCode, 200)
    assert.equal(committed.payload.data.settings.realm, 'intl')
    assert.deepEqual(patches, [{ namespace: 'custom-workbuddy', patch: { realm: 'intl' } }])
    await settings.update('custom-workbuddy', { realm: 'cn' })
    const reading = await webServer.call(`${ROUTE}/state`)
    assert.equal(reading.payload.data.settings.realm, 'cn')
    for (const dispose of childDisposers.reverse()) await dispose()
    mountSettings()
    assert.equal(listeners.size, 1, 'replacing Settings must not duplicate the owner Config listener')
  } finally {
    for (const dispose of childDisposers.reverse()) await dispose()
    for (const dispose of ownerDisposers.reverse()) await dispose()
  }
  assert.equal(listeners.size, 0)
})
