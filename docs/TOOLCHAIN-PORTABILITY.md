# Toolchain Version-Range and Baseline Portability

Status: **Accepted design specification (authorized prerequisite for cross-machine verification of `nunc-admission-retention-hardening`).**

This specification replaces brittle patch-level equality pinning (`Node === 26.7.0`, `npm === 11.19.0`) and machine-local branch refs (`refs/nunc/task-retention-pre-change`) with SemVer range enforcement, observed-version recording, and clone-portable baseline commit OIDs, while keeping `package-lock.json` dependency pins exact.

## Binding Contract

### 1. SemVer Range Policy for Node and npm (`MUST`)

- **`package.json` (`engines`)**: Declare compatible caret/major-bounded ranges (`"node": "^26.7.0"`, `"npm": "^11.19.0"`) instead of exact patch strings. Keep `devDependencies` and `package-lock.json` dependency versions strictly unchanged and exact. Align `package-lock.json` root `packages[""].engines` with `package.json` without altering locked package resolutions.
- **`.node-version`**: Declare the target major line (`26`) rather than locking a single patch binary across developer machines.
- **Compatibility predicate**: Validate Node and npm versions as strict stable SemVer triples within the declared caret floor (`major === 26`, `>= 26.7.0`, zero prerelease/non-numeric segments for Node; `major === 11`, `>= 11.19.0`, zero prerelease segments for npm). Reject older patches (`26.6.x`, `11.18.x`), different majors (`25.x`, `27.x`), malformed strings, and prerelease tags.

### 2. Check Runner and Preflight Receipt Behavior (`MUST`)

- **`scripts/check.mjs`**:
  - Validate `process.versions.node` and `npm --version` against `package.json` `engines.node` and `engines.npm` using the SemVer range predicate above (never exact equality against `.node-version` or a hardcoded patch string).
  - Resolve `npm-cli.js` by checking the active Node binary's installation directory (`dirname(process.execPath)` and `dirname(realpathSync(process.execPath))`) before falling back to `/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js` or `PATH`-resolved `npm`.
  - Log the actual observed `node` and `npm` versions alongside the check summary.
- **`src/live/contract.ts` (`preflight`)**:
  - Enforce the same stable SemVer floor (`^26.7.0`) on `process.versions.node` (with `NODE_OPTIONS` unset).
  - Bind and record the actual runtime `process.versions.node` in both the preflight SHA-256 digest and returned `Receipt.node`, preserving deterministic receipt invalidation when switching Node versions without failing compatible patch upgrades.

### 3. Clone-Portable Comparison Baseline References (`MUST`)

- Replace references to the MBA-local ref `refs/nunc/task-retention-pre-change` in `tests/live/task-retention-native.test.ts`, `tests/live/task-retention-comparison.test.ts`, `tests/live/same-task-history.test.ts`, and `docs/DEVELOPMENT.md` with the immutable `main`-history commit OID `1d4fc4a210b64f71871ab3f5c10093215a25990c` (keeping `70dacad1f065a70b29f565b5bfcf02d31cec2bdc` for `.scratch/baseline-70dacad` and `0.86.1` dependency verification in `src/live/contract.ts`).

### 4. Synchronized Documentation and Regression Tests (`MUST`)

- Update `docs/DEVELOPMENT.md` and `README.md` to state the `^26.7.0` / `^11.19.0` range policy, recorded observed versions, and `1d4fc4a210b64f71871ab3f5c10093215a25990c` setup for `.scratch/prechange`.
- Add focused unit tests in `tests/engine/runner.test.ts` and `tests/live/contract.test.ts` (or a shared range-check test) verifying acceptance of `26.7.0` / `26.13.0` and `11.19.0` / `11.20.0`, and explicit rejection of older patches, cross-major versions, and prerelease tags.

## Implementation Notes & Hazard Map (`ADVISORY`)

- **`package.json` (`packageManager`)**: `packageManager: "npm@11.19.0"` can trigger Corepack strict errors on machines running `npm 11.20.0`; omit `packageManager` or avoid checking it in `scripts/check.mjs` so Homebrew rolling `npm` upgrades stay unblocked.
- **Detached baselines (`70dacad` and `1d4fc4a`)**: `src/live/comparison.ts` only invokes `preflight()` on the candidate repository (`repository`), while `.scratch/baseline-70dacad` and `.scratch/prechange` are checked only for HEAD, clean tree, build parity (`dist/src/index.js`), and Pi version. Therefore historical baselines do not re-run old exact-version `.node-version` checks when prepared on Node `26.13.0`.
- **Cross-machine execution order**: Integrate `nunc-toolchain-portability` onto `main` first (or before `nunc-admission-retention-hardening` final verification), rebase `nunc-admission-retention-hardening.implement-hardening` onto updated `main`, prepare `.scratch/{baseline-70dacad,prechange}`, and run the full `node scripts/check.mjs all` + `dist/tests/pi/larva.integration.js` + `gate-reviewer` phase acceptance on `Tefx-MBP-Personal`.
