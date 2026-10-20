/**
 * Gateway process supervision.
 *
 * The WorkBuddy gateway is a Python program that speaks the upstream
 * subscription protocol and re-publishes it as an OpenAI-compatible endpoint.
 * This module owns its lifecycle: spawn, readiness detection, log ring,
 * restart, and shutdown.
 *
 * Design constraints that shaped it:
 *
 * - **Spawn is injected**, not imported. `spawn` arrives through the
 *   constructor so tests drive the whole state machine without a Python
 *   interpreter or a listening port.
 * - **Readiness is observed, not assumed.** The gateway prints
 *   `listening : http://host:port/v1` once it is serving; that line is the only
 *   honest signal. A fixed sleep would report "running" during a slow boot and
 *   "stopped" during a fast one.
 * - **Mutable state lives outside the gateway checkout.** `accounts/` and
 *   `usage/` are redirected into `$DSH_HOME/workbuddy/` by environment
 *   variable, so a `link:`-installed plugin never writes into its own source.
 *
 * @module dsh-plugin-workbuddy-gateway/gateway
 */

import { createInterface } from 'node:readline'

/** How many log lines to retain for the settings page. */
const LOG_LIMIT = 400

/** How long to wait for the readiness line before declaring the boot failed. */
const READY_TIMEOUT_MS = 45_000

/** Lifecycle states the settings page renders. */
export const GATEWAY_STATE = {
  stopped: 'stopped',
  starting: 'starting',
  running: 'running',
  failed: 'failed',
}

/** The readiness line the gateway prints once it is serving. */
const READY_PATTERN = /listening\s*:\s*(http:\/\/\S+)/

/** How the gateway spells the bound port in its readiness line. */
const PORT_PATTERN = /:(\d+)\/v1/

/**
 * Confirm the selected realm using the key passed to the launched process.
 * @param {object} options - gateway baseUrl, apiKey, and selected realm (null follows saved state).
 * @returns {Promise<void>} rejects when the gateway cannot confirm the realm within ten seconds.
 */
export async function confirmGatewayRealm({ baseUrl, apiKey, realm }) {
  if (realm === null) return
  const response = await fetch(`${baseUrl.replace(/\/v1$/, '')}/realm`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ realm }),
  })
  if (!response.ok) throw new Error(`realm setup returned HTTP ${response.status}`)
  const result = await response.json()
  if (result.current !== realm) throw new Error('gateway did not confirm the configured realm')
}

/**
 * Python commands to try, in order, when the operator has not named one.
 *
 * `python` alone is not a portable default. macOS has shipped no `python` shim
 * since 12.3 (only `python3`), and several Linux distributions do the same, so a
 * Windows-only assumption here turns into "the gateway will not start" on a
 * machine where Python is installed and working.
 *
 * Windows is listed first because that is the platform this was verified on, and
 * `python` is the conventional name there.
 *
 * @param {string} platform - `process.platform`.
 * @returns {string[]} interpreter candidates, most likely first.
 */
export function pythonCandidates(platform) {
  return platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']
}

/** How long one interpreter probe may take before that candidate is skipped. */
const PROBE_TIMEOUT_MS = 5000

/**
 * Find the first candidate interpreter that actually runs.
 *
 * A wrong guess costs one failed spawn and an ENOENT line on the settings page,
 * so probing is worth a few milliseconds once per start. Every probe is bounded:
 * a command that exists but never exits must not wedge `start()`, which is why
 * the timer races the child rather than trusting it to settle.
 *
 * When nothing answers, null is returned and the caller falls back to the first
 * candidate so its spawn error is what the operator sees — that message is what
 * they need in order to set `pythonPath` by hand.
 *
 * @param {object} options - probe inputs.
 * @param {Function} options.spawn - the same injected spawn the class uses.
 * @param {string[]} options.candidates - commands to try, in order.
 * @returns {Promise<string|null>} the first working command, or null if none.
 */
