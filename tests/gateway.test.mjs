/**
 * Lifecycle tests for the gateway supervisor.
 *
 * These drive the state machine with a fake child process, so they assert what
 * the settings page will be told without needing Python or a listening port.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GATEWAY_STATE, Gateway, baseUrlFor, confirmGatewayRealm, pythonCandidates } from '../src/gateway.js'
import { fakeSpawn } from './support.mjs'

const SETTINGS = {
  port: 18088,
  autoStart: true,
  providerSync: true,
  gatewayDir: 'C:/gw',
  // Pinned on purpose. These tests are about the process state machine, so they
  // name the interpreter and skip the PATH probe entirely — leaving it unnamed
  // would make every assertion depend on which python the host happens to have.
  // The probe has its own tests below.
  pythonPath: 'python',
  realm: null,
}

const PATHS = {
  script: 'C:/gw/wb_proxy.py',
  cwd: 'C:/gw',
  accountsDir: 'C:/home/workbuddy/accounts',
  usageDir: 'C:/home/workbuddy/usage',
}

test('successful quoted HTTP access logs on stderr stay neutral while failures remain errors', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  spawner.last().announceReady()
  await started
  for (const code of [200, 204, 302, 400, 401, 429, 500]) {
    spawner.last().emitError(`[wb-proxy] 13:36:16 "GET /accounts?realm=cn HTTP/1.1" ${code} -`)
    assert.equal(gateway.snapshot().log.at(-1).level, code < 400 ? 'log' : 'error')
  }
  spawner.last().emitError('Traceback: upstream failed')
  assert.equal(gateway.snapshot().log.at(-1).level, 'error')
  await gateway.stop()
})

/** Yield until a condition holds, or fail the test rather than hanging. */
async function waitFor(condition, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error('waitFor timed out')
}

/** Build a supervisor over a fake spawn. */
function harness({ settings = SETTINGS, onReady } = {}) {
  const spawner = fakeSpawn()
  let currentSettings = settings
  const gateway = new Gateway({
    spawn: spawner.spawn,
    settings: () => currentSettings,
    paths: () => PATHS,
    onReady,
  })
  return {
    gateway,
    spawner,
    setSettings: (next) => { currentSettings = { ...currentSettings, ...next } },
  }
}

test('start resolves only once the gateway reports it is listening', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start({ apiKey: 'k' })

  // Before readiness the supervisor must not claim to be running.
  assert.equal(gateway.state, GATEWAY_STATE.starting)
  assert.equal(gateway.baseUrl, null)

  spawner.last().announceReady(18088)
  const result = await started

  assert.equal(result.ok, true)
  assert.equal(gateway.state, GATEWAY_STATE.running)
  assert.equal(gateway.baseUrl, 'http://127.0.0.1:18088/v1')
  assert.equal(result.baseUrl, 'http://127.0.0.1:18088/v1')
})

test('start passes the port, the api key, and the state-redirect env', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start({ apiKey: 'secret-token' })
  spawner.last().announceReady()
  await started

  const [call] = spawner.calls
  assert.equal(call.command, 'python')
  assert.deepEqual(call.args, ['-u', 'C:/gw/wb_proxy.py', '--port', '18088', '--api-key', 'secret-token'])
  assert.equal(call.options.cwd, 'C:/gw')
  // Mutable gateway state must never land in the checkout.
  assert.equal(call.options.env.ACCOUNTS_DIR, 'C:/home/workbuddy/accounts')
  assert.equal(call.options.env.WB_PROXY_USAGE_DIR, 'C:/home/workbuddy/usage')
  assert.equal(call.options.env.WB_GROWTH_CHECKIN_ENABLED, '0')
})

test('growth automation and its verification budget reach the child at startup', async () => {
  const { gateway, spawner } = harness({ settings: { ...SETTINGS, autoGrowthCheckin: true,
    growthCheckinRetrySeconds: 60, growthCheckinMaxChecks: 4 } })
  const started = gateway.start()
  spawner.last().announceReady()
  await started
  const env = spawner.calls[0].options.env
  assert.equal(env.WB_GROWTH_CHECKIN_ENABLED, '1')
  assert.equal(env.WB_GROWTH_CHECKIN_RETRY_SECONDS, '60')
  assert.equal(env.WB_GROWTH_CHECKIN_MAX_CHECKS, '4')
})

test('no --api-key argument is passed when no token is configured', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  spawner.last().announceReady()
  await started
  assert.equal(spawner.calls[0].args.includes('--api-key'), false)
})

