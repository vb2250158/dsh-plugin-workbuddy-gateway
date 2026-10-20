/**
 * Tests for the settings-section schema.
 *
 * The regression these guard: the section was registered with a bare function.
 * The settings service calls `schema.toJSON()` when it describes a namespace, so
 * the provider catalog threw `registration.schema.toJSON is not a function` and
 * the whole models settings page failed to load. The schema must therefore be a
 * *node* that is also callable — both halves matter.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { defineSchema } from '../src/schema.js'
import { SETTINGS_BASE, normalizeSettings } from '../src/settings.js'

/** The schema the plugin actually registers. */
const schema = defineSchema(SETTINGS_BASE, (candidate) => normalizeSettings(candidate))

test('the schema is callable, because the service admits values through it', () => {
  assert.equal(typeof schema, 'function')
  const resolved = schema({ port: 19000 })
  assert.equal(resolved.port, 19000)
  // The plugin's own normalization still runs.
  assert.equal(resolved.autoStart, true)
  assert.equal(schema({ port: 'nonsense' }).port, SETTINGS_BASE.port)
})

test('the schema serializes, which is what the provider catalog requires', () => {
  assert.equal(typeof schema.toJSON, 'function')
  const serialized = schema.toJSON()
  assert.equal(typeof serialized, 'object')
  assert.ok(serialized !== null)
  // `describe()` ships this straight to the browser, so it has to survive JSON.
  const roundTripped = JSON.parse(JSON.stringify(serialized))
  assert.deepEqual(roundTripped, serialized)
})

test('every settings field appears in the serialized schema', () => {
  const { refs, uid } = schema.toJSON()
  const root = refs[uid]
  assert.equal(root.type, 'object')
  assert.deepEqual(Object.keys(root.dict), Object.keys(SETTINGS_BASE))
})

test('the schema node exposes the structure the secret redactor walks', () => {
  // `redactSecrets` reads `type`, `meta.role`, `dict`, and `inner`.
  assert.equal(schema.type, 'object')
  assert.equal(typeof schema.meta, 'object')
  assert.equal(typeof schema.dict, 'object')
  assert.deepEqual(Object.keys(schema.dict), Object.keys(SETTINGS_BASE))
  // No field is a secret, so nothing is redacted away from the form.
  for (const node of Object.values(schema.dict)) {
    assert.equal(node.meta?.role, undefined)
  }
})

test('leaf types follow the defaults they describe', () => {
  assert.equal(schema.dict.port.type, 'number')
  assert.equal(schema.dict.autoStart.type, 'boolean')
  assert.equal(schema.dict.gatewayDir.type, 'string')
  assert.equal(schema.dict.pythonPath.type, 'string')
  // `realm` defaults to null, which has no inferable type.
  assert.equal(schema.dict.realm.type, 'any')
})

test('the schema dict cannot drift from the defaults', () => {
  // A hand-written dict would silently miss a field added later; deriving it
  // from the defaults object is what makes this assertion meaningful.
  const custom = defineSchema({ alpha: 1, beta: 'two', gamma: false })
  assert.deepEqual(Object.keys(custom.dict), ['alpha', 'beta', 'gamma'])
  assert.equal(custom.dict.alpha.type, 'number')
  assert.equal(custom.dict.beta.type, 'string')
  assert.equal(custom.dict.gamma.type, 'boolean')
})

test('a schema without an explicit admission step fills from the defaults', () => {
  const plain = defineSchema({ port: 18088, autoStart: true })
  assert.deepEqual(plain({}), { port: 18088, autoStart: true })
  assert.deepEqual(plain({ port: 9999 }), { port: 9999, autoStart: true })
  // A non-object candidate must not throw during admission.
  assert.deepEqual(plain(null), { port: 18088, autoStart: true })
})

test('the serialized defaults mirror the section base', () => {
  const { refs, uid } = schema.toJSON()
  assert.deepEqual(refs[uid].meta.default, { ...SETTINGS_BASE })
})

test('live Config accepts the standard validator and retains a replaceable immutable value', () => {
  const live = defineSchema(SETTINGS_BASE, normalizeSettings, { volatile: true })
  const ref = live['~standard'].validate({ autoStart: false }).value
  assert.equal(ref.get().autoGrowthCheckin, false)
  assert.ok(Object.isFrozen(ref.get()))
  const next = live({ autoGrowthCheckin: true }).get()
  ref[Symbol.for('cosmokit.volatile.write')](next)
  assert.equal(ref.get().autoGrowthCheckin, true)
  const json = live.toJSON()
  assert.equal(json.refs[json.uid].meta.volatile, true)
})
