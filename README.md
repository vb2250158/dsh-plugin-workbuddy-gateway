# dsh-plugin-workbuddy-gateway

在 DSH 的设置页管理 WorkBuddy 账号、本地网关和模型路由。网关将 WorkBuddy 国际版或国内版的订阅接口转换为 OpenAI 兼容接口，供 DSH 使用。

中文 | [English](README.en.md)

本仓库是 [Acoder416 上游](https://github.com/Acoder416/dsh-plugin-workbuddy-gateway) 的维护 fork。0.2.3 修复指定账号目录后区域设置的保存与重启读取。

**当前版本：0.2.3。** 安装建议固定到 Git 标签 `v0.2.3`；回退方法见下文。此仓库提供源码安装，不要求安装插件市场。

## 功能

- 在「设置 → WorkBuddy」启动、停止、重启网关，查看端口、进程和日志。
- 从桌面端导入账号，或通过浏览器 OAuth 授权登录。
- 显示账号积分余额、最近确认的签到领取状态，支持刷新积分和国内版签到。
- 桌面账号导入时，国内版尝试签到，随后读取积分；国际版只读取积分。
- 启用、停用或移除账号；网关在同一区域内选择可用账号。
- 将网关模型写入 DSH 的 `llm-pi-ai` 提供方配置。

本插件不是 WorkBuddy / 腾讯官方集成，依赖订阅端内部接口和 DSH 内部扩展接口。接口变化可能导致功能失效，使用也可能触发服务条款限制或账号风控。

## 环境要求

| 项目 | 要求 |
|---|---|
| DSH | 已安装并初始化 `web` profile，具备 Web 设置、凭据与 `llm-pi-ai` 服务；原始集成针对 `0.1.5-rc.2` 开发 |
| Node.js | 插件声明最低 `20.19`；实际还需满足所用 DSH 的 Node 版本要求 |
| Python | `3.9+`，标准库即可，无需 `pip install` |
| Git / pnpm | 用于从 GitHub 安装或连接本地源码 |
| WorkBuddy 账号 | 国际版或国内版账号，且有可用额度 |

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 网关运行与进程管理 | 已在本机使用 | 已适配，未实机验证 | 已适配，未实机验证 |
| 桌面凭证扫描 | 已在本机使用 | 按应用数据目录查找，未实机验证 | 按 XDG 配置目录查找，未验证桌面端兼容性 |
| 浏览器授权 | 支持 | 已适配，未实机验证 | 已适配，未实机验证 |

Windows 自动尝试 `python`、`python3`；macOS / Linux 自动尝试 `python3`、`python`。也可以在设置页指定 `pythonPath`。

## 安装

以下示例使用已存在的 `web` profile。默认目录是 `~/.dsh/profiles/web`；设置了 `DSH_HOME` 时使用 `$DSH_HOME/profiles/web`，自定义 profile 则替换 `web`。修改前建议备份该目录中的 `package.json`、锁文件及 patch 文件。

### 方式一：直接安装固定版本

```sh
dsh plugin --profile web add "github:vb2250158/dsh-plugin-workbuddy-gateway#v0.2.3"
```

这个命令安装包依赖，**还需要启用插件**：编辑 profile 的 `package.json`，在现有 `dsh.profile.bundles` 数组末尾添加 `dsh-plugin-workbuddy-gateway`。保留原有字段和其他 bundle，下面仅展示相关部分：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-workbuddy-gateway"
      ]
    }
  }
}
```

停止并重新启动 DSH，再刷新浏览器。bundle 在 DSH 启动时加载，仅点击网关的「重启」不足以加载新的宿主插件代码。

### 方式二：手动克隆并连接本地目录

适合希望保留源码、手动更新或调试的用户。将源码放在长期保留的目录，后续不要删除或移动它。

```sh
git clone --branch v0.2.3 https://github.com/vb2250158/dsh-plugin-workbuddy-gateway.git
cd dsh-plugin-workbuddy-gateway
npm run preflight
```

Windows PowerShell：

```powershell
$dshPluginDir = (Get-Location).Path
$dshProfileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles/web'
} else {
  Join-Path $env:USERPROFILE '.dsh/profiles/web'
}
pnpm --dir $dshProfileDir add "link:$dshPluginDir"
```

macOS / Linux：

```sh
dsh_plugin_dir="$PWD"
dsh_profile_dir="${DSH_HOME:-$HOME/.dsh}/profiles/web"
pnpm --dir "$dsh_profile_dir" add "link:$dsh_plugin_dir"
```

然后按方式一编辑 `dsh.profile.bundles`，重启 DSH 并刷新页面。插件以 JavaScript 和 Python 源文件交付，无需编译。

### 可选：使用 profile patch 挂载

安装依赖后，也可以在 profile 的 `cordis.patch.yml` 中添加：

```yaml
- insert:
    - id: workbuddy-gateway
      name: dsh-plugin-workbuddy-gateway
