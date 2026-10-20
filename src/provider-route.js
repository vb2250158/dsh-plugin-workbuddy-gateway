/**
 * The plugin's `llm-pi-ai` provider route, written through DSH's own settings writer.
 *
 * Why this and not a `settings.yaml` edit: the `llm-pi-ai` section belongs to
 * the pi-ai adapter's namespace, and a whole-section write through the settings
 * service would replace the `providers` map — destroying every other route the
 * user has. A path-level `mutate` is the narrow operation that adds or removes
 * exactly one key, and it goes through the same writer that owns the document's
 * locking and formatting, so it cannot corrupt the file or fight the GUI.
 *
 * The plugin deliberately does not parse YAML anywhere: DSH's settings service
 * is the authority on its own document.
 *
 * @module dsh-plugin-workbuddy-gateway/provider-route
 */

/** The namespace the pi-ai adapter registers; not owned by this plugin. */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/** Path inside that namespace holding the provider routes. */
const PROVIDERS_PATH = ['providers']

/**
 * Is the pi-ai namespace available to write to?
 *
 * It is registered by the pi-ai adapter's own plugin, which loads from a bundle
 * layer that may compose before or after this one. Every route therefore
 * tolerates its absence and reports it, rather than throwing at mount time.
 *
 * @param {object} settings - the settings service.
 * @returns {{ok: true, providers: object} | {ok: false, reason: string}} availability.
 */
export function readProviderMap(settings) {
  try {
    const descriptor = settings.describe({ redactSecrets: false })
      .find((entry) => entry.ns === PI_AI_NAMESPACE)
    if (descriptor === undefined) {
      return { ok: false, reason: `settings namespace "${PI_AI_NAMESPACE}" is not registered` }
    }
    const section = descriptor.value
    const providers = section?.providers
    return {
      ok: true,
      providers: providers !== null && typeof providers === 'object' ? providers : {},
    }
  } catch (error) {
    return { ok: false, reason: messageOf(error) }
  }
}

/**
 * Describe this plugin's route without changing anything.
 *
 * @param {object} settings - the settings service.
 * @param {string} providerId - this plugin's route id.
 * @returns {object} the reading the settings page renders.
 */
export function describeProvider(settings, providerId) {
  const reading = readProviderMap(settings)
  if (!reading.ok) {
    return { present: false, providerId, routes: [], reason: reading.reason }
  }
  const entry = reading.providers[providerId]
  return {
    present: Object.prototype.hasOwnProperty.call(reading.providers, providerId),
    providerId,
    routes: Object.keys(reading.providers),
    baseURL: entry?.baseURL ?? null,
    modelCount: Array.isArray(entry?.models) ? entry.models.length : 0,
  }
}

/**
 * Derive the pi-ai provider profile from one gateway model listing.
 *
 * Only fields DSH's own custom-provider form would expose are written, plus the
 * per-model facts the gateway actually reports (context window, max output,
 * modalities, reasoning tiers). Everything unstated keeps pi-ai's defaults.
 *
 * @param {object} options - derivation inputs.
 * @param {string} options.baseUrl - gateway base URL, e.g. `http://127.0.0.1:18088/v1`.
 * @param {string} options.apiKeyRef - credential reference holding the bearer token.
 * @param {object[]} options.models - entries from the gateway's `/v1/models`.
 * @param {string[]} [options.only] - restrict the listing to these model ids.
 * @returns {object} the provider profile.
 */
export function buildProviderEntry({ baseUrl, apiKeyRef, models, only }) {
  const list = Array.isArray(models) ? models : []
  const selected = Array.isArray(only) && only.length > 0
    ? list.filter((model) => only.includes(model.id))
    : list

  return {
    displayName: 'WorkBuddy',
    apiKeyEnv: apiKeyRef,
    api: 'openai-completions',
    baseURL: baseUrl,
    defaultInput: ['text', 'image'],
    models: selected.map((model) => modelProfile(model)),
  }
}

/**
 * Project one gateway model entry into a pi-ai model profile.
 *
 * @param {object} model - one entry from the gateway's `/v1/models`.
 * @returns {object} the profile.
 */
function modelProfile(model) {
  const profile = { id: model.id }
  if (typeof model.name === 'string' && model.name !== '') profile.name = model.name

  const context = model.context_length ?? model.max_input_tokens
  if (typeof context === 'number' && context > 0) profile.contextWindow = context
  const output = model.max_output_tokens ?? model.max_completion_tokens
  if (typeof output === 'number' && output > 0) profile.maxTokens = output

  const modalities = model.input_modalities ?? model.modalities?.input
  if (Array.isArray(modalities) && modalities.length > 0) {
    const known = modalities.filter((modality) => modality === 'text' || modality === 'image')
    if (known.length > 0) profile.input = known
  }

  // A fixed-effort model exposes no tier menu: its effort is not the caller's
  // to pick, and declaring tiers would offer choices the gateway ignores.
  if (model.reasoning_fixed_effort !== undefined) return profile

  const efforts = model.reasoning_efforts
  if (Array.isArray(efforts) && efforts.length > 0) {
    const mapped = {}
    // An empty `off` sends no reasoning parameter, which only stops a model that
    // reasons per request; declaring it for an always-reasoning model would
    // promise an off switch that does not exist.
    if (model.reasoning_can_disable === true) mapped.off = null
    // `max` is this plugin's menu label for the gateway's `xhigh`; the wire
    // value stays whatever the gateway understands.
    for (const effort of efforts) mapped[effort === 'xhigh' ? 'max' : effort] = effort

    // The picker offers exactly the declared keys, so a map with one selectable
    // level renders a one-option menu — a control that cannot do anything. One
    // non-off level means the tier is effectively fixed, and the honest
    // rendering is no menu at all.
    const selectable = Object.keys(mapped).filter((level) => level !== 'off')
    if (selectable.length > 1) profile.reasoningEfforts = mapped
  }
  return profile
}

/**
 * Write or remove this plugin's provider route.
 *
 * @param {object} options - the edit to apply.
 * @param {object} options.settings - the settings service.
 * @param {string} options.providerId - this plugin's route id.
 * @param {object|null} options.entry - the profile to write, or null to remove it.
 * @returns {Promise<object>} what happened.
 */
export async function applyProvider({ settings, providerId, entry }) {
  const reading = readProviderMap(settings)
  if (!reading.ok) {
    return { changed: false, reason: reading.reason, providers: [] }
  }

  const present = Object.prototype.hasOwnProperty.call(reading.providers, providerId)
  if (entry === null && !present) {
    return { changed: false, reason: 'provider route already absent', providers: Object.keys(reading.providers) }
  }

  // One path-level operation: the sibling routes are never read, written, or
  // rewritten, so a concurrent GUI edit to another provider cannot be lost.
  await settings.mutate(PI_AI_NAMESPACE, [{
    op: entry === null ? 'unset' : 'set',
    path: [...PROVIDERS_PATH, providerId],
    ...entry === null ? {} : { value: entry },
  }])

  const after = readProviderMap(settings)
  return { changed: true, providers: after.ok ? Object.keys(after.providers) : [] }
}

/**
 * Read the base URL currently recorded for this plugin's route.
 *
 * @param {object} settings - the settings service.
 * @param {string} providerId - this plugin's route id.
 * @returns {string|null} the recorded base URL.
 */
export function currentProviderBaseUrl(settings, providerId) {
  const reading = readProviderMap(settings)
  if (!reading.ok) return null
  return reading.providers[providerId]?.baseURL ?? null
}

/** Turn a thrown value into a message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
