/**
 * Realm-driven rendering contract.
 *
 * The settings page is a function of the reading it is handed: the realm picker
 * echoes the committed realm, the account and model sections describe that same
 * realm, and the CN-only controls (check-in, claim credits) appear only there.
 * These assertions pin those couplings without a browser, so a regression in the
 * realm plumbing fails here instead of on screen.
 *
 * @module dsh-plugin-workbuddy-gateway/tests/client-realm
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

const localDateKey = (date = new Date()) => {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** The inert React stand-in the other client tests use. */
function fakeReact(data) {
  let hookIndex = 0
  return {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
    useState: (initial) => [hookIndex++ === 0 ? { phase: 'ready', data } : initial, () => {}],
    useRef: (current) => ({ current }),
    useCallback: (callback) => callback,
    useEffect: () => {},
  }
}

/** Render the section for one reading, with no host round-trip. */
function render(data, language = 'en') {
  let section = null
  runInNewContext(source, {
    navigator: { language },
    window: { __ModuleLoader__: { load({ factory }) {
      factory(() => fakeReact(data)).apply({
        effect: () => () => {},
        slots: {
          inject: (_slot, register) => register(),
          register: (_definition, component) => { section = component },
        },
      })
    } } },
  })
  assert.ok(section, 'the section must register')
  return section()
}

/**
 * All virtual elements below a rendered node, expanding function components —
 * `StateBadge`, `Field`, and the inline `action()` helper are plain functions.
 */
function elements(node) {
  if (node === null || typeof node !== 'object') return []
  if (typeof node.type === 'function') return elements(node.type(node.props))
  return [node, ...(node.children ?? []).flatMap(elements)]
}

/** Concatenated visible strings below a node. */
function visibleText(node) {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(visibleText).join(' ')
}

/** One reading for a realm, with an account and a model in that realm. */
function reading(realm, { claimed = false, lastCheckin = null } = {}) {
  const other = realm === 'cn' ? 'intl' : 'cn'
  return {
    gateway: { state: 'running', baseUrl: 'http://127.0.0.1:18088/v1', pid: 1, uptimeMs: 1000, log: [] },
    settings: { realm, port: 18088, keyConfigured: true, autoStart: true, providerSync: true },
    account: {
      accounts: [{
        uid: 'sample',
        nickname: 'Sample',
        realm,
        realmName: realm,
        enabled: true,
        credits: { remain: 12.34 },
        checkinClaimed: realm === 'cn' ? claimed : null,
        lastCheckin: lastCheckin ?? (claimed ? `${localDateKey()} 12:00:00` : null),
      }],
      usable: 1,
    },
    provider: { present: true, routes: ['workbuddy'] },
    models: [{ id: `${realm}-model`, context_length: 1000, max_output_tokens: 100 }],
    activeRealm: realm,
    modelsRealm: other,
    reads: { accounts: null, models: null, realm: null },
  }
}

const buttons = (tree) => elements(tree)
  .filter((node) => node.type === 'button')
  .map((node) => visibleText(node))

const realmPicker = (tree) => elements(tree).find((node) => node.type === 'select')

test('the realm picker is bound to the committed realm', () => {
  for (const realm of ['intl', 'cn']) {
    const picker = realmPicker(render(reading(realm)))
    assert.ok(picker, `a picker renders for ${realm}`)
    assert.equal(picker.props.value, realm)
    // Both concrete realms stay offered, plus the "follow the gateway" option.
    assert.deepEqual(picker.children.map((option) => option.props.value), ['', 'intl', 'cn'])
  }
})

test('the CN-only controls appear only in the CN realm', () => {
  const cn = render(reading('cn'))
  assert.ok(buttons(cn).includes('Check in'), 'CN offers per-account and bulk check-in')
  assert.ok(buttons(cn).includes('Claim credits'), 'CN offers the growth-task claim')

  const intl = render(reading('intl'))
  assert.ok(!buttons(intl).includes('Claim credits'), 'the international realm has no claim endpoint')
  assert.ok(!buttons(intl).includes('Check in'), 'the international realm has no check-in endpoint')
})

test('a CN account card shows whether today was claimed', () => {
  const claimed = render(reading('cn', { claimed: true }))
  const claimTag = elements(claimed).find((node) => node?.props?.title === `${localDateKey()} 12:00:00`)
  assert.ok(claimTag, 'the claimed tag carries the confirmation time')
  assert.equal(visibleText(claimTag), 'Checked in')

  const pending = render(reading('cn'))
  assert.match(visibleText(pending), /Not checked in/)

  // The international realm never shows a claim state.
  const intl = render(reading('intl'))
  assert.ok(!/Checked in|Not checked in/.test(visibleText(intl)))
})

test('a previous day claim is shown as not checked in today', () => {
  const oldClaim = render(reading('cn', { claimed: true, lastCheckin: '2000-01-01 12:00:00' }))
  assert.match(visibleText(oldClaim), /Not checked in/)
})

test('the account and model sections describe the same realm as the setting', () => {
  const tree = render(reading('cn'))
  const text = visibleText(tree)
  assert.match(text, /Active gateway realm: China \(codebuddy\.cn\)/)
  // modelsRealm is deliberately the other realm here: the label must follow the
  // catalog, not the setting, so a stale catalog is visible on screen.
  assert.match(text, /Model catalog realm: Global \(workbuddy\.ai\)/)
})

test('the duplicate refresh buttons are told apart', () => {
  const list = buttons(render(reading('cn')))
  assert.ok(list.includes('Refresh all credits'), 'the toolbar button refreshes every account')
  assert.ok(list.includes('Refresh credits'), 'the account card button refreshes one account')
})
