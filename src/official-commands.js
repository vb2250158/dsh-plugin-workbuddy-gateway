/**
 * Direct official CodeBuddy commands and their durable continuation ownership.
 * The CLI owns authentication and its transcript; DSH stores the pairing only.
 * @module dsh-plugin-workbuddy-gateway/official-commands
 */
import { access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, delimiter } from 'node:path'
import { z } from 'zod'
import { OfficialCliClient, officialCliArgv } from './official-cli.js'

const recordSchema = z.object({
  remoteSessionId: z.string().min(1).max(512).nullable(),
  model: z.string().min(1).max(200),
  cwd: z.string().min(1),
  cliEntry: z.string().min(1),
  nodePath: z.string().min(1),
  realm: z.literal('cn'),
  authSource: z.literal('official-cli-login'),
  state: z.enum(['ready', 'running', 'unknown']),
  operationId: z.string().uuid(),
  updatedAt: z.string().datetime(),
}).strict()

/** Local-only pairing records, validated by the Host storage-domain owner. */
export const OFFICIAL_DOMAIN = Object.freeze({
  name: 'workbuddy_official_cli',
  version: 1,
  tables: { sessions: { valueSchema: recordSchema } },
})

const failure = text => ({ kind: 'error', text })
const success = text => ({ kind: 'success', text })

/**
 * Construct the direct command owner with injectable storage and transport.
 * @param {object} options - domain table, authoritative settings, directory and subprocess services.
 * @returns {object} execute, stop, reset, and cooperative dispose operations.
 */
export function createOfficialCommands({
  store, settings, directory, spawn,
  clientFactory = options => new OfficialCliClient(options),
  checkPath = access,
}) {
  const active = new Map()
  let disposed = false
  const save = (id, value) => store.put(id, recordSchema.parse({
    ...value, updatedAt: new Date().toISOString(),
  }))

  /** Execute one human command without scheduling the DSH main model. */
  async function execute({ agent, rawInput, signal }) {
    const id = agent.session.id
    if (disposed) return failure('官方 CodeBuddy 入口正在关闭。')
    if (active.has(id)) return failure('本会话的 CodeBuddy 仍在运行；请等待或使用 /codebuddy-stop。')
    const config = settings()
    if (!config.officialCliEnabled) return failure('请先启用官方 CodeBuddy CLI 入口并配置其安装路径。')
    const prompt = rawInput.trim()
    if (!prompt) return failure('用法：/codebuddy 任务内容。同一 DSH 会话会继续同一个官方会话。')
    if (Buffer.byteLength(prompt, 'utf8') > 256 * 1024) {
      return failure('任务内容超过 256 KiB，请缩短后再发送。')
    }
    const existing = store.get(id)
    if (existing && existing.state !== 'ready') {
      return failure('上次 CodeBuddy 操作尚未确认结束；已保留原会话，请先核对其结果，不会自动重发。')
    }
    const cwd = directory(agent.session)
    const model = config.officialCliModel || agent.model.current()?.model
    const entry = config.officialCliEntry
    const nodePath = config.officialCliNode || process.execPath
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(model)) {
      return failure('当前会话没有可用的模型 ID；请明确配置官方 CLI 模型，不会自动换模型。')
    }
    if (typeof entry !== 'string' || !isAbsolute(entry) || !isAbsolute(nodePath) || !isAbsolute(cwd)) {
      return failure('官方 CLI、Node 入口和当前工作区必须是绝对路径。')
    }
    if (existing && (existing.cwd !== cwd || existing.model !== model
      || existing.cliEntry !== entry || existing.nodePath !== nodePath)) {
      return failure('本会话的工作区、模型或 CLI 入口已变化。原官方会话仍保留；使用 /codebuddy-new 建立新绑定。')
    }
    const operation = { controller: new AbortController(), client: null, finished: null }
    // Acquire before path checks or persistence so another invocation cannot race.
    active.set(id, operation)
    const abort = () => operation.controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let release
    operation.finished = new Promise(resolve => { release = resolve })
    const record = {
      remoteSessionId: existing?.remoteSessionId ?? null, model, cwd,
      cliEntry: entry, nodePath, realm: 'cn', authSource: 'official-cli-login',
      state: 'running', operationId: randomUUID(), updatedAt: new Date().toISOString(),
    }
    let sessionAdmitted = false
    let intentSaved = false
    try {
      await Promise.all([checkPath(entry), checkPath(nodePath), checkPath(cwd)])
      if (operation.controller.signal.aborted) return failure('CodeBuddy 操作已取消，尚未发送任务。')
      await save(id, record)
      intentSaved = true
      operation.client = clientFactory({
        spawn, cwd,
        argv: officialCliArgv({ nodePath, cliPath: entry, model }),
        env: {
          CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
          CODEBUDDY_DISABLE_COMPILE_CACHE: '1',
          CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
          CODEBUDDY_AUTH_TOKEN: undefined, CODEBUDDY_API_KEY: undefined,
          CODEBUDDY_BASE_URL: undefined, ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
          NODE_OPTIONS: undefined,
          PATH: dirname(nodePath) + delimiter + (process.env.PATH ?? ''),
        },
      })
      const result = await operation.client.run({
        prompt, sessionId: record.remoteSessionId ?? undefined,
        signal: operation.controller.signal,
        onSession: async remoteSessionId => {
          record.remoteSessionId = remoteSessionId
          await save(id, record)
          // The transport awaits this hook before sending the print-mode user message.
          sessionAdmitted = true
        },
      })
      if (result.cleanExit !== true) throw new Error('Official CLI exit remains unknown')
      record.remoteSessionId = result.sessionId
      record.state = 'ready'
      await save(id, record)
      if (result.stopReason !== 'end_turn') return failure('CodeBuddy 未正常完成本轮；原官方会话已保留。')
      if (typeof result.text !== 'string' || !result.text.trim()) return failure('CodeBuddy 本轮没有返回正文；不会自动重发。')
      return success(result.text)
    } catch (caught) {
      const facts = caught !== null && typeof caught === 'object' ? caught : {}
      const cleanCancellation = facts.code === 'CANCELLED'
        && facts.cleanup === 'clean' && facts.confirmedCancelled === true
      if (intentSaved) {
        record.state = cleanCancellation || (!sessionAdmitted && facts.cleanup !== 'unknown') ? 'ready' : 'unknown'
        try {
          await save(id, record)
        } catch (storageFailure) {
          // A rejected or uncertain durable write must not be disguised as ready.
          return failure('官方 CLI 操作的保存结果尚未确认；请保留本机会话并检查存储状态，不会自动重发。')
        }
      }
      if (cleanCancellation) {
        return failure('CodeBuddy 已正常停止；官方会话和已有结果保留。'
          + (typeof facts.partialText === 'string' && facts.partialText ? '\n\n' + facts.partialText : ''))
      }
      const explanation = facts.code === 'AUTH_REQUIRED'
        ? '请先通过官方 CodeBuddy 国内登录入口完成登录。'
        : '官方 CodeBuddy 操作失败；请检查本机 CLI 状态。不会换账号、改写身份或自动重发。'
      return failure(explanation + (record.state === 'unknown' ? ' 本轮结果尚未确认，原会话已保留。' : ''))
    } finally {
      signal?.removeEventListener('abort', abort)
      // Unknown managed ranges stay owned and block replacement processes.
      if (operation.client?.snapshot().cleanup !== 'unknown') active.delete(id)
      release()
    }
  }

  /** Request protocol cancellation and await this session's original operation. */
  async function stop({ agent }) {
    const id = agent.session.id
    const operation = active.get(id)
    if (!operation) return success('本会话没有正在运行的 CodeBuddy 操作。')
    operation.controller.abort()
    await operation.finished
    if (operation.client?.snapshot().cleanup === 'unknown') {
      return failure('已请求停止，但尚不能确认官方 CLI 已退出；保留任务归属，禁止自动重试。')
    }
    if (store.get(id)?.state === 'unknown') return failure('CLI 已退出，但本轮结果尚未确认；原官方会话保留。')
    return success('CodeBuddy 已停止，已有结果和官方会话保留。')
  }

  /** Start a new pairing only after the previous operation has a known terminal state. */
  async function reset({ agent }) {
    if (disposed) return failure('官方 CodeBuddy 入口正在关闭。')
    const id = agent.session.id
    if (active.has(id) || (store.get(id) && store.get(id).state !== 'ready')) {
      return failure('仍有运行中或结果未知的操作，不能丢弃其会话绑定。')
    }
    await store.delete(id)
    return success('下次 /codebuddy 将新建官方会话；原官方历史没有删除。')
  }

  return {
    execute, stop, reset,
    async dispose() {
      disposed = true
      const operations = [...active.values()]
      for (const operation of operations) operation.controller.abort()
      await Promise.all(operations.map(operation => operation.finished))
      for (const [id, operation] of active) {
        if (await operation.client.reconcileExit()) active.delete(id)
      }
      if (active.size) throw new Error('Official CodeBuddy managed ranges remain unconfirmed')
    },
  }
}

