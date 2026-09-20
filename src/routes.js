/**
 * HTTP surface of the WorkBuddy gateway plugin.
 *
 * One prefix route base carries every endpoint the settings page calls. Reads
 * are open to the local page; every route that changes state additionally
 * requires a same-origin request.
 *
 * All successful responses share the `{ ok: true, data }` envelope and all
 * failures `{ ok: false, error: { code, message } }`, matching the other
 * community plugins on this host.
 *
 * @module dsh-plugin-workbuddy-gateway/routes
 */

import { messageOf, methodNotAllowed, readJsonBody, refuseOrigin, sameOrigin, sendJson } from './http.js'
import { API_KEY_REF, ROUTE_BASE } from './settings.js'

/** How long one gateway read may take before the page is told it timed out. */
const GATEWAY_TIMEOUT_MS = 20_000

/**
 * Register every route.
 *
 * @param {object} ctx - host context carrying `webServer`.
 * @param {object} deps - collaborators, injected for testability.
 * @param {object} deps.gateway - the supervisor (see `gateway.js`).
 * @param {() => object} deps.settings - current normalized settings.
 * @param {(patch: object) => Promise<void>} deps.updateSettings - persist a settings patch.
 * @param {() => object|undefined} deps.credentials - reads the DSH credential
 *   service. A getter, not a value: this plugin mounts before every service it
 *   uses has activated, so a captured handle would be permanently `undefined`.
 * @param {(models: object[]|null) => Promise<object>} deps.syncProvider - write/remove the llm-pi-ai route.
 * @param {() => object} deps.providerState - describe the current route without changing it.
 * @returns {Array<Function>} one disposer per route.
 */
