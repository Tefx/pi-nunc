# Nunc

Nunc is a [Pi](https://pi.dev) extension designed to keep a **single long-running session** coherent inside a finite context window.

Scope stays strictly within the active session branch: `/new` starts with empty memory, and `/tree`, `/fork`, and `/clone` follow the selected branch. Nunc avoids cross-session memory databases, user profiling, or background document indexing—durable project knowledge belongs in code, docs, and commits.

This package is `"private": true` and is not published to npm.

## How It Works

Stock compaction replaces older conversation history with a single flat summary, which often drops exact constraints, parameters, or mid-task state over multiple compactions, and invalidates prompt caches when summaries move. Nunc replaces that summary with incremental working-memory slots (`M`) and a cache-friendly context layout:

```text
Normal turn:   F | R_before | M | R_after
Compaction:    F | M | B | K   -->   updated M + retained K
```

1. **Verbatim recent history (`R` / `K`):** Recent turns stay verbatim so the model sees exact tool calls, outputs, and immediate context.
2. **Anchored working memory (`M`):** Information that still matters after older turns age out—goals, constraints, decisions, inputs, and unfinished work—lives in discrete text slots (`{ id, text }`). During normal turns, unchanged `M` stays anchored at the history boundary where it was last sent (`R_before | M | R_after`), keeping the prompt prefix stable for provider caching.
3. **Single-pass incremental maintenance:** When Pi triggers compaction (threshold, overflow recovery, or `/compact`), Nunc splits active history into retiring `B` and retained `K`, and makes **at most one** call on the session's current model. The model returns a structured JSON patch (`add`, `update`, `remove`, `priority`, `required`, and optional `toolResultEdits`). All `required` items are kept together; if validation or capacity fails, Nunc cancels the compaction so Pi preserves the existing session state unchanged.
4. **Tool-result cleanup & overflow calibration:** Completed business-tool outputs that have already been distilled into `M` (or duplicated in `K`) can be compacted or summarized in place while keeping raw originals in the session JSONL. If a provider undercounts tokens or rejects a maintenance request for context overflow, Nunc records branch-bound calibration so the next attempt automatically trims large tool bodies or fails fast without repeating the same rejected call.

## Tools and TUI

### Interactive TUI & Commands

- **`/nunc` or `F7`:** Opens the Nunc overlay in TUI mode (`Slots` tab to search, preview, edit, or delete memory slots; `Context` tab to inspect the live `F / M / R` layout, token budgets, and last maintenance record). In non-TUI modes, `/nunc` prints the full text report.
- **`/nunc details`:** Prints the text report (slot occupancy, budgets, last main/maintenance status, and recent diagnostics) without calling a model.
- **Footer indicator:** Shows slot count and memory-target occupancy (`🧠 8·42%`, `🧠 0` when empty, `🧠 ↻8` during maintenance/save, `🧠 !8` on warnings, `🧠 ×` on invalid config).

### Optional Model Tools (`--nunc-memory-tools`)

By default, Nunc manages `M` only during compaction without changing the model's toolset. When enabled via `--nunc-memory-tools` or Pi settings (`{"nunc": {"memoryTools": true}}`), Nunc exposes two tools to the model:

- **`nunc_memory_read`:** Reads current slots, revision, and budget; also supports read-only keyword search (`query`) and entry lookup (`entryIds`, `originals`) over retired messages and cleaned tool outputs on the current session branch.
- **`nunc_memory_patch`:** Atomically adds, updates, or removes memory slots (and optional `toolResultEdits`) during a turn using compare-and-swap (`expectedRevision`).

## Requirements

| Dependency | Version |
| --- | --- |
| Node | `26.7.0` (`.node-version`) |
| npm | `11.19.0` |
| Pi / `@earendil-works/pi-ai` / `@earendil-works/pi-tui` | Runtime: stable `^1.0.3`; devDependencies pinned to `1.1.0` |

Runtime constraints:

- Persistent sessions only (`--no-session` is rejected).
- Native images only (`images.blockImages` must remain `false`).
- Single custom compaction owner (do not run another compaction extension alongside Nunc).

## Quick Start

```sh
git clone https://github.com/tefx/pi-nunc.git
cd pi-nunc
npm ci --ignore-scripts --no-audit --no-fund
npm run build

node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --offline --no-extensions -e dist/src/index.js
```

With a custom config file or model memory tools enabled:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --offline --no-extensions -e dist/src/index.js \
  --nunc-config ./nunc.json --nunc-memory-tools
```

`package.json` registers `"pi": { "extensions": ["./dist/src/index.js"] }`, so the repo directory can also be loaded as a local Pi package after `npm run build`.

## Configuration

### Pi `settings.json`

In `~/.pi/agent/settings.json` or a trusted project `.pi/settings.json`:

```json
{
  "nunc": {
    "memoryTools": false,
    "toolResultCleanup": true
  }
}
```

### `--nunc-config` JSON

All fields are optional. `policyFile` resolves relative to the config file's directory.

| Field | Default | Purpose |
| --- | --- | --- |
| `policyFile` | unset | Supplemental UTF-8 Markdown maintenance preferences appended to `policies/default.md`. |
| `memory.fraction` | `0.1` | Planning reserve fraction of available context (`[0, 1)`). |
| `memory.targetTokens` | `8192` | Soft organizing target for `M`. |
| `memory.maxTokens` | unset | Optional advisory ceiling on the maintenance organizing target. |
| `memory.hardMaxTokens` | unset | Optional hard cap on saved `M` (when unset, `required` slots may exceed the soft target). |
| `rolling.keepRecentFraction` | `0.5` | Target fraction of post-`M` context kept as verbatim `K` (`(0, 1)`). |
| `extraction.toolResults` | `"auto"` | `"auto"` (head/tail reduction only when needed to fit input limits) or `"full"`. |
| `extraction.headTailChars` | `200` | Head and tail character count kept when reducing large tool results. |
| `extraction.outputTokens` | `"auto"` | `"auto"` (scales from an 8192 floor up to model output capability) or positive integer. |
| `budget.safetyTokens` | `1024` | Safety margin subtracted from input limits. |
| `budget.growthTokens` | `1024` | Post-compaction growth room reserved for upcoming turns. |
| `budget.extraMainInputTokens` | `0` | Extra input token allowance for main requests. |
| `budget.extraExtractionInputTokens` | `0` | Extra input token allowance for maintenance requests. |
| `budget.inputLimit` | unset | Optional explicit input token ceiling. |
| `budget.imageTokens` | unset | Optional per-image token estimate override (defaults to Pi's heuristic). |

Example `nunc.json` (overriding `rolling.keepRecentFraction` from `0.5` to `0.67`):

```json
{
  "policyFile": "./preferences.md",
  "memory": { "fraction": 0.1, "maxTokens": 2000, "hardMaxTokens": 8192 },
  "rolling": { "keepRecentFraction": 0.67 },
  "extraction": { "toolResults": "auto", "headTailChars": 200 },
  "budget": { "safetyTokens": 1024, "growthTokens": 1024 }
}
```

## Development

`npm ci` and `npm run build` compile the extension. Running the full check suite (`scripts/check.mjs all`) additionally requires the pinned Node/npm versions, a local comparison baseline checkout, POSIX PTYs, and `/usr/bin/python3`. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/LIVE.md](docs/LIVE.md).

## Documentation

Detailed specifications live in `docs/`:

- [Project constitution: scope, ownership, and limits](docs/CONSTITUTION.md)
- [Core design](docs/DESIGN.md)
- [Stable memory placement and retention](docs/STABLE-MEMORY.md)
- [Extraction protocol and required items](docs/EXTRACTION.md)
- [Pi extension loading, commands, and persistence](docs/PI.md)
- [Maintenance engine](docs/ENGINE.md)
- [Capacity ownership and calibration](docs/CAPACITY.md)
- [Slots/Context UI](docs/UI.md)
- [Active memory and model tools](docs/ACTIVE-MEMORY.md)
- [Working-memory guidance refinements](docs/MEMORY-GUIDANCE.md)
- [Tool-result cleanup](docs/TOOL-RESULT-CLEANUP.md)
- [Native OpenAI routing and billing](docs/NATIVE-OPENAI.md)
