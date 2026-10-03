# Third-party notices

This package redistributes third-party code. The terms below apply to it, and the
MIT license in the repository root applies to everything else.

---

## `vendor/workbuddy-gateway/`

**What it is.** A vendored copy of the WorkBuddy → OpenAI-compatible reverse
proxy. Python standard library only; no build step and no dependencies.

**Upstream.** [`ardeyouxipianyi/workbuddy2api-intl`](https://github.com/ardeyouxipianyi/workbuddy2api-intl)
(also published there as `ardeyouxipianyi/workbuddy2api`), version 1.1.2 as
vendored. Local modifications to the account adapter are listed below; the
upstream license is retained.

**License.** MIT. The upstream `LICENSE` file is preserved unmodified at
`vendor/workbuddy-gateway/LICENSE`. Its copyright line reads
`Copyright (c) 2026` with no name attached, and it is reproduced here exactly as
received rather than attributed to a name its own text does not state.

**Modifications in 0.1.2.** `wb_accounts.py` contains local changes for:

- Platform-specific desktop credential directories and `WORKBUDDY_DESKTOP_AUTH_DIR`.
- Reading credits after desktop import and CN check-in.
- Persisting confirmed reward-claim status, including HTTP error code `10001`.

**Modifications in 0.1.3.** `wb_proxy.py` includes HTTP 502/503/504 in
connection-stage account failover. `tests/test_upstream.py` exercises the real
account pool with simulated upstream responses and no live credentials.

**Modifications in 0.1.4.** Upstream 502/503/504 failover does not cool down
accounts; request-local attempt tracking bounds retries without blocking the
caller's next request. Authentication and rate-limit cooldowns are preserved.

**Modifications in 0.2.3.** `wb_proxy.py` classifies upstream code 11140 as an account-level restriction, preserves readable error bodies, rotates and cools affected accounts, and avoids account cooldown for transport failures. `wb_accounts.py` shares read-only eligibility between status counts and selection, expires domestic check-in status at the local day boundary, and `wb_proxy.py` refreshes credits after a successful check-in and returns the updated account snapshot. Authentication and model-limit guards remain active; offline tests cover both client protocols, same-realm retries, check-in expiry, and credit refresh.

**Modifications in 0.2.2.** `wb_accounts.py` stores per-account/model reset deadlines
and serializes atomic saves. `wb_proxy.py` rotates on HTTP 429 or business code
6004, skips restricted pairs until reset, and preserves error response bodies.
The new local `wb_rate_limits.py` parses upstream reset timestamps and Retry-After,
with a configurable fallback. This supersedes 0.2.1's pool-wide cooldown handling;
affected models no longer impose account-wide cooldowns. Offline Python tests cover
persistence, concurrent writes, model/realm isolation, and both HTTP protocols.

A local `.npmignore` excludes Python bytecode and account state from npm packages.

`tests/test_accounts.py` covers these changes with offline fixtures. Preserve or
reconcile these changes when updating upstream. The plugin runs this copy from its own directory and
redirects the mutable state it produces — account credentials and usage records —
out of the checkout and into `$DSH_HOME/workbuddy/`, by environment variable. That
keeps a `link:`-installed plugin from writing into its own source tree.

**What it does that this project does not control.** The gateway authenticates
against WorkBuddy's own service using credentials the official desktop app
already stored on the machine, and translates the subscription protocol into the
OpenAI wire format. It is not an official WorkBuddy or Tencent API client, and
neither this plugin nor its author has any relationship with WorkBuddy or
Tencent.

### MIT license text, as received

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Referenced, not redistributed

The plugin's design references community DSH plugins. No code from them is
included here; they were read for their integration patterns only.

- [`iJetLi/deepseek-harness-codearts`](https://gitee.com/iJetLi/deepseek-harness-codearts) — per-account/model reset deadlines; the Python implementation is independently written.
- `dsh-plugin-archived-sessions` — the `settings.section` slot registration.
- `dsh-plugin-codex-monitor` — host route + client page shape, and the
  same-origin guard convention for mutating routes.

## Not covered by this repository's license

- **WorkBuddy / CodeBuddy / Tencent** names, marks, and service. Using this
  software does not grant any right to them.
- **DSH** (`@deepseek-ai/*`) — the harness this plugin plugs into. It is a
  separate project under its own license, and it is a runtime dependency rather
  than a redistributed artifact.
