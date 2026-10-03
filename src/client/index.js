/**
 * Browser half of `dsh-plugin-workbuddy-gateway`.
 *
 * This file is the loader's lazy-CJS factory artifact: the page injects
 * `window.__ModuleLoader__`, and the client module system loads it when the
 * profile composes the package. `react` is the only external, and it comes from
 * the loader's module table rather than a bundled copy.
 *
 * It contributes one section to the settings panel (`settings.section`): the
 * gateway's lifecycle controls, its accounts, its model inventory, and the
 * `llm-pi-ai` route that puts those models in the picker. All data comes from
 * the host half over same-origin `fetch`; this file only renders and polls.
 *
 * @module dsh-plugin-workbuddy-gateway/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-workbuddy-gateway',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** Host bridge base; mirrors `ROUTE_BASE` in the host half. */
    const BASE = '/dsh-workbuddy-gateway/api/v1'

    /** Poll interval while the gateway is running or starting. */
    const POLL_ACTIVE_MS = 2000

    /** Poll interval while the gateway is stopped or failed. */
    const POLL_IDLE_MS = 5000

    /** Two languages, as the rest of this machine's plugins do. */
    const COPY = {
      zh: {
        nav: 'WorkBuddy',
        intro: '把 WorkBuddy（workbuddy.ai / codebuddy.cn）的订阅额度变成 DSH 可用的模型。插件负责托管本地反代网关、管理账号，并写入对应的模型提供方路由。',
        state: {
          running: '运行中',
          starting: '启动中',
          stopped: '已停止',
          failed: '启动失败',
        },
        stateHint: {
          running: '网关正在提供 OpenAI 兼容接口',
          starting: '正在等待网关报告监听成功',
          stopped: '网关未运行，WorkBuddy 模型不可用',
          failed: '网关启动失败或已退出，见下方日志',
        },
        start: '启动',
        stop: '停止',
        restart: '重启',
        refresh: '刷新',
        starting: '正在启动…',
        stopping: '正在停止…',
        gateway: '网关',
        endpoint: '接口地址',
        pid: '进程',
        uptime: '已运行',
        port: '端口',
        gatewayDir: '网关目录',
        pythonPath: 'Python 解释器',
        platform: '平台',
        script: '启动脚本',
        accountStore: '账号目录',
        usageStore: '用量目录',
        applyPort: '应用端口',
        portNote: '改动端口会同时更新模型路由里的接口地址；需要重启网关才生效。',
        key: '接口密钥',
        keySet: '已配置',
        keyUnset: '未配置',
        keyNote: '密钥存放在 DSH 的凭据库里（WORKBUDDY_API_KEY），不写进 settings.yaml。网关与模型路由都用它。',
        generateKey: '生成密钥',
        clearKey: '清除密钥',
        keyOnce: (value) => `新密钥（只显示这一次）：${value}`,
        accounts: '账号',
        noAccounts: '还没有账号。用下面的「浏览器授权登录」，或从本机 WorkBuddy 桌面端导入。',
        // The gateway filters its account list by realm, so both numbers are
        // scoped to one realm; a cross-realm "usable" count was the bug.
        accountUsable: (usable, total) => `本区可用 ${usable} / 共 ${total}`,
        accountScopeNote: '只列出当前区域的账号。另一个区（国内版 / 国际版）需要切换区域才会显示。',
        realm: '区域',
        realmIntl: '国际版 (workbuddy.ai)',
        realmCn: '国内版 (codebuddy.cn)',
        realmDefault: '跟随网关当前设置',
        realmNote: '网关运行时切换区域立即生效；停止时在下次启动应用。',
        realmSwitched: '区域设置已保存。请查看网关当前区域和模型清单。',
        activeRealm: '网关当前区域',
        modelsRealm: '模型清单所属区域',
        realmUnknown: '未确认',
        modelLimited: (model, time) => `${model} 限流至 ${time}（预计）`,
        limitsNote: '可用数量表示账号基础状态；模型限制请看各账号下方的恢复时间。',
        realmStopped: '网关未运行',
        realmManual: '自动维护已关闭；请点击「写入模型路由」更新 DSH 模型选项。',
        expires: (text) => `${text} 后过期`,
        disabled: '已停用',
        scan: '扫描桌面端账号',
        // 工具栏按钮作用于全部账号，账号卡片按钮只作用于自己；两者文案必须能
        // 区分，否则并排出现时点错按钮会被误当成「单个刷新变成了全部刷新」。
        refreshAllCredits: '刷新全部积分',
        refreshAccountCredits: '刷新积分',
        claimCredits: '领取积分',
        checkin: '签到',
        checkedIn: (time) => `已签到${time ? ` · ${time}` : ''}`,
        notCheckedIn: '未签到',
        enableAll: '全部启用',
        disableAll: '全部停用',
        enable: '启用',
        disable: '停用',
        creditBalance: (value) => `${value} 积分`,
        taskClaimed: '积分任务已执行，请刷新积分查看结果。',
        scanNote: '只读取本机 WorkBuddy 桌面端已有的凭证，不会修改它。',
        import: '导入',
        imported: (name) => `已导入 ${name}`,
        remove: '移除',
        confirmRemove: '确认移除',
        cancel: '取消',
        login: '浏览器授权登录',
        loginStarted: '已在浏览器打开授权页；完成后账号会自动出现。',
        loginWait: '等待授权…',
        loginDone: '授权完成',
        loginFailed: (message) => `授权失败：${message}`,
        openLink: '打开授权链接',
        models: '模型',
        modelsNote: (count) => `网关提供 ${count} 个模型。`,
        modelContext: '上下文',
        modelOutput: '最大输出',
        modelReasoning: '推理档位',
        modelVision: '图片',
        provider: '模型路由',
        providerPresent: '已写入 settings.yaml',
        providerAbsent: '未写入',
        providerNote: '把网关的模型注册成 DSH 的提供方，模型选择器里就会出现。只增删本插件自己那一条路由，不动其他提供方。',
        providerSync: '写入模型路由',
        providerRemove: '移除模型路由',
        providerWaiting: '需要先启动网关才能读取模型清单。',
        providerSynced: (count) => `已写入 ${count} 个模型。`,
        providerRemoved: '已移除模型路由。',
        log: '网关日志',
        logEmpty: '暂无输出。',
        readErrors: '部分读取失败',
        busy: '处理中…',
        failed: (message) => `操作失败：${message}`,
        hostHint: 'host 半改动需要重启 dsh 才生效；本页刷新即可。',
        autostart: '随 dsh 启动',
        autoSync: '自动维护模型路由',
        save: '保存',
        saved: '已保存。',
      },
      en: {
        nav: 'WorkBuddy',
        intro: 'Turns a WorkBuddy (workbuddy.ai / codebuddy.cn) subscription into models DSH can use. The plugin supervises the local translation gateway, manages its accounts, and writes the matching provider route.',
        state: {
          running: 'Running',
          starting: 'Starting',
          stopped: 'Stopped',
          failed: 'Failed',
        },
        stateHint: {
          running: 'The gateway is serving an OpenAI-compatible endpoint',
          starting: 'Waiting for the gateway to report that it is listening',
          stopped: 'The gateway is not running, so WorkBuddy models are unavailable',
          failed: 'The gateway failed to start or has exited — see the log below',
        },
        start: 'Start',
        stop: 'Stop',
        restart: 'Restart',
        refresh: 'Refresh',
        starting: 'Starting…',
        stopping: 'Stopping…',
        gateway: 'Gateway',
        endpoint: 'Endpoint',
        pid: 'Process',
        uptime: 'Uptime',
        port: 'Port',
        gatewayDir: 'Gateway directory',
        pythonPath: 'Python interpreter',
        platform: 'Platform',
        script: 'Launch script',
        accountStore: 'Account store',
        usageStore: 'Usage store',
        applyPort: 'Apply port',
        portNote: 'Changing the port also updates the endpoint in the provider route; restart the gateway for it to take effect.',
        key: 'API key',
        keySet: 'Configured',
        keyUnset: 'Not configured',
        keyNote: 'The key lives in DSH\'s credential store (WORKBUDDY_API_KEY), never in settings.yaml. Both the gateway and the provider route use it.',
        generateKey: 'Generate key',
        clearKey: 'Clear key',
        keyOnce: (value) => `New key (shown once): ${value}`,
        accounts: 'Accounts',
        noAccounts: 'No accounts yet. Use "Sign in via browser" below, or import from the local WorkBuddy desktop app.',
        // Both numbers are scoped to one realm, because that is how the gateway
        // filters its account list.
        accountUsable: (usable, total) => `${usable} usable of ${total} in this realm`,
        accountScopeNote: 'Only accounts in the current realm are listed. Switch realms to see the other one.',
        realm: 'Realm',
        realmIntl: 'Global (workbuddy.ai)',
        realmCn: 'China (codebuddy.cn)',
        realmDefault: 'Follow the gateway\'s current setting',
        realmNote: 'Realm changes apply immediately while the gateway is running, or on its next start.',
        realmSwitched: 'Realm saved. Check the active gateway realm and model catalog.',
        activeRealm: 'Active gateway realm',
        modelsRealm: 'Model catalog realm',
        realmUnknown: 'Not confirmed',
        modelLimited: (model, time) => `${model} rate limited until ${time} (estimated)`,
        limitsNote: 'The count reflects account readiness; model restrictions and reset times appear below each account.',
        realmStopped: 'Gateway not running',
        realmManual: 'Automatic maintenance is off; sync the model route to update the DSH model picker.',
        expires: (text) => `expires in ${text}`,
        disabled: 'disabled',
        scan: 'Scan desktop accounts',
        refreshAllCredits: 'Refresh all credits',
        refreshAccountCredits: 'Refresh credits',
        claimCredits: 'Claim credits',
        checkin: 'Check in',
        checkedIn: (time) => `Checked in${time ? ` · ${time}` : ''}`,
        notCheckedIn: 'Not checked in',
        enableAll: 'Enable all',
        disableAll: 'Disable all',
        enable: 'Enable',
        disable: 'Disable',
        creditBalance: (value) => `${value} credits`,
        taskClaimed: 'Credit tasks ran; refresh credits to see the result.',
        scanNote: 'Reads credentials the local WorkBuddy desktop app already has, and does not modify them.',
        import: 'Import',
        imported: (name) => `Imported ${name}`,
        remove: 'Remove',
        confirmRemove: 'Confirm remove',
        cancel: 'Cancel',
        login: 'Sign in via browser',
        loginStarted: 'The authorization page was opened in your browser; the account appears here once you finish.',
        loginWait: 'Waiting for authorization…',
        loginDone: 'Authorized',
        loginFailed: (message) => `Authorization failed: ${message}`,
        openLink: 'Open authorization link',
        models: 'Models',
        modelsNote: (count) => `The gateway serves ${count} model(s).`,
        modelContext: 'Context',
        modelOutput: 'Max output',
        modelReasoning: 'Reasoning',
        modelVision: 'Images',
        provider: 'Provider route',
        providerPresent: 'Written to settings.yaml',
        providerAbsent: 'Not written',
        providerNote: 'Registers the gateway\'s models as a DSH provider so they appear in the model picker. It only adds or removes this plugin\'s own route and never touches other providers.',
        providerSync: 'Write provider route',
        providerRemove: 'Remove provider route',
        providerWaiting: 'Start the gateway first so its model list can be read.',
        providerSynced: (count) => `Wrote ${count} model(s).`,
        providerRemoved: 'Provider route removed.',
        log: 'Gateway log',
        logEmpty: 'No output yet.',
        readErrors: 'Some reads failed',
        busy: 'Working…',
        failed: (message) => `Failed: ${message}`,
        hostHint: 'Host-half changes need a dsh restart; this page only needs a refresh.',
        autostart: 'Start with dsh',
        autoSync: 'Keep the provider route in sync',
        save: 'Save',
        saved: 'Saved.',
      },
    }

    /** The copy object for one language tag. */
    const COPY_BY_LANGUAGE = { zh: COPY.zh, en: COPY.en }

    /** Language tag this page is reading, resolved once so its copy is stable. */
    const LANGUAGE = (() => {
      const tag = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language.toLowerCase()
        : 'en'
      return tag.startsWith('zh') ? 'zh' : 'en'
    })()

    /**
     * The current language's copy.
     *
     * Returns one of two module-level constants, so the object identity is
     * stable across renders and safe to use in a React dependency array — a
     * fresh object each render would restart the polling effect every time.
     */
    function copy() {
      return COPY_BY_LANGUAGE[LANGUAGE]
    }

    /** `12s` / `3m04s` / `2h11m` / `4d03h`. */
    function humanDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
      return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`
    }

    /** `1234` → `1.2k`, `1000000` → `1.0M`. */
    function humanCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value < 1000) return String(value)
      if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
      return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
    }

    /**
     * 设置页样式表。
     *
     * 对齐 Gitee 上 `iJetLi/deepseek-harness-codearts` 的 Jet Hub 样式
     * （`plugin-src/client/jet-hub-styles.js`）：CSS 类 + 一次 `<style>` 注入，
     * 而不是逐元素的行内 style 对象。类名前缀 `dsw-wb-`，对应 Jet Hub 的 `dim-jh-`。
     *
     * 色值只走主题变量 `--dsw-alias-*`，并保留浅色兜底；强调色沿用 Jet Hub 的
     * `#1677ff`，圆角、阴影、hover 过渡也与之一致。
     */
    const STYLES = `
.dsw-wb-page { display: flex; flex-direction: column; gap: 14px; padding: 2px 0 24px; color: var(--dsw-alias-label-primary, #1f2329); }

/* 头部：品牌在左，状态与操作在右 */
.dsw-wb-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsw-wb-brand { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsw-wb-brandName { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsw-wb-brandDesc { margin: 0; max-width: 72ch; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dsw-wb-headerActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

/* 状态徽章 */
.dsw-wb-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; line-height: 18px; font-weight: 600; white-space: nowrap; }
.dsw-wb-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.dsw-wb-badge[data-tone="running"] { color: #15803d; background: rgb(34 197 94 / 12%); }
.dsw-wb-badge[data-tone="starting"] { color: #b45309; background: rgb(227 116 0 / 12%); }
.dsw-wb-badge[data-tone="failed"] { color: #b3261e; background: rgb(217 48 37 / 12%); }
.dsw-wb-badge[data-tone="stopped"] { color: var(--dsw-alias-label-tertiary, #8f959e); background: rgb(143 149 158 / 12%); }

/* 卡片 */
.dsw-wb-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); transition: border-color .16s ease, box-shadow .16s ease; }
.dsw-wb-card:hover { border-color: color-mix(in srgb, #1677ff 22%, var(--dsw-alias-border-l2, #eef0f3)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dsw-wb-cardHead { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.dsw-wb-cardTitle { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dsw-wb-cardMeta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dsw-wb-spacer { flex: 1 1 auto; }

/* 键值网格：对齐 Jet Hub 的 .dim-jh-accountMeta */
.dsw-wb-meta { display: grid; gap: 4px; margin: 0; }
.dsw-wb-metaRow { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: baseline; gap: 10px; }
.dsw-wb-metaRow dt { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dsw-wb-metaRow dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }
.dsw-wb-metaRow dd.dsw-wb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 16px; }

/* 表单控件行 */
.dsw-wb-field { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsw-wb-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dsw-wb-input, .dsw-wb-select { font: inherit; font-size: 13px; line-height: 20px; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); color: var(--dsw-alias-label-primary, #1f2329); }
.dsw-wb-input { width: 110px; }
.dsw-wb-select { max-width: 100%; }
.dsw-wb-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); cursor: pointer; }

/* 文字 */
.dsw-wb-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dsw-wb-empty { margin: 0; padding: 20px; text-align: center; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dsw-wb-notice { margin: 0; padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }
.dsw-wb-notice[data-tone="ok"] { border-color: color-mix(in srgb, #22c55e 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(34 197 94 / 8%); color: #15803d; }
.dsw-wb-notice[data-tone="warn"] { border-color: color-mix(in srgb, #e37400 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(227 116 0 / 8%); color: #b45309; }
.dsw-wb-notice[data-tone="error"] { border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(217 48 37 / 8%); color: #b3261e; }

/* 按钮：对齐 Jet Hub 的 .dim-jh-btn */
.dsw-wb-btn { font: inherit; font-size: 12px; line-height: 18px; padding: 5px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); color: var(--dsw-alias-label-primary, #1f2329); white-space: nowrap; cursor: pointer; transition: border-color .15s ease, background .15s ease, color .15s ease; }
.dsw-wb-btn:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 40%, var(--dsw-alias-border-l2, #dfe1e5)); background: color-mix(in srgb, #1677ff 6%, var(--dsw-alias-bg-layer-3, #fff)); color: #1677ff; }
.dsw-wb-btn[data-kind="primary"] { border-color: #1677ff; background: #1677ff; color: #fff; }
.dsw-wb-btn[data-kind="primary"]:hover:not(:disabled) { border-color: #0f5fce; background: #0f5fce; color: #fff; }
.dsw-wb-btn[data-kind="danger"] { border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #dfe1e5)); color: #d93025; }
.dsw-wb-btn[data-kind="danger"]:hover:not(:disabled) { border-color: #d93025; background: rgb(217 48 37 / 6%); color: #b3261e; }
.dsw-wb-btn:disabled { opacity: .5; cursor: default; }

/* 操作按钮组 */
.dsw-wb-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsw-wb-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #f0f1f3); }

/* 账号 / 扫描结果卡片 */
.dsw-wb-list { display: grid; gap: 10px; }
.dsw-wb-account { padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); transition: border-color .16s ease, box-shadow .16s ease; }
.dsw-wb-account:hover { border-color: color-mix(in srgb, #1677ff 22%, var(--dsw-alias-border-l2, #eef0f3)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dsw-wb-account[data-enabled="false"] { opacity: .62; }
.dsw-wb-accountTop { display: flex; align-items: center; gap: 8px; }
.dsw-wb-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #9aa0a6); }
.dsw-wb-dot[data-on="true"] { background: #22c55e; box-shadow: 0 0 0 3px rgb(34 197 94 / 14%); }
.dsw-wb-accountName { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dsw-wb-tag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; }
.dsw-wb-tag[data-tone="on"] { color: #15803d; background: rgb(34 197 94 / 12%); }
.dsw-wb-tag[data-tone="off"] { color: var(--dsw-alias-label-tertiary, #8f959e); background: rgb(143 149 158 / 12%); }
.dsw-wb-tag[data-tone="warn"] { color: #b45309; background: rgb(227 116 0 / 12%); }
.dsw-wb-tag[data-tone="info"] { color: #1677ff; background: rgb(22 119 255 / 10%); }
.dsw-wb-account .dsw-wb-meta { margin-top: 8px; }

/* 模型表 */
.dsw-wb-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dsw-wb-table th { padding: 6px 8px 6px 0; text-align: left; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8f959e); border-bottom: 1px solid var(--dsw-alias-border-l2, #eef0f3); }
.dsw-wb-table td { padding: 6px 8px 6px 0; vertical-align: top; color: var(--dsw-alias-label-secondary, #646a73); border-bottom: 1px solid var(--dsw-alias-border-l1, #f4f5f7); }
.dsw-wb-table tr:last-child td { border-bottom: none; }
.dsw-wb-table td.dsw-wb-modelId { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--dsw-alias-label-primary, #1f2329); }

/* 日志 */
.dsw-wb-log { max-height: 240px; margin: 0; padding: 8px 10px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1, #f2f4f7); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #f9fafb); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 16px; }
.dsw-wb-logLine { display: flex; gap: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsw-wb-logTime { flex-shrink: 0; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dsw-wb-logLine[data-level="error"] { color: #d93025; }
`

    /** 样式只注入一次；重复 mount 不会叠加 `<style>`。 */
    let stylesInstalled = false

    /**
     * 把样式表挂到 `document.head`。
     *
     * @returns {Function} 卸载函数，随插件 effect 一起释放。
     */
    function installStyles() {
      if (stylesInstalled || typeof document === 'undefined') return () => {}
      stylesInstalled = true
      const node = document.createElement('style')
      node.textContent = STYLES
      document.head.appendChild(node)
      return () => {
        node.remove()
        stylesInstalled = false
      }
    }

    /** Unwrap the bridge's `{ ok, data }` envelope. */
    async function getJson(path, signal) {
      const response = await fetch(`${BASE}${path}`, { signal })
      const payload = await response.json().catch(() => null)
      if (payload === null || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      }
      return payload.data
    }

    /** POST one JSON body and unwrap the envelope. */
    async function postJson(path, body) {
      const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      }
      const result = payload.data?.result
      if (result?.ok === false) throw new Error(result.error ?? result.msg ?? 'Gateway operation failed')
      const failures = result?.results?.filter((entry) => entry.ok === false) ?? []
      if (failures.length > 0) {
        throw new Error(failures.map((entry) => `${entry.uid}: ${entry.error ?? entry.msg ?? 'Failed'}`).join('; '))
      }
      return payload.data
    }

    /** 徽章能表达的网关状态；其他任何值都退化成「已停止」。 */
    const KNOWN_STATES = new Set(['running', 'starting', 'stopped', 'failed'])

    /**
     * 状态徽章。
     *
     * `state` 缺失、为空或不在已知集合里时退化为「已停止」：既不会在渲染期抛错，
     * 也不会产生一个没有对应 CSS 规则的 `data-tone`（那样徽章会失去配色）。
     * 渲染期的异常没有 error boundary 兜底，会直接把整个设置页打白。
     */
    function StateBadge({ state, t }) {
      const tone = typeof state === 'string' && KNOWN_STATES.has(state) ? state : 'stopped'
      return h('span', {
        className: 'dsw-wb-badge',
        'data-tone': tone,
        title: t?.stateHint?.[tone] ?? '',
      }, t?.state?.[tone] ?? tone)
    }

    /** 键值网格里的一行「标签 + 值」。 */
    function Field({ label, value, title }) {
      return h('div', { className: 'dsw-wb-metaRow' },
        h('dt', null, label),
        h('dd', { className: 'dsw-wb-mono', title: title ?? String(value ?? '') }, String(value ?? '—')))
    }

    /**
     * 国内版账号当日积分是否已领取。
     *
     * 网关保存最近一次确认结果和时间；只有确认时间是本地今天且
     * `checkinClaimed` 为 true 时才显示已领取。国际版后端没有签到接口，
     * 两个字段恒为 null，因此这里也恒为 false——调用方只在 `realm === 'cn'` 时展示它。
     */
    function localDateKey(date = new Date()) {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }

    function checkinClaimedOf(entry) {
      if (entry?.checkinClaimed !== true) return false
      return typeof entry.lastCheckin === 'string' && entry.lastCheckin.slice(0, 10) === localDateKey()
    }

    /**
     * The whole settings section.
     *
     * One polling loop owns the page's data; it reads through a ref for the
     * OAuth state so a login in progress never restarts it.
     */
    function Section() {
      const t = copy()
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const [busy, setBusy] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [portDraft, setPortDraft] = React.useState(null)
      const [scan, setScan] = React.useState(null)
      const [login, setLogin] = React.useState(null)
      const [confirmUid, setConfirmUid] = React.useState(null)
      const [generation, setGeneration] = React.useState(0)
      const dataRef = React.useRef(null)
      const aliveRef = React.useRef(true)
      // Reads started before or during a mutation cannot publish stale settings.
      const mutationRef = React.useRef({ version: 0, pending: false })

      React.useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      // One polling loop. It backs off when the gateway is idle or the tab is
      // hidden, and it keeps polling through an OAuth wait so the new account
      // appears without the operator refreshing the page.
      //
      // `login` is a dependency on purpose: starting a login has to wake the
      // loop, and a ref would not. `setGeneration` is a stable setter, so this
      // only restarts when the pending login actually changes.
      React.useEffect(() => {
        let cancelled = false
        let timer = null
        const tick = async () => {
          if (cancelled) return
          const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
          if (!hidden && !mutationRef.current.pending) {
            const version = mutationRef.current.version
            try {
              const data = await getJson('/state')
              if (!cancelled && version === mutationRef.current.version) {
                dataRef.current = data
                setState({ phase: 'ready', data, error: null })
              }
            } catch (error) {
              if (!cancelled && version === mutationRef.current.version) {
                setState((current) => ({
                  phase: 'error',
                  data: current.data,
                  error: error instanceof Error ? error.message : String(error),
                }))
              }
            }

            // Poll the pending OAuth flow, if any. The gateway answers
            // `{status: "pending"|"ok"|"error"|"expired"|"unknown", ...}`.
            if (login !== null && login.state !== undefined) {
              try {
                const result = await getJson(`/accounts/login/poll?state=${encodeURIComponent(login.state)}`)
                const poll = result.poll ?? {}
                if (!cancelled && poll.status === 'ok') {
                  setLogin(null)
                  setMessage({ kind: 'ok', text: t.loginDone })
                  setGeneration((value) => value + 1)
                } else if (!cancelled && (poll.status === 'error' || poll.status === 'expired' || poll.status === 'unknown')) {
                  setLogin(null)
                  setMessage({ kind: 'error', text: t.loginFailed(String(poll.message ?? poll.status)) })
                }
              } catch {
                /* a failed poll is not fatal; the next tick retries */
              }
            }
          }
          if (cancelled) return
          const latest = dataRef.current
          const active = latest?.gateway?.state === 'running' || latest?.gateway?.state === 'starting'
            || login !== null
          const delay = hidden ? 8000 : active ? POLL_ACTIVE_MS : POLL_IDLE_MS
          timer = setTimeout(() => { void tick() }, delay)
        }
        void tick()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [generation, login, t])

      const refresh = React.useCallback(() => setGeneration((value) => value + 1), [])

      /** Apply confirmed settings and model data before the next background poll. */
      const applyConfigResult = React.useCallback((result) => {
        if (!aliveRef.current || result?.settings === undefined) return
        setState((current) => {
          if (current.data === null) return current
          return {
            ...current,
            data: {
              ...current.data,
              ...result,
              settings: { ...current.data.settings, ...result.settings },
              gateway: result.gateway ?? current.data.gateway,
            },
          }
        })
        dataRef.current = dataRef.current === null ? null : {
          ...dataRef.current,
          ...result,
          settings: { ...dataRef.current.settings, ...result.settings },
        }
      }, [])

      /** Apply account snapshots returned by a completed gateway operation immediately. */
      const applyAccountResult = React.useCallback((result) => {
        const snapshot = Array.isArray(result?.accounts) ? result
          : Array.isArray(result?.result?.accounts) ? result.result : null
        if (!aliveRef.current || snapshot === null) return
        const update = (current) => current.data === null ? current : {
          ...current,
          data: {
            ...current.data,
            account: { ...current.data.account, accounts: snapshot.accounts },
          },
        }
        setState(update)
        if (dataRef.current !== null) {
          dataRef.current = {
            ...dataRef.current,
            account: { ...dataRef.current.account, accounts: snapshot.accounts },
          }
        }
      }, [])

      /** Run one mutating action with busy state and error reporting. */
      const run = React.useCallback(async (label, action, successText) => {
        if (mutationRef.current.pending) return null
        mutationRef.current.pending = true
        mutationRef.current.version += 1
        setBusy(label)
        setMessage(null)
        try {
          const result = await action()
          if (aliveRef.current) {
            applyAccountResult(result)
            if (successText !== undefined) setMessage({ kind: 'ok', text: successText })
            refresh()
          }
          return result
        } catch (error) {
          if (aliveRef.current) {
            setMessage({ kind: 'error', text: t.failed(error instanceof Error ? error.message : String(error)) })
            refresh()
          }
          return null
        } finally {
          mutationRef.current.pending = false
          mutationRef.current.version += 1
          if (aliveRef.current) setBusy(null)
        }
      }, [applyAccountResult, refresh, t])

      const data = state.data

      if (state.phase === 'loading' && data === null) {
        return h('div', { className: 'dsw-wb-page' }, h('p', { className: 'dsw-wb-note' }, t.busy))
      }

      if (data === null) {
        return h('div', { className: 'dsw-wb-page' },
          h('p', { className: 'dsw-wb-notice', 'data-tone': 'error' }, t.failed(state.error ?? '')),
          h('p', { className: 'dsw-wb-note' }, t.hostHint),
          h('div', { className: 'dsw-wb-toolbar' },
            h('button', { className: 'dsw-wb-btn', onClick: refresh }, t.refresh)))
      }

      const gateway = data.gateway ?? {}
      const settings = data.settings ?? {}
      const account = data.account ?? { accounts: [], usable: 0 }
      const provider = data.provider ?? {}
      const models = Array.isArray(data.models) ? data.models : []
      const realmLabel = (realm) => realm === 'cn' ? t.realmCn : realm === 'intl' ? t.realmIntl : t.realmUnknown
      const running = gateway.state === 'running'
      const accounts = Array.isArray(account.accounts) ? account.accounts : []
      /** One lifecycle button, disabled while another action is in flight. */
      const action = (label, onClick, kind) => h('button', {
        className: 'dsw-wb-btn',
        'data-kind': kind,
        disabled: busy !== null,
        onClick,
      }, label)

      const body = [
        // 头部：品牌、状态徽章与生命周期操作。
        h('div', { key: 'header', className: 'dsw-wb-header' },
          h('div', { className: 'dsw-wb-brand' },
            h('h2', { className: 'dsw-wb-brandName' }, t.nav),
            h('p', { className: 'dsw-wb-brandDesc' }, t.intro)),
          h('div', { className: 'dsw-wb-headerActions' },
            h(StateBadge, { state: gateway.state, t }),
            running
              ? action(t.restart, () => void run('restart', () => postJson('/gateway/restart')), undefined)
              : action(t.start, () => void run('start', () => postJson('/gateway/start')), 'primary'),
            running ? action(t.stop, () => void run('stop', () => postJson('/gateway/stop')), undefined) : null,
            action(t.refresh, refresh, undefined))),

        h('p', { key: 'stateLine', className: 'dsw-wb-note' },
          busy !== null ? t.busy : (running ? String(gateway.baseUrl ?? '') : t.stateHint[gateway.state] ?? '')),

        message !== null
          ? h('p', { key: 'message', className: 'dsw-wb-notice', 'data-tone': message.kind === 'error' ? 'error' : 'ok' }, message.text)
          : null,

        gateway.lastError !== null && gateway.lastError !== undefined
          ? h('p', { key: 'lastError', className: 'dsw-wb-notice', 'data-tone': 'error' }, String(gateway.lastError))
          : null,

        data.reads !== undefined && data.reads !== null
          && (data.reads.accounts != null || data.reads.models != null || data.reads.realm != null)
          ? h('p', { key: 'readErrors', className: 'dsw-wb-notice', 'data-tone': 'warn' },
              `${t.readErrors}: ${[data.reads.accounts, data.reads.models, data.reads.realm].filter(Boolean).join(' / ')}`)
          : null,

        // 网关主体。
        h('section', { key: 'gatewayCard', className: 'dsw-wb-card' },
          h('div', { className: 'dsw-wb-cardHead' },
            h('h3', { className: 'dsw-wb-cardTitle' }, t.gateway)),
          h('dl', { className: 'dsw-wb-meta' },
            h(Field, { key: 'endpoint', label: t.endpoint, value: gateway.baseUrl ?? '—' }),
            h(Field, { key: 'pid', label: t.pid, value: gateway.pid ?? '—' }),
            h(Field, { key: 'uptime', label: t.uptime, value: gateway.uptimeMs === null || gateway.uptimeMs === undefined ? '—' : humanDuration(gateway.uptimeMs) }),
            // 解释器是探测出来的而不是配置的：在把 Python 叫成别的名字的平台上，
            // 这一行是操作者了解插件最终选了哪个解释器的唯一途径。
            h(Field, { key: 'python', label: t.pythonPath, value: gateway.pythonPath }),
            h(Field, { key: 'platform', label: t.platform, value: gateway.platform }),
            h(Field, { key: 'script', label: t.script, value: gateway.script }),
            h(Field, { key: 'accountsStore', label: t.accountStore, value: gateway.accountStore }),
            h(Field, { key: 'usageStore', label: t.usageStore, value: gateway.usageStore })),
          h('div', { className: 'dsw-wb-field' },
            h('span', { className: 'dsw-wb-label' }, t.port),
            h('input', {
              className: 'dsw-wb-input',
              value: portDraft ?? String(settings.port ?? ''),
              inputMode: 'numeric',
              onChange: (event) => setPortDraft(event.target.value),
            }),
            action(t.applyPort, () => void run('config', async () => {
              const result = await postJson('/config', { port: Number(portDraft ?? settings.port) })
              applyConfigResult(result)
              setPortDraft(null)
            }, t.saved)),
            h('label', { className: 'dsw-wb-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.autoStart === true,
                disabled: busy !== null,
                onChange: (event) => void run('config', async () => {
                  const result = await postJson('/config', { autoStart: event.target.checked })
                  applyConfigResult(result)
                }),
              }),
              t.autostart),
            h('label', { className: 'dsw-wb-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.providerSync === true,
                disabled: busy !== null,
                onChange: (event) => void run('config', async () => {
                  const result = await postJson('/config', { providerSync: event.target.checked })
                  applyConfigResult(result)
                }),
              }),
              t.autoSync)),
          h('p', { className: 'dsw-wb-note' }, t.portNote)),

        // 接口密钥。
        h('section', { key: 'keyCard', className: 'dsw-wb-card' },
          h('div', { className: 'dsw-wb-cardHead' },
            h('h3', { className: 'dsw-wb-cardTitle' }, t.key),
            h('span', { className: 'dsw-wb-cardMeta' }, settings.keyConfigured === true ? t.keySet : t.keyUnset),
            h('span', { className: 'dsw-wb-spacer' }),
            action(t.generateKey, () => void run('key', async () => {
              const result = await postJson('/key', { action: 'generate' })
              if (result?.value !== undefined) setMessage({ kind: 'ok', text: t.keyOnce(result.value) })
            }), undefined),
            action(t.clearKey, () => void run('key', () => postJson('/key', { action: 'clear' }), t.saved), undefined)),
          h('p', { className: 'dsw-wb-note' }, t.keyNote)),

        // 账号。
        h('section', { key: 'accountsCard', className: 'dsw-wb-card' },
          h('div', { className: 'dsw-wb-cardHead' },
            h('h3', { className: 'dsw-wb-cardTitle' }, t.accounts),
            h('span', { className: 'dsw-wb-cardMeta' }, t.accountUsable(account.usable ?? 0, accounts.length)),
            h('span', { className: 'dsw-wb-spacer' }),
            action(t.scan, () => void run('scan', async () => {
              const result = await postJson('/accounts/scan')
              setScan(result.scan ?? null)
            }), undefined),
            action(t.login, () => void run('login', async () => {
              const result = await postJson('/accounts/login/start', { realm: settings.realm === 'cn' ? 'cn' : 'intl' })
              const started = result.login ?? {}
              setLogin(started)
              // 网关把授权地址命名为 authUrl。
              if (typeof started.authUrl === 'string') window.open(started.authUrl, '_blank', 'noopener')
              setMessage({ kind: 'ok', text: t.loginStarted })
            }), undefined)),
          h('div', { className: 'dsw-wb-toolbar' },
            action(t.refreshAllCredits, () => void run('credits', () => postJson('/accounts/credits'), undefined), undefined),
            settings.realm === 'cn'
              ? action(t.claimCredits, () => void run('tasks', () => postJson('/tasks/run'), t.taskClaimed), undefined)
              : null,
            settings.realm === 'cn'
              ? action(t.checkin, () => void run('checkin', () => postJson('/accounts/checkin'), t.saved), undefined)
              : null,
            action(t.enableAll, () => void run('enable-all', () => postJson('/accounts/set-all', { enabled: true }), t.saved), undefined),
            action(t.disableAll, () => void run('disable-all', () => postJson('/accounts/set-all', { enabled: false }), t.saved), undefined)),

          // 区域选择放在这张卡片里而不是网关卡片：它过滤的正是下面这张账号列表。
          h('div', { className: 'dsw-wb-field' },
            h('span', { className: 'dsw-wb-label' }, t.realm),
            h('select', {
              className: 'dsw-wb-select',
              value: settings.realm ?? '',
              disabled: busy !== null,
              onChange: (event) => void run('realm', async () => {
                const value = event.target.value === '' ? null : event.target.value
                const result = await postJson('/config', { realm: value })
                applyConfigResult(result)
              }, t.realmSwitched),
            },
              h('option', { value: '' }, t.realmDefault),
              h('option', { value: 'intl' }, t.realmIntl),
              h('option', { value: 'cn' }, t.realmCn))),
          h('p', { className: 'dsw-wb-note' }, `${t.activeRealm}: ${running ? realmLabel(data.activeRealm) : t.realmStopped}`),
          h('p', { className: 'dsw-wb-note' }, t.realmNote),
          settings.providerSync === false ? h('p', { className: 'dsw-wb-note' }, t.realmManual) : null,

          login !== null
            ? h('p', { className: 'dsw-wb-note' }, t.loginWait)
            : null,

          accounts.length === 0
            ? h('p', { className: 'dsw-wb-empty' }, t.noAccounts)
            : h('div', { className: 'dsw-wb-list' }, accounts.map((entry) => h('div', {
                key: entry.uid,
                className: 'dsw-wb-account',
                'data-enabled': entry.enabled === false ? 'false' : 'true',
              },
                h('div', { className: 'dsw-wb-accountTop' },
                  h('span', { className: 'dsw-wb-dot', 'data-on': entry.enabled === false ? 'false' : 'true' }),
                  h('span', { className: 'dsw-wb-accountName' }, entry.nickname ?? entry.uid),
                  // 签到状态只对国内版有意义，国际版后端没有这个接口。
                  entry.realm === 'cn'
                    ? h('span', {
                        className: 'dsw-wb-tag',
                        'data-tone': checkinClaimedOf(entry) ? 'on' : 'off',
                        title: entry.lastCheckin ? String(entry.lastCheckin) : '',
                      }, checkinClaimedOf(entry) ? t.checkedIn('') : t.notCheckedIn)
                    : null,
                  entry.enabled === false ? h('span', { className: 'dsw-wb-tag', 'data-tone': 'off' }, t.disabled) : null),
                h('p', { className: 'dsw-wb-note' },
                  [entry.realmName ?? entry.realm, entry.expiresIn === undefined ? null : t.expires(entry.expiresIn),
                    entry.credits?.remain === undefined ? null : t.creditBalance(entry.credits.remain)]
                    .filter(Boolean).join(' · ')),
                ...Object.entries(entry.modelRateLimits ?? {})
                  .filter(([, resetAt]) => typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt * 1000 > Date.now())
                  .map(([model, resetAt]) => h('p', { key: `limit-${model}`, className: 'dsw-wb-note' },
                    t.modelLimited(model, new Date(resetAt * 1000).toLocaleString()))),
                confirmUid === entry.uid
                  ? h('div', { className: 'dsw-wb-actions' },
                      h('button', {
                        className: 'dsw-wb-btn',
                        'data-kind': 'danger',
                        disabled: busy !== null,
                        onClick: () => void run('delete', async () => {
                          await postJson('/accounts/delete', { uid: entry.uid })
                          setConfirmUid(null)
                        }, t.saved),
                      }, t.confirmRemove),
                      h('button', { className: 'dsw-wb-btn', onClick: () => setConfirmUid(null) }, t.cancel))
                  : h('div', { className: 'dsw-wb-actions' },
                      action(t.refreshAccountCredits, () => void run(`credits-${entry.uid}`, () => postJson('/accounts/credits', { uid: entry.uid }), undefined), undefined),
                      entry.realm === 'cn'
                        ? action(t.checkin, () => void run(`checkin-${entry.uid}`, () => postJson('/accounts/checkin', { uid: entry.uid }), t.saved), undefined)
                        : null,
                      action(entry.enabled === false ? t.enable : t.disable,
                        () => void run(`set-${entry.uid}`, () => postJson('/accounts/set', { uid: entry.uid, enabled: entry.enabled === false }), t.saved), undefined),
                      h('button', { className: 'dsw-wb-btn', disabled: busy !== null, onClick: () => setConfirmUid(entry.uid) }, t.remove))))),

          h('p', { className: 'dsw-wb-note' }, t.limitsNote),
          h('p', { className: 'dsw-wb-note' }, t.accountScopeNote),
          h('p', { className: 'dsw-wb-note' }, t.scanNote),

          scan !== null && Array.isArray(scan.detected) && scan.detected.length > 0
            ? h('div', { className: 'dsw-wb-list' }, scan.detected.map((found) => h('div', {
                key: found.path,
                className: 'dsw-wb-account',
              },
                h('div', { className: 'dsw-wb-accountTop' },
                  h('span', { className: 'dsw-wb-accountName' }, found.nickname ?? found.file)),
                h('p', { className: 'dsw-wb-note' },
                  [found.realmName, found.expiresIn === undefined ? null : t.expires(found.expiresIn), found.valid === false ? found.error : null]
                    .filter(Boolean).join(' · ')),
                h('div', { className: 'dsw-wb-actions' },
                  h('button', {
                    className: 'dsw-wb-btn',
                    'data-kind': 'primary',
                    disabled: busy !== null || found.valid === false,
                    onClick: () => void run('import', async () => {
                      await postJson('/accounts/import', { path: found.path, realm: found.realm })
                      setScan(null)
                    }, t.imported(found.nickname ?? found.file)),
                  }, t.import)))))
            : null),

        // 模型路由。
        h('section', { key: 'providerCard', className: 'dsw-wb-card' },
          h('div', { className: 'dsw-wb-cardHead' },
            h('h3', { className: 'dsw-wb-cardTitle' }, t.provider),
            h('span', { className: 'dsw-wb-cardMeta' }, provider.present === true
              ? `${t.providerPresent} · ${String(provider.modelCount ?? 0)}`
              : t.providerAbsent),
            h('span', { className: 'dsw-wb-spacer' }),
            provider.present === true
              ? action(t.providerRemove, () => void run('provider', async () => {
                  await postJson('/provider/sync', { action: 'remove' })
                }, t.providerRemoved), undefined)
              : action(t.providerSync, () => void run('provider', async () => {
                  const result = await postJson('/provider/sync', {})
                  const count = result.entry?.models?.length ?? 0
                  setMessage({ kind: 'ok', text: t.providerSynced(count) })
                }, undefined), 'primary')),
          h('p', { className: 'dsw-wb-note' }, provider.present === true ? t.providerNote : t.providerNote + ' ' + (running ? '' : t.providerWaiting)),
          Array.isArray(provider.routes) && provider.routes.length > 0
            ? h('p', { className: 'dsw-wb-note dsw-wb-mono' }, provider.routes.join(', '))
            : null,
          provider.reason !== null && provider.reason !== undefined
            ? h('p', { className: 'dsw-wb-notice', 'data-tone': 'warn' }, String(provider.reason))
            : null),

        // 模型清单。
        models.length > 0
          ? h('section', { key: 'modelsCard', className: 'dsw-wb-card' },
              h('div', { className: 'dsw-wb-cardHead' },
                h('h3', { className: 'dsw-wb-cardTitle' }, t.models),
                h('span', { className: 'dsw-wb-cardMeta' }, `${t.modelsRealm}: ${realmLabel(data.modelsRealm)} · ${t.modelsNote(models.length)}`)),
              h('table', { className: 'dsw-wb-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'ID'),
                  h('th', null, t.modelContext),
                  h('th', null, t.modelOutput),
                  h('th', null, t.modelReasoning),
                  h('th', null, t.modelVision))),
                h('tbody', null, models.map((model) => h('tr', { key: model.id },
                  h('td', { className: 'dsw-wb-modelId' }, model.id),
                  h('td', null, humanCount(model.context_length ?? model.max_input_tokens)),
                  h('td', null, humanCount(model.max_output_tokens ?? model.max_completion_tokens)),
                  h('td', null, model.reasoning_fixed_effort !== undefined
                    ? `${model.reasoning_fixed_effort} (fixed)`
                    : Array.isArray(model.reasoning_efforts) ? model.reasoning_efforts.join(', ') : '—'),
                  h('td', null, (model.input_modalities ?? model.modalities?.input ?? []).includes('image') ? '✓' : '—'))))))
          : null,

        // 日志。
        h('section', { key: 'logCard', className: 'dsw-wb-card' },
          h('div', { className: 'dsw-wb-cardHead' },
            h('h3', { className: 'dsw-wb-cardTitle' }, t.log)),
          Array.isArray(gateway.log) && gateway.log.length > 0
            ? h('div', { className: 'dsw-wb-log' }, gateway.log.slice(-120).map((entry) => h('div', {
                key: entry.seq,
                className: 'dsw-wb-logLine',
                'data-level': entry.level === 'error' ? 'error' : 'log',
              },
                h('span', { className: 'dsw-wb-logTime' }, new Date(entry.at).toLocaleTimeString()),
                h('span', null, entry.text))))
            : h('p', { className: 'dsw-wb-note' }, t.logEmpty)),

        h('p', { key: 'hostHint', className: 'dsw-wb-note' }, t.hostHint),
      ]

      return h('div', { className: 'dsw-wb-page' }, body)
    }

    /**
     * Register the page as a settings section.
     *
     * The settings shell exposes `settings.section`; registering into it is what
     * puts this page next to 模型 and 外观. The registration is held by
     * `slots.inject` so the section appears whenever the shell is present and
     * disappears with the plugin.
     *
     * @param {object} ctx - client context carrying the slot registry.
     */
    function apply(ctx) {
      // 样式表随插件 mount 注入一次，并在卸载时移除；宿主没提供 effect 时
      // 直接注入，页面上最多留一份 `<style>`。
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => installStyles(), 'dsh-plugin-workbuddy-gateway: styles')
      } else {
        installStyles()
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'workbuddy-gateway',
        order: 40,
        label: () => copy().nav,
      }, Section))
    }

    module.exports.name = 'dsh-plugin-workbuddy-gateway'
    module.exports.inject = ['slots']
    module.exports.apply = apply
    return module.exports
  },
})
