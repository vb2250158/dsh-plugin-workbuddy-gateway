/** Exercise settings through an installed dsh CLI, using a private profile and no accounts. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cli = process.argv[2]
assert.ok(cli, 'Usage: node scripts/verify-profile-settings.mjs <dsh CLI .js or .cmd> [plugin directory]')
const pluginRoot = resolve(process.argv[3] ?? fileURLToPath(new URL('..', import.meta.url)))
const fixture = fileURLToPath(new URL('../tests/fixtures/profile-settings.js', import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'wb-profile-settings-'))
const profile = join(home, 'profiles', 'workbuddy-test')
const pluginLink = join(profile, 'node_modules', 'dsh-plugin-workbuddy-gateway')
let linked = false
try {
  const bundle = join(profile, 'node_modules', 'workbuddy-test-bundle')
  await mkdir(bundle, { recursive: true })
  await symlink(pluginRoot, pluginLink, process.platform === 'win32' ? 'junction' : 'dir')
  linked = true
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'workbuddy-test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'workbuddy-test-fixture', name: pathToFileURL(fixture).href },
    { id: 'config-editor', name: '@deepseek-ai/dsh-config-editor' },
    { id: 'settings', name: '@deepseek-ai/dsh-settings' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } },
    { id: 'web-server', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
  ] }]))
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'workbuddy-settings-test', private: true,
    dependencies: { 'dsh-plugin-workbuddy-gateway': `link:${pluginRoot}` },
    dsh: { profile: { bundles: ['workbuddy-test-bundle', 'dsh-plugin-workbuddy-gateway'] } },
  }))
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'workbuddy-gateway', config: { autoStart: false, providerSync: false } },
  ]))
  for (const phase of ['write', 'restart']) await launch(phase)
  assert.deepEqual(JSON.parse(await readFile(join(home, 'result.json'), 'utf8')), {
    settings: 'persisted', provider: 'removed', sibling: 'preserved', gateway: 'stopped',
  })
  console.log('PASS: installed runtime loads the bundle without installSection; Config edits stay live, persist across restart, and provider writes preserve sibling routes.')
} finally {
  if (linked) await unlink(pluginLink)
  const inside = relative(resolve(tmpdir()), resolve(home))
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside))
  await rm(home, { recursive: true, force: true })
}

/** Start only the private test profile; a timeout terminates only its owned process tree. */
async function launch(phase) {
  const batch = extname(cli).toLowerCase() === '.cmd'
  const command = batch ? 'powershell.exe' : process.execPath
  const args = batch
    ? ['-NoProfile', '-NonInteractive', '-Command', `& '${resolve(cli).replaceAll("'", "''")}' --profile workbuddy-test; exit $LASTEXITCODE`]
    : [resolve(cli), '--profile', 'workbuddy-test']
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|SECRET|TOKEN|PASSWORD/i.test(key) && !/^(DSH_|WB_TEST_|WORKBUDDY_)/.test(key)))
  const child = spawn(command, args, {
    env: { ...env, DSH_HOME: home, WB_TEST_HOME: home, WB_TEST_PHASE: phase, WB_TEST_PLUGIN: pluginRoot },
    cwd: home, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
  })
  let output = ''
  let timedOut = false
  let termination = Promise.resolve()
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32') {
      termination = new Promise((done, reject) => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', reject)
        killer.once('close', done)
      })
      void termination.catch(() => {})
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  }, 60_000)
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', done)
    })
    await termination
    assert.equal(timedOut, false, `${phase} timed out\n${output}`)
    assert.equal(code, 0, `${phase} failed\n${output}`)
    assert.doesNotMatch(output, /installSection is not a function|skipping profile bundle|incompatible with dsh|did not activate/i)
  } finally {
    clearTimeout(timer)
  }
}