/**
 * Mount optional public services without making them core startup prerequisites.
 * @param {object} ctx - owning plugin context.
 * @param {Function} readSettings - authoritative live settings reader.
 */
export function mountOfficialCommands(ctx, readSettings) {
  ctx.inject(['commands', 'storageDomain', 'subprocess', 'workingDirectory'], injected => {
    let initialization
    let closed = false
    // A disabled bridge must not open storage or affect gateway startup.
    const initialize = () => {
      if (!initialization) {
        initialization = (async () => {
          const domain = await injected.storageDomain.open(OFFICIAL_DOMAIN)
          const owner = createOfficialCommands({
            store: domain.table('sessions'), settings: readSettings,
            directory: session => injected.workingDirectory.get(session),
            spawn: spec => injected.subprocess.spawn(spec),
          })
          return { domain, owner }
        })().catch(caught => {
          initialization = undefined
          throw caught
        })
      }
      return initialization
    }
    injected.effect(() => async () => {
      closed = true
      if (!initialization) return
      const { domain, owner } = await initialization
      await owner.dispose()
      await domain.close()
    }, 'workbuddy: official CLI commands')
    for (const [name, description, operation] of [
      ['codebuddy', '通过已登录的国内官方 CodeBuddy 处理任务；默认只读', 'execute'],
      ['codebuddy-stop', '停止本会话的官方 CodeBuddy 操作并保留已有结果', 'stop'],
      ['codebuddy-new', '为下次官方 CodeBuddy 请求建立新会话绑定', 'reset'],
    ]) {
      injected.commands.register({
        name, description,
        handler: async invocation => {
          if (closed) return failure('官方 CodeBuddy 入口正在关闭。')
          if (operation === 'execute' && !readSettings().officialCliEnabled) {
            return failure('请先启用官方 CodeBuddy CLI 入口并配置其安装路径。')
          }
          if (operation === 'stop' && !initialization) {
            return success('当前入口没有持有运行中的 CodeBuddy 操作；历史记录保持原样。')
          }
          let owner
          try {
            const initialized = await initialize()
            owner = initialized.owner
          } catch (storageFailure) {
            return failure('无法读取官方 CodeBuddy 的本机会话映射；请检查存储状态，尚未发送任务。')
          }
          return owner[operation](invocation)
        },
      })
    }
  })
}