async function firstWorkingPython({ spawn, candidates }) {
  for (const candidate of candidates) {
    const works = await new Promise((resolve) => {
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        // A probe that outlives its budget is killed so it cannot linger.
        try {
          child?.kill()
        } catch {
          /* a child that never started has nothing to kill */
        }
        settle(false)
      }, PROBE_TIMEOUT_MS)

      let child
      try {
        child = spawn(candidate, ['-c', 'pass'], { stdio: 'ignore', windowsHide: true })
      } catch {
        settle(false)
        return
      }
      child.on('error', () => settle(false))
      child.on('exit', (code) => settle(code === 0))
    })
    if (works) return candidate
  }
  return null
}

/**
 * Own the gateway's lifecycle.
 *
 * @example
 * const gateway = new Gateway({ spawn, pythonPath: '', ... })
 * await gateway.start()
 * gateway.snapshot()
 */
export class Gateway {
  #spawn
  #settingsSource
  #paths
  #onReady
  #lastPaths = null
  #child = null
  #state = GATEWAY_STATE.stopped
  #log = []
  #logSeq = 0
  #baseUrl = null
  #pid = null
  #startedAt = null
  #lastExit = null
  #lastError = null
  #readyTimer = null
  #readyWaiters = []
  /** Args of an in-flight `start()`, exposed only so `stop()` can read `keepState`. */
  #starting = null
  /** Set while `stop()` is waiting for the child, so its exit is not read as a crash. */
  #stopping = false
  /** The interpreter the last start actually spawned, which the probe may have chosen. */
  #interpreter = null

  /**
   * @param {object} options - construction options.
   * @param {Function} options.spawn - `node:child_process` spawn, injected.
   * @param {Function} options.settings - returns the current normalized settings.
   * @param {Function} options.paths - returns the resolved filesystem locations.
   *   A function rather than a value: `gatewayDir` is a settings field, so the
   *   script path must be re-derived at every start.
   * @param {() => {script: string, cwd: string, accountsDir: string, usageDir: string}} options.paths
   * @param {Function} [options.onReady] - confirms configuration after the socket
   *   is listening. Failure stops the child; running is reported only on success.
   */
  constructor({ spawn, settings, paths, onReady }) {
    this.#spawn = spawn
    this.#settingsSource = settings
    this.#paths = paths
    this.#onReady = onReady
  }

  /** Current lifecycle state. */
  get state() {
    return this.#state
  }

  /**
   * Whether the gateway is serving right now.
   *
   * A real getter, not a convenience read of the snapshot object: the read path
   * checks this to decide whether the gateway can be called, and an `undefined`
   * here silently disables every account and model read.
   */
  get running() {
    return this.#state === GATEWAY_STATE.running
  }

  /**
   * Record one line in the log ring without touching the state machine.
   *
   * The settings page reads this ring, so anything the plugin decides *not* to
   * do has to land here too — an autostart that declines to run is otherwise
   * indistinguishable from one that was never configured.
   *
   * @param {'log'|'error'} level - line severity.
   * @param {string} text - the line.
   */
  note(level, text) {
    this.#append(level, text)
  }

  /** The base URL the gateway reported, or null when it is not serving. */
  get baseUrl() {
    return this.#baseUrl
  }

