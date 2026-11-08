import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createOfficialCommands, OFFICIAL_DOMAIN, mountOfficialCommands } from '../src/official-commands.js'

const paths = { cwd: resolve('test-project'), entry: resolve('test-cli.mjs'), node: process.execPath }
const agent = { session: { id: 'dsh-test-session' }, model: { current: () => ({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }) } }
const invocation = (rawInput = 'read one file') => ({ agent, rawInput, signal: new AbortController().signal })

function setup({ run, put, config = {}, factory } = {}) {
  const records = new Map(), writes = [], clients = [], options = []
  const store = {
    get: id => records.get(id),
    put: async (id, record) => { if (put) await put(id, record); writes.push(structuredClone(record)); records.set(id, structuredClone(record)) },
    delete: async id => records.delete(id),
  }
  const settings = {
    officialCliEnabled: true, officialCliNode: paths.node,
    officialCliEntry: paths.entry, officialCliModel: '', ...config,
  }
  const owner = createOfficialCommands({
    store, settings: () => settings, directory: () => paths.cwd, spawn: () => { throw Error('unexpected direct spawn') },
    checkPath: async () => {},
    clientFactory: value => {
      options.push(value)
      const client = factory ? factory(value) : {
        snapshot: () => ({ cleanup: 'clean' }),
        reconcileExit: async () => true,
        run: async request => {
          clients.push(request)
          if (run) return run(request)
          assert.equal(records.get(agent.session.id).state, 'running')
          await request.onSession('official-session-one')
          assert.equal(records.get(agent.session.id).remoteSessionId, 'official-session-one')
          return { sessionId: 'official-session-one', text: 'official reply', stopReason: 'end_turn', cleanExit: true }
        },
      }
      return client
    },
  })
  return { owner, records, writes, clients, options, settings, store }
}

test('two direct commands continue the same persisted official session without touching a main model', async () => {
  const s = setup()
  assert.deepEqual(await s.owner.execute(invocation('first')), { kind: 'success', text: 'official reply' })
  assert.equal(s.clients[0].sessionId, undefined)
  assert.equal(s.records.get(agent.session.id).state, 'ready')
  assert.deepEqual(await s.owner.execute(invocation('second')), { kind: 'success', text: 'official reply' })
  assert.equal(s.clients[1].sessionId, 'official-session-one')
  assert.equal(s.clients[1].prompt, 'second')
  assert.equal(s.options[0].env.CODEBUDDY_INTERNET_ENVIRONMENT, 'internal')
  for (const name of ['CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY', 'CODEBUDDY_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'NODE_OPTIONS']) {
    assert(Object.hasOwn(s.options[0].env, name))
    assert.equal(s.options[0].env[name], undefined)
  }
  assert.equal(s.options[0].argv[s.options[0].argv.indexOf('--tools') + 1], 'Read,Glob,Grep')
  assert(s.options[0].argv.includes('--strict-mcp-config'))
  assert.equal(s.writes.filter(record => record.state === 'running').length, 4)
  assert(!JSON.stringify(s.writes).includes('first'))
  assert(!JSON.stringify(s.writes).includes('second'))
})

test('initial durable intent failure prevents a CLI process', async () => {
  const s = setup({ put: async () => { throw Error('disk full') } })
  assert.equal((await s.owner.execute(invocation())).kind, 'error')
  assert.equal(s.options.length, 0)
})

test('session pairing is committed before the transport is permitted to prompt', async () => {
  let allowedToPrompt = false, writes = 0
  const s = setup({
    put: async () => { if (++writes === 2) throw Error('session map write failed') },
    run: async request => {
      await request.onSession('created-not-prompted')
      allowedToPrompt = true
    },
  })
  assert.equal((await s.owner.execute(invocation())).kind, 'error')
  assert.equal(allowedToPrompt, false)
  assert.equal(s.records.get(agent.session.id).state, 'ready')
})

test('same-session concurrency is refused before a second transport starts', async () => {
  let finish, entered
  const started = new Promise(resolve => { entered = resolve })
  const s = setup({ run: async request => {
    await request.onSession('active-session'); entered()
    return new Promise(resolve => { finish = () => resolve({ sessionId: 'active-session', text: 'done', stopReason: 'end_turn', cleanExit: true }) })
  } })
  const first = s.owner.execute(invocation())
  await started
  assert.match((await s.owner.execute(invocation())).text, /仍在运行/u)
  assert.equal(s.options.length, 1)
  finish()
  await first
})

test('official model or executable changes never silently reuse the previous session', async () => {
  const s = setup()
  await s.owner.execute(invocation())
  s.settings.officialCliModel = 'other-model'
  assert.match((await s.owner.execute(invocation())).text, /已变化/u)
  assert.equal(s.options.length, 1)
  assert.equal((await s.owner.reset({ agent })).kind, 'success')
  await s.owner.execute(invocation())
  assert.equal(s.clients[1].sessionId, undefined)
})

test('unknown outcome remains durable and is not replayed after owner recreation', async () => {
  const s = setup({ run: async request => {
    await request.onSession('unknown-session')
    throw Object.assign(Error('opaque failure'), { code: 'TRANSPORT_ERROR', cleanup: 'clean' })
  } })
  assert.equal((await s.owner.execute(invocation())).kind, 'error')
  assert.equal(s.records.get(agent.session.id).state, 'unknown')
  assert.equal((await s.owner.reset({ agent })).kind, 'error')
  const reopened = createOfficialCommands({
    store: s.store, settings: () => s.settings, directory: () => paths.cwd,
    spawn: () => { throw Error('must not replay') }, checkPath: async () => {},
  })
  assert.match((await reopened.execute(invocation())).text, /不会自动重发/u)
})

test('stop waits for confirmed protocol cancellation and preserves partial generated text', async () => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const s = setup({ run: async request => {
    await request.onSession('cancelled-session')
    entered()
    await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
    throw Object.assign(Error('cancelled'), {
      code: 'CANCELLED', cleanup: 'clean', confirmedCancelled: true, partialText: 'already produced',
    })
  } })
  const first = s.owner.execute(invocation())
  await started
  assert.equal((await s.owner.stop({ agent })).kind, 'success')
  assert.match((await first).text, /already produced/u)
  assert.equal(s.records.get(agent.session.id).state, 'ready')
})