```

**bundle 和显式 patch 只能选一种。** 使用 patch 时不要把本插件加入 `dsh.profile.bundles`，否则会出现 `duplicate loader entry id: workbuddy-gateway`。首次配置后重启 DSH。

## 第一次使用

1. 打开「设置 → WorkBuddy」，确认网关已启动。默认监听 `127.0.0.1:18088`。
2. 选择国际版或国内版区域；两个区域的账号和模型分别管理。
3. 点击「扫描桌面端账号」并导入，或选择「浏览器授权登录」并完成授权。
4. 检查账号是否启用、是否有积分。导入后的同步需要上游接口可用；失败时可手动刷新积分或重试签到。
5. 点击「写入模型路由」（开启自动维护时会自动尝试写入），刷新页面后在 DSH 模型选择器中选择模型。

### 积分与签到

「刷新积分」查询余额；上游下发的精确值保留到小数点后两位，已失效的资源包不计入可用余额。「签到」调用国内版每日领取接口。上游返回 `code: 10001`（包括 HTTP 错误响应）时，表示当天已经领取，插件也会保存该结果。

刷新积分需要实时请求上游，每个账号一次，连接不稳定时会先重试再返回结果。因此「刷新全部积分」在账号较多或网络较差时（例如经由代理访问国际版）可能要等待较久，也可能失败；只关心一个账号时，用账号卡片上的「刷新积分」。

账号卡片显示的是最近保存的领取状态和确认时间，并非持续查询官方签到状态。历史时间不代表今天已领取；需要时点击签到重新确认。国际版不提供此签到功能。

「领取积分」会调用内置网关的成长任务流程，与每日签到是不同操作。它依赖上游活动接口，耗时和可用性可能变化；失败时查看操作提示，不保证获得积分。

### 桌面端凭证目录

扫描只识别目录中的 `workbuddy-desktop-ai.info`（国际版）和 `workbuddy-desktop.info`（国内版）。

| 平台 | 默认目录 |
|---|---|
| Windows | `%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/CodeBuddyExtension/Data/Public/auth` |

macOS / Linux 的默认目录尚未通过真实桌面端安装验证。如果扫描不到，先确认桌面端已登录及文件实际位置，再指定目录。macOS / Linux 示例：

```sh
export WORKBUDDY_DESKTOP_AUTH_DIR="/absolute/path/to/auth"
dsh --profile web
```

Windows PowerShell 示例：

```powershell
$env:WORKBUDDY_DESKTOP_AUTH_DIR = 'D:\path\to\auth'
dsh --profile web
```

此变量必须由启动 DSH 的进程传给网关；修改后需重启 DSH。也可以直接使用浏览器授权。

### 多账号行为

区域切换同时更新账号列表与模型清单；开启自动维护模型路由时，也更新 DSH 的模型选项。页面分别显示已选区域、网关当前区域和模型清单所属区域。关闭自动维护时，需要手动点击「写入模型路由」。网关未确认切换成功时不会保存新区域。

没有会话绑定时，网关轮询同一区域的可用账号；同一会话优先复用已绑定账号。`429` 或上游业务码 `6004` 会记录该账号、该模型的限流恢复时间，并尝试同区其他可用账号；该账号的其他模型不受这条记录影响。到期只表示可以再次尝试，不保证上游一定接受请求；账号有积分也不代表该模型未触发频率限制。

恢复时间优先读取上游消息中带 UTC 偏移的日期时间，其次使用 `Retry-After`；两者都不可用时，默认等待 300 秒。可在启动 DSH 前设置环境变量 `WB_RATE_LIMIT_FALLBACK_SECONDS` 为正数秒数，修改后重启 DSH。独立运行网关时也可使用 `--rate-limit-fallback-seconds`。限流记录保存在账号文件中，重启、重新导入或切换启用状态不会清除尚未到期的记录。账号卡片显示受限模型和预计恢复时间；账号可用数量不代表每个模型都可用。

同区所有候选账号都被该模型的限流记录阻止时，后续请求直接返回 `429`，错误信息包含最早的 `resetAt`（Unix 秒），到期前不再请求上游。多个账号均返回 `429` 不能据此判断为共享 IP 限流；各账号的恢复时间分别保存。

上游连接阶段遇到 `401`、`403` 或网络异常时，保留原有账号错误处理并尝试其他账号。`502`、`503`、`504` 也会尝试其他账号，但不将账号置入冷却。一次请求中每个候选账号最多尝试一次；没有其他可用账号或同一区域全部失败时仍返回错误。其他 HTTP 错误、流式响应开始后的失败不保证切换；账号不会跨区域使用。

WorkBuddy 桌面端不必常驻。网关独立保存导入后的凭证；退出桌面端不保证这些凭证立即失效。

## 数据与安全

| 内容 | 保存位置 |
|---|---|
| 账号访问令牌、刷新令牌、积分、签到及模型限流记录 | `$DSH_HOME/workbuddy/accounts/` |
| 用量记录 | `$DSH_HOME/workbuddy/usage/` |
| 网关接口密钥 | DSH 凭据库中的 `WORKBUDDY_API_KEY` |
| 插件设置与模型路由 | DSH 用户设置 |

未设置 `DSH_HOME` 时默认使用 `~/.dsh`。账号文件包含敏感令牌，不要上传到 GitHub、共享网盘或反馈截图中。保持本地监听和接口鉴权；停用或移除账号可以阻止当前网关继续选择它，但不能代替在服务端撤销授权。

## 升级与回退

升级前停止 DSH，并备份 profile 配置和 `$DSH_HOME/workbuddy/`。备份包含凭证，应保存在仅自己可访问的位置。

直接安装方式：

```sh
# 升级到本版
dsh plugin --profile web add "github:vb2250158/dsh-plugin-workbuddy-gateway#v0.2.3"