  /**
   * Start the gateway, resolving after the listener and configuration are ready.
   *
   * Calling `start()` on a running gateway is a no-op, so a settings page
   * button and an `autoStart` mount cannot fight each other.
   *
   * @param {object} [options] - start options.
   * @param {string} [options.apiKey] - bearer token the gateway must require.
   * @param {boolean} [options.keepState] - on a readiness failure, leave the
   *   state `failed` instead of clearing it to `stopped`. `stop()` reaps the
   *   failed child with this set, so the reading the page renders names the
   *   failure rather than reporting a tidy stop.
   * @returns {Promise<{ok: boolean, state: string, baseUrl: string|null, error: string|null}>}
   */
  async start({ apiKey, keepState = false } = {}) {
    if (this.#state === GATEWAY_STATE.running) {
      return { ok: true, state: this.#state, baseUrl: this.#baseUrl, error: null }
    }
    if (this.#state === GATEWAY_STATE.starting) {
      return { ok: false, state: this.#state, baseUrl: null, error: 'already starting' }
    }

    const settings = this.#settingsSource()
    const paths = this.#paths()
    this.#lastPaths = paths
    this.#state = GATEWAY_STATE.starting
    this.#lastError = null
    this.#lastExit = null
    this.#baseUrl = null

    // An unnamed interpreter is probed rather than assumed: `python` does not
    // exist on a stock macOS, and the failure that produces is an ENOENT that
    // looks like a broken plugin rather than a naming difference.
    let interpreter = settings.pythonPath
    if (interpreter === '') {
      const candidates = pythonCandidates(process.platform)
      interpreter = await firstWorkingPython({ spawn: this.#spawn, candidates }) ?? candidates[0]
      if (interpreter !== candidates[0]) {
        this.#append('log', `using ${interpreter} (${candidates[0]} was not runnable)`)
      }
    }
    this.#append('log', `starting gateway: ${interpreter} ${paths.script} --port ${settings.port}`)
    this.#interpreter = interpreter

    // The environment selects the realm before listening; POST /realm then
    // confirms and persists it using the launched process's API key.
    const args = ['-u', paths.script, '--port', String(settings.port)]
    if (typeof apiKey === 'string' && apiKey !== '') args.push('--api-key', apiKey)

    let child
    try {
      child = this.#spawn(interpreter, args, {
        cwd: paths.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          // Redirect mutable state out of the (possibly `link:`-installed)
          // checkout and into $DSH_HOME.
          ACCOUNTS_DIR: paths.accountsDir,
          WB_PROXY_USAGE_DIR: paths.usageDir,
          WB_PROXY_REALM: settings.realm ?? '',
          WB_GROWTH_CHECKIN_ENABLED: settings.autoGrowthCheckin === true ? '1' : '0',
          WB_GROWTH_CHECKIN_RETRY_SECONDS: String(settings.growthCheckinRetrySeconds ?? 300),
          WB_GROWTH_CHECKIN_MAX_CHECKS: String(settings.growthCheckinMaxChecks ?? 3),
          // Keep Python from buffering the readiness line behind its stdio.
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      })
    } catch (error) {
      this.#state = GATEWAY_STATE.failed
      this.#lastError = `spawn failed: ${messageOf(error)}`
      this.#append('error', this.#lastError)
      return { ok: false, state: this.#state, baseUrl: null, error: this.#lastError }
    }

    this.#child = child
    this.#pid = typeof child.pid === 'number' ? child.pid : null
    this.#startedAt = Date.now()
    this.#starting = { keepState }
    this.#pipe(child, 'stdout')
    this.#pipe(child, 'stderr')

    child.on('error', (error) => {
      this.#lastError = `process error: ${messageOf(error)}`
      this.#append('error', this.#lastError)
      if (this.#state !== GATEWAY_STATE.running) this.#state = GATEWAY_STATE.failed
      this.#settleReady(false, this.#lastError)
    })

    child.on('exit', (code, signal) => {
      this.#onExit(child, code, signal)
    })

    // `keepState` is this call's argument; clearing `#starting` only ends the
    // window in which a late exit would be attributed to this start.
    this.#starting = null
    const ready = await this.#waitReady()
    if (!ready.ok) {
      // A boot that never reported readiness must not be left running: it is
      // either wedged or already dead, and either way the port is not serving.
      if (!keepState) this.#state = GATEWAY_STATE.failed
      this.#lastError = ready.error
      // A failed start must not be reported as a clean stop, so the state this
      // call leaves behind survives the reaping.
      await this.stop({ keepState: true })
      return { ok: false, state: this.#state, baseUrl: null, error: ready.error }
    }

    if (this.#onReady !== undefined) {
      try {
        await this.#onReady({ baseUrl: this.#baseUrl, apiKey })
      } catch (error) {
        const detail = `post-ready setup failed: ${messageOf(error)}`
        if (this.#child !== child) {
          return { ok: false, state: this.#state, baseUrl: null, error: detail }
        }
        this.#append('error', detail)
        await this.stop({ keepState: true })
        this.#state = GATEWAY_STATE.failed
        this.#lastError = detail
        return { ok: false, state: this.#state, baseUrl: null, error: detail }
      }
    }
    if (this.#child !== child || this.#state !== GATEWAY_STATE.starting) {
      return { ok: false, state: this.#state, baseUrl: null, error: 'gateway stopped during setup' }
    }
    this.#state = GATEWAY_STATE.running
    this.#append('log', `gateway ready at ${this.#baseUrl}`)
    return { ok: true, state: this.#state, baseUrl: this.#baseUrl, error: null }
  }

  /**
   * Stop the gateway, resolving once the child is gone.
   *
   * Idempotent: stopping a stopped gateway is a successful no-op, which is what
   * lets both the settings page and plugin disposal call it unconditionally.
   *
   * @param {object} [options] - stop options.
   * @param {boolean} [options.keepState] - leave a `failed` reading intact.
   * @returns {Promise<{ok: boolean, state: string}>}
   */
  async stop({ keepState = false } = {}) {
    const child = this.#child
    this.#clearReadyTimer()
    this.#settleReady(false, 'stopped')
    if (child === null) {
      if (!keepState) this.#state = GATEWAY_STATE.stopped
      this.#baseUrl = null
      this.#pid = null
      return { ok: true, state: this.#state }
    }

    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const finish = (resolveExit) => {
        clearTimeout(timer)
        child.off('exit', finish)
        resolveExit()
      }
      const timer = setTimeout(() => { finish(resolve) }, 5000)
      child.once('exit', () => { finish(resolve) })
    })

    // Flag the intent before killing: the exit is about to arrive, and the exit
    // handler must read it as a stop rather than as a crash.
    this.#stopping = true
    try {
      child.kill()
    } catch (error) {
      this.#append('error', `kill failed: ${messageOf(error)}`)
    }
    await exited

    // Only the child this stop targeted may clear the bookkeeping: a restart
    // installs the next process before this promise resolves in some timelines.
    const wasCurrent = child === this.#child
    this.#stopping = false
    if (wasCurrent) {
      this.#child = null
      this.#pid = null
      this.#baseUrl = null
      if (!keepState && this.#state !== GATEWAY_STATE.failed) this.#state = GATEWAY_STATE.stopped
    }
    return { ok: true, state: this.#state }
  }

  /**
   * Restart the gateway: stop, then start with the current settings.
   *
   * @param {object} [options] - forwarded to {@link start}.
   * @returns {Promise<object>} the start result.
   */
  async restart(options = {}) {
    await this.stop()
    this.#state = GATEWAY_STATE.stopped
    return this.start(options)
  }

  /**
   * One serializable reading of everything the settings page shows.
   *
   * @param {object} [extra] - extra fields the caller already resolved
   *   (account list, model list), merged into the result.
   * @returns {object} the snapshot.
   */
  snapshot(extra = {}) {
    const settings = this.#settingsSource()
    // Report the paths the running child was actually launched with; before the
    // first start, resolve them so the page can show where they will point.
    const paths = this.#lastPaths ?? this.#paths()
    return {
      state: this.#state,
      running: this.#state === GATEWAY_STATE.running,
      baseUrl: this.#baseUrl,
      pid: this.#pid,
      startedAt: this.#startedAt,
      uptimeMs: this.#startedAt === null ? null : Date.now() - this.#startedAt,
      lastError: this.#lastError,
      lastExit: this.#lastExit,
      port: settings.port,
      gatewayDir: settings.gatewayDir,
      // Report the interpreter actually spawned, not the configured default:
      // those differ whenever the probe had to fall back, and the reading is
      // how an operator discovers what the plugin chose.
      pythonPath: this.#interpreter ?? (settings.pythonPath === '' ? `${pythonCandidates(process.platform)[0]} (resolved from PATH)` : settings.pythonPath),
      platform: process.platform,
      script: paths.script,
      accountStore: paths.accountsDir,
      usageStore: paths.usageDir,
      log: this.#log.map((entry) => ({ ...entry })),
      ...extra,
    }
  }

  // -- internals -------------------------------------------------------------

  /** Stream one child stream into the log ring, splitting on newlines. */
  #pipe(child, streamName) {
    const stream = child[streamName]
    if (stream === null || stream === undefined) return
    const reader = createInterface({ input: stream })
    reader.on('line', (line) => {
      // The bundled Python gateway writes its access log to stderr. A
      // successful HTTP status is routine traffic and must not be rendered as
      // an error just because of the stream it uses.
      const accessSuccess = /"[A-Z]+ \S+ HTTP\/\d(?:\.\d)?" [23]\d\d(?:\s|$)/.test(line)
      const level = streamName === 'stderr' && !accessSuccess ? 'error' : 'log'
      this.#append(level, line)
      this.#observe(line)
    })
  }

  /** Detect readiness from one output line. */
  #observe(line) {
    if (this.#state !== GATEWAY_STATE.starting) return
    const match = READY_PATTERN.exec(line)
    if (match === null) return
    this.#baseUrl = match[1]
    this.#settleReady(true, null)
  }

  /** Append to the bounded log ring. */
  #append(level, text) {
    this.#logSeq += 1
    this.#log.push({ seq: this.#logSeq, level, text, at: Date.now() })
    if (this.#log.length > LOG_LIMIT) this.#log.splice(0, this.#log.length - LOG_LIMIT)
  }

  /** Wait for the readiness signal, or time out. */
  #waitReady() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#clearReadyTimer()
        resolve({ ok: false, error: `gateway did not report readiness within ${READY_TIMEOUT_MS}ms` })
      }, READY_TIMEOUT_MS)
      this.#readyTimer = timer
      this.#readyWaiters.push(resolve)
    })
  }

  /** Resolve every pending readiness waiter exactly once. */
  #settleReady(ok, error) {
    this.#clearReadyTimer()
    const waiters = this.#readyWaiters
    this.#readyWaiters = []
    for (const resolve of waiters) resolve({ ok, error })
  }

  /** Clear the readiness timer if one is pending. */
  #clearReadyTimer() {
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer)
      this.#readyTimer = null
    }
  }

