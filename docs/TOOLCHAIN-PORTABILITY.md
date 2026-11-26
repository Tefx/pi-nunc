# Toolchain Version-Range and Baseline Portability

Status: **Implemented toolchain contract. See DEVELOPMENT.md for current temporary-baseline setup and verification commands.**

This specification replaces brittle patch-level equality pinning (`Node === 26.7.0`, `npm === 11.19.0`) and machine-local branch refs (`refs/nunc/task-retention-pre-change`) with SemVer range enforcement, observed-version recording, and clone-portable baseline commit OIDs, while keeping `package-lock.json` dependency pins exact.

## Binding Contract

### 1. SemVer Range Policy for Node and npm (`MUST`)

- **`package.json` (`engines`)**: Declare minimum versions (`"node": ">=22.19.0"`, `"npm": ">=11.5.1"`). Keep `devDependencies` and `package-lock.json` dependency versions unchanged and exact. Align `package-lock.json` root `packages[""].engines` with `package.json` without altering locked package resolutions.
- **`.node-version`**: Select Node major `26` for live preflight without pinning a patch version.
- **Compatibility predicate**: Accept strict stable SemVer triples at or above the declared `>=` floor, including later majors. Reject versions below the floor, malformed strings, and prereleases. A positive-major caret range additionally requires the same major.

### 2. Check Runner and Preflight Receipt Behavior (`MUST`)

- **`scripts/check.mjs`**:
  - Validate `process.versions.node` and `npm --version` against `package.json` `engines.node` and `engines.npm` using the SemVer range predicate above (never exact equality against `.node-version` or a hardcoded patch string).
  - Resolve `npm-cli.js` by checking the active Node binary's installation directory (`dirname(process.execPath)` and `dirname(realpathSync(process.execPath))`) before falling back to `/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js` or `PATH`-resolved `npm`.
  - Log the actual observed `node` and `npm` versions alongside the check summary.
- **`src/live/contract.ts` (`preflight`)**:
  - Enforce the separate stable caret range (`^26.7.0`) on `process.versions.node` (with `NODE_OPTIONS` unset).
  - Bind and record the actual runtime `process.versions.node` in both the preflight SHA-256 digest and returned `Receipt.node`, preserving deterministic receipt invalidation when switching Node versions without failing compatible patch upgrades.

### 3. Clone-Portable Comparison Baseline References (`MUST`)

- Replace references to the MBA-local ref `refs/nunc/task-retention-pre-change` in `tests/live/task-retention-native.test.ts`, `tests/live/task-retention-comparison.test.ts`, `tests/live/same-task-history.test.ts`, and `docs/DEVELOPMENT.md` with the immutable `main`-history commit OID `1d4fc4a210b64f71871ab3f5c10093215a25990c` (keeping `70dacad1f065a70b29f565b5bfcf02d31cec2bdc` for the historical default baseline and `0.86.1` dependency verification in `src/live/contract.ts`).

### 4. Synchronized Documentation and Regression Tests (`MUST`)

- Keep `docs/DEVELOPMENT.md` and `README.md` aligned with the package floors, separate live caret range, observed-version reporting, and temporary detached baseline at `1d4fc4a210b64f71871ab3f5c10093215a25990c`.
- Cover acceptance at and above the package floors, rejection below them and on malformed or prerelease input, and the live caret's same-major restriction in `tests/engine/runner.test.ts` and `tests/live/contract.test.ts`.

## Implementation Notes & Hazard Map (`ADVISORY`)

- **`package.json` (`packageManager`)**: `packageManager: "npm@11.19.0"` can trigger Corepack strict errors on machines running `npm 11.20.0`; omit `packageManager` or avoid checking it in `scripts/check.mjs` so Homebrew rolling `npm` upgrades stay unblocked.
- **Detached baselines (`70dacad` and `1d4fc4a`)**: `src/live/comparison.ts` only invokes `preflight()` on the candidate repository (`repository`), while temporary detached historical targets are checked only for HEAD, clean tree, build parity (`dist/src/index.js`), and Pi version. Therefore historical baselines do not re-run old exact-version `.node-version` checks when prepared on Node `26.13.0`.
- **Cross-machine verification**: Run the checks in DEVELOPMENT.md using an installed compatible Node/npm toolchain. Comparison fixtures create detached historical targets, install each tracked lock offline with lifecycle scripts disabled, compile with the installed TypeScript, and remove those targets on teardown or setup failure. No pre-existing `.scratch` baseline is required. Host integration and phase acceptance remain separately reported evidence.
