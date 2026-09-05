# Local development

Selected check environment: Node **26.7.0**, npm **11.19.0**, Pi/pi-ai **0.85.0**, TypeScript **5.9.3**, Node types **26.4.1**. These are selected targets, not a minimum-version compatibility claim. The package is private ESM; source/tests use strict TypeScript and the native Node test runner. `skipLibCheck` skips upstream declaration internals; project source, tests and their typed public API calls are checked.

`package-lock.json` locks dependencies. Pi packages are host peers and explicit development dependencies, with no implicit global import resolution. Pi 0.85.0's unbundled public root imports `@earendil-works/pi-server` although its published dependency manifest omits it. The pinned **development** `pi-server@0.85.0` is a local SDK-load prerequisite. It is not a running server, core patch or change to an installed daily Pi. Future packaging/host integration must reconcile that upstream packaging limitation before claiming standalone distribution support.

## Install explicitly

Installation is separate from checks and needs target/effect authorization. Within the authorized checkout:

```sh
/usr/bin/env -u NODE_OPTIONS \
  npm_config_cache="$PWD/.npm-cache" npm_config_ignore_scripts=true \
  /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js \
  ci --include=dev --no-audit --no-fund
```

Ignoring dependency lifecycle scripts follows Pi's npm installation guidance. No global package installation, version update or daily configuration edit is required. npm may print an update notice; do not follow it as part of this selected-runtime check. `.npm-cache/`, `.scratch/`, `node_modules/` and `dist/` are local ignored working state. No credentials belong there.

## Required engine check

```sh
/usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  /opt/homebrew/bin/node scripts/check.mjs engine
```

The tracked runner:

1. Rejects missing, multiple and unknown selections. `all` intentionally fails until the Pi producer delivers the integrated inventory.
2. Enforces `.node-version`/manifest Node agreement and the selected npm version using the absolute npm CLI. It checks local direct development package versions against the tracked lock and fails on missing/mismatched tools.
3. Invokes the local TypeScript compiler through the current absolute Node executable. Emits declarations and JavaScript under `dist/`.
4. Discovers all nonempty `tests/engine/**/*.test.ts` selections and invokes their emitted files with the native Node test runner. Compile errors, missing emitted files, process signals and test failures exit nonzero.

The runner never installs, downloads, updates or refreshes models. Compiler/test subprocesses get a minimal environment, worktree-local HOME/Pi directories and offline/telemetry flags, with no inherited credentials. The bridge fixture creates explicit in-memory credential/catalog state and no configured models file. `PI_OFFLINE` suppresses host startup network operations; tests additionally use only controlled service providers and perform no live model request. `npm run check:engine` is a convenience alias when the shell already selects the declared Node.

For build-only consumers, `npm run build` emits the public `pi-nunc/engine` export. The engine's policy loader resolves `policies/default.md` for both direct source loading and emitted `dist/src/engine` layout. Optional user policies use an explicit absolute path or resolve relative to the supplied absolute configuration file's directory, never implicit process cwd.

## Verification ownership

- `tests/engine/memory.test.ts`: incremental changes, complete priorities, whole-slot capacity, IDs and stable order.
- `tests/engine/source.test.ts`: complete projected evidence, tool pairing, host boundary restrictions, bounded reduction and native/unsupported input.
- `tests/engine/budget.test.ts`: complete request estimates, provider input/output ceilings, Pi output-cap exceptions, cache/unknown usage, growth and changed models/configuration.
- `tests/engine/lifecycle.test.ts`: terminal response validation, cancellation, frozen state and explicit failures.
- `tests/engine/policy.test.ts`: real policy loading, UTF-8 failures, path base and next-load behavior. Exact content comparison tests the asset-loading contract only.
- `tests/engine/pi-model.test.ts`: public package import and real Pi model registry/runtime to controlled pi-ai provider; actual host summary projection used in budgeting.
- `tests/engine/runner.test.ts`: CLI failure behavior for invalid selection and injected Node options.

Policy quality, real-model task continuation and final project acceptance are not established by these tests. The next producer must add real extension loader/hook/persistence tests, configuration and session lifecycle handling, the integrated `all` inventory and bounded live observation runner. No daily/global Pi installation or real-model testing is part of this engine delivery.
