# Changelog

## 0.2.3 — 2026-09-20

- 修复 `--accounts-dir` 指定目录后，区域设置仍写入插件源码目录的问题；保存和重启读取均使用当前账号目录。
- Fix realm persistence with `--accounts-dir`: both save and reload use the configured account directory, including directories selected after module import.
- Add offline regression tests for save/reload and isolation between two account directories.
- Publish this maintenance fork at `vb2250158/dsh-plugin-workbuddy-gateway`; upstream remains `Acoder416/dsh-plugin-workbuddy-gateway`.

## 0.2.2 — 2026-09-17

- Persist HTTP 429 / business-code 6004 limits per account and model, using the upstream reset time and UTC offset, then Retry-After, then a configurable 300-second fallback (`WB_RATE_LIMIT_FALLBACK_SECONDS`). Other models remain eligible.
- Try other eligible accounts in the same realm at most once per request. Skip restricted account/model pairs until their deadline; when all are restricted, return 429 with the earliest reset time instead of repeatedly probing or reporting a generic unavailable pool.
- Show active model restrictions and estimated recovery times on account cards. Preserve restrictions across restarts, credential reimports, and enable toggles.
- Replace v0.2.1's pool-wide limit assumption and cooldown bypass. Several accounts returning 429 does not prove a shared IP limit; their individual reset times can differ.
- Preserve upstream error bodies for Chat Completions and Responses clients, including HTTP 400 carrying business code 6004. Retain bounded 502/503/504 failover and existing authentication/network error handling.
- Add offline regression coverage for three distinct reset times, persistence, model isolation, concurrent saves, realm isolation, and both client protocols. Keep `v0.2.1` unchanged for rollback.

## 0.2.1 — 2026-09-17

- Stop a single rate-limited request from locking the whole account pool out for five minutes. A 429 cooled the account it touched for 300 seconds, and the failover path tries every candidate within one request, so three accounts answering 429 once each put the entire pool in cooldown — after which every request failed in about 20 ms with `no usable account for realm 'intl'` until the cooldowns lapsed. When *every* candidate answers 429, the limit is pool-wide (the accounts share one egress, so rotating did not help) and the cooldown is now 30 seconds.
- Give a fully cooled pool one attempt instead of refusing outright: the account closest to recovery is tried once per request, so a limit that clears in seconds no longer reads as a hard failure. The per-request attempt bound is unchanged, so this cannot stampede the upstream.

## 0.2.0 — 2026-09-17

- Restore realm switching fixes omitted from v0.1.4: confirm the gateway realm before saving, read models for the selected realm, and update automatic provider routes.
- Apply confirmed settings immediately and discard background reads started before a settings write. Display the gateway and model catalog realms separately.
- Rebuild the settings page on the Jet Hub style system (`iJetLi/deepseek-harness-codearts`): one injected stylesheet and `dsw-wb-*` classes over the theme's `--dsw-alias-*` tokens, replacing the per-element inline `style` objects. Adds a brand header, rounded cards with hover feedback, a status badge, account cards, and a per-section toolbar.
- Harden the settings page against a malformed `/state` reading: a gateway state outside `running` / `starting` / `stopped` / `failed` now renders as stopped instead of emitting a `data-tone` no stylesheet matches. Render-phase failures have no error boundary, so this class of bug blanks the whole settings panel.
- Fix realm switching never taking effect. The host half cached the settings thunk's *value* inside `setSource`, which `installSection` calls only when the settings provider attaches or detaches; a committed change afterwards fires `onChange` alone. The section therefore stayed frozen on the realm it mounted with — the picker never echoed a switch, the account and model reads kept querying the old realm, and the CN-only controls never appeared. The thunk is now re-read on attach, on every committed change, and immediately after a write.
- Report credits to the cent, preferring the upstream's `*Precise` fields (measured on a real account: 2415 reported as 2415.78) and rounding the sum. Expired packages are now summed separately instead of into the usable balance, which they inflated.
- Distinguish the bulk credit refresh from the per-account one; both previously carried the same label side by side, so refreshing one account looked like refreshing all of them.
- Show a claim badge on CN account cards, with the confirmation time in its tooltip.

## 0.1.4 — 2026-09-16

- Fix a regression in 0.1.3: HTTP 502/503/504 on multiple accounts applied account cooldowns and made the caller's next retry fail with `no usable account`.
- Keep failover bounded by the request's tried-account set without cooling down accounts for these upstream gateway errors. Preserve cooldowns for authentication failures, rate limiting, and network exceptions.
- Add a regression reproducing three upstream failures followed by a caller retry two seconds later.

## 0.1.3 — 2026-09-16

- Treat upstream HTTP 502/503/504 during model connection setup as account-failover candidates, alongside 401/403/429 and network errors. Previously these gateway errors immediately failed the request without trying another available account.
- With only one account, return the upstream 502/503/504 without cooling down that account, so a caller retry is not blocked.
- Preserve bounded attempts, same-realm selection, and session rebinding. Errors after streaming begins are not replayed; an upstream-wide outage may still fail every account.
- Add offline regression tests for APISIX 502 → 504 → success, exhausted accounts, non-retryable HTTP 400, existing auth/rate-limit failover, and bounded single-account attempts.
- Keep `v0.1.2` and `v0.1.1` available for rollback.

## 0.1.2 — 2026-09-16

- Add credit refresh, CN check-in, growth-task requests, and account enable/disable controls to the settings integration.
- Refresh credits after desktop import and CN check-in; persist confirmed claim state, including upstream HTTP errors carrying code `10001`.
- Detect desktop credential directories by platform and support `WORKBUDDY_DESKTOP_AUTH_DIR`. macOS/Linux discovery has offline tests but no real-device verification.
- Render HTTP 2xx/3xx access logs from stderr as ordinary logs, preserving error highlighting for failed requests.
- Correct account-card control nesting, localized labels, and nested operation failure reporting; give account operations longer than the regular read timeout.
- Align package, plugin, and health versions; add Python account regression tests and release packaging checks.
- Rewrite Chinese and English installation and usage documentation, including fixed-tag upgrades and rollback to `v0.1.1`.

## 0.1.1

Existing release tag retained unchanged. Use it to restore the earlier plugin code; see the README for rollback commands and backup requirements.
