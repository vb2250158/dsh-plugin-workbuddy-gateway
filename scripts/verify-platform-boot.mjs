/**
 * End-to-end check of interpreter resolution plus a real gateway boot.
 *
 * Runs the supervisor for real — no fake spawn — with `pythonPath` unnamed, so it
 * exercises exactly what a fresh install on an unverified platform does: probe
 * for an interpreter, spawn the vendored gateway, detect readiness from its log,
 * then shut it down.
 *
 * Usage: node scripts/verify-platform-boot.mjs [port]
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Gateway, confirmGatewayRealm, pythonCandidates } from '../src/gateway.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2] ?? 0)
const stateDir = mkdtempSync(join(tmpdir(), 'wb-boot-'))
const accountsDir = join(stateDir, 'accounts')
mkdirSync(accountsDir)
const realmFile = join(accountsDir, 'active_realm.json')
writeFileSync(realmFile, JSON.stringify({ realm: 'intl' }))
const apiKey = 'offline-boot-test'
let realm = 'cn'

let failed = false
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed = true
}

console.log(`platform      : ${process.platform}`)
console.log(`candidates    : ${pythonCandidates(process.platform).join(', ')}`)
console.log(`state dir     : ${stateDir}\n`)

const gateway = new Gateway({
  spawn,
  settings: () => ({
    port,
    autoStart: true,
    providerSync: false,
    gatewayDir: '',
    pythonPath: '',
    realm,
  }),
  paths: () => ({
    script: join(root, 'vendor', 'workbuddy-gateway', 'wb_proxy.py'),
    cwd: join(root, 'vendor', 'workbuddy-gateway'),
    accountsDir,
    usageDir: join(stateDir, 'usage'),
  }),
  onReady: async ({ baseUrl, apiKey: launchedKey }) => {
    const response = await fetch(`${baseUrl.replace(/\/v1$/, '')}/realm`, {
      headers: { authorization: `Bearer ${launchedKey}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`initial realm request returned ${response.status}`)
    const initial = await response.json()
    check('the first request already uses China before POST /realm', initial.current === 'cn')
    await confirmGatewayRealm({ baseUrl, apiKey: launchedKey, realm })
  },
})

try {
  const result = await gateway.start({ apiKey })
  const reading = gateway.snapshot()

  check('the gateway started', result.ok, result.error ?? '')
  check('it reported readiness', reading.baseUrl !== null, String(reading.baseUrl))
  // The whole point: the interpreter was chosen, not assumed.
  check('the probe recorded an interpreter', typeof reading.pythonPath === 'string' && reading.pythonPath !== '', reading.pythonPath)
  check('the probe line is in the log', reading.log.some((entry) => entry.text.includes('starting gateway:')))

  if (result.ok && reading.baseUrl !== null) {
    const health = await fetch(`${reading.baseUrl.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(5000) })
    check('the gateway answers /health', health.ok, `HTTP ${String(health.status)}`)
    await health.arrayBuffer()
    const growthUrl = `${reading.baseUrl.replace(/\/v1$/, '')}/scheduler/growth`
    const policy = { enabled: true, retrySeconds: 60, maxChecks: 2 }
    const rejected = await fetch(growthUrl, { method: 'POST', body: JSON.stringify(policy), signal: AbortSignal.timeout(5000) })
    check('growth policy rejects unauthenticated writes', rejected.status === 401)
    await rejected.arrayBuffer()
    const changed = await fetch(growthUrl, { method: 'POST', body: JSON.stringify(policy),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) })
    const applied = await changed.json()
    check('growth policy is applied to the running scheduler', changed.ok && Object.keys(policy).every(key => applied[key] === policy[key]))
    check('the confirmed realm is saved in the configured account store', JSON.parse(readFileSync(realmFile)).realm === 'cn')
    realm = null
    const restarted = await gateway.restart({ apiKey })
    check('restart without an override restores the saved China realm', restarted.ok, restarted.error ?? '')
  }

  await gateway.stop()
  check('it stopped cleanly', gateway.state === 'stopped', gateway.state)
  check('the child is gone', gateway.snapshot().pid === null)
} catch (error) {
  check('the run completed without throwing', false, error.message)
} finally {
  await gateway.stop()
  rmSync(stateDir, { recursive: true, force: true })
}

console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: OK')
process.exit(failed ? 1 : 0)