test('realm confirmation runs after listener readiness', async () => {
  const applied = []
  const { gateway, spawner } = harness({
    settings: { ...SETTINGS, realm: 'cn' },
    onReady: async ({ baseUrl }) => { applied.push(baseUrl) },
  })
  const started = gateway.start()
  spawner.last().announceReady()
  await started

  // The real gateway has no --realm flag; passing one would abort argparse.
  assert.equal(spawner.calls[0].args.includes('--realm'), false)
  assert.deepEqual(applied, ['http://127.0.0.1:18088/v1'])
})

test('a realm setup failure stops the child instead of serving the wrong region', async () => {
  const { gateway, spawner } = harness({
    onReady: async () => { throw new Error('realm endpoint refused') },
  })
  const started = gateway.start()
  spawner.last().announceReady()
  const result = await started

  assert.equal(result.ok, false)
  assert.equal(gateway.state, GATEWAY_STATE.failed)
  assert.equal(spawner.last().killRequests, 1)
  assert.equal(gateway.snapshot().pid, null)
  assert.ok(gateway.snapshot().log.some((entry) => entry.text.includes('post-ready setup failed')))
})

test('running waits for realm confirmation and stop during setup stays stopped', async () => {
  let confirm
  let launchedKey
  const { gateway, spawner } = harness({
    onReady: ({ apiKey }) => {
      launchedKey = apiKey
      return new Promise((resolve) => { confirm = resolve })
    },
  })
  const started = gateway.start({ apiKey: 'launch-key' })
  spawner.last().announceReady()
  await waitFor(() => confirm !== undefined)
  assert.equal(gateway.state, GATEWAY_STATE.starting)
  assert.equal(gateway.running, false)
  assert.equal(launchedKey, 'launch-key')
  await gateway.stop()
  confirm()
  assert.equal((await started).ok, false)
  assert.equal(gateway.state, GATEWAY_STATE.stopped)
})

test('a failed confirmation from an old start cannot stop its replacement', async () => {
  let rejectOld
  const { gateway, spawner } = harness({
    onReady: () => rejectOld === undefined
      ? new Promise((_resolve, reject) => { rejectOld = reject })
      : Promise.resolve(),
  })
  const oldStart = gateway.start()
  spawner.last().announceReady()
  await waitFor(() => rejectOld !== undefined)
  const restarted = gateway.restart()
  await waitFor(() => spawner.children.length === 2)
  spawner.last().announceReady()
  assert.equal((await restarted).ok, true)
  rejectOld(new Error('old setup failed'))
  assert.equal((await oldStart).ok, false)
  assert.equal(gateway.running, true)
  assert.equal(spawner.last().killRequests, 0)
  await gateway.stop()
})

test('realm confirmation authenticates and rejects unconfirmed HTTP responses', async (t) => {
  let response
  const request = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer launch-key')
    assert.equal(JSON.parse(options.body).realm, 'cn')
    assert.ok(options.signal instanceof AbortSignal)
    return response
  })
  const options = { baseUrl: 'http://127.0.0.1:18088/v1', apiKey: 'launch-key', realm: 'cn' }
  for (const status of [401, 500]) {
    response = new Response('{}', { status })
    await assert.rejects(confirmGatewayRealm(options), new RegExp(`HTTP ${status}`))
  }
  response = Response.json({ current: 'intl' })
  await assert.rejects(confirmGatewayRealm(options), /did not confirm/)
  response = Response.json({ current: 'cn' })
  await confirmGatewayRealm(options)
  assert.equal(request.mock.calls[0].arguments[0], 'http://127.0.0.1:18088/realm')
  await confirmGatewayRealm({ ...options, realm: null })
  assert.equal(request.mock.callCount(), 4)
})

test('a configured region reaches the child before HTTP setup and changes on restart', async () => {
  const { gateway, spawner, setSettings } = harness({ settings: { ...SETTINGS, realm: 'cn' } })
  let started = gateway.start()
  spawner.last().announceReady()
  await started
  assert.equal(spawner.calls[0].options.env.WB_PROXY_REALM, 'cn')
  setSettings({ realm: 'intl' })
  started = gateway.restart()
  await waitFor(() => spawner.children.length === 2)
  spawner.last().announceReady()
  await started
  assert.equal(spawner.calls[1].options.env.WB_PROXY_REALM, 'intl')
  await gateway.stop()
})

