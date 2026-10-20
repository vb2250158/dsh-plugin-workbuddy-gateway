/**
 * Tests for the `llm-pi-ai` route writes.
 *
 * These assert on the exact path operations handed to DSH's settings service.
 * That is the whole safety argument for this module: one path-level op against
 * `providers.<id>` cannot touch a sibling route, whereas a section-level write
 * would replace the whole map.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyProvider, buildProviderEntry, currentProviderBaseUrl, describeProvider, readProviderMap } from '../src/provider-route.js'

/**
 * A settings service stand-in that records operations and applies them.
 *
 * @param {object} initial - the initial `llm-pi-ai` section.
 * @param {object} [options] - behavior switches.
 */
function fakeSettings(initial = { providers: {} }, { unregistered = false, failOn } = {}) {
  const calls = []
  let section = initial
  return {
    calls,
    section: () => section,
    describe() {
      if (unregistered) return []
      return [{ ns: 'llm-pi-ai', value: section }]
    },
    async mutate(namespace, ops) {
      calls.push({ namespace, ops })
      if (failOn !== undefined && ops.some((op) => op.path.includes(failOn))) {
        throw new Error(`refused: ${failOn}`)
      }
      for (const op of ops) {
        const [, id] = op.path
        const providers = { ...section.providers }
        if (op.op === 'unset') delete providers[id]
        else providers[id] = op.value
        section = { ...section, providers }
      }
    },
  }
}

const ENTRY = {
  displayName: 'WorkBuddy',
  apiKeyEnv: 'WORKBUDDY_API_KEY',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:18088/v1',
  models: [{ id: 'gpt-6-astra' }],
}

test('adding a route issues one set on providers.<id> and nothing else', async () => {
  const settings = fakeSettings({ providers: { sub: { api: 'openai-responses' } } })
  const result = await applyProvider({ settings, providerId: 'workbuddy', entry: ENTRY })

  assert.equal(result.changed, true)
  assert.deepEqual(result.providers, ['sub', 'workbuddy'])
  assert.equal(settings.calls.length, 1)
  assert.equal(settings.calls[0].namespace, 'llm-pi-ai')
  assert.deepEqual(settings.calls[0].ops, [
    { op: 'set', path: ['providers', 'workbuddy'], value: ENTRY },
  ])
  // The sibling route is untouched in the resulting section.
  assert.deepEqual(settings.section().providers.sub, { api: 'openai-responses' })
})

test('removing a route issues one unset on providers.<id>', async () => {
  const settings = fakeSettings({ providers: { sub: { api: 'openai-responses' }, workbuddy: ENTRY } })
  const result = await applyProvider({ settings, providerId: 'workbuddy', entry: null })

  assert.equal(result.changed, true)
  assert.deepEqual(result.providers, ['sub'])
  assert.deepEqual(settings.calls[0].ops, [{ op: 'unset', path: ['providers', 'workbuddy'] }])
})

test('removing an absent route is a no-op with no write at all', async () => {
  const settings = fakeSettings({ providers: { sub: {} } })
  const result = await applyProvider({ settings, providerId: 'workbuddy', entry: null })

  assert.equal(result.changed, false)
  assert.match(result.reason ?? '', /already absent/)
  assert.equal(settings.calls.length, 0)
})

test('an unregistered llm-pi-ai namespace is reported rather than thrown', async () => {
  const settings = fakeSettings({ providers: {} }, { unregistered: true })
  const result = await applyProvider({ settings, providerId: 'workbuddy', entry: ENTRY })

  assert.equal(result.changed, false)
  assert.match(result.reason ?? '', /not registered/)
})

test('describeProvider reports presence, routes and model count', () => {
  const settings = fakeSettings({ providers: { sub: {}, workbuddy: ENTRY } })
  const state = describeProvider(settings, 'workbuddy')

  assert.equal(state.present, true)
  assert.deepEqual(state.routes, ['sub', 'workbuddy'])
  assert.equal(state.modelCount, 1)
  assert.equal(state.baseURL, 'http://127.0.0.1:18088/v1')
})

test('describeProvider reports absence for a namespace with other routes', () => {
  const settings = fakeSettings({ providers: { sub: {} } })
  const state = describeProvider(settings, 'workbuddy')
  assert.equal(state.present, false)
  assert.deepEqual(state.routes, ['sub'])
})

test('describeProvider degrades instead of throwing when the namespace is absent', () => {
  const settings = fakeSettings({}, { unregistered: true })
  const state = describeProvider(settings, 'workbuddy')
  assert.equal(state.present, false)
  assert.equal(state.routes.length, 0)
  assert.match(state.reason ?? '', /not registered/)
})

