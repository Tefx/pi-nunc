# Nunc

**A bounded, rolling present for Pi.**

Nunc is a [Pi](https://pi.dev) **0.85.1** extension for continuing one session inside a finite context. Recent work stays as verbatim history. Information still needed after that window leaves is kept in a small set of working-memory slots. Pi keeps the full JSONL log; Nunc does not search memory, write documents, or carry state across sessions.

```text
Before compaction: host instructions/tools | memory M      | retiring B | retained K
After compaction:  host instructions/tools | updated M     | retained K | new messages
```

Maintenance asks what would still be needed with effective host instructions **F**, retained history **K**, and normal working tools. Existing memory **M** fills those gaps. Later evidence in K helps decide which parts of retiring prefix **B** remain useful. Declared necessary items are retained together, or maintenance fails without changing the saved session.

This package is `"private": true`. It is not published to npm. There is no license file in this repository.

## Requirements

Checked environment:

| Tool | Version |
| --- | --- |
| Node | 26.7.0 (`.node-version`) |
| npm | 11.19.0 |
| Pi / `@earendil-works/pi-ai` / `@earendil-works/pi-tui` | 0.85.1 |

Runtime limits:

- Persistent Pi sessions only. Do not start with `--no-session`.
- Leave `images.blockImages` off. Nunc refuses image-blocking conversion.
- One custom compaction owner. If another compaction extension is also enabled, keep exactly one writer.
- Nunc uses Pi’s current model, thinking level, authentication, compaction settings, and transport. It does not log in, copy credentials, or select another account.

A different global `pi` binary is unsupported unless it reports exactly `0.85.1`. Nunc checks `VERSION` at session start.

## Quick start

Requires Node **26.7.0** and npm **11.19.0** on `PATH` (`node -v`, `npm -v`). Runtime and ordinary install do not use a Homebrew-only Node or npm path.

```sh
git clone https://github.com/tefx/pi-nunc.git
cd pi-nunc
npm ci --ignore-scripts --no-audit --no-fund
npm run build

node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --offline --no-extensions -e dist/src/index.js
```

Optional JSON (path is relative to Pi’s cwd):

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --offline --no-extensions -e dist/src/index.js --nunc-config ./nunc.json
```

`--no-extensions` skips discovery; `-e` loads this compiled entry for one invocation. `package.json` declares `"pi": { "extensions": ["./dist/src/index.js"] }`. That path is used when this directory is loaded as a **local** Pi package after `dist/` exists. It is not an npm registry install target.

`/reload` rebuilds extensions in the current process. It does not reopen the session file.

The tracked `scripts/check.mjs` inventory is a separate development check with extra prerequisites, including a Homebrew npm CLI path and a comparison baseline checkout. See [local development](docs/DEVELOPMENT.md).

## Commands and UI

| Command | Behavior |
| --- | --- |
| `/nunc` | TUI: open the Slots/Context overlay (Slots first). Other modes: the same complete text report as `/nunc details`. No model request. |
| `/nunc details` | Complete text report in every mode: slots/occupancy/warning, current budgets including maintenance input, last maintenance, recent diagnostics. |
| `F7` | TUI shortcut for the overlay. Does not submit the main editor draft. Unchanged. |

`/nunc status` is removed; it is an unknown argument. Unknown arguments print `Usage: /nunc [details]` and do not open the panel. Native completion offers only `details`. The previous short status text and status alias are superseded. Read-only commands do not append session entries. RPC `hasUI` is not a terminal overlay; `ctx.mode === "tui"` is required for the panel. The text report and panel read `ContextSurface`, last-maintenance accounting, and UI diagnostics; they do not keep a second budget or M store.

Footer examples: `nunc 8·42%` (saved slots and memory-budget occupancy), `nunc ↻ 8` (maintenance, including waiting for Pi to save), `nunc ! 8` (current warning), `nunc ×` (unusable configuration). Occupancy is Nunc’s memory budget, not Pi’s whole-context meter.

The overlay searches, previews, edits, and deletes slots. The Context tab shows the current F/M/R layout and the last main-request or maintenance observation. Viewing and editing do not call a model or compact. Saving writes a native session entry with the complete memory snapshot and leaves retained history K unchanged. Manual edits not yet absorbed by a later compaction need this Nunc to take effect; stock Pi or an older Nunc still reads the last native summary.

Details: [extension usage](docs/PI.md), [Slots/Context UI](docs/UI.md).

## Configuration

Omit `--nunc-config` for Nunc defaults. All fields are optional. Unknown names or invalid types fail at load. Nunc reads the file and does not write it. `policyFile` is UTF-8 and resolves from the configuration file’s directory.

Implemented defaults (`src/pi/config.ts`):

| Field | Default |
| --- | --- |
| `policyFile` | unset (built-in `policies/default.md` only) |
| `memory.fraction` | `0.1` (range `[0, 1)`) |
| `memory.maxTokens` | unset (no absolute cap) |
| `rolling.keepRecentFraction` | `0.67` (range `(0, 1)`) |
| `extraction.toolResults` | `"auto"` (`"full"` disables tool-body reduction) |
| `extraction.headTailChars` | `200` |
| `extraction.outputTokens` | `min(8192, model.maxTokens)` |
| `budget.safetyTokens` | `1024` |
| `budget.growthTokens` | `1024` |
| `budget.extraMainInputTokens` | `0` |
| `budget.extraExtractionInputTokens` | `0` |
| `budget.inputLimit` | unset |
| `budget.imageTokens` | unset (native images need a justified per-image bound) |

Optional integers are positive except the `extra*` fields, which may be zero. Example file (every key optional):

```json
{
  "policyFile": "./preferences.md",
  "memory": { "fraction": 0.1, "maxTokens": 2000 },
  "rolling": { "keepRecentFraction": 0.67 },
  "extraction": { "toolResults": "auto", "headTailChars": 200 },
  "budget": { "safetyTokens": 1024, "growthTokens": 1024 }
}
```

Pi compaction settings remain Pi’s (`compaction.reserveTokens` default 16384, `keepRecentTokens` default 20000, `enabled` default true). Nunc’s trigger is `H = contextWindow - reserveTokens`. Require a positive reserve and H, and `0 <= keepRecentTokens < H`. Pi uses `keepRecentTokens` for native preparation; Nunc chooses a legal retained suffix from `keepRecentFraction` independently.

An explicit `extraction.outputTokens` equal to `model.maxTokens` is still honored, with a migration warning on APIs that have no serialized output cap. Remove that override to use the 8192 planning default. Nunc never rewrites Pi settings.

## Compaction and maintenance

Pi decides when compaction runs: automatic threshold (`contextTokens > contextWindow - reserveTokens`), overflow recovery, or `/compact [instructions]`. Nunc handles `session_before_compact` and does not add a second scheduler.

Each opportunity makes **at most one** maintenance request on the **current** model. There is no repair retry and no second summarizer model. Optional `/compact` instructions append to user policy for that call only. Extraction uses the raw API defaults bounded by the extraction output reserve; it does not inherit the main turn’s thinking budget.

The model returns one JSON object with `add`, `remove`, `priority`, and `required`:

- `required` is a unique subset of `priority` (surviving slot IDs and addition keys). Every declared required item must fit together inside the memory limit. If it cannot, or growth space after the candidate is insufficient, maintenance fails with `CAPACITY`. Saved M and K stay unchanged. Required is for this maintenance, not a permanent pin.
- `priority` lists every survivor and addition exactly once. Optional items use remaining budget in that order. Surviving slots keep their relative order and exact text; additions append. Priority does not reorder ordinary memory.

Code validates references, whole-slot rendered budgets, and the retained-history cut. Policy text cannot keep an item that failed those checks. Empty memory and empty `required` are valid when nothing must continue.

On success Nunc hands Pi one compaction result: `summary`, `firstKeptEntryId`, `tokensBefore`, and `details.nunc = { version: 1, slots, nextId }`. Failure or cancellation before that handoff returns `{ cancel: true }` so Pi does not fall through to the default summarizer. After handoff, append, rebuild, and their errors belong to Pi. A maintenance event is not a persistence receipt; watch `session_compact` and the JSONL file.

Main requests are checked separately. Crossing Nunc’s softer memory-planning target does not reject a send. Oversized indivisible input still fails before HTTP. Details: [engine](docs/ENGINE.md), [capacity](docs/CAPACITY.md), [policy](docs/POLICY.md).

## Limits

- Same-session memory only. `/new` starts empty; `/tree`, `/fork`, and `/clone` follow Pi’s selected path.
- No cross-session memory database, proactive search, or document-writing service.
- Ordinary turns do not require memory tools or usage counters.
- Token figures are planning estimates, not tokenizer proofs, cache guarantees, or cost proofs.
- Supported host is stock Pi **0.85.1** with persistent sessions. No minimum-version or all-provider claim.
- Images need model image input **and** `budget.imageTokens`. PDF, audio, and unknown blocks fail explicitly.
- Unload or downgrade without a later native compaction: stock Pi reads the last native summary, not unabsorbed manual edits.
- `scripts/check.mjs` requires the pinned Node and a hardcoded Homebrew npm CLI path. It also needs a local comparison baseline before `all`. See [local development](docs/DEVELOPMENT.md). Real TUI checks also need POSIX PTYs and `/usr/bin/python3`.
- Historical extraction acceptance recorded product `4f1f668` (423 tests / 52 files), UI human confirmation of IME/resize/theme, and disclosed comparison limits. That record is not proof of later source.

Long-term work belongs in code, documents, and other artifacts. Forgetting is how the working context stays finite.

## Development

`npm ci` and `npm run build` are not enough for `scripts/check.mjs all`. Prepare the [comparison baseline](docs/DEVELOPMENT.md#comparison-baseline-for-all), then run the inventory with the check runner’s Node/npm constraints in [local development](docs/DEVELOPMENT.md).

See also [bounded observations](docs/LIVE.md).

## Further documentation

- [Core design](docs/DESIGN.md)
- [Extraction, required items, and comparison scope](docs/EXTRACTION.md)
- [Pi extension loading, commands, and persistence](docs/PI.md)
- [Maintenance engine](docs/ENGINE.md)
- [Capacity ownership](docs/CAPACITY.md)
- [Slots/Context UI](docs/UI.md)
