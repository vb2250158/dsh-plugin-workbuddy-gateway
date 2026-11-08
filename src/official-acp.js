/**
 * Official CodeBuddy ACP transport over a DSH-owned subprocess. Authentication
 * belongs to the CLI's normal login; this transport never copies credentials.
 * Each run closes stdin and verifies the whole managed range has exited. An
 * unknown shutdown retains the handle and blocks a replacement process.
 * @module dsh-plugin-workbuddy-gateway/official-acp
 */

/** Structured transport failure; cleanup reports process ownership independently. */
export class OfficialAcpError extends Error {
  constructor(code, message, facts = {}) {
    super(message)
    this.name = 'OfficialAcpError'
    this.code = code
    Object.assign(this, facts)
  }
}

/** Build the restricted official CLI invocation; paths and selected model are caller-owned. */
export function officialAcpArgv({ nodePath, cliPath, model }) {
  if (![nodePath, cliPath, model].every(value => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('Official ACP requires executable, CLI path and selected model')
  }
  return [nodePath, cliPath, '--acp', '--setting-sources', '', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--model', model]
}

const error = (code, message) => new OfficialAcpError(code, message)
const object = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const sessionIdValid = value => typeof value === 'string' && value.length > 0 && value.length <= 512

/** Await without signalling or terminating the subprocess when the observation budget expires. */
async function bounded(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(error('EXIT_UNKNOWN', 'Official CLI exit could not be confirmed')), milliseconds)
    })])
  } finally {
    clearTimeout(timer)
  }
}

