/**
 * Settings namespace for the WorkBuddy gateway plugin.
 *
 * These are the values the settings page owns. They are deliberately separate
 * from the `llm-pi-ai` provider route the plugin writes: the route is derived
 * state (baseURL, model list, credential reference), while everything here is
 * an operator preference.
 *
 * @module dsh-plugin-workbuddy-gateway/settings
 */

/** Registered namespace: lowercase-hyphenated, as `settings.register` requires. */
export const SETTINGS_NAMESPACE = 'workbuddy-gateway'

/** Credential reference the generated bearer token is stored under. */
export const API_KEY_REF = 'WORKBUDDY_API_KEY'

/** Provider id this plugin owns inside the `llm-pi-ai` providers dict. */
export const PROVIDER_ID = 'workbuddy'

/** Route base every HTTP endpoint of this plugin lives under. */
export const ROUTE_BASE = '/dsh-workbuddy-gateway/api/v1'

/** Port the supervised gateway listens on.
 *
 * 18088 rather than the upstream default 8788: Windows reserves TCP
 * 8703–9302 for Hyper-V/WSL dynamic exclusions on this machine, and a bind
 * inside that range fails with WinError 10013.
 */
export const DEFAULT_PORT = 18088

/**
 * Default gateway checkout: an optional override, not a requirement.
 *
 * Empty by default, which makes the plugin run the copy bundled in this
 * package's `vendor/` directory. That is the only default that works for
 * somebody else's machine — an absolute path to the author's checkout was the
 * original value, and it silently pointed a fresh install at a directory that
 * does not exist.
 *
 * Set it to run a different upstream checkout without editing code.
 */
export const DEFAULT_GATEWAY_DIR = ''

/**
 * Shape of the resolved namespace.
 *
 * A plain object rather than a schemastery schema: this plugin deliberately has
 * no runtime dependency on the harness packages, so it validates and defaults
 * the section itself. `normalizeSettings` below is that validation.
 *
 * @typedef {object} WorkBuddyGatewaySettings
 * @property {number} port         - Gateway listen port.
 * @property {boolean} autoStart   - Spawn the gateway when the plugin mounts.
 * @property {boolean} providerSync- Whether the plugin keeps its `llm-pi-ai` route present.
 * @property {boolean} autoGrowthCheckin - Confirm daily domestic growth activity automatically.
 * @property {number} growthCheckinRetrySeconds - Delay between unconfirmed activity checks.
 * @property {number} growthCheckinMaxChecks - Daily verification budget per account.
 * @property {string} gatewayDir   - Directory holding `wb_proxy.py`.
 * @property {string} pythonPath   - Python executable; `""` means resolve from PATH.
 * @property {string|null} realm   - `"intl"`, `"cn"`, or null for the gateway default.
 */

/** Composition default; the base layer `installSection` falls back to. */
export const SETTINGS_BASE = {
  port: DEFAULT_PORT,
  autoStart: true,
  providerSync: true,
  autoGrowthCheckin: false,
  growthCheckinRetrySeconds: 300,
  growthCheckinMaxChecks: 3,
  gatewayDir: DEFAULT_GATEWAY_DIR,
  pythonPath: '',
  realm: null,
}

/**
 * Coerce one untrusted section into the shape the rest of the plugin assumes.
 *
 * Every field falls back independently, so a section that is missing, partial,
 * or hand-edited into a wrong type still yields a usable configuration instead
 * of throwing during mount.
 *
 * @param {unknown} raw - the resolved settings section.
 * @returns {WorkBuddyGatewaySettings} a fully defaulted configuration.
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const port = Number(source.port)
  const realm = source.realm
  const retry = source.growthCheckinRetrySeconds
  const checks = source.growthCheckinMaxChecks
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    autoStart: source.autoStart !== false,
    providerSync: source.providerSync !== false,
    autoGrowthCheckin: source.autoGrowthCheckin === true,
    growthCheckinRetrySeconds: Number.isInteger(retry) && retry >= 30 && retry <= 3600 ? retry : 300,
    growthCheckinMaxChecks: Number.isInteger(checks) && checks >= 1 && checks <= 10 ? checks : 3,
    // An empty string is the meaningful default here ("use the bundled
    // gateway"), so only a wrong *type* falls back rather than an empty value.
    gatewayDir: typeof source.gatewayDir === 'string' ? source.gatewayDir.trim() : DEFAULT_GATEWAY_DIR,
    pythonPath: typeof source.pythonPath === 'string' ? source.pythonPath.trim() : '',
    realm: realm === 'intl' || realm === 'cn' ? realm : null,
  }
}