# 回退到已有旧版标签
dsh plugin --profile web add "github:vb2250158/dsh-plugin-workbuddy-gateway#v0.2.1"
```

本地 `link:` 方式，在插件源码目录执行：

```sh
git status --short
git fetch origin --tags
git switch --detach v0.2.3
# 回退时改为：git switch --detach v0.2.1
```

如果存在本地修改，先自行保存，避免覆盖。切换版本后重启 DSH 并刷新页面。`link:` 安装的版本由本地目录决定，重新安装其他目录中的副本不会更新正在使用的插件。

回退代码不会撤销积分领取、还原账号操作或自动恢复模型路由。需要恢复配置时使用自己的备份。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 排障

| 现象 | 检查方式 |
|---|---|
| 设置页没有 WorkBuddy | 确认依赖已安装、bundle 或 patch 已启用，并重启整个 DSH |
| 修改后界面没有变化 | 检查 profile 依赖实际指向的目录；重启 DSH 并刷新浏览器 |
| 找不到 Python | 安装 Python 3.9+，检查 PATH 或设置 `pythonPath` |
| 端口被占用 | 网关默认是 `18088`；DSH Web 端口通常是另一个端口。先确认监听进程再停止它，或修改网关端口 |
| 桌面账号扫描为空 | 检查平台目录、两个 `.info` 文件，或设置 `WORKBUDDY_DESKTOP_AUTH_DIR` |
| 签到状态未更新 | 确认是国内版，重新签到并检查操作错误；历史记录不代表今天的状态 |
| 模型列表为空 | 确认网关运行、区域正确、账号可用，写入模型路由后刷新页面 |
| 返回 429 / 6004 | 查看账号卡片的模型恢复时间；等待到期或手动选择其他模型。刷新积分不会清除模型限流 |
| 上游 APISIX 返回 502/504 | 本版在连接阶段尝试同区其他账号；如果上游服务整体故障，需等待恢复或更换模型。切换无法保证消除错误 |
| 日志出现红色 | 本版将 HTTP `2xx/3xx` 访问日志归为普通日志；其余 stderr 仍可能标红，应结合状态码和文字判断 |

## 卸载

1. 在设置页移除模型路由并停止网关，然后停止 DSH。
2. 从 `dsh.profile.bundles` 移除插件名，或删除显式 patch 中的 `workbuddy-gateway` 条目。
3. 执行 `dsh plugin --profile web remove dsh-plugin-workbuddy-gateway`。
4. 重启 DSH。若不再保留账号，可自行删除 `$DSH_HOME/workbuddy/`，并清理凭据库里的 `WORKBUDDY_API_KEY`。

## 开发与验证

```sh
npm test
npm run test:python
npm run preflight
node scripts/check-package.mjs
```

`test:python` 使用 `python` 命令；只有 `python3` 的环境可执行 `python3 -m unittest discover -s tests -p 'test_*.py'`。回归测试使用模拟接口，不消耗真实账号额度，也不能替代 macOS 实机验证。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 来源与许可证

插件使用 [MIT 许可证](LICENSE)。内置网关来自 [ardeyouxipianyi/workbuddy2api-intl](https://github.com/ardeyouxipianyi/workbuddy2api-intl)，亦为 MIT；本版包含凭证目录、导入积分同步和签到结果处理方面的本地修改，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