export function mount(ctx, deps) {
  const { gateway, settings, updateSettings, credentials: credentialsOf, syncProvider, providerState } = deps

  /** Current bearer token: stored under the credential ref, else the environment. */
  const apiKeyOf = async () => {
    const credentials = credentialsOf()
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(API_KEY_REF)
      if (resolved !== undefined && resolved.value !== '') return resolved.value
    }
    const ambient = process.env[API_KEY_REF]
    return ambient !== undefined && ambient !== '' ? ambient : null
  }

  /** Call one gateway endpoint, returning parsed JSON. */
  const callGateway = async (route, { method = 'GET', body, timeoutMs = GATEWAY_TIMEOUT_MS } = {}) => {
    const base = gateway.baseUrl
    if (base === null) throw new Error('gateway is not running')
    const key = await apiKeyOf()
    const url = `${base.replace(/\/v1$/, '')}${route}`
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          ...key === null ? {} : { authorization: `Bearer ${key}` },
          ...body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
      const text = await response.text()
      let parsed = null
      try {
        parsed = text === '' ? null : JSON.parse(text)
      } catch {
        throw new Error(`gateway returned non-JSON (HTTP ${String(response.status)})`)
      }
      if (!response.ok) {
        const detail = parsed?.error?.message ?? parsed?.msg ?? text.slice(0, 200)
        throw new Error(`HTTP ${String(response.status)}: ${detail}`)
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }

  /** Best-effort read that degrades to an error string instead of failing the snapshot. */
  const tryGateway = async (route, options) => {
    try {
      return { value: await callGateway(route, options), error: null }
    } catch (error) {
      return { value: null, error: messageOf(error) }
    }
  }

  /**
   * How many accounts in a listing can actually serve a request.
   *
   * Derived from the listing rather than taken from the gateway's own `usable`
   * field, because that field is counted across every realm while the listing is
   * filtered to one. Mixing them produced a panel reading "2 usable of 1".
   */
  const usableIn = (accounts) => accounts.filter((account) => (
    account.enabled !== false
    && account.inCooldown !== true
    && (account.lastError === undefined || account.lastError === null || account.lastError === '')
  )).length

  /**
   * Build the full page reading.
   *
   * Account and model lists live inside the gateway, so they exist only while it
   * is serving; a stopped gateway reports empty lists plus the reason rather
   * than failing the whole snapshot.
   */
  const snapshot = async () => {
    const gatewayReading = gateway.snapshot()
    const provider = providerState()
    const settingsNow = settings()
    const settingsReading = { ...settingsNow, keyConfigured: await apiKeyOf() !== null }
    // The realm is part of the request, not just a label: the gateway filters
    // its listing by it, so omitting it would show whichever realm the gateway
    // happened to have active rather than the one the plugin is configured for.
    const realmQuery = settingsNow.realm === null ? '' : `?realm=${encodeURIComponent(settingsNow.realm)}`
    if (!gateway.running) {
      return {
        gateway: gatewayReading,
        settings: settingsReading,
        account: { accounts: [], usable: 0, storage: gatewayReading.accountStore },
        models: [],
        modelsRealm: null,
        activeRealm: null,
        provider,
        reads: { accounts: 'gateway not running', models: 'gateway not running', realm: 'gateway not running' },
      }
    }
    const [accounts, models, realm] = await Promise.all([
      tryGateway(`/accounts${realmQuery}`),
      tryGateway(`/v1/models${realmQuery}`),
      tryGateway('/realm'),
    ])
    const listed = Array.isArray(accounts.value?.accounts) ? accounts.value.accounts : []
    return {
      gateway: gateway.snapshot(),
      settings: settingsReading,
      account: {
        accounts: listed,
        usable: usableIn(listed),
        storage: accounts.value?.storage ?? gatewayReading.accountStore,
      },
      models: Array.isArray(models.value?.data) ? models.value.data : [],
      modelsRealm: models.value?.realm ?? null,
      activeRealm: realm.value?.current ?? null,
      provider,
      reads: { accounts: accounts.error, models: models.error, realm: realm.error },
    }
  }

  /** Reject a bad request payload with a 400 rather than a 500. */
  const invalid = (message) => {
    const error = new Error(message)
    error.code = 'invalid-input'
    return error
  }

  /**
   * Wrap one handler in the envelope, the verb check, the same-origin guard for
   * mutations, and the error mapping.
   */
  const route = (methods, { mutating = false, handler }) => ({
    async handle(request, response) {
      const method = request.method ?? 'GET'
      if (!methods.includes(method)) {
        methodNotAllowed(response, methods.join(', '))
        return
      }
      if (mutating && !sameOrigin(request)) {
        refuseOrigin(response)
        return
      }
      try {
        const body = mutating && method !== 'GET' ? await readJsonBody(request) : {}
        const data = await handler(body, request)
        sendJson(response, 200, { ok: true, data })
      } catch (error) {
        const badInput = error?.code === 'invalid-input'
        sendJson(response, badInput ? 400 : 500, {
          ok: false,
          error: { code: badInput ? 'invalid-input' : 'internal', message: messageOf(error) },
        })
      }
    },
  })

  /**
   * One entry per endpoint. `poll` is flagged because its URL carries a query
   * string, and an exact WebRoute matches the pathname verbatim — that one has
   * to be registered as a prefix or the gateway's own state parameter never
   * reaches the handler.
   */
  const routes = [
    ['/health', false, route(['GET'], {
      handler: () => ({
        ok: true,
        plugin: { version: '0.2.3', routeBase: ROUTE_BASE },
        gateway: gateway.snapshot(),
      }),
    })],

    ['/state', false, route(['GET'], { handler: () => snapshot() })],

    ['/config', false, route(['POST'], {
      mutating: true,
      handler: async (body) => {
        const patch = {}
        if (body.port !== undefined) {
          const port = Number(body.port)
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('port must be an integer 1-65535')
          patch.port = port
        }
        if (body.autoStart !== undefined) patch.autoStart = body.autoStart === true
        if (body.providerSync !== undefined) patch.providerSync = body.providerSync === true
        if (body.gatewayDir !== undefined) {
          if (typeof body.gatewayDir !== 'string' || body.gatewayDir.trim() === '') {
            throw invalid('gatewayDir must be a non-empty path')
          }
          patch.gatewayDir = body.gatewayDir.trim()
        }
        if (body.pythonPath !== undefined) {
          if (typeof body.pythonPath !== 'string') throw invalid('pythonPath must be a string')
          patch.pythonPath = body.pythonPath.trim()
        }
        if (body.realm !== undefined) {
          if (body.realm !== null && body.realm !== 'intl' && body.realm !== 'cn') {
            throw invalid('realm must be intl, cn, or null')
          }
          patch.realm = body.realm
        }
        if (Object.keys(patch).length === 0) throw invalid('no recognized settings key in the request body')
        if (patch.realm !== undefined && patch.realm !== null && gateway.running) {
          const result = await callGateway('/realm', { method: 'POST', body: { realm: patch.realm } })
          if (result?.current !== patch.realm) throw new Error('gateway did not confirm the requested realm')
        }
        await updateSettings(patch)
        if (patch.realm !== undefined || patch.providerSync === true) {
          const reading = await snapshot()
          if (gateway.running && settings().providerSync) {
            if (reading.reads.models !== null) throw new Error(reading.reads.models)
            await syncProvider(reading.models)
            reading.provider = providerState()
          }
          return reading
        }
        return { settings: settings(), gateway: gateway.snapshot() }
      },
    })],

    ['/key', false, route(['POST'], {
      mutating: true,
      handler: async (body) => {
        const credentials = credentialsOf()
        if (credentials === undefined) throw invalid('no credential service is available to manage the key')
        if (body.action === 'clear') {
          await credentials.unset(API_KEY_REF)
          return { keyRef: API_KEY_REF, configured: false }
        }
        const value = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
        await credentials.set(API_KEY_REF, value)
        return { keyRef: API_KEY_REF, configured: true, value }
      },
    })],

    ['/gateway/start', false, route(['POST'], {
      mutating: true,
      handler: async () => {
        const apiKey = await apiKeyOf()
        const result = await gateway.start({ ...apiKey === null ? {} : { apiKey } })
        if (!result.ok) throw new Error(result.error ?? 'gateway failed to start')
        return { gateway: gateway.snapshot(), baseUrl: result.baseUrl }
      },
    })],

    ['/gateway/stop', false, route(['POST'], {
      mutating: true,
      handler: async () => ({ gateway: gateway.snapshot(), result: await gateway.stop() }),
    })],

    ['/gateway/restart', false, route(['POST'], {
      mutating: true,
      handler: async () => {
        const apiKey = await apiKeyOf()
        const result = await gateway.restart({ ...apiKey === null ? {} : { apiKey } })
        if (!result.ok) throw new Error(result.error ?? 'gateway failed to restart')
        return { gateway: gateway.snapshot(), baseUrl: result.baseUrl }
      },
    })],

    ['/accounts/scan', false, route(['POST'], {
      mutating: true,
      handler: async () => ({
        scan: await callGateway('/accounts/import/desktop', { method: 'POST', body: {} }),
      }),
    })],

    ['/accounts/import', false, route(['POST'], {
      mutating: true,
      handler: async (body) => {
        if (typeof body.path !== 'string' || body.path.trim() === '') throw invalid('path is required')
        const result = await callGateway('/accounts/import/desktop', {
          method: 'POST', timeoutMs: 180_000,
          body: { path: body.path, ...body.realm === undefined ? {} : { realm: body.realm } },
        })
        return { imported: result.imported ?? [], accounts: result.accounts ?? [] }
      },
    })],

    ['/accounts/delete', false, route(['POST'], {
      mutating: true,
      handler: async (body) => {
        if (typeof body.uid !== 'string' || body.uid.trim() === '') throw invalid('uid is required')
        return { result: await callGateway('/accounts/delete', { method: 'POST', body: { uid: body.uid } }) }
      },
    })],

    ['/accounts/credits', false, route(['POST'], {
      mutating: true,
      handler: async (body) => ({
        result: await callGateway('/accounts/credits', {
          method: 'POST', timeoutMs: 180_000,
          body: body.uid === undefined ? {} : { uid: body.uid },
        }),
      }),
    })],

    ['/accounts/checkin', false, route(['POST'], {
      mutating: true,
      handler: async (body) => ({
        result: await callGateway('/accounts/checkin', {
          method: 'POST', timeoutMs: 180_000,
          body: body.uid === undefined ? {} : { uid: body.uid },
        }),
      }),
    })],

    ['/accounts/set', false, route(['POST'], {
      mutating: true,
      handler: async (body) => {
        if (typeof body.uid !== 'string' || body.uid.trim() === '') throw invalid('uid is required')
        return { result: await callGateway('/accounts/set', {
          method: 'POST', body: { uid: body.uid, enabled: body.enabled === true },
        }) }
      },
    })],

    ['/accounts/set-all', false, route(['POST'], {
      mutating: true,
      handler: async (body) => ({
        result: await callGateway('/accounts/set-all', {
          method: 'POST', body: { enabled: body.enabled === true },
        }),
      }),
    })],

    ['/tasks/run', false, route(['POST'], {
      mutating: true,
      handler: async () => ({ result: await callGateway('/tasks/run', { method: 'POST', body: {}, timeoutMs: 180_000 }) }),
    })],

    ['/accounts/login/start', false, route(['POST'], {
      mutating: true,
      handler: async (body) => ({
        login: await callGateway('/accounts/login/start', {
          method: 'POST',
          body: {
            ...body.realm === undefined ? {} : { realm: body.realm },
            ...body.platform === undefined ? {} : { platform: body.platform },
          },
        }),
      }),
    })],

    ['/accounts/login/poll', true, route(['GET'], {
      handler: async (_body, request) => {
        const url = new URL(String(request.url), 'http://localhost')
        const state = url.searchParams.get('state') ?? ''
        if (state === '') throw invalid('state query parameter is required')
        return { poll: await callGateway(`/accounts/login/poll?state=${encodeURIComponent(state)}`) }
      },
    })],

    ['/provider/sync', false, route(['POST'], {
      mutating: true,
      handler: async (body) => {
        if (body.action === 'remove') {
          await syncProvider(null)
          return { provider: providerState() }
        }
        const realm = settings().realm
        const query = realm === null ? '' : `?realm=${encodeURIComponent(realm)}`
        const models = await callGateway(`/v1/models${query}`)
        const entry = await syncProvider(Array.isArray(models?.data) ? models.data : [])
        return { provider: providerState(), entry }
      },
    })],
  ]

  const disposers = []
  for (const [suffix, needsPrefix, definition] of routes) {
    disposers.push(ctx.webServer.register({
      kind: needsPrefix ? 'prefix' : 'exact',
      path: `${ROUTE_BASE}${suffix}`,
      handler: (request, response) => definition.handle(request, response),
    }))
  }
  return disposers
}

/** Exported so tests can address routes without importing the plugin entry. */
export { ROUTE_BASE, API_KEY_REF }
