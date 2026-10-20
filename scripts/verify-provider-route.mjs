/**
 * Integration check of the provider route against DSH's real settings service.
 *
 * The unit tests assert the shape of the path operations. This asserts the thing
 * they cannot: that DSH's own file-backed settings writer accepts a path-level
 * `mutate` against the `llm-pi-ai` namespace, preserves a sibling route, and
 * leaves the user's other sections alone.
 *
 * It boots the real provider against a throwaway copy of a settings document, so
 * it is safe to run at any time and touches nothing of the user's.
 *
 * Run from the DSH checkout:
 *   node --import tsx/esm <this file> [path-to-settings.yaml]
 *
 * Exits non-zero when the integration no longer holds.
 */

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'

import { applyProvider, describeProvider, buildProviderEntry } from '../src/provider-route.js'

/** A document with two providers plus unrelated sections. */
const FIXTURE = `ui-theme:
  preference: light
llm-pi-ai:
  providers:
    {
      sub:
        {
          apiKeyEnv: SUB_API_KEY,
          api: openai-responses,
          baseURL: https://sub.example/v1
        }
    }
llm-deepseek: {}
`

const source = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'wb-provider-route-'))
const file = join(dir, 'settings.yaml')
if (source === undefined) writeFileSync(file, FIXTURE, 'utf8')
else copyFileSync(source, file)

/** Read one registered section through the current settings descriptor API. */
function readSection(settings, namespace) {
  return settings.describe({ redactSecrets: false }).find((entry) => entry.ns === namespace)?.value
}

const before = readFileSync(file, 'utf8')

const ctx = new Context()
await ctx.plugin(FileSettingsProvider, { path: file, watch: false })

// Stand in for the pi-ai adapter's registration. The schema only has to be
// callable: the service calls it to admit a merged candidate.
ctx.settings.register('llm-pi-ai', (value) => value ?? {}, { base: {} })
// And this plugin's own namespace, registered the way `installSection` does.
ctx.settings.register('workbuddy-gateway', (value) => value ?? {}, { base: { port: 18088 } })

let failed = false
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failed = true
}

const beforeDoc = readSection(ctx.settings, 'llm-pi-ai')
check('fixture starts with only the sibling route', Object.keys(beforeDoc.providers).length === 1)

const entry = buildProviderEntry({
  baseUrl: 'http://127.0.0.1:18088/v1',
  apiKeyRef: 'WORKBUDDY_API_KEY',
  models: [{
    id: 'gpt-6-astra',
    name: 'GPT-6-Astra',
    context_length: 1000000,
    max_output_tokens: 128000,
    input_modalities: ['text', 'image'],
    reasoning_efforts: ['low', 'high'],
    reasoning_can_disable: true,
  }],
})

const added = await applyProvider({ settings: ctx.settings, providerId: 'workbuddy', entry })
check('add reports the new route set', added.changed && added.providers.includes('workbuddy'), JSON.stringify(added.providers))

const afterAdd = readSection(ctx.settings, 'llm-pi-ai')
check('sibling route survives the add', afterAdd.providers.sub?.baseURL === 'https://sub.example/v1', JSON.stringify(afterAdd.providers.sub))
check('the new route carries the derived models', afterAdd.providers.workbuddy?.models?.[0]?.id === 'gpt-6-astra')
check('describeProvider agrees the route is present', describeProvider(ctx.settings, 'workbuddy').present === true)

// Unrelated sections are checked against the document text, not through the
// service: a namespace nothing registered is not readable through `get`, and
// "the write did not drop someone else's section" is a claim about the file.
const fileAfterAdd = readFileSync(file, 'utf8')
check('unrelated sections survive the add', fileAfterAdd.includes('preference: light') && fileAfterAdd.includes('llm-deepseek'), fileAfterAdd.replaceAll('\n', ' | ').slice(0, 160))
check('the document still parses as YAML', fileAfterAdd.includes('providers:'))

// A second add must replace, not duplicate.
await applyProvider({ settings: ctx.settings, providerId: 'workbuddy', entry: { ...entry, baseURL: 'http://127.0.0.1:19000/v1' } })
const afterSecond = readSection(ctx.settings, 'llm-pi-ai')
check('a repeated add replaces the route', afterSecond.providers.workbuddy?.baseURL === 'http://127.0.0.1:19000/v1')
check('a repeated add does not duplicate', Object.keys(afterSecond.providers).length === 2)

const removed = await applyProvider({ settings: ctx.settings, providerId: 'workbuddy', entry: null })
check('remove reports the route gone', removed.changed && !removed.providers.includes('workbuddy'), JSON.stringify(removed.providers))

const afterRemove = readSection(ctx.settings, 'llm-pi-ai')
check('sibling route survives the remove', afterRemove.providers.sub?.baseURL === 'https://sub.example/v1')
check('describeProvider agrees the route is absent', describeProvider(ctx.settings, 'workbuddy').present === false)

const removingAgain = await applyProvider({ settings: ctx.settings, providerId: 'workbuddy', entry: null })
check('removing an absent route is a reported no-op', removingAgain.changed === false, removingAgain.reason ?? '')

await ctx.stop?.()
console.log(failed ? 'RESULT: FAILED' : 'RESULT: OK')
console.log('workspace:', dir, before.length > 0 ? '' : '')
process.exit(failed ? 1 : 0)
