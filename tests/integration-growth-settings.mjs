/** Verify growth configuration against a built current DSH in a disposable profile. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as WorkBuddy from '../src/index.js'
import { fakeWebServer } from './support.mjs'

const dsh = resolve(process.argv[2] ?? process.cwd())
const artifact = (relative) => import(pathToFileURL(join(dsh, relative, 'lib/index.js')).href)
const [{ boot, initProfile, readProfilePatches }, { default: ConfigEditor }, { default: Settings }] = await Promise.all([
  artifact('packages/boot/app-boot'), artifact('packages/boot/config-editor'), artifact('packages/settings/settings'),
])
const home = realpathSync(mkdtempSync(join(tmpdir(), 'wb-growth-settings-')))
const dir = join(home, 'profiles', 'test')
const server = fakeWebServer()
let ctx
try {
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"growth-settings-test"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'workbuddy-gateway', name: 'cordis:workbuddy', config: { autoStart: false, providerSync: false } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (context) => {
    context.provide('profileContext', profile)
    context.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
    context.provide('webServer', server)
    context.provide('credentials', { resolve: async () => undefined })
    Object.assign(context.loader.builtins, { editor: ConfigEditor, settings: Settings, workbuddy: WorkBuddy })
  })
  const descriptor = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'workbuddy-gateway')
  assert.equal(descriptor?.value.autoGrowthCheckin, false)
  assert.equal(descriptor.autoGenerate, false)
  const route = '/dsh-workbuddy-gateway/api/v1'
  const before = await server.call(`${route}/state`)
  assert.equal(before.payload.data.gateway.state, 'stopped')
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'workbuddy-gateway')
  const fiber = entry.fiber
  const result = await server.call(`${route}/config`, { method: 'POST', body: { autoGrowthCheckin: true } })
  assert.equal(result.statusCode, 200, JSON.stringify(result.payload))
  assert.equal(result.payload.data.settings.autoGrowthCheckin, true)
  assert.equal(entry.fiber, fiber, 'settings updates must not restart the gateway owner')
  assert.match(readFileSync(profile.patchPath, 'utf8'), /autoGrowthCheckin: true/)
  await ctx.settings.update('workbuddy-gateway', { autoGrowthCheckin: false })
  const after = await server.call(`${route}/state`)
  assert.equal(after.payload.data.settings.autoGrowthCheckin, false)
  assert.equal(after.payload.data.gateway.state, 'stopped')
  console.log('OK: current DSH describes, persists and applies the independent growth switch without remounting')
} finally {
  await ctx?.fiber.dispose()
  assert.ok(home.toLowerCase().startsWith((realpathSync(tmpdir()) + sep).toLowerCase()))
  rmSync(home, { recursive: true, force: true })
}
