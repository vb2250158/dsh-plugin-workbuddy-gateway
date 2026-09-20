/**
 * Host half of `dsh-plugin-workbuddy-gateway`.
 *
 * WorkBuddy (www.workbuddy.ai / codebuddy.cn) sells model access as a
 * subscription rather than an API key, so its quota is only reachable through a
 * local translation gateway. This plugin makes that gateway a managed part of
 * DSH instead of a `.bat` file someone has to remember to start:
 *
 * - it supervises the gateway process (spawn, readiness, log ring, shutdown);
 * - it exposes the gateway's accounts, models and lifecycle over the host's own
 *   web server, so the settings page needs no other transport;
 * - it writes and removes the matching `llm-pi-ai` provider route, which is what
 *   actually makes the models appear in the model picker.
 *
 * The gateway's Python source ships in this package's `vendor/` directory and is
 * run with the interpreter already on PATH. Mutable gateway state (`accounts/`,
 * `usage/`) is redirected into `$DSH_HOME/workbuddy/` so a `link:`-installed
 * plugin never writes into its own checkout.
 *
 * @module dsh-plugin-workbuddy-gateway
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Gateway, baseUrlFor } from './gateway.js'
import { mount } from './routes.js'
import { applyProvider, buildProviderEntry, currentProviderBaseUrl, describeProvider, PI_AI_NAMESPACE } from './provider-route.js'
import { defineSchema } from './schema.js'
import {
  API_KEY_REF,
  PROVIDER_ID,
  SETTINGS_BASE,
  SETTINGS_NAMESPACE,
  normalizeSettings,
} from './settings.js'

/**
 * The settings section's schema.
 *
 * A real schema node, not the bare admission function it used to be: the
 * provider catalog serializes every registered schema with `toJSON()`, and a
 * plain function has none, which took the whole models settings page down.
 */
const SECTION_SCHEMA = defineSchema(SETTINGS_BASE, (candidate) => normalizeSettings(candidate))

/** Cordis plugin name. */
export const name = 'dsh-plugin-workbuddy-gateway'

/** Services this plugin needs: the web server to mount routes, settings to persist. */
export const inject = ['webServer', 'settings']

/** Plugin build marker, surfaced by `/health` so a stale mount is visible. */
export const PLUGIN_VERSION = '0.2.3'

/**
 * Register the gateway supervisor, its routes, and its settings section.
 *
 * @param {object} ctx - host context.
 * @param {object} [config] - loader config; composition defaults for the section.
 */