  /**
   * Fold a child exit into the state machine.
   *
   * The child is passed in rather than read from the field: a restart kills the
   * old process and spawns a new one, and the old process's exit event can land
   * *after* the new child is installed. Clearing the fields unconditionally
   * would strip the live child's pid from the reading.
   *
   * @param {object} child - the process this exit belongs to.
   * @param {number|null} code - exit code.
   * @param {string|null} signal - terminating signal.
   */
  #onExit(child, code, signal) {
    const isCurrent = child === this.#child
    this.#lastExit = { code, signal, at: Date.now() }
    const failedStart = this.#starting
    this.#starting = null
    if (isCurrent) {
      this.#child = null
      this.#pid = null
      this.#baseUrl = null
    }

    // An exit this plugin asked for is a stop; anything else is a failure the
    // settings page must show rather than hide behind a quiet "stopped".
    if (this.#stopping) {
      if (isCurrent) this.#state = GATEWAY_STATE.stopped
      this.#settleReady(false, 'stopped')
      return
    }

    this.#settleReady(false, 'process exited before readiness')
    if (isCurrent || failedStart !== null) {
      this.#state = GATEWAY_STATE.failed
      this.#lastError = `gateway exited (code ${String(code)}, signal ${String(signal)})`
      this.#append('error', this.#lastError)
    }
  }
}

/**
 * Derive the gateway's base URL for a configured port.
 * @param {number} port - listen port.
 * @returns {string} the OpenAI-compatible base URL.
 */
export function baseUrlFor(port) {
  return `http://127.0.0.1:${String(port)}/v1`
}

/** Read a message off an unknown thrown value. */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/** Exported for tests that need to assert the readiness grammar. */
export const __internals = { READY_PATTERN, PORT_PATTERN, READY_TIMEOUT_MS, LOG_LIMIT }
