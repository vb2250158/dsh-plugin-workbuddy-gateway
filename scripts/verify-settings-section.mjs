/**
 * Integration check of the settings-section registration.
 *
 * Reproduces the exact path that failed in the browser: the provider catalog
 * calls `settings.describe({ redactSecrets: true })`, which serializes every
 * registered schema with `toJSON()` and walks it to strip secret fields. A bare
 * function satisfies neither, and the whole models settings page broke with
 * `registration.schema.toJSON is not a function`.
 *
 * Run from the DSH checkout:
 *   node --import tsx/esm <this file>
 *
 * Exits non-zero when the registration can no longer be described.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'

import { defineSchema } from '../src/schema.js'
import { SETTINGS_BASE, SETTINGS_NAMESPACE, normalizeSettings } from '../src/settings.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-schema-'))
const file = join(dir, 'settings.yaml')
writeFileSync(file, 'llm-pi-ai:\n  providers: {}\n', 'utf8')

/** Read one registered section through the current settings descriptor API. */
function readSection(settings, namespace) {
  return settings.describe({ redactSecrets: false }).find((entry) => entry.ns === namespace)?.value
}

const ctx = new Context()
await ctx.plugin(FileSettingsProvider, { path: file, watch: false })

// The pi-ai adapter's namespace, so the catalog has a second entry to describe.
// It gets a real schema node as well: `describe()` serializes EVERY registered
// namespace, so a stub here would fail the same way the plugin's own did.
ctx.settings.register('llm-pi-ai', defineSchema({ providers: {} }, (value) => value ?? {}), { base: {} })

let failed = false
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failed = true
}

// Isolate which registration cannot be described: `describe()` walks all of them.
try {
  ctx.settings.describe({ redactSecrets: true })
  check('describe works before our section registers', true)
} catch (error) {
  check('describe works before our section registers', false, error.message)
}

// Exactly what the plugin registers.
ctx.settings.installSection(
  ctx,
  SETTINGS_NAMESPACE,
  defineSchema(SETTINGS_BASE, (candidate) => normalizeSettings(candidate)),
  { ...SETTINGS_BASE },
  { setSource: () => {}, onChange: () => {} },
)

check('the section resolves through the schema', readSection(ctx.settings, SETTINGS_NAMESPACE)?.port === SETTINGS_BASE.port)

let descriptors
try {
  descriptors = ctx.settings.describe({ redactSecrets: true })
  check('describe({ redactSecrets: true }) succeeds', true)
} catch (error) {
  check('describe({ redactSecrets: true }) succeeds', false, error.message)
  await ctx.stop?.()
  process.exit(1)
}

const ours = descriptors.find((entry) => entry.ns === SETTINGS_NAMESPACE)
check('our namespace is described', ours !== undefined)
if (ours !== undefined) {
  check('the descriptor carries a serialized schema', typeof ours.schema === 'object' && ours.schema !== null)
  check('the descriptor carries the resolved value', ours.value?.port === SETTINGS_BASE.port)
  check('the descriptor carries the composition base', ours.base?.port === SETTINGS_BASE.port)
  check('no secret was declared for this section', Array.isArray(ours.secrets) && ours.secrets.length === 0)
  // A form renders from this, so it has to survive the wire.
  check('the descriptor is JSON-serializable', (() => {
    try {
      JSON.parse(JSON.stringify(ours))
      return true
    } catch {
      return false
    }
  })())
}

// Writes still work through the registered schema.
let writeOk = true
try {
  await ctx.settings.update(SETTINGS_NAMESPACE, { port: 19000 })
} catch (error) {
  writeOk = false
  console.log('   update failed:', error.message)
}
check('a settings write still succeeds', writeOk && readSection(ctx.settings, SETTINGS_NAMESPACE)?.port === 19000)

await ctx.stop?.()
console.log(failed ? 'RESULT: FAILED' : 'RESULT: OK')
process.exit(failed ? 1 : 0)
