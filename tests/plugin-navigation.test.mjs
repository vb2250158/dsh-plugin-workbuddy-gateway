import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('gateway controls are reachable from Plugins without a duplicate Settings entry', () => {
  const registered = []
  let client
  runInNewContext(readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => ({})) } } },
  })
  client.apply({ effect: () => {}, slots: {
    inject: (_slot, register) => register(),
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  } })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'plugins.bundle.config')
  assert.equal(registered[0].options.key, 'dsh-plugin-workbuddy-gateway')
  assert.equal(typeof registered[0].component, 'function')
})