test('a section whose providers value is not an object reads as empty', () => {
  assert.deepEqual(readProviderMap(fakeSettings({ providers: null })).providers, {})
  assert.deepEqual(readProviderMap(fakeSettings({})).providers, {})
})

test('currentProviderBaseUrl reads the recorded endpoint', () => {
  const settings = fakeSettings({ providers: { workbuddy: ENTRY } })
  assert.equal(currentProviderBaseUrl(settings, 'workbuddy'), 'http://127.0.0.1:18088/v1')
  assert.equal(currentProviderBaseUrl(settings, 'absent'), null)
})

test('buildProviderEntry derives models, capacities, modalities and reasoning tiers', () => {
  const entry = buildProviderEntry({
    baseUrl: 'http://127.0.0.1:18088/v1',
    apiKeyRef: 'WORKBUDDY_API_KEY',
    models: [
      {
        id: 'gpt-6-astra',
        name: 'GPT-6-Astra',
        context_length: 1000000,
        max_output_tokens: 128000,
        input_modalities: ['text', 'image'],
        reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
        reasoning_can_disable: true,
      },
      {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3-Codex',
        context_length: 272000,
        max_output_tokens: 72000,
        reasoning_fixed_effort: 'medium',
      },
    ],
  })

  assert.equal(entry.api, 'openai-completions')
  assert.equal(entry.apiKeyEnv, 'WORKBUDDY_API_KEY')
  assert.equal(entry.baseURL, 'http://127.0.0.1:18088/v1')

  const [astra, codex] = entry.models
  assert.equal(astra.contextWindow, 1000000)
  assert.equal(astra.maxTokens, 128000)
  assert.deepEqual(astra.input, ['text', 'image'])
  // `off` because the gateway says the model can disable reasoning; `max` is
  // this plugin's label for the gateway's `xhigh`.
  assert.deepEqual(astra.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high', max: 'xhigh' })
  // A fixed-effort model declares no menu at all.
  assert.equal(codex.reasoningEfforts, undefined)
})

test('buildProviderEntry honours an explicit model subset', () => {
  const entry = buildProviderEntry({
    baseUrl: 'http://127.0.0.1:18088/v1',
    apiKeyRef: 'K',
    models: [{ id: 'a' }, { id: 'b' }],
    only: ['b'],
  })
  assert.deepEqual(entry.models.map((model) => model.id), ['b'])
})

test('buildProviderEntry tolerates a non-array model listing', () => {
  const entry = buildProviderEntry({ baseUrl: 'http://x/v1', apiKeyRef: 'K', models: undefined })
  assert.deepEqual(entry.models, [])
})

/**
 * The picker offers exactly the declared keys, so these shapes decide whether a
 * reasoning menu appears at all. Getting them wrong is how a model ends up with
 * a one-option menu that cannot switch anything, or with no menu when the
 * gateway really does offer tiers.
 */
test('a fixed-effort model declares no reasoning menu', () => {
  const entry = buildProviderEntry({
    baseUrl: 'http://x/v1',
    apiKeyRef: 'K',
    models: [{ id: 'deepseek-v4.1-flash', reasoning_fixed_effort: 'high', always_reasoning: true }],
  })
  assert.equal(entry.models[0].reasoningEfforts, undefined)
})

test('a single reported tier declares no menu, because it would have one option', () => {
  const entry = buildProviderEntry({
    baseUrl: 'http://x/v1',
    apiKeyRef: 'K',
    models: [{ id: 'hy4-preview-f', reasoning_efforts: ['high'], reasoning_can_disable: false }],
  })
  assert.equal(
    entry.models[0].reasoningEfforts,
    undefined,
    'a one-option menu is a control that cannot do anything',
  )
})

test('a single tier plus an off switch still declares no menu', () => {
  const entry = buildProviderEntry({
    baseUrl: 'http://x/v1',
    apiKeyRef: 'K',
    models: [{ id: 'x', reasoning_efforts: ['high'], reasoning_can_disable: true }],
  })
  assert.equal(entry.models[0].reasoningEfforts, undefined)
})

test('two reported tiers do declare a menu', () => {
  const entry = buildProviderEntry({
    baseUrl: 'http://x/v1',
    apiKeyRef: 'K',
    models: [{ id: 'hy3', reasoning_efforts: ['low', 'high'], reasoning_can_disable: false }],
  })
  assert.deepEqual(entry.models[0].reasoningEfforts, { low: 'low', high: 'high' })
})

test('a model with no reasoning fields declares no menu and no extra keys', () => {
  const entry = buildProviderEntry({
    baseUrl: 'http://x/v1',
    apiKeyRef: 'K',
    models: [{ id: 'plain-model' }],
  })
  assert.deepEqual(entry.models[0], { id: 'plain-model' })
})
