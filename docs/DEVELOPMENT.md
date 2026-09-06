# Local development

Selected targets: Node **26.7.0**, npm **11.19.0**, Pi/pi-ai **0.85.1**, TypeScript **5.9.3**, Node types **26.4.1**. The package is private ESM with strict TypeScript and Node's native test runner. These exact versions define the checked environment; no minimum-version claim is made. `skipLibCheck` skips upstream declaration internals, while project source/tests and public API calls remain type-checked.

`package-lock.json` pins dependencies. Pi packages are exact host peers and development dependencies. Pi 0.85.1 declares its own server dependency; Nunc requires no separate `pi-server` workaround, running server, global import or private core patch.

## Explicit installation

Inside the authorized checkout, use its isolated environment and selected toolchain:

```sh
/usr/bin/env -u NODE_OPTIONS \
  npm_config_cache="$PWD/.npm-cache" npm_config_ignore_scripts=true \
  /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js \
  ci --include=dev --no-audit --no-fund
```

Installation requires the corresponding effect authorization and runs separately from checks. Dependency lifecycle scripts remain disabled. No check installs, downloads, updates packages, refreshes a live model catalog, or changes daily Pi settings. `node_modules/`, `dist/`, `.npm-cache/` and `.scratch/` are ignored local working state. Offline fixtures use dummy task-owned authentication only; do not copy daily credentials into fixtures or reports.

## Required checks

```sh
/usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  /opt/homebrew/bin/node scripts/check.mjs all
```

Use `engine` instead of `all` for the narrower engine inventory. Missing, multiple, unknown and empty selections fail. `all` discovers every tracked `tests/**/*.test.ts`, requires nonempty engine/Pi/live suites, compiles their full source closure and executes every emitted test. It includes the actual CLI's bounded-stdin/preflight negatives and stock RPC/TUI observation selection. Compilation errors, missing emitted files, process signals and test failures exit nonzero.

The runner checks the selected Node/npm versions and installed direct development packages against the lock. Child processes receive constructed offline environments. `npm run build` emits JavaScript/declarations for `pi-nunc`, `pi-nunc/pi` and `pi-nunc/engine`; it performs no tests. `npm run check` and `npm run check:engine` are aliases when the shell selects the declared Node.

Real TUI tests require POSIX PTYs and `/usr/bin/python3` with its standard library. `scripts/pty-driver.py` creates an actual terminal for the pinned stock CLI, sends real input bytes, forwards termination and waits for child exit. Missing prerequisites fail explicitly; the runner never installs Python or substitutes an RPC/SDK test for the TUI.

## Default inheritance and test isolation

Product and real verification use Pi's effective native configuration/model/authentication. A standalone process resolves its own defaults; an invoking runtime forwards its current nonsecret selection to preserve unsaved startup/runtime choices. Tests use a fictional pre-existing native profile and named loopback/configuration overrides; they never inspect real auth. Isolate task sessions/cwd/files/output, without cloning agent/config/auth profiles. Saved settings/defaults and daily sessions remain untouched. Normal native credential refresh/persistence remains Pi-owned and is not subject to a byte-freeze promise.

The runner requires actual target, call/token/time/known-cost limits and scenarios; defaults need no repeated catalog or approval text. Named overrides record a test reason and differences and affect only the invocation/new task state. Unknown billing stays null. Single-use/quota/reconciliation checks protect actual effects; there is no Nunc authentication preparation or refresh suite. Producer tests prove controlled mechanics; downstream runtime owns real authentication/model use and acceptance judges completeness.

## Evidence layers

| Inventory | Behavior exercised |
|---|---|
| `tests/engine` | Slot changes/priorities, source fidelity/tool pairing, full/reduced accounting, output/thinking limits, unknown/cache usage, growth, policy loading, cancellation and public model bridge. |
| `tests/pi` component fixtures | Public package/extension loading, hooks, native JSONL/path rebuilding, source/media/config changes, cancellation and real isolated append failure. Their SDK fixtures supplement stock-host evidence. |
| `scripts/observe-stock.mjs` via `tests/pi/queue.test.ts` | `verify-live` stdin/preflight → stock RPC or actual PTY/TUI → native local capacity rejection → engine maintenance → Pi retry. Delivered B/K versus future D, original queue/custom delivery, future images, editor state, main and maintenance cancellation. |
| `scripts/observe-lifecycle.mjs` | Three legal overlapping checkpoints, actual restart/reload, model/tree/fork/clone/new, threshold/manual/disabled-auto behavior, provider replacement, unknown contexts/calls, payload/sampling/API rejection, bounded failures. |
| `scripts/observe-apis.mjs` | Stock native Responses and Anthropic adapters against loopback SSE, with pre-HTTP rejection and native recovery. Completions is exercised by the other stock drivers. |
| `tests/live` | Bounded nonsecret stdin/target/receipt/build parity, no-call preflight, quotas/failure/unknown usage, actual stock RPC/tools/calibrated rollovers/restart, child termination, cleanup and prerequisite-gated artifact checks. |

Drivers preserve mechanical reports, native sessions, request payloads and process/PTY observations under their isolated artifact directories before cleaning fixture state. The downstream `--observe-stock` route embeds evidence in its returned report before authorized removal. Controlled services return protocol fixtures, including incremental patches derived from the structured request; they make no model judgment. Fixed or scripted artifact contents test plumbing and scorer behavior only.

`all` proves the checked local mechanics. Real token accuracy, cache benefit, model policy quality, paid-service behavior, continued-task effectiveness and final integrated acceptance require separately authorized observation and judgment. See [PI](PI.md) for the extension contract and [LIVE](LIVE.md) for the bounded downstream runner. This producer neither installs a daily extension nor performs live/paid calls.