export function apply(ctx, config) {
  const root = dirname(fileURLToPath(import.meta.url))
  const vendorDir = resolve(root, '..', 'vendor', 'workbuddy-gateway')
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const stateDir = join(dshHome, 'workbuddy')

  /**
   * The authoritative settings thunk.
   *
   * `installSection` hands `setSource` a thunk and calls it only when the
   * settings provider attaches or detaches; a committed change afterwards fires
   * `onChange` alone. Caching the thunk's *value* therefore froze the section at
   * mount time: the realm picker never echoed a switch, the account and model
   * reads kept querying the old realm, and the CN-only buttons never appeared.
   */
  let readSettings = () => ({ ...SETTINGS_BASE, ...config })

  /** Current resolved settings; re-derived on attach and on every committed change. */
  let current = normalizeSettings(readSettings())

  /** Re-derive {@link current} from the authoritative thunk. */
  const syncCurrent = () => {
    current = normalizeSettings(readSettings())
    return current
  }

  /**
   * Resolve the gateway script to run.
   *
   * The bundled `vendor/` copy is the default, because it is the copy this
   * plugin version was developed and tested against and it is the only path that
   * exists on a fresh install. An explicit `gatewayDir` overrides it, so an
   * operator can run a different upstream checkout without editing code — and if
   * that override is wrong, the bundled script is used rather than a crash.
   *
   * @param {object} settings - the resolved settings section.
   * @returns {string} absolute path to `wb_proxy.py`.
   */
  const scriptOf = (settings) => {
    const vendored = join(vendorDir, 'wb_proxy.py')
    const vendoredExists = existsSync(vendored)
    if (settings.gatewayDir !== '') {
      const override = join(settings.gatewayDir, 'wb_proxy.py')
      if (existsSync(override)) return override
      if (vendoredExists) {
        ctx.logger?.warn?.(
          'workbuddy-gateway: gatewayDir %s has no wb_proxy.py; falling back to the bundled copy',
          settings.gatewayDir,
        )
      }
    }
    return vendored
  }

  const pathsOf = (settings) => ({
    script: scriptOf(settings),
    cwd: dirname(scriptOf(settings)),
    accountsDir: join(stateDir, 'accounts'),
    usageDir: join(stateDir, 'usage'),
  })

  const gateway = new Gateway({
    spawn,
    settings: () => current,
    // A function, not a value: `gatewayDir` is a settings field, so the script
    // path has to be re-derived on every start.
    paths: () => pathsOf(current),
    onReady: async ({ baseUrl }) => {
      if (current.realm === null) return
      const key = await resolveApiKey(ctx)
      await fetch(`${baseUrl.replace(/\/v1$/, '')}/realm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...key === null ? {} : { authorization: `Bearer ${key}` },
        },
        body: JSON.stringify({ realm: current.realm }),
      })
    },
  })

  /** Describe the plugin's own route without changing anything. */
  const providerState = () => describeProvider(ctx.settings, PROVIDER_ID)

  /**
   * Write or remove the provider route.
   *
   * A null argument removes the route; an array of models derives the profile
   * from what the gateway actually reports, so the picker can never offer a
   * model the running gateway does not serve.
   */
  const syncProvider = async (models) => {
    if (models === null) {
      const result = await applyProvider({ settings: ctx.settings, providerId: PROVIDER_ID, entry: null })
      return { removed: result.changed, reason: result.reason ?? null, routes: result.providers }
    }
    const entry = buildProviderEntry({
      baseUrl: baseUrlFor(current.port),
      apiKeyRef: API_KEY_REF,
      models,
    })
    const result = await applyProvider({ settings: ctx.settings, providerId: PROVIDER_ID, entry })
    return { written: result.changed, reason: result.reason ?? null, routes: result.providers, entry }
  }

  /**
   * Ensure a bearer token exists before the gateway is asked to require one.
   *
   * @param {object|undefined} credentials - the credential service, already
   *   awaited by the caller so this function does not block on a service the
   *   harness may be slow to activate.
   * @returns {Promise<string|null>} the token, or null when none can be held.
   */
  const ensureApiKey = async (credentials) => {
    const existing = await resolveApiKey(ctx)
    if (existing !== null) return existing
    if (credentials === undefined) return null
    const value = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
    await credentials.set(API_KEY_REF, value)
    return value
  }

  /** Re-derive the route's baseURL after a settings change. */
  const refreshBaseUrl = async () => {
    const state = providerState()
    if (!state.present) return
    const recorded = currentProviderBaseUrl(ctx.settings, PROVIDER_ID)
    const desired = baseUrlFor(current.port)
    if (recorded === null || recorded === desired) return
    try {
      // A port change must not leave a stale endpoint behind. Only the endpoint
      // is corrected here, not the model list, because the gateway may not be
      // running and the list can only come from it.
      const section = ctx.settings.get(PI_AI_NAMESPACE)
      const entry = section?.providers?.[PROVIDER_ID]
      if (entry === undefined || entry === null) return
      await applyProvider({
        settings: ctx.settings,
        providerId: PROVIDER_ID,
        entry: { ...entry, baseURL: desired },
      })
    } catch (error) {
      ctx.logger?.warn?.('workbuddy-gateway: could not refresh the provider baseURL: %s', messageOf(error))
    }
  }

  // The settings section is wired FIRST, and its `installSection` resolves the
  // section synchronously through `setSource`. The web-server block below reads
  // `current.autoStart`, and a reversed order would compare the composition
  // default instead of the user's choice.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(
      ctx,
      SETTINGS_NAMESPACE,
      SECTION_SCHEMA,
      { ...SETTINGS_BASE, ...config },
      {
        setSource: (source) => {
          readSettings = source
          syncCurrent()
        },
        onChange: () => {
          syncCurrent()
          // Routes are derived from the port, so a port change must not leave a
          // stale baseURL behind in settings.yaml.
          if (!current.providerSync) return
          void refreshBaseUrl()
        },
      },
    )
  })

  ctx.inject(['webServer'], (webCtx) => {
    // Kicked off here, awaited only inside the autostart task: the routes below
    // do not need the credential service to mount, and blocking the mount on it
    // would delay every route for a service the page may never ask about.
    const startupCredentials = waitForService(ctx, 'credentials')

    const disposers = mount(webCtx, {
      gateway,
      settings: () => current,
      updateSettings: async (patch) => {
        // `update` merges a partial patch into this namespace's user layer. The
        // namespace is already registered by `installSection`, so registering
        // again here would throw.
        await webCtx.settings.update(SETTINGS_NAMESPACE, patch)
        // Re-derive before this request's own snapshot runs. The scope watcher
        // that also does it is not ordered against this await, and a realm switch
        // that still read the old realm would answer with the previous region's
        // accounts and models.
        syncCurrent()
      },
      credentials: () => webCtx.get('credentials'),
      syncProvider,
      providerState,
    })

    webCtx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* a route the host already tore down is not an error here */
        }
      }
    }, 'dsh-plugin-workbuddy-gateway: http routes')

    // The gateway is stopped with the harness, never left orphaned. It is only
    // stopped if this plugin started it: adopting a pre-existing server on the
    // port is not possible (there is no way to know who owns it), so the plugin
    // treats "port already serving" as a start failure and says so.
    webCtx.effect(() => () => {
      void gateway.stop()
    }, 'dsh-plugin-workbuddy-gateway: gateway shutdown')

    if (!current.autoStart) {
      gateway.note('log', 'autostart is off; the gateway stays stopped until you start it here')
      return
    }
    gateway.note('log', 'autostart is on; preparing to start the gateway')
    void (async () => {
      try {
        const apiKey = await ensureApiKey(await startupCredentials)
        if (apiKey === null) {
          // Starting anyway would serve the user's quota from an unauthenticated
          // local port. Better to stay down and say why.
          gateway.note('error', `not starting: no credential service is available to hold ${API_KEY_REF}`)
          ctx.logger?.warn?.(
            'workbuddy-gateway: not autostarting — no credential service is available to hold %s, '
            + 'so the gateway could not be given a bearer token',
            API_KEY_REF,
          )
          return
        }
        const result = await gateway.start({ apiKey })
        if (!result.ok) {
          gateway.note('error', `autostart failed: ${result.error ?? 'unknown error'}`)
          ctx.logger?.warn?.('workbuddy-gateway: autostart failed: %s', result.error ?? 'unknown error')
        }
      } catch (error) {
        gateway.note('error', `autostart threw: ${messageOf(error)}`)
        ctx.logger?.warn?.('workbuddy-gateway: autostart threw: %s', messageOf(error))
      }
    })()
  })
}

/**
 * Wait for one host service to activate.
 *
 * This plugin mounts before every service it uses has activated, so a first
 * `ctx.get()` can legitimately return nothing. The observable failure that
 * motivated this: the gateway was started without a bearer token because the
 * credential service was still absent at mount time, and a later lookup through
 * the HTTP route succeeded — proving the service does arrive, just not yet.
 *
 * @param {object} ctx - host context.
 * @param {string} name - service name.
 * @param {number} [timeoutMs] - how long to wait before giving up.
 * @returns {Promise<object|undefined>} the service, or undefined on timeout.
 */
async function waitForService(ctx, name, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const service = ctx.get(name)
    if (service !== undefined) return service
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => { setTimeout(resolve, 200) })
  }
}

/**
 * Read the stored bearer token.
 *
 * The credential service is looked up on every call rather than captured once:
 * this plugin mounts before every service it uses has activated, so a captured
 * handle would be permanently `undefined` and the gateway would start with no
 * authentication at all.
 *
 * @param {object} ctx - host context.
 * @returns {Promise<string|null>} the token, or null when none is configured.
 */
async function resolveApiKey(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(API_KEY_REF)
      if (resolved !== undefined && resolved.value !== '') return resolved.value
    } catch (error) {
      ctx.logger?.warn?.('workbuddy-gateway: could not read %s: %s', API_KEY_REF, messageOf(error))
    }
  }
  const ambient = process.env[API_KEY_REF]
  return ambient !== undefined && ambient !== '' ? ambient : null
}

/** Turn a thrown value into a message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