test('an exit before readiness fails the start and reports why', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  spawner.last().emitError('Traceback: argparse error')
  spawner.last().finish(2, null)
  const result = await started

  assert.equal(result.ok, false)
  assert.equal(gateway.state, GATEWAY_STATE.failed)
  assert.match(result.error ?? '', /exited/)
  assert.ok(gateway.snapshot().log.some((entry) => entry.text.includes('argparse error')))
})

test('an unexpected death while running is a failure, not a quiet stop', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  spawner.last().announceReady()
  await started

  spawner.last().finish(1, null)
  assert.equal(gateway.state, GATEWAY_STATE.failed)
  assert.match(gateway.snapshot().lastError ?? '', /exited/)
})

test('stop is idempotent and a deliberate stop is not a failure', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  spawner.last().announceReady()
  await started

  const result = await gateway.stop()
  assert.equal(result.ok, true)
  assert.equal(gateway.state, GATEWAY_STATE.stopped)
  assert.equal(gateway.snapshot().pid, null)
  assert.equal(spawner.last().killRequests, 1)

  // Stopping an already-stopped gateway is a successful no-op.
  const again = await gateway.stop()
  assert.equal(again.ok, true)
  assert.equal(gateway.state, GATEWAY_STATE.stopped)
})

test('start on a running gateway is a no-op rather than a second process', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  spawner.last().announceReady()
  await started

  const again = await gateway.start()
  assert.equal(again.ok, true)
  assert.equal(spawner.children.length, 1)
})

test('restart replaces the process and re-reads the settings', async () => {
  const { gateway, spawner, setSettings } = harness()
  const started = gateway.start()
  spawner.last().announceReady(18088)
  await started

  setSettings({ port: 19999 })
  const restarted = gateway.restart()
  // `restart` awaits the first process's exit before spawning, so the second
  // child does not exist yet on this tick; yield until it does.
  await waitFor(() => spawner.children.length === 2)
  spawner.children[1].announceReady(19999)
  const result = await restarted

  assert.equal(result.ok, true)
  assert.equal(gateway.baseUrl, 'http://127.0.0.1:19999/v1')
  assert.equal(spawner.calls[1].args[3], '19999')
  assert.equal(spawner.children.length, 2)
})

test('a late exit from a replaced process cannot clear the live one', async () => {
  const { gateway, spawner, setSettings } = harness()
  const started = gateway.start()
  spawner.last().announceReady(18088)
  await started

  setSettings({ port: 19999 })
  const restarted = gateway.restart()
  await waitFor(() => spawner.children.length === 2)
  spawner.children[1].announceReady(19999)
  await restarted

  // The replaced process reports its exit only now — after the new child is
  // installed and running. It must not blank the live child's bookkeeping.
  spawner.children[0].finish(null, 'SIGTERM')

  assert.equal(gateway.state, GATEWAY_STATE.running)
  assert.equal(gateway.snapshot().pid, spawner.children[1].pid)
  assert.equal(gateway.baseUrl, 'http://127.0.0.1:19999/v1')
})

test('a late exit from a replaced process is not reported as a crash', async () => {
  const { gateway, spawner, setSettings } = harness()
  const started = gateway.start()
  spawner.last().announceReady(18088)
  await started

  setSettings({ port: 19999 })
  const restarted = gateway.restart()
  await waitFor(() => spawner.children.length === 2)
  spawner.children[1].announceReady(19999)
  await restarted

  // The replaced process exits with a failure code after the new one is live.
  const before = gateway.snapshot().lastError
  spawner.children[0].finish(1, null)
  assert.equal(gateway.state, GATEWAY_STATE.running)
  assert.equal(gateway.snapshot().lastError, before)
})

test('the log ring stays bounded and keeps the newest lines', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  const child = spawner.last()
  for (let index = 0; index < 600; index += 1) child.emitError(`line ${index}`)
  child.announceReady()
  await started

  const { log } = gateway.snapshot()
  assert.equal(log.length <= 400, true)
  assert.ok(log.some((entry) => entry.text === 'line 599'))
  assert.equal(log.some((entry) => entry.text === 'line 0'), false)
})

test('a spawn failure is reported rather than thrown at the caller', async () => {
  const gateway = new Gateway({
    spawn: () => { throw new Error('ENOENT python') },
    settings: () => SETTINGS,
    paths: () => PATHS,
  })
  const result = await gateway.start()
  assert.equal(result.ok, false)
  assert.equal(gateway.state, GATEWAY_STATE.failed)
  assert.match(result.error ?? '', /ENOENT/)
})