test('sending cancel without a confirmed terminal response remains unknown', async () => {
  const s = setup({ run: async request => {
    await request.onSession('unconfirmed-session')
    throw Object.assign(Error('unknown cancellation'), { code: 'CANCELLED', cleanup: 'clean', confirmedCancelled: false })
  } })
  await s.owner.execute(invocation())
  assert.equal(s.records.get(agent.session.id).state, 'unknown')
})

test('unknown managed range stays owned and blocks subsequent invocation and reset', async () => {
  const s = setup({ factory: () => ({
    snapshot: () => ({ cleanup: 'unknown' }), reconcileExit: async () => false,
    run: async request => { await request.onSession('unknown-range'); throw Object.assign(Error('range unknown'), { code: 'EXIT_UNKNOWN', cleanup: 'unknown' }) },
  }) })
  await s.owner.execute(invocation())
  assert.match((await s.owner.execute(invocation())).text, /仍在运行/u)
  assert.equal((await s.owner.reset({ agent })).kind, 'error')
  await assert.rejects(s.owner.dispose(), /remain unconfirmed/u)
})

test('authentication failure before session admission does not poison a safe retry', async () => {
  const s = setup({ run: async () => { throw Object.assign(Error('auth'), { code: 'AUTH_REQUIRED', cleanup: 'clean' }) } })
  assert.match((await s.owner.execute(invocation())).text, /完成登录/u)
  assert.equal(s.records.get(agent.session.id).state, 'ready')
})

test('cancel before any work never opens a transport or persists an intent', async () => {
  const s = setup(), controller = new AbortController()
  controller.abort()
  assert.match((await s.owner.execute({ ...invocation(), signal: controller.signal })).text, /尚未发送/u)
  assert.equal(s.options.length, 0)
  assert.equal(s.writes.length, 0)
})

test('domain rejects malformed or extra credential fields', () => {
  const schema = OFFICIAL_DOMAIN.tables.sessions.valueSchema
  assert.equal(schema.safeParse({ state: 'ready', token: 'not-a-record' }).success, false)
  const valid = {
    remoteSessionId: null, model: 'deepseek-v4.1-flash', cwd: paths.cwd, cliEntry: paths.entry,
    nodePath: paths.node, realm: 'cn', authSource: 'official-cli-login', state: 'ready',
    operationId: 'b1ae077f-580c-415a-8555-91ad6d4f1384', updatedAt: new Date().toISOString(),
  }
  assert.equal(schema.safeParse(valid).success, true)
  assert.equal(schema.safeParse({ ...valid, accessToken: 'forbidden' }).success, false)
})

test('mount registers direct commands through optional services and closes its own domain', async () => {
  let injection, closed = false, opened = 0
  const settings = { officialCliEnabled: false }
  const registrations = [], cleanups = []
  const ctx = { inject: (services, callback) => { injection = { services, callback } } }
  mountOfficialCommands(ctx, () => settings)
  assert.deepEqual(injection.services, ['commands', 'storageDomain', 'subprocess', 'workingDirectory'])
  await injection.callback({
    commands: { register: definition => registrations.push(definition) },
    storageDomain: { open: async spec => {
      opened++
      assert.equal(spec, OFFICIAL_DOMAIN)
      return { table: () => ({ get() {}, put() {}, delete() {} }), close: async () => { closed = true } }
    } },
    subprocess: { spawn() { throw Error('disabled mount cannot spawn') } },
    workingDirectory: { get: () => paths.cwd },
    effect: effect => cleanups.push(effect()),
  })
  assert.deepEqual(registrations.map(item => item.name), ['codebuddy', 'codebuddy-stop', 'codebuddy-new'])
  assert.equal((await registrations[0].handler(invocation())).kind, 'error')
  assert.equal(opened, 0)
  settings.officialCliEnabled = true
  assert.equal((await registrations[0].handler(invocation(''))).kind, 'error')
  assert.equal(opened, 1)
  await cleanups[0]()
  assert.equal(closed, true)
})

test('the official mapping domain satisfies the Host storage unit-name grammar', () => {
  assert.match(OFFICIAL_DOMAIN.name, /^[a-z][a-z0-9_]*$/)
  for (const table of Object.keys(OFFICIAL_DOMAIN.tables)) assert.match(table, /^[a-z][a-z0-9_]*$/)
})
