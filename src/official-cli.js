/**
 * Official CodeBuddy print/stream-json transport over a DSH-owned subprocess.
 * Normal CLI login owns authentication. One child handles one user turn, then
 * stdin EOF lets the product flush its session and exit. Unknown managed ranges
 * stay owned and block replacement; this module never terminates a process.
 * @module dsh-plugin-workbuddy-gateway/official-cli
 */
import { randomUUID } from 'node:crypto'

/** Transport failure with independent process cleanup and cancellation facts. */
export class OfficialCliError extends Error {
  constructor(code, message, facts = {}) {
    super(message)
    this.name = 'OfficialCliError'
    this.code = code
    Object.assign(this, facts)
  }
}

const failure = (code, message) => new OfficialCliError(code, message)
const object = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const validSessionId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,511}$/.test(value)

/** Build the restricted official invocation; run() adds the fixed session-id or resume target. */
export function officialCliArgv({ nodePath, cliPath, model }) {
  if (![nodePath, cliPath, model].every(value => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('Official CLI requires executable, CLI path and selected model')
  }
  return [nodePath, cliPath, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--setting-sources', '', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep',
    '--strict-mcp-config', '--model', model]
}

/** Bound observation only; expiration never signals the managed process. */
async function bounded(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('EXIT_UNKNOWN', 'Official CLI exit could not be confirmed')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

/** Serial one-turn official CLI owner, using normal login and precise stream-json frames. */
export class OfficialCliClient {
  /** @param {object} options - DSH spawn, fixed base argv/cwd/env, and byte/time budgets. */
  constructor({ spawn, argv, cwd, env = {}, timeoutMs = 120_000, shutdownMs = 30_000,
    maxProtocolBytes = 8 * 1024 * 1024, maxOutputBytes = 1024 * 1024 }) {
    if (typeof spawn !== 'function' || !Array.isArray(argv) || !argv.length
      || !argv.every(value => typeof value === 'string') || typeof cwd !== 'string' || !cwd) {
      throw new TypeError('Official CLI requires spawn, argv and cwd')
    }
    for (const value of [timeoutMs, shutdownMs, maxProtocolBytes, maxOutputBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Official CLI budgets must be positive integers')
    }
    if (Object.entries(env).some(([key, value]) => value !== undefined && /token|secret|password|api.?key/i.test(key))) {
      throw new TypeError('Official CLI does not accept injected credentials')
    }
    const modelIndex = argv.lastIndexOf('--model')
    if (modelIndex < 0 || typeof argv[modelIndex + 1] !== 'string' || !argv[modelIndex + 1]) {
      throw new TypeError('Official CLI requires an explicit selected model')
    }
    this.expectedModel = argv[modelIndex + 1]
    this.options = { spawn, argv: [...argv], cwd, env: { ...env }, timeoutMs, shutdownMs, maxProtocolBytes, maxOutputBytes }
    this.state = 'idle'
    this.handle = undefined
    this.operation = undefined
  }

  /** @returns ownership facts only; no prompts, argv, account or diagnostic text. */
  snapshot() {
    return { state: this.state, phase: this.operation?.phase ?? this.state,
      cleanup: this.state === 'unknown' ? 'unknown' : this.state === 'idle' ? 'clean' : 'pending',
      pid: this.handle?.pid ?? null, retainedHandle: this.handle !== undefined,
      ...(this.operation ? { sessionId: this.operation.sessionId } : {}) }
  }

  /** Reobserve a retained range without launching, signalling or replaying anything. */
  async reconcileExit() {
    if (this.state !== 'unknown') return this.state === 'idle'
    if (!await this.close(this.operation)) return false
    this.state = 'idle'
    this.operation = undefined
    this.handle = undefined
    return true
  }

  /**
   * Run one turn using a new UUID or the exact existing official session.
   * onSession is awaited before any user frame, so storage failure sends no prompt.
   * @param {object} request - prompt, optional resume sessionId, signal and callbacks.
   * @returns {Promise<object>} current result text, model, session id and verified exit facts.
   */
  async run({ prompt, sessionId, signal, onSession, onChunk }) {
    if (this.state !== 'idle') throw failure(this.state === 'unknown' ? 'EXIT_UNKNOWN' : 'BUSY', 'Official CLI already has an owned operation')
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > this.options.maxProtocolBytes / 2) {
      throw failure('INVALID_INPUT', 'Official CLI prompt is empty or exceeds the input limit')
    }
    if (sessionId !== undefined && !validSessionId(sessionId)) throw failure('INVALID_INPUT', 'Invalid official CLI session id')
    if (signal?.aborted) throw failure('CANCELLED', 'Official CLI request was cancelled before starting')
    const operation = { sessionId: sessionId ?? randomUUID(), phase: 'initializing', pending: new Map(), nextId: 1,
      buffer: Buffer.alloc(0), protocolBytes: 0, outputBytes: 0, text: '', failure: undefined,
      promptSent: false, cancelling: false, confirmedCancelled: false }
    operation.failureNotice = new Promise(resolve => { operation.notifyFailure = resolve })
    this.operation = operation
    this.state = 'running'
    const abort = () => this.cancel()
    let timer, caught, result
    try {
      this.handle = this.options.spawn({ argv: [...this.options.argv, sessionId === undefined ? '--session-id' : '--resume', operation.sessionId],
        cwd: this.options.cwd, env: this.options.env, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: this.options.shutdownMs })
      const handle = this.handle
      if (!handle.stdin || !handle.stdout || !handle.stderr || typeof handle.waitForExit !== 'function') {
        throw failure('INVALID_HANDLE', 'Official CLI did not expose managed piped streams')
      }
      operation.stdin = handle.stdin
      handle.stdin.on('error', () => this.fail(operation, failure('TRANSPORT_ERROR', 'Official CLI input stream failed')))
      handle.stdout.on('data', chunk => this.read(operation, chunk, onChunk))
      handle.stderr.on('data', chunk => this.accountBytes(operation, chunk))
      handle.stdout.on('error', () => this.fail(operation, failure('TRANSPORT_ERROR', 'Official CLI output stream failed')))
      handle.stderr.on('error', () => this.fail(operation, failure('TRANSPORT_ERROR', 'Official CLI diagnostic stream failed')))
      handle.stdout.on('end', () => {
        if (!operation.result && (operation.promptSent || operation.pending.size)) {
          this.fail(operation, failure('TRANSPORT_ERROR', 'Official CLI closed its response stream before completion'))
        }
      })
      operation.done = Promise.resolve(handle.done).then(outcome => {
        operation.outcome = outcome
        if (!operation.result && (operation.promptSent || operation.pending.size)) {
          this.fail(operation, failure('PROCESS_EXITED', 'Official CLI exited before completing its response'))
        }
        return outcome
      }, () => { this.fail(operation, failure('PROCESS_ERROR', 'Official CLI process observation failed')) })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      timer = setTimeout(() => this.fail(operation, failure('TIMEOUT', 'Official CLI request exceeded its time budget')), this.options.timeoutMs)
      // The official response includes account.token. Keep no response/account
      // reference after initialization and never expose it through diagnostics.
      const initializedModel = await this.control(operation, { subtype: 'initialize', hasPrompt: true })
        .then(value => object(value) ? value.currentModelId : undefined)
      if (typeof initializedModel !== 'string') throw failure('MODEL_UNCONFIRMED', 'Official CLI did not confirm the selected model before prompting')
      if (initializedModel !== this.expectedModel) throw failure('MODEL_MISMATCH', 'Official CLI selected a different model before prompting')
      operation.phase = 'opening-session'
      if (onSession) {
        try { await this.guard(operation, Promise.resolve().then(() => onSession(operation.sessionId))) }
        catch (error) { throw operation.failure ?? failure('SESSION_PERSISTENCE_FAILED', 'Official CLI session could not be saved before prompting') }
      }
      if (operation.failure) throw operation.failure
      operation.phase = 'prompting'
      const completion = new Promise(resolve => { operation.resolveResult = resolve })
      operation.promptSent = true
      this.send(operation, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        session_id: operation.sessionId, parent_tool_use_id: null })
      result = await this.guard(operation, completion)
      if (operation.cancelResponse) await this.guard(operation, operation.cancelResponse)
      if (operation.cancelling || /^aborted_/.test(result.terminal_reason ?? '')) {
        operation.confirmedCancelled = /^aborted_/.test(result.terminal_reason ?? '') || operation.interruptAcknowledged === true
        throw failure('CANCELLED', 'Official CLI request was cancelled')
      }
      if (result.subtype !== 'success' || result.is_error !== false || typeof result.result !== 'string') {
        throw failure('REMOTE_ERROR', 'Official CodeBuddy did not complete the requested turn')
      }
      if (operation.model !== this.expectedModel) throw failure('MODEL_UNCONFIRMED', 'Official CLI did not confirm the selected model')
      if (Buffer.byteLength(result.result) > this.options.maxOutputBytes) throw failure('OUTPUT_LIMIT', 'Official CLI exceeded its final result limit')
    } catch (error) {
      caught = error instanceof OfficialCliError ? error : failure('TRANSPORT_ERROR', 'Official CLI transport failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    if (operation.failure) caught = operation.failure
    if (caught && operation.promptSent && !operation.result && !operation.cancelling) this.cancel()
    const clean = await this.close(operation)
    if (!caught && operation.failure) caught = operation.failure
    const facts = { sessionId: operation.sessionId, partialText: operation.text,
      confirmedCancelled: operation.confirmedCancelled, stopReason: operation.result?.terminal_reason,
      exit: operation.outcome, promptSent: operation.promptSent }
    if (!clean) {
      this.state = 'unknown'
      throw new OfficialCliError(caught?.code ?? 'EXIT_UNKNOWN', caught?.message ?? 'Official CLI exit could not be confirmed', { ...facts, cleanup: 'unknown' })
    }
    this.state = 'idle'
    this.handle = undefined
    this.operation = undefined
    if (caught) throw new OfficialCliError(caught.code, caught.message, { ...facts, cleanup: 'clean' })
    if (operation.outcome?.exitCode !== 0 || operation.outcome?.signal !== null) {
      throw new OfficialCliError('PROCESS_EXITED', 'Official CLI did not exit normally', { ...facts, cleanup: 'clean' })
    }
    return { sessionId: operation.sessionId, text: result.result, stopReason: 'end_turn',
      model: operation.model, exit: operation.outcome, cleanExit: true }
  }

  /** Request the official interrupt control, never provider termination. */
  cancel() {
    const operation = this.operation
    if (!operation || this.state !== 'running') return false
    if (!operation.promptSent) {
      this.fail(operation, failure('CANCELLED', 'Official CLI request was cancelled before prompting'))
      return true
    }
    if (operation.cancelling || operation.result) return false
    operation.cancelling = true
    operation.phase = 'cancelling'
    operation.cancelResponse = this.control(operation, { subtype: 'interrupt', session_id: operation.sessionId, reason: 'user' })
      .then(value => {
        if (!object(value) || value.session_id !== operation.sessionId || value.interrupted !== true) {
          throw failure('PROTOCOL_ERROR', 'Official CLI did not confirm interruption of its owned session')
        }
        operation.interruptAcknowledged = true
      }).catch(error => { this.fail(operation, error instanceof OfficialCliError ? error : failure('TRANSPORT_ERROR', 'Official CLI interruption failed')) })
    return true
  }

  /** Close stdin and verify the full managed range; observation timeout preserves ownership. */
  async close(operation) {
    if (!this.handle) return true
    operation.phase = 'closing'
    if (this.handle.stdin && !this.handle.stdin.writableEnded && !this.handle.stdin.destroyed) this.handle.stdin.end()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.shutdownMs)
    try {
      if (!await bounded(this.handle.waitForExit(controller.signal), this.options.shutdownMs)) return false
      await bounded(operation.done ?? this.handle.done, this.options.shutdownMs)
      return true
    } catch (error) {
      // Failed managed-range observation never authorizes a replacement child.
      return false
    } finally { clearTimeout(timer) }
  }

  /** Race a protocol/persistence operation against the one owned failure notification. */
  guard(operation, promise) {
    return Promise.race([promise, operation.failureNotice.then(error => { throw error })])
  }

  /** Fail waiters without discarding the owned handle or raw stderr into a message. */
  fail(operation, error) {
    if (operation.failure) return
    operation.failure = error
    operation.notifyFailure(error)
    for (const pending of operation.pending.values()) pending.reject(error)
    operation.pending.clear()
    // Deadlines still ask the product to cancel; its reply is no longer awaited
    // as a success. EOF plus managed-range observation follows in run().
    if (operation.promptSent && !operation.result && !operation.cancelling) {
      operation.cancelling = true
      this.send(operation, { type: 'control_request', request_id: `cancel-${operation.nextId++}`,
        request: { subtype: 'interrupt', session_id: operation.sessionId, reason: 'transport-stopped' } })
    }
  }

  /** Issue only supported official stream-json controls. */
  control(operation, request) {
    if (operation.failure) return Promise.reject(operation.failure)
    const requestId = `dsh-${operation.nextId++}`
    return new Promise((resolve, reject) => {
      operation.pending.set(requestId, { resolve, reject })
      this.send(operation, { type: 'control_request', request_id: requestId, request })
    })
  }

  /** Bounded writes; no user input is placed in a shell command or process argv. */
  send(operation, message) {
    if (!operation.stdin || operation.stdin.destroyed || operation.stdin.writableEnded) {
      this.fail(operation, failure('TRANSPORT_ERROR', 'Official CLI input is closed'))
      return
    }
    const encoded = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(encoded) > this.options.maxProtocolBytes) {
      this.fail(operation, failure('PROTOCOL_LIMIT', 'Official CLI outbound message exceeds its limit'))
      return
    }
    try { operation.stdin.write(encoded) }
    catch (error) { this.fail(operation, failure('TRANSPORT_ERROR', 'Official CLI input write failed')) }
  }

  /** Drain both streams with a whole-operation cap, retaining no stderr content. */
  accountBytes(operation, chunk) {
    if (operation.failure) return false
    operation.protocolBytes += Buffer.byteLength(chunk)
    if (operation.protocolBytes > this.options.maxProtocolBytes) {
      this.fail(operation, failure('PROTOCOL_LIMIT', 'Official CLI exceeded its protocol byte limit'))
      return false
    }
    return true
  }

  /** Decode bounded UTF-8 NDJSON lines from the official process only. */
  read(operation, chunk, onChunk) {
    if (!this.accountBytes(operation, chunk)) return
    operation.buffer = Buffer.concat([operation.buffer, Buffer.from(chunk)])
    let newline
    while ((newline = operation.buffer.indexOf(10)) !== -1 && !operation.failure) {
      const line = operation.buffer.subarray(0, newline)
      operation.buffer = operation.buffer.subarray(newline + 1)
      if (!line.length) continue
      try { this.message(operation, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)), onChunk) }
      catch (error) { this.fail(operation, error instanceof OfficialCliError ? error : failure('PROTOCOL_ERROR', 'Official CLI sent invalid stream-json data')) }
    }
  }

  /** Validate the exact official control/user-output envelopes; account payloads are never retained. */
  message(operation, message, onChunk) {
    if (!object(message) || typeof message.type !== 'string') throw failure('PROTOCOL_ERROR', 'Official CLI sent an invalid stream-json envelope')
    if (message.type === 'control_response') {
      const response = message.response
      const pending = object(response) && operation.pending.get(response.request_id)
      if (!pending || !['success', 'error'].includes(response.subtype)) throw failure('PROTOCOL_ERROR', 'Official CLI returned an unmatched control response')
      operation.pending.delete(response.request_id)
      if (response.subtype === 'error') {
        const auth = typeof response.error === 'string' && /authentication required|not authenticated|login required/i.test(response.error)
        pending.reject(failure(auth ? 'AUTH_REQUIRED' : 'REMOTE_ERROR', auth
          ? 'Sign in through the official domestic CodeBuddy CLI before using this integration'
          : 'Official CodeBuddy rejected the control request'))
      } else pending.resolve(response.response)
      return
    }
    if (message.type === 'control_request') {
      if (typeof message.request_id !== 'string' || !object(message.request)) throw failure('PROTOCOL_ERROR', 'Official CLI sent an invalid approval request')
      this.send(operation, { type: 'control_response', response: message.request.subtype === 'can_use_tool'
        ? { subtype: 'success', request_id: message.request_id, response: { allowed: false, reason: 'Tool approval is not granted by this integration' } }
        : { subtype: 'error', request_id: message.request_id, error: 'Client capability is not available' } })
      return
    }
    if (message.session_id !== undefined && message.session_id !== operation.sessionId) {
      throw failure('PROTOCOL_ERROR', 'Official CLI output does not match the owned session')
    }
    if (message.type === 'system' && message.subtype === 'init') {
      if (operation.promptSent) {
        if (message.model !== this.expectedModel) throw failure('MODEL_MISMATCH', 'Official CLI is not using the selected model')
        operation.model = message.model
      }
      return
    }
    if (!operation.promptSent || operation.result) return
    if (message.type === 'assistant') {
      if (!object(message.message) || !Array.isArray(message.message.content)) throw failure('PROTOCOL_ERROR', 'Official CLI sent invalid assistant content')
      const text = message.message.content.filter(part => object(part) && part.type === 'text')
        .map(part => {
          if (typeof part.text !== 'string') throw failure('PROTOCOL_ERROR', 'Official CLI sent invalid assistant text')
          return part.text
        }).join('')
      operation.outputBytes += Buffer.byteLength(text)
      if (operation.outputBytes > this.options.maxOutputBytes) throw failure('OUTPUT_LIMIT', 'Official CLI exceeded its assistant output limit')
      operation.text += text
      if (text && onChunk) {
        try { onChunk(text) } catch (error) { throw failure('OBSERVER_FAILED', 'Official CLI text observer failed') }
      }
    } else if (message.type === 'result') {
      if (message.session_id !== operation.sessionId || typeof message.subtype !== 'string' || typeof message.is_error !== 'boolean') {
        throw failure('PROTOCOL_ERROR', 'Official CLI returned an invalid terminal result')
      }
      operation.result = { subtype: message.subtype, is_error: message.is_error, result: message.result,
        terminal_reason: message.terminal_reason }
      operation.resolveResult(operation.result)
    }
  }
}
