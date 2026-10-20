# dsh-plugin-workbuddy-gateway

Manage WorkBuddy accounts, a local OpenAI-compatible gateway, and DSH model routes from **Settings → WorkBuddy**.

[中文](README.md) | English

**Version: 0.3.0.** Supports the current Config-based Settings API, verified against the official Windows DSH `0.2.1-rc.2` installation for settings edits, provider writes and restart persistence. Install from the fixed Git tag `v0.3.0`. No plugin market is required.

This is an unofficial integration using WorkBuddy subscription endpoints and DSH internal APIs. Those interfaces can change, and using them may violate service terms or trigger account restrictions.

## Requirements and platforms

- An installed DSH web profile with settings, credentials, and `llm-pi-ai` services. The original integration targeted DSH `0.1.5-rc.2`.
- Node 20.19+ for this plugin, plus the Node requirements of your DSH version.
- Python 3.9+ on PATH. The gateway uses only the standard library.
- Git and pnpm for installation, and a WorkBuddy account with available quota.

Windows has been used locally. macOS and Linux have platform-specific code but have not been verified on real machines. macOS credential scanning now uses its application-data directory; Linux uses the XDG directory, with desktop-client compatibility unverified. Browser OAuth is also available.

Python detection tries `python`, then `python3` on Windows, and the reverse order elsewhere. Set `pythonPath` in the settings page to choose an interpreter explicitly.

## Install a fixed version

Use an existing, initialized web profile:

```sh
dsh plugin --profile web add "github:vb2250158/dsh-plugin-workbuddy-gateway#<main-commit>"
```

Then append `dsh-plugin-workbuddy-gateway` to the existing `dsh.profile.bundles` array in the profile's `package.json`. Preserve its other entries. The default profile directory is `~/.dsh/profiles/web`, or `$DSH_HOME/profiles/web` when configured.

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

Restart **DSH itself**, then refresh the browser. Restarting only the Python gateway does not reload the host plugin.

## Manual installation from a checkout

Keep the checkout in a permanent directory:

```sh
git clone --branch v0.3.0 https://github.com/Acoder416/dsh-plugin-workbuddy-gateway.git
cd dsh-plugin-workbuddy-gateway
npm run preflight
```

PowerShell:

```powershell
$dshPluginDir = (Get-Location).Path
$dshProfileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles/web'
} else {
  Join-Path $env:USERPROFILE '.dsh/profiles/web'
}
pnpm --dir $dshProfileDir add "link:$dshPluginDir"
```

macOS / Linux:

```sh
dsh_plugin_dir="$PWD"
dsh_profile_dir="${DSH_HOME:-$HOME/.dsh}/profiles/web"
pnpm --dir "$dsh_profile_dir" add "link:$dsh_plugin_dir"
```

Enable the bundle as above and restart DSH. No build step is required. Do not delete or move the linked directory.

Alternatively, after installing the dependency, insert the plugin into the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: workbuddy-gateway
      name: dsh-plugin-workbuddy-gateway
