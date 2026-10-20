/** Actual host services with a stopped gateway and an isolated configuration document. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'workbuddy-profile-settings-fixture'

/** Register read-only credentials and run after the profile has settled. */
export function apply(ctx) {
  assert.equal(resolve(ctx.profileContext.home), resolve(process.env.WB_TEST_HOME))
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.inject(['settings', 'configEditor', 'webServer'], scope => {
    scope.appReady.onReady(() => {
      void verify(scope).then(() => scope.appExit(0), error => { console.error(error); scope.appExit(1) })
    })
  })
}

async function verify(ctx) {
  assert.equal(typeof ctx.settings.installSection, 'undefined', 'this check requires the current Config-based Settings service')
  const { applyProvider, buildProviderEntry, readProviderMap } = await import(
    pathToFileURL(join(process.env.WB_TEST_PLUGIN, 'src/provider-route.js')).href)
  const { PROVIDER_ID, API_KEY_REF } = await import(pathToFileURL(join(process.env.WB_TEST_PLUGIN, 'src/settings.js')).href)
  const root = process.env.WB_TEST_HOME
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const endpoint = `${origin}/dsh-workbuddy-gateway/api/v1`
  const call = async (route, patch) => {
    const response = await fetch(`${endpoint}/${route}`, patch === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(patch),
    })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.data
  }
  const descriptor = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'workbuddy-gateway')
  assert.ok(descriptor, 'WorkBuddy must expose a Config form when installSection is absent')
  assert.equal(descriptor.autoGenerate, false)
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'workbuddy-gateway')
  const fiber = entry.fiber
  const before = await call('state')
  const manifest = JSON.parse(await readFile(join(process.env.WB_TEST_PLUGIN, 'package.json'), 'utf8'))
  assert.equal((await call('health')).plugin.version, manifest.version)
  assert.equal(before.gateway.state, 'stopped')
  assert.equal(before.settings.autoStart, false)
  const sibling = buildProviderEntry({ baseUrl: 'http://127.0.0.1:1/v1', apiKeyRef: 'FIXTURE_KEY', models: [{ id: 'fixture-sibling' }] })
  if (process.env.WB_TEST_PHASE === 'write') {
    const changed = await call('config', { realm: 'intl', port: 19088 })
    assert.equal(changed.settings.realm, 'intl')
    assert.equal(changed.settings.port, 19088)
    assert.equal(entry.fiber, fiber, 'Config edits must not remount the gateway owner')
    await ctx.settings.update('workbuddy-gateway', { realm: 'cn' })
    assert.equal((await call('state')).settings.realm, 'cn', 'external Config edits must reach the running plugin')
    assert.match(await readFile(ctx.profileContext.patchPath, 'utf8'), /port: 19088/)
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'fixture-sibling'], value: sibling }])
    const resolvedSibling = readProviderMap(ctx.settings).providers['fixture-sibling']
    await writeFile(join(root, 'sibling.json'), JSON.stringify(resolvedSibling))
    const route = buildProviderEntry({ baseUrl: 'http://127.0.0.1:19088/v1', apiKeyRef: API_KEY_REF, models: [{ id: 'fixture-workbuddy' }] })
    assert.equal((await applyProvider({ settings: ctx.settings, providerId: PROVIDER_ID, entry: route })).changed, true)
    assert.deepEqual(readProviderMap(ctx.settings).providers['fixture-sibling'], resolvedSibling)
    assert.equal((await applyProvider({ settings: ctx.settings, providerId: PROVIDER_ID, entry: null })).changed, true)
    assert.deepEqual(readProviderMap(ctx.settings).providers, { 'fixture-sibling': resolvedSibling })
    return
  }
  assert.equal(before.settings.realm, 'cn')
  assert.equal(before.settings.port, 19088)
  const resolvedSibling = JSON.parse(await readFile(join(root, 'sibling.json'), 'utf8'))
  assert.deepEqual(readProviderMap(ctx.settings).providers, { 'fixture-sibling': resolvedSibling })
  await writeFile(join(root, 'result.json'), JSON.stringify({
    settings: 'persisted', provider: 'removed', sibling: 'preserved', gateway: 'stopped',
  }))
}
