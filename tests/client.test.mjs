/** Settings factory regression tests with an inert hook host and no network. */
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

/** Render the lazy factory's settings tree without scheduling polling effects. */
function render(accounts) {
  const data = {
    gateway: { state: 'running', log: [] },
    settings: { realm: 'cn', port: 18088 },
    account: { accounts, usable: accounts.length },
    provider: {},
  }
  let hookIndex = 0
  let section
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
    useState: (initial) => [hookIndex++ === 0 ? { phase: 'ready', data } : initial, () => {}],
    useRef: (current) => ({ current }),
    useCallback: (callback) => callback,
    useEffect: () => {},
  }
  runInNewContext(source, {
    navigator: { language: 'en' },
    window: { __ModuleLoader__: { load({ factory }) {
      factory(() => react).apply({ slots: {
        inject: (_slot, register) => register(),
        register: (_definition, component) => { section = component },
      } })
    } } },
  })
  return section()
}

/** All virtual elements below a rendered node. */
function elements(node) {
  if (node === null || typeof node !== 'object') return []
  return [node, ...node.children.flatMap(elements)]
}

/** Visible strings in the settings factory's tree. */
function visibleText(node) {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  return node.children.map(visibleText).join(' ')
}

test('account controls and realm selector stay inside the account card even with no accounts', () => {
  for (const accounts of [[], [{ uid: 'sample', nickname: 'Sample', realm: 'cn', enabled: true }]]) {
    const tree = render(accounts)
    const card = tree.children.find((node) => node?.props?.key === 'accountsCard')
    assert.ok(card)
    assert.equal(elements(card).filter((node) => node.type === 'select').length, 1)
    const text = visibleText(card)
    // 工具栏按钮作用于全部账号，文案必须与账号卡片上的区分开。
    assert.match(text, /Refresh all credits/)
    assert.match(text, /Disable all/)
    assert.match(text, accounts.length === 0 ? /No accounts yet/ : /Sample/)
    assert.ok(tree.children.some((node) => node?.props?.key === 'providerCard'))
  }
})

test('account card displays confirmed claim status and localized credits', () => {
  const tree = render([{ uid: 'sample', realm: 'cn', enabled: true,
    checkinClaimed: true, lastCheckin: `${localDateKey()} 12:00:00`, credits: { remain: 100 } }])
  // 签到状态现在是账号卡片上的标签，确认时间放在标签的 title 里。
  assert.match(visibleText(tree), /Checked in/)
  const claimTag = elements(tree).find((node) => node?.props?.title === `${localDateKey()} 12:00:00`)
  assert.ok(claimTag, 'the check-in tag carries the confirmation time')
  assert.equal(visibleText(claimTag), 'Checked in')
  assert.match(visibleText(tree), /100 credits/)
  const buttons = elements(tree).filter((node) => node.type === 'button').map(visibleText)
  assert.ok(buttons.includes('Disable'))
  assert.ok(buttons.includes('Disable all'))
})


test('account model limits show model names and hide expired deadlines', () => {
  const text = visibleText(render([{ uid: 'limited', realm: 'intl', enabled: true,
    modelRateLimits: { 'limited-model': Date.now() / 1000 + 3600, 'expired-model': 1 } }]))
  assert.match(text, /limited-model rate limited until/)
  assert.doesNotMatch(text, /expired-model/)
  assert.match(text, /model restrictions and reset times/)
})
