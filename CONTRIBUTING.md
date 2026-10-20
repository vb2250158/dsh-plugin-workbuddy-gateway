# Contributing

Thanks for looking. This plugin sits on top of two things it does not own — the
DSH harness and a vendored third-party gateway — so most of the guidance below is
about respecting those boundaries.

## Getting set up

You need:

- **Node 20.19+** — the plugin's only runtime requirement.
- **Python 3.9+** on `PATH` — only if you want the gateway to actually run. The
  unit tests do not need it.
- **A DSH checkout** — only for the integration scripts. Everything else works
  without one.

```bash
npm test                 # offline JavaScript tests
npm run test:python      # offline bundled-account tests (Python 3.9+)
npm run preflight        # proves spawn + piped stdio work on your machine
node scripts/check-package.mjs   # pre-publish check
```

The current-settings integration check needs a built harness CLI or the official Desktop CLI. Run it from this checkout:

```bash
node scripts/verify-profile-settings.mjs /path/to/deepseek-harness/apps/cli/lib/bin.js
# On Windows, the first argument may instead be the installed Desktop dsh.cmd.
```

This launches a disposable profile through `dsh`, loads the real Config editor, Settings and pi-ai services, and checks HTTP settings edits, external edits, provider writes, sibling preservation and restart persistence. It disables gateway startup and supplies no real credentials. An optional second argument selects another plugin directory, such as an extracted release, for regression comparison. The old `verify-settings-section.mjs` and `verify-provider-route.mjs` scripts target the removed legacy Settings service and are only useful with a corresponding old harness.

## What a change needs

**A test that fails without it.** The tests here are not decoration: nearly every
real defect this plugin has had was invisible to the code reading well and was
caught by an assertion instead. Two examples worth knowing about, because they
are the shape of bug this codebase is prone to:

- A getter that existed only as a field on a returned object, so the read path
  checked `undefined` and silently skipped every account and model load. The
  tests had asserted the *snapshot field* rather than the getter.
- A settings schema registered as a bare function. The service serializes every
  schema with `toJSON()` to describe it, so the provider catalog broke the whole
  models settings page. Nothing had asserted that the registration was
  describable.

Both fixes came with the assertion that would have caught them.

**A reason in the comment.** This code explains *why* far more than *what*. Keep
that: the non-obvious decisions here (why readiness is read from a log line, why
provider routes are written through `settings.mutate`, why `running` is a real
getter) are each a bug that was fixed once and would quietly return without the
rationale attached.

**No new runtime dependencies.** The host half imports only Node builtins, and
the client bundle requires only `react`. This is deliberate: the plugin is
installed by `link:` into a DSH profile, where a dependency the profile does not
also have is a resolution failure waiting to happen.

## Boundaries

**Track changes to `vendor/`.** The bundled gateway comes from
[`ardeyouxipianyi/workbuddy2api-intl`](https://github.com/ardeyouxipianyi/workbuddy2api-intl)
(MIT). Local account-adapter fixes are listed in `THIRD_PARTY_NOTICES.md` and
covered by `npm run test:python`. Record every local modification there, retain
the license, and reconcile these patches on upstream updates.

**Do not weaken the account guards.** Every mutating HTTP route is behind a
same-origin check, and the plugin refuses to autostart the gateway when it cannot
obtain a bearer token for it. A gateway started without that token serves the
user's paid quota to anything on the machine that can reach the port.

**Do not add unverifiable claims to the README.** The test counts and the
reasoning-tier table in it are reproducible (`npm test`, `node
scripts/reasoning-report.mjs`), and that is the point.

## Harness coupling

This plugin uses DSH internals that are not a stable public contract:

| Used | For |
|---|---|
| volatile `Config`, `settings.configure`, and `loader/volatile-update` | expose live configuration and the custom settings page on current DSH |
| `settings.installSection`, when available | register the section on legacy hosts only |
| `settings.describe({ redactSecrets })` | must be able to serialize the section's schema |
| `settings.update` on the plugin entry id and `settings.mutate` on `llm-pi-ai` | persist plugin settings and add/remove exactly one provider route |
| `webServer.register` | the plugin's HTTP surface |
| `credentials.resolve` / `set` / `unset` | hold the gateway's bearer token |
| the `settings.section` client slot | render the settings page |

A harness change to any of these can break this plugin without any change here.
That is what the `integration` CI job exists to detect, and why its DSH revision
is pinned in `.github/workflows/ci.yml` — bump `DSH_REF` deliberately, after
running the integration scripts against the newer harness.

## Versioning and releases

Develop fixes on a branch, run the offline JavaScript and Python tests and the
package check listed above, and merge the verified change into `main` before
tagging a release. Run the integration scripts when changing harness integration.
Record any unavailable checks in the release notes; do not describe them as passed.

Use patch versions for fixes (`0.2.2` → `0.2.3`), minor versions for new features
or larger changes (`0.2.x` → `0.3.0`), and prerelease tags such as `v0.3.0-rc.1`
for release candidates. Update `package.json`, `PLUGIN_VERSION`, the health
endpoint version, both READMEs, and `CHANGELOG.md` together.

Create an annotated `vX.Y.Z` tag on the tested release commit in `main`, then
create a GitHub Release for that existing tag. Include the changes, validation,
fixed-tag installation command, previous-version rollback command, and any
restart or data-migration requirements. Mark only the newest stable release as
Latest. Check that the remote tag resolves to the intended commit.

Published tags are immutable: never move, overwrite, or delete one to replace a
release. Publish a new version for corrections. Installations should pin a release
tag rather than `main`; rollback changes code, not account data or configuration,
so preserve a private backup before upgrading.

## Reporting a bug

Include:

- the DSH version, and whether the harness is a checkout or an installed package
- what `GET /dsh-workbuddy-gateway/api/v1/health` returns (it carries the plugin
  version, the gateway state, and the gateway's recent log)
- for a model-behavior question, `node scripts/reasoning-report.mjs` output

That endpoint and script answer most "why does it look like this" questions
without a round trip.

## Licensing

Contributions are accepted under the repository's MIT license. By opening a pull
request you confirm you have the right to submit the work under it. See
`THIRD_PARTY_NOTICES.md` for the vendored code's separate terms.
