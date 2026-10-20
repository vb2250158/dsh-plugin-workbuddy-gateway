/**
 * A minimal stand-in for a schemastery schema.
 *
 * The settings service treats a namespace schema as three things at once:
 *
 *   1. **A callable admission step.** It calls `schema(merged)` to resolve the
 *      section, which is where defaults are applied and a bad value is rejected.
 *   2. **A schema tree.** `describe({ redactSecrets: true })` walks `type`,
 *      `meta.role`, `dict`, and `inner` to strip secret-role fields.
 *   3. **A serializable node.** `describe()` calls `schema.toJSON()` and ships
 *      the result to the browser, which is what a settings form renders from.
 *
 * A plain function satisfies only the first. Registering one made the provider
 * catalog fail with `registration.schema.toJSON is not a function`, which took
 * the whole models settings page down — the cheapest possible mistake with the
 * most visible blast radius.
 *
 * This builds a real schema *shape* without importing schemastery: this plugin
 * deliberately carries no runtime dependency on harness packages, and every
 * requirement above is structural. The `dict` is derived from the defaults
 * object, so fields cannot drift out of sync with the schema the way a
 * hand-written map would.
 *
 * @module dsh-plugin-workbuddy-gateway/schema
 */

/** Placeholder id space for `toJSON` refs; one schema per document in practice. */
const ROOT_UID = 'workbuddy-gateway-root'

/**
 * Infer one leaf node from a default value.
 *
 * Only the node kinds this plugin's settings use are recognized; anything else
 * falls back to `any`, which the redactor treats as a leaf and passes through.
 *
 * @param {unknown} value - the field's default.
 * @returns {object} the leaf schema node.
 */
function leafFor(value) {
  if (typeof value === 'boolean') return { type: 'boolean', meta: { default: value } }
  if (typeof value === 'number') return { type: 'number', meta: { default: value } }
  if (typeof value === 'string') return { type: 'string', meta: { default: value } }
  if (value === null || value === undefined) return { type: 'any', meta: {} }
  if (Array.isArray(value)) return { type: 'array', meta: { default: value }, inner: { type: 'any', meta: {} } }
  return { type: 'object', meta: { default: value }, dict: dictFor(value) }
}

/**
 * Build the `dict` for an object of defaults.
 *
 * @param {object} defaults - field name to default value.
 * @returns {Record<string, object>} property name to leaf node.
 */
function dictFor(defaults) {
  const dict = {}
  for (const [key, value] of Object.entries(defaults)) dict[key] = leafFor(value)
  return dict
}

/**
 * Create a schema for one section.
 *
 * @param {object} defaults - the section's fields and their defaults. Used both
 *   as the schema's structural skeleton and as the value an absent section
 *   resolves to.
 * @param {(candidate: unknown) => object} [admit] - the admission step; defaults
 *   to filling missing keys from `defaults`.
 * @param {{volatile?: boolean}} [options] - expose flat primitive settings as a live Cordis Config reference.
 * @returns {Function & {type: string, meta: object, dict: object, toJSON: Function}}
 *   a callable schema node.
 */
export function defineSchema(defaults, admit, { volatile = false } = {}) {
  const resolve = admit ?? ((candidate) => ({ ...defaults, ...(candidate ?? {}) }))

  // A schemastery schema is a function carrying schema data as properties, so
  // the admission call and the introspection both work off one object.
  const schema = (candidate) => {
    const value = resolve(candidate)
    if (!volatile) return value
    // Cordis shares this reference protocol across module copies. Keeping this
    // adapter local supports older profiles without adding a runtime dependency.
    // This plugin's normalized settings contain only primitive values.
    let current = Object.freeze({ ...value })
    return Object.freeze({
      get: () => current,
      [Symbol.for('cosmokit.volatile.write')]: (next) => { current = next },
    })
  }
  schema.type = 'object'
  schema.meta = { default: { ...defaults }, ...volatile ? { volatile: true } : {} }
  schema.dict = dictFor(defaults)
  schema.toJSON = () => {
    const refs = {}
    const encode = (node, uid) => {
      const record = { type: node.type, meta: { ...node.meta } }
      refs[uid] = record
      if (node.dict) record.dict = Object.fromEntries(Object.entries(node.dict)
        .map(([key, child]) => [key, encode(child, `${uid}/${key}`)]))
      if (node.inner) record.inner = encode(node.inner, `${uid}/inner`)
      return uid
    }
    encode(schema, ROOT_UID)
    return { uid: ROOT_UID, refs }
  }
  // Loader recognizes Schemastery's graph protocol when deciding whether a
  // Config change can update its live reference without remounting the plugin.
  schema[Symbol.for('schemastery')] = true
  schema['~standard'] = { version: 1, vendor: 'schemastery', validate: (value) => ({ value: schema(value) }) }
  return schema
}