/** One owner of serial, restricted ACP runs over injected SubprocessHandles. */
export class OfficialAcpClient {
  /**
   * @param {object} options - injected DSH spawn, explicit argv/cwd/env, and byte/time budgets.
   * No spawn signal is passed: caller cancellation uses ACP, not provider termination.
   */
  constructor({ spawn, argv, cwd, env = {}, timeoutMs = 120_000, shutdownMs = 10_000,
    maxProtocolBytes = 8 * 1024 * 1024, maxOutputBytes = 1024 * 1024 }) {
    if (typeof spawn !== 'function' || !Array.isArray(argv) || argv.length === 0
      || !argv.every(value => typeof value === 'string') || typeof cwd !== 'string' || !cwd) {
      throw new TypeError('Official ACP requires spawn, argv and cwd')
    }
    for (const value of [timeoutMs, shutdownMs, maxProtocolBytes, maxOutputBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Official ACP budgets must be positive integers')
    }
    if (Object.entries(env).some(([key, value]) => value !== undefined && /token|secret|password|api.?key/i.test(key))) {
      throw new TypeError('Official ACP does not accept injected credentials')
    }
    this.options = { spawn, argv: [...argv], cwd, env: { ...env }, timeoutMs, shutdownMs, maxProtocolBytes, maxOutputBytes }
    this.handle = undefined
    this.state = 'idle'
    this.operation = undefined
  }

  /** @returns non-sensitive ownership facts; never includes argv, prompts, stdout or credentials. */
  snapshot() {
    return { state: this.state, phase: this.operation?.phase ?? this.state, cleanup: this.state === 'unknown' ? 'unknown' : this.state === 'idle' ? 'clean' : 'pending', pid: this.handle?.pid ?? null, retainedHandle: this.handle !== undefined,
      ...(this.operation?.sessionId ? { sessionId: this.operation.sessionId } : {}) }
  }

  /** Recheck an unknown retained managed range without starting or stopping anything. */
  async reconcileExit() {
    if (this.state !== 'unknown') return this.state === 'idle'
    const clean = await this.close(this.operation)
    if (clean) {
      this.handle = undefined
      this.operation = undefined
      this.state = 'idle'
    }
    return clean
  }

  /**
   * Run a new session, or load the supplied official CLI session before prompting.
   * @param {object} request - prompt, optional existing sessionId, cancellation and text observer.
   * @returns {Promise<object>} text, official sessionId, stopReason and confirmed exit facts.
   * Throws with cleanup=unknown when a retained process must be reconciled first.
   */
  async run({ prompt, sessionId, signal, onChunk, onSession }) {
    if (this.state !== 'idle') throw error(this.state === 'unknown' ? 'EXIT_UNKNOWN' : 'BUSY', 'Official CLI already has an owned operation')
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > this.options.maxProtocolBytes / 2) {
      throw error('INVALID_INPUT', 'Official CLI prompt is empty or exceeds the input limit')
    }
    if (sessionId !== undefined && !sessionIdValid(sessionId)) throw error('INVALID_INPUT', 'Invalid official CLI session id')
    if (signal?.aborted) throw error('CANCELLED', 'Official CLI request was cancelled before starting')
    const operation = { pending: new Map(), nextId: 1, sessionId, text: '', outputBytes: 0,
      protocolBytes: 0, buffer: Buffer.alloc(0), failure: undefined, cancelling: false, phase: 'initializing' }
    operation.failureNotice = new Promise(resolve => { operation.notifyFailure = resolve })
    this.state = 'running'
    this.operation = operation
    let value, failure, timer
    const abort = () => {
      if (operation.phase === 'prompting' || operation.phase === 'cancelling') this.cancelOperation(operation)
      else this.fail(operation, error('CANCELLED', 'Official CLI request was cancelled'))
    }
    try {
      this.handle = this.options.spawn({ argv: this.options.argv, cwd: this.options.cwd,
        env: this.options.env, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: this.options.shutdownMs })
      const handle = this.handle
      if (!handle.stdin || !handle.stdout || !handle.stderr || typeof handle.waitForExit !== 'function') {
        throw error('INVALID_HANDLE', 'Official CLI did not expose managed piped streams')
      }
      operation.stdin = handle.stdin
      handle.stdin.on('error', () => this.fail(operation, error('TRANSPORT_ERROR', 'Official CLI input stream failed')))
      handle.stdout.on('data', chunk => this.read(operation, chunk, onChunk))
      handle.stderr.on('data', chunk => this.accountBytes(operation, chunk))
      handle.stdout.on('error', () => this.fail(operation, error('TRANSPORT_ERROR', 'Official CLI output stream failed')))
      handle.stderr.on('error', () => this.fail(operation, error('TRANSPORT_ERROR', 'Official CLI diagnostic stream failed')))
      handle.stdout.on('end', () => {
        if (operation.pending.size) this.fail(operation, error('TRANSPORT_ERROR', 'Official CLI closed its response stream before completion'))
      })
      // Observe rejection immediately; a spawn failure may precede initialize.
      operation.done = Promise.resolve(handle.done).then(outcome => {
        operation.outcome = outcome
        if (operation.pending.size) this.fail(operation, error('PROCESS_EXITED', 'Official CLI exited before its ACP response'))
        return outcome
      }, () => {
        this.fail(operation, error('PROCESS_ERROR', 'Official CLI process observation failed'))
        return undefined
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      timer = setTimeout(() => this.fail(operation, error('TIMEOUT', 'Official CLI request exceeded its time budget')), this.options.timeoutMs)
      const initialized = await this.request(operation, 'initialize', { protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: 'dsh-official-codebuddy', version: '1' } })
      if (!object(initialized) || initialized.protocolVersion !== 1) throw error('PROTOCOL_ERROR', 'Official CLI did not accept ACP version 1')
      operation.phase = 'opening-session'
      if (sessionId !== undefined) {
        if (initialized.agentCapabilities?.loadSession !== true) throw error('LOAD_UNSUPPORTED', 'Official CLI cannot load an existing session')
        await this.request(operation, 'session/load', { sessionId, cwd: this.options.cwd, mcpServers: [] })
      } else {
        const created = await this.request(operation, 'session/new', { cwd: this.options.cwd, mcpServers: [] })
        if (!object(created) || !sessionIdValid(created.sessionId)) throw error('PROTOCOL_ERROR', 'Official CLI returned an invalid session id')
        operation.sessionId = created.sessionId
      }
      if (onSession) {
        try {
          await Promise.race([Promise.resolve().then(() => onSession(operation.sessionId)),
            operation.failureNotice.then(failure => { throw failure })])
        } catch (caught) {
          throw operation.failure ?? error('SESSION_PERSISTENCE_FAILED', 'Official CLI session could not be saved before prompting')
        }
      }
      if (operation.failure) throw operation.failure
      operation.phase = 'prompting'
      const result = await this.request(operation, 'session/prompt', { sessionId: operation.sessionId,
        prompt: [{ type: 'text', text: prompt }] })
      if (!object(result) || typeof result.stopReason !== 'string') throw error('PROTOCOL_ERROR', 'Official CLI returned no stop reason')
      operation.stopReason = result.stopReason
      operation.confirmedCancelled = result.stopReason === 'cancelled'
      if (operation.cancelling || result.stopReason === 'cancelled') throw error('CANCELLED', 'Official CLI request was cancelled')
      if (result.stopReason !== 'end_turn') throw error('INCOMPLETE', 'Official CLI did not complete the requested turn')
      value = { sessionId: operation.sessionId, text: operation.text, stopReason: result.stopReason }
    } catch (caught) {
      failure = caught instanceof OfficialAcpError ? caught : error('TRANSPORT_ERROR', 'Official CLI transport failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    if (operation.failure) failure = operation.failure
    if (failure && operation.sessionId) this.cancelOperation(operation)
    const clean = await this.close(operation)
    if (!failure && operation.failure) failure = operation.failure
    const failureFacts = { sessionId: operation.sessionId, partialText: operation.text,
      confirmedCancelled: operation.confirmedCancelled === true, stopReason: operation.stopReason }
    if (!clean) {
      this.state = 'unknown'
      throw new OfficialAcpError(failure?.code ?? 'EXIT_UNKNOWN', failure?.message ?? 'Official CLI exit could not be confirmed',
        { ...failureFacts, cleanup: 'unknown' })
    }
    this.handle = undefined
    this.operation = undefined
    this.state = 'idle'
    if (failure) throw new OfficialAcpError(failure.code, failure.message, { ...failureFacts, cleanup: 'clean' })
    if (operation.outcome?.exitCode !== 0 || operation.outcome?.signal !== null) {
      throw new OfficialAcpError('PROCESS_EXITED', 'Official CLI did not exit normally', { ...failureFacts, cleanup: 'clean' })
    }
    return { ...value, exit: operation.outcome, cleanExit: true }
  }

  /** Stop all request waiters while retaining process ownership until verified shutdown. */
  fail(operation, failure) {
    if (operation.failure) return
    operation.failure = failure
    operation.notifyFailure(failure)
    for (const { reject } of operation.pending.values()) reject(failure)
    operation.pending.clear()
    this.cancelOperation(operation)
  }

  /** Request cancellation of this owner's current turn, without terminating its process. */
  cancel() {
    if (!this.operation || this.state !== 'running') return false
    if (this.operation.phase === 'prompting' || this.operation.phase === 'cancelling') this.cancelOperation(this.operation)
    else this.fail(this.operation, error('CANCELLED', 'Official CLI request was cancelled'))
    return true
  }

  /** Send the supported cancellation notification once; never signal or kill a process. */
  cancelOperation(operation) {
    if (!operation.sessionId || operation.cancelling || !operation.stdin || operation.stdin.writableEnded) return
    operation.cancelling = true
    operation.phase = 'cancelling'
    this.send(operation, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: operation.sessionId } })
  }

  /** EOF is the normal disposal path; an unobserved range remains owned. */
  async close(operation) {
    if (!this.handle) return true
    operation.phase = 'closing'
    if (this.handle.stdin && !this.handle.stdin.writableEnded && !this.handle.stdin.destroyed) this.handle.stdin.end()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.shutdownMs)
    try {
      const empty = await bounded(this.handle.waitForExit(controller.signal), this.options.shutdownMs)
      if (!empty) return false
      await bounded(operation.done ?? this.handle.done, this.options.shutdownMs)
      return true
    } catch (caught) {
      // A failed observation cannot authorize a replacement process.
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** JSON-RPC request ids and pending promises belong to this one process. */
  request(operation, method, params) {
    if (operation.failure) return Promise.reject(operation.failure)
    const id = operation.nextId++
    return new Promise((resolve, reject) => {
      operation.pending.set(id, { resolve, reject })
      this.send(operation, { jsonrpc: '2.0', id, method, params })
    })
  }

  /** Writes are bounded and never include credentials or raw diagnostics in errors. */
  send(operation, message) {
    if (!operation.stdin || operation.stdin.destroyed || operation.stdin.writableEnded) {
      this.fail(operation, error('TRANSPORT_ERROR', 'Official CLI input is closed'))
      return
    }
    const encoded = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(encoded) > this.options.maxProtocolBytes) {
      this.fail(operation, error('PROTOCOL_LIMIT', 'Official CLI outbound message exceeds the protocol limit'))
      return
    }
    try {
      operation.stdin.write(encoded)
    } catch (caught) {
      this.fail(operation, error('TRANSPORT_ERROR', 'Official CLI input write failed'))
    }
  }

  /** Drain both streams with a shared whole-operation byte cap. */
  accountBytes(operation, chunk) {
    if (operation.failure) return false
    operation.protocolBytes += Buffer.byteLength(chunk)
    if (operation.protocolBytes > this.options.maxProtocolBytes) {
      this.fail(operation, error('PROTOCOL_LIMIT', 'Official CLI exceeded its protocol byte limit'))
      return false
    }
    return true
  }

  /** Decode bounded NDJSON records; no filesystem or terminal client capability is advertised. */
  read(operation, chunk, onChunk) {
    if (!this.accountBytes(operation, chunk)) return
    operation.buffer = Buffer.concat([operation.buffer, Buffer.from(chunk)])
    let newline
    while ((newline = operation.buffer.indexOf(10)) !== -1 && !operation.failure) {
      const line = operation.buffer.subarray(0, newline)
      operation.buffer = operation.buffer.subarray(newline + 1)
      if (line.length === 0) continue
      try {
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
        this.message(operation, message, onChunk)
      } catch (caught) {
        this.fail(operation, caught instanceof OfficialAcpError ? caught : error('PROTOCOL_ERROR', 'Official CLI sent invalid ACP data'))
      }
    }
  }

  /** Validate wire records before matching responses or accepting session output. */
  message(operation, message, onChunk) {
    if (!object(message) || message.jsonrpc !== '2.0') throw error('PROTOCOL_ERROR', 'Official CLI sent an invalid RPC envelope')
    if (typeof message.method === 'string') {
      if ('id' in message) {
        if (message.method === 'session/request_permission') {
          const options = message.params?.options
          const rejected = Array.isArray(options) && options.find(option => object(option)
            && ['reject_once', 'reject_always'].includes(option.kind) && typeof option.optionId === 'string')
          this.send(operation, { jsonrpc: '2.0', id: message.id, result: {
            outcome: rejected ? { outcome: 'selected', optionId: rejected.optionId } : { outcome: 'cancelled' },
          } })
        } else {
          this.send(operation, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability is not available' } })
        }
        return
      }
      if (message.method !== 'session/update') return
      if (!object(message.params) || message.params.sessionId !== operation.sessionId || !object(message.params.update)) {
        throw error('PROTOCOL_ERROR', 'Official CLI update does not match the owned session')
      }
      const update = message.params.update
      if (operation.phase !== 'prompting' || update.sessionUpdate !== 'agent_message_chunk') return
      if (!object(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string') {
        throw error('PROTOCOL_ERROR', 'Official CLI returned unsupported assistant content')
      }
      operation.outputBytes += Buffer.byteLength(update.content.text)
      if (operation.outputBytes > this.options.maxOutputBytes) throw error('OUTPUT_LIMIT', 'Official CLI exceeded its assistant output limit')
      operation.text += update.content.text
      if (onChunk) {
        try { onChunk(update.content.text) } catch (caught) {
          throw error('OBSERVER_FAILED', 'Official CLI text observer failed')
        }
      }
      return
    }
    const pending = operation.pending.get(message.id)
    if (!pending || ('result' in message) === ('error' in message)) throw error('PROTOCOL_ERROR', 'Official CLI returned an unmatched ACP response')
    operation.pending.delete(message.id)
    if ('error' in message) {
      const code = object(message.error) ? message.error.code : undefined
      const denied = code === -32000 || /authentication required|not authenticated|login required/i.test(message.error?.message ?? '')
      pending.reject(error(denied ? 'AUTH_REQUIRED' : 'REMOTE_ERROR', denied
        ? 'Sign in through the official domestic CodeBuddy CLI before using this integration'
        : 'Official CodeBuddy rejected the ACP request'))
      return
    }
    pending.resolve(message.result)
  }
}