test('baseUrlFor matches the base URL the gateway announces', () => {
  assert.equal(baseUrlFor(18088), 'http://127.0.0.1:18088/v1')
})

/**
 * `running` is the flag the HTTP read path uses to decide whether the gateway
 * can be called at all. It existed only as a field on the snapshot object for a
 * while, so `gateway.running` was `undefined` and every account and model read
 * was silently skipped. These assertions are deliberately on the getter itself,
 * not on `snapshot().running`.
 */
test('running is a real getter that tracks every state', async () => {
  const { gateway, spawner } = harness()

  assert.equal(gateway.running, false, 'stopped before start')
  assert.equal(typeof gateway.running, 'boolean')

  const started = gateway.start()
  assert.equal(gateway.running, false, 'not running while starting')

  spawner.last().announceReady(18088)
  await started
  assert.equal(gateway.running, true, 'running after readiness')

  await gateway.stop()
  assert.equal(gateway.running, false, 'not running after stop')
})

test('running is false after a failure', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  spawner.last().finish(1, null)
  await started
  assert.equal(gateway.running, false)
})

test('running agrees with the snapshot field in every state', async () => {
  const { gateway, spawner } = harness()
  assert.equal(gateway.running, gateway.snapshot().running)

  const started = gateway.start()
  assert.equal(gateway.running, gateway.snapshot().running)

  spawner.last().announceReady(18088)
  await started
  assert.equal(gateway.running, true)
  assert.equal(gateway.snapshot().running, true)

  await gateway.stop()
  assert.equal(gateway.running, gateway.snapshot().running)
})

/**
 * The interpreter is probed rather than assumed, because `python` does not exist
 * on a stock macOS — only `python3`. Getting this wrong is the difference between
 * a plugin that works there and one that reports ENOENT for a machine that has
 * Python installed.
 */
test('an unnamed interpreter prefers python3 off Windows and python on it', () => {
  assert.deepEqual(pythonCandidates('darwin'), ['python3', 'python'])
  assert.deepEqual(pythonCandidates('linux'), ['python3', 'python'])
  assert.deepEqual(pythonCandidates('win32'), ['python', 'python3'])
})

test('an unnamed interpreter falls back to the one that actually runs', async () => {
  // Only `python3` is runnable, which is the macOS case.
  const spawner = fakeSpawn({ runnable: ['python3'] })
  const gateway = new Gateway({
    spawn: spawner.spawn,
    settings: () => ({ ...SETTINGS, pythonPath: '' }),
    paths: () => PATHS,
  })
  const started = gateway.start()
  await waitFor(() => spawner.children.length === 1)
  spawner.last().announceReady(18088)
  await started

  const [call] = spawner.calls
  assert.equal(call.command, 'python3', 'spawned the interpreter that works')
  assert.ok(gateway.snapshot().log.some((entry) => entry.text.includes('python3')), 'the log names it')
})

test('the probe is skipped entirely when the interpreter is named', async () => {
  const { gateway, spawner } = harness()
  const started = gateway.start()
  spawner.last().announceReady(18088)
  await started

  assert.deepEqual(spawner.probes, [], 'no probe ran')
  assert.equal(spawner.calls[0].command, 'python', 'spawned the named interpreter')
})

test('a machine with no runnable interpreter still reports a useful error', async () => {
  const spawner = fakeSpawn({ runnable: [] })
  const gateway = new Gateway({
    spawn: spawner.spawn,
    settings: () => ({ ...SETTINGS, pythonPath: '' }),
    paths: () => PATHS,
  })
  const started = gateway.start()
  await waitFor(() => spawner.children.length === 1)
  spawner.last().finish(1, null)
  const result = await started

  assert.equal(result.ok, false)
  // Falls back to the platform's first candidate so the operator sees its name.
  assert.equal(spawner.calls[0].command, pythonCandidates(process.platform)[0])
})

test('the snapshot reports the interpreter that was selected', async () => {
  const spawner = fakeSpawn({ runnable: ['python3'] })
  const gateway = new Gateway({
    spawn: spawner.spawn,
    settings: () => ({ ...SETTINGS, pythonPath: '' }),
    paths: () => PATHS,
  })
  const started = gateway.start()
  await waitFor(() => spawner.children.length === 1)
  spawner.last().announceReady(18088)
  await started

  assert.equal(gateway.snapshot().pythonPath, 'python3')
  assert.equal(gateway.snapshot().platform, process.platform)
})