```

**Choose either the bundle entry or this patch, never both.** Duplicate registration prevents startup.

## Accounts, credits, and models

Changing realms updates the account list and model catalog. Automatic route maintenance also updates the DSH model picker; otherwise, sync the model route manually. The page shows the selected realm, active gateway realm, and model catalog realm separately. A switch that the running gateway does not confirm is not saved.

On startup and restart, the gateway applies the selected realm before listening and reports running only after confirmation. Failed confirmation stops the gateway and displays an error. The active realm is stored in `active_realm.json` inside the account directory and restored when no realm is selected.

1. Open Settings → WorkBuddy and start the gateway (default `127.0.0.1:18088`).
2. Select the global or China realm.
3. Scan and import a desktop credential, or complete browser OAuth.
4. Check that the account is enabled and has credits.
5. Write the provider route, or enable automatic route maintenance, then refresh the page to update the model picker.

Desktop imports attempt CN daily check-in before reading credits; global imports only read credits. Synchronization requires working upstream endpoints. Retry the relevant action if it fails.

With **Start with dsh** enabled, the gateway automatically checks in enabled CN accounts about ten seconds after startup, without opening settings. Successful check-ins refresh credits and persist the local calendar date, so restarting DSH on the same day skips confirmed accounts. Disabled and global accounts do not check in. Failed attempts remain eligible on the next startup or existing scheduled cycle; manual check-in is also available. Working network access and valid credentials are required. The existing periodic schedule continues while the gateway runs.

**Refresh credits** reads the balance. Upstream values are kept to two decimals, and expired packages are excluded from the usable total. **Check in** invokes the CN daily reward endpoint. Upstream code `10001`, including in an HTTP error response, means the reward was already claimed. The account card shows the last stored confirmation and timestamp. For the China realm, the gateway compares that timestamp with the local date, so yesterday's or older record automatically appears as not checked in today. Reading the page does not make another upstream request; use Check in when you need an immediate confirmation.

Refreshing credits queries the upstream live, once per account, and retries before reporting a result. **Refresh all credits** can therefore take a while and may fail when there are several accounts or the network is poor — for example when the global realm is reached through a proxy. To refresh one account, use **Refresh credits** on its card.

**Claim credits** invokes the bundled gateway's growth-task workflow, separate from daily check-in. It depends on upstream activity endpoints and does not guarantee rewards.

**Automatic growth check-in (CN personal accounts)** is an independent, opt-in switch in the account section. Startup and subsequent background checks read the official current-day activity record. An inactive account submits one chat activity event, then verifies the result. Only an official `is_active: true` for today's date confirms completion. This does not call a model or automatically redeem rewards, spend makeup cards, or draw prizes. Only enabled, signed-in CN personal accounts participate; accounts already active in the official client skip the report.

The activity calendar uses Asia/Shanghai. Admission is saved before sending, allowing at most one report per account per day across restarts, including uncertain network outcomes. Unconfirmed activity gets up to three verification rounds by default, five minutes apart, then displays the failure reason and stops checking for that day. Disabling the switch or stopping the gateway prevents subsequent requests; already-sent requests cannot be recalled. Network, credentials, or upstream changes can prevent confirmation.

The `workbuddy-gateway` settings namespace exposes `autoGrowthCheckin` (default `false`), `growthCheckinRetrySeconds` (default `300`, range `30–3600`), and `growthCheckinMaxChecks` (default `3`, range `1–10`). The settings-page switch updates the running bundled gateway; file edits apply on restart. Upgrade the plugin and restart DSH for this feature. A custom `gatewayDir` must also implement its scheduler endpoint.

The plugin supports current profile Config forms and legacy settings sections. Current hosts use the exported volatile `Config` and `settings.configure()`, address edits by the actual plugin entry id, and persist changes in the profile's `cordis.patch.yml`. Only legacy hosts that provide `installSection()` use that API. The configuration listener belongs to the plugin instance and is not duplicated when Settings is replaced.

From the checkout, run `node scripts/verify-profile-settings.mjs <built-dsh-CLI.js-or-Desktop-dsh.cmd>` to check actual host loading, HTTP settings edits, external edits, provider writes and restart persistence. The check uses a temporary profile, temporary HTTP port and empty credentials. It does not start the gateway, read real accounts or call a model.

Without a session binding, the gateway rotates across available accounts in the same realm. Bound sessions prefer their existing account. HTTP 429 or upstream business code 6004 records a restriction for that account and model, then tries another eligible account in the same realm. Other models remain eligible. Reaching the deadline permits another attempt; it does not guarantee upstream acceptance. A positive credit balance does not rule out a model frequency limit.

The reset deadline comes from the upstream message's date and UTC offset, then from `Retry-After`. Without either, the fallback is 300 seconds. Set `WB_RATE_LIMIT_FALLBACK_SECONDS` to a positive number of seconds before launching DSH and restart DSH after changing it. Standalone gateways also accept `--rate-limit-fallback-seconds`. Restrictions persist in account files across restarts, reimports, and enable/disable toggles. Account cards show restricted models and estimated reset times. The usable account count does not establish availability for every model.

When model restrictions block all otherwise eligible accounts in the realm, subsequent requests return HTTP 429 with the earliest `resetAt` (Unix seconds) in the error message, without contacting upstream before that deadline. Multiple accounts returning 429 does not establish a shared IP limit; each account retains its own deadline.

When the official WorkBuddy client returns upstream code `11140` as well, treat it as an account-level risk restriction, not a prompt problem. The gateway marks that account temporarily unavailable, tries other accounts in the same realm, and returns the upstream trace ID and explanation; DSH no longer renders it as an invalid API key. Contact WorkBuddy support to resolve the restriction; changing the prompt, retrying, or switching local models cannot clear it. Other HTTP 401/403 responses retain authentication cooldown and same-realm failover. HTTP 502/503/504, SSL disconnects, and connection timeouts try other accounts without account cooldown. Each candidate is tried at most once per request; failure across all candidates still returns an error. Requests are not replayed after streaming starts, and accounts never cross realms.

Availability excludes disabled or cooling accounts, missing tokens, and expired credentials without a refresh token. Historical errors alone do not block retry after cooldown. Refreshable credentials are eligible for a refresh attempt, which may still fail. Account availability, model restrictions, and credit balances are separate signals.

The desktop app does not need to stay open after import. Logging out of it does not necessarily revoke the gateway's saved tokens.

## Desktop credential locations

Only `workbuddy-desktop-ai.info` (global) and `workbuddy-desktop.info` (China) are scanned.

Recent desktop versions can store nicknames and login tokens as `$wbEncrypted` objects. The plugin displays the filename for unreadable nicknames; encrypted tokens produce an explanation and disable import. Select the matching region and use the plugin's **Sign in via browser** action to add the account. The plugin does not decrypt or modify desktop files, and does not read timestamped backups or `.logged-out` files. Empty scans show a message; plaintext credentials remain importable.

| Platform | Default directory |
|---|---|
| Windows | `%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/CodeBuddyExtension/Data/Public/auth` |

The macOS/Linux locations have not been verified against real desktop installations. If the files live elsewhere, set `WORKBUDDY_DESKTOP_AUTH_DIR` in the environment used to launch DSH:

```sh
export WORKBUDDY_DESKTOP_AUTH_DIR="/absolute/path/to/auth"
dsh --profile web
```

On PowerShell, use `$env:WORKBUDDY_DESKTOP_AUTH_DIR = 'D:\path\to\auth'` before launching DSH. Restart DSH after changing it. Browser OAuth avoids desktop-file discovery.

## Storage and security

Account files under `$DSH_HOME/workbuddy/accounts/` contain access and refresh tokens, credits, check-in records, and model rate-limit deadlines. Usage records live under `$DSH_HOME/workbuddy/usage/`. The default home is `~/.dsh`.

The gateway API key is stored in DSH's credential store as `WORKBUDDY_API_KEY`. Keep account files private, keep the listener local, and retain API authentication. Removing or disabling an account stops this gateway from selecting it; it does not revoke credentials at the provider.

## Upgrade and rollback

Stop DSH and back up the profile configuration, lockfile, and WorkBuddy state before upgrading. Backups contain credentials and must stay private.

```sh
# Install the current version
dsh plugin --profile web add "github:vb2250158/dsh-plugin-workbuddy-gateway#<main-commit>"
# Roll back only on a host that still provides the legacy Settings API
dsh plugin --profile web add "github:Acoder416/dsh-plugin-workbuddy-gateway#v0.2.6"
```

For a linked checkout:

```sh
git status --short
git fetch origin --tags
git switch --detach v0.3.0
# To roll back on a legacy host: git switch --detach v0.2.6
```

Preserve local changes before switching. Restart DSH and refresh the browser afterward. A linked installation follows that directory, not another checkout. Keep `v0.3.0` on DSH `0.2.1-rc.2`: that host does not provide the legacy Settings API used by `v0.2.6`. Code rollback does not undo reward claims, account changes, or model-route writes. Restore your own configuration backup if needed. See [CHANGELOG.md](CHANGELOG.md).

## Troubleshooting and removal

- Missing settings page: check the installed dependency and bundle/patch entry, then restart DSH.
- Changes not visible: confirm the profile points to the checkout you edited.
- No Python: install Python 3.9+ or configure `pythonPath`.
- Port in use: identify the listener before stopping it; the gateway port and DSH Web port are separate.
- No desktop accounts: verify the directory and filenames, use the environment override, or sign in through the browser.
- Red logs: HTTP 2xx/3xx access lines are neutral in this version. Other stderr lines may still appear red; inspect their text and status code.

To uninstall, remove the provider route and stop the gateway and DSH. Remove its bundle/patch entry, run `dsh plugin --profile web remove dsh-plugin-workbuddy-gateway`, then restart DSH. Delete WorkBuddy state and the stored API key separately if you no longer need them.

## Development and license

```sh
npm test
npm run test:python
npm run preflight
node scripts/check-package.mjs
```

On systems with only `python3`, run `python3 -m unittest discover -s tests -p 'test_*.py'`. Regression tests use simulated responses and do not spend account quota or substitute for platform testing.

See [CONTRIBUTING.md](CONTRIBUTING.md). Plugin and bundled gateway are MIT-licensed. Gateway upstream: [ardeyouxipianyi/workbuddy2api-intl](https://github.com/ardeyouxipianyi/workbuddy2api-intl). Local account-adapter changes are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
