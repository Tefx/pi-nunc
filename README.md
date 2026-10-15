# Nunc

**A bounded, rolling present for Pi.**

Nunc is a [Pi](https://pi.dev) extension for continuing one session inside a finite context. It supports **stable 1.x from 1.0.3**; development dependencies and current reproducible checks are pinned to **1.1.0**. Recent work stays as verbatim history. Information still needed after that window leaves is kept in a small set of working-memory slots. Pi keeps the full JSONL log; Nunc does not search memory, write documents, or carry state across sessions.

```text
Before compaction: host instructions/tools F | retiring B | retained K | working memory M
After compaction:  host instructions/tools F | retained K | new messages | updated memory M
```

Maintenance asks what would still be needed with effective host instructions **F**, retained history **K**, and normal working tools. Existing memory **M** fills those gaps. Later evidence in K helps decide which parts of retiring prefix **B** remain useful. Declared necessary items are retained together, or maintenance fails without changing the saved session.

This package is `"private": true`. It is not published to npm. There is no license file in this repository.

**Accepted change status:** [Stable memory placement and retention](docs/STABLE-MEMORY.md) is implemented: unchanged M stays at a legal history boundary (`F | Rbefore | M | Rafter`), and the default retention fraction is `0.5`. The diagram above is the maintenance B/K view, not the main-request send order. CRUD/CAS, complete tool units, native persistence and conservative receipts are unchanged. Live cache/task observation uses Gemini first, bounded GPT Luna when needed, and no Astra calls via `examples/stable-memory-selection.json`.

## Requirements

Checked environment:

| Tool | Version |
| --- | --- |
| Node | 26.7.0 (`.node-version`) |
| npm | 11.19.0 |
| Pi / `@earendil-works/pi-ai` / `@earendil-works/pi-tui` | Development: 1.1.0; supported policy: stable 1.x, ≥1.0.3 |

Runtime limits:

- Persistent Pi sessions only. Do not start with `--no-session`.
- Leave `images.blockImages` off. Nunc refuses image-blocking conversion.
- One custom compaction owner. If another compaction extension is also enabled, keep exactly one writer.
- Nunc uses Pi’s current model, thinking level, authentication, compaction settings, and transport. It does not log in, copy credentials, or select another account. Maintenance explicitly forwards frozen session thinking on supported OpenAI-compatible APIs; other raw-call paths retain their existing behavior (see below). Current relational-memory comparisons use native `openai/gpt-6.1-sol` subscription OAuth and **medium** on main and maintenance; see [native OpenAI routing and billing](docs/NATIVE-OPENAI.md).

Nunc checks the imported SDK `VERSION` before registration and accepts stable `^1.0.3`: newer 1.x minor/patch releases do not need a release-specific allowlist edit. It checks required public context/session/provider APIs before maintenance. Prereleases, other major versions and missing required APIs fail explicitly. Pi supplies runtime SDK modules; the stock checks use the package CLI entrypoint, including its embedded module mapping, and record the imported SDK version. Direct ESM imports can instead resolve a local development SDK, so an installed global binary alone does not establish the active SDK binding. Pi supplies host SDK packages; peers use `*` as its packaging contract requires, while the runtime support rule remains `^1.0.3`. Development dependencies/lock stay exact for reproducible checks; they do not cap a newer host. This follows Pi’s public-API/semantic-versioning contract, not a guarantee that every future minor release is bug-free. No updater, automatic dependency installation or runtime/config rewrite is introduced.

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

Footer examples: `🧠 8·42%` (saved slots and memory-budget occupancy), `🧠 0` (empty working memory), `🧠 ↻8` (maintenance, including waiting for Pi to save), `🧠 !8` (current warning), `🧠 ×` (unusable configuration). Occupancy is Nunc’s memory budget, not Pi’s whole-context meter.

The overlay searches, previews, edits, and deletes slots. The Context tab shows the current F/M/R layout and the last main-request or maintenance observation. Viewing and editing do not call a model or compact. Saving writes a native session entry with the complete memory snapshot and leaves retained history K unchanged. Manual edits not yet absorbed by a later compaction need this Nunc to take effect; stock Pi or an older Nunc still reads the last native summary.

Details: [extension usage](docs/PI.md), [Slots/Context UI](docs/UI.md).

## Configuration

Omit `--nunc-config` for Nunc defaults. All fields are optional. Unknown names or invalid types fail at load. Nunc reads the file and does not write it. `policyFile` is UTF-8 and resolves from the configuration file’s directory.

Implemented defaults (`src/pi/config.ts`):

| Field | Default |
| --- | --- |
| `policyFile` | unset (built-in `policies/default.md` only) |
| `memory.fraction` | `0.1` (range `[0, 1)`) |
| `memory.maxTokens` | unset (no explicit advisory planning ceiling) |
| `memory.targetTokens` | `8192` (soft organizing target) |
| `memory.hardMaxTokens` | unset (only an explicit value sets the independent saved-M hard cap) |
| `rolling.keepRecentFraction` | `0.5` (range `(0, 1)`) |
| `extraction.toolResults` | `"auto"` (full tool bodies unless complete extraction exceeds the input limit; then one bounded reduction) |
| `extraction.headTailChars` | `200` |
| `extraction.outputTokens` | `"auto"`; accepts `"auto"` or a positive integer |
| `budget.safetyTokens` | `1024` |
| `budget.growthTokens` | `1024` |
| `budget.extraMainInputTokens` | `0` |
| `budget.extraExtractionInputTokens` | `0` |
| `budget.inputLimit` | unset |
| `budget.imageTokens` | unset (uses Pi's native per-image heuristic) |

Images work without extra configuration on image-capable models. `budget.imageTokens` optionally overrides the per-image planning estimate; existing explicit values retain priority. Neither the default nor an override guarantees a token upper bound. Main requests, extraction, retained-history planning and the Context panel use the same rule. Compatible request receipts supply actual usage for the historical prefix; new images are estimated. Provider overflow recovery remains Pi-owned, with no extra Nunc retry loop.

Automatic capped maintenance reserves at least `min(8192, output capability)` and desires the model's output capability, bounded by any explicit `outputLimit`. It has no fixed 32K ceiling. It resolves the actual cap once from the complete frozen request, including policy/schema, tools, M/B/K, images, cleanup controls and configured overhead: `cap <= contextWindow - inputEstimate - safetyTokens`. It checks the minimum first, so a larger desired amount does not reject full sources that fit the existing floor. Less than the floor returns `CAPACITY` without dispatch. Uncapped native routes keep the old 8192-level planning reserve and serialize no cap. Explicit numbers keep fixed semantics. `/nunc` distinguishes the desired amount, resolved reserve/cap and limiting reason. A larger cap permits more output without promising a complete response. These are heuristic estimates, not tokenizer bounds.

Memory retains established results, parameters and inputs while continuing work needs them, and consolidates obsolete process with `update`/`remove`. New necessary material can be added or merged by topic without rewriting unchanged slots. Shared headings or lists may group facts with the same relation or qualifier; explicit source revisions replace invalid old values within the same scope unless comparison or rollback still needs them. Manual growth beyond budget requires consolidating or removing old process records with no continuing use; preserve necessary state and normal word spaces. Narration follows user communication; incompatible old prose is repaired under its existing IDs.

Maintenance F reports tool names, descriptions and top-level parameter keys instead of deep parameter schemas; full native tool definitions remain validated and unchanged for main requests. Supplied eligible large consumed K results are candidates for short supported summaries or omission, without discarding outstanding obligations or adopted facts.

`keepRecentFraction` remains a soft target. Nunc chooses the closest feasible legal suffix on either side (ties retain more history), with growth room, nonempty B/K and intact tool units. Infeasible historical planning remains advisory; no new main guard or post-response cut is introduced.

Optional integers are positive except the `extra*` fields, which may be zero. Example file (every key optional):

```json
{
  "policyFile": "./preferences.md",
  "memory": { "fraction": 0.1, "maxTokens": 2000, "hardMaxTokens": 8192 },
  "rolling": { "keepRecentFraction": 0.67 },
  "extraction": { "toolResults": "auto", "headTailChars": 200 },
  "budget": { "safetyTokens": 1024, "growthTokens": 1024 }
}
```

The example above explicitly specifies `rolling.keepRecentFraction: 0.67` to illustrate overriding the `0.5` default; explicit overrides remain fully supported. `memory.fraction` and `memory.maxTokens` now set an advisory maintenance target, never the independent save hard cap. To retain a previous explicit `maxTokens: 2000` save limit, also set `hardMaxTokens: 2000`. Existing saved M is not rewritten. An explicit hard cap still binds maintenance and growing manual edits; without one, automatic maintenance can retain required items over the organizing target. Manual growth remains limited by its reported budget, and shrinking/non-growing edits remain possible. Main admission measures the actual next request after a save.

Pi compaction settings remain Pi’s (`compaction.reserveTokens` default 16384, `keepRecentTokens` default 20000, `enabled` default true). Nunc’s trigger is `H = contextWindow - reserveTokens`. Require a positive reserve and H, and `0 <= keepRecentTokens < H`. Pi uses `keepRecentTokens` for native preparation; Nunc chooses a legal retained suffix from `keepRecentFraction` independently.

An explicit `extraction.outputTokens` equal to `model.maxTokens` is still honored, with a migration warning on APIs that have no serialized output cap. Remove that override to use automatic capped sizing or the uncapped 8192-level planning default. To preserve legacy source reduction and fixed output, explicitly set `extraction: { "toolResults": "auto", "outputTokens": 8192 }`. Older versions do not accept the string `"auto"`; remove it or replace it with a supported number before rollback. Nunc never rewrites Pi settings.

## Compaction and maintenance

Pi decides when compaction runs: automatic threshold (`contextTokens > contextWindow - reserveTokens`), overflow recovery, or `/compact [instructions]`. Nunc handles `session_before_compact` and does not add a second scheduler.

Each opportunity makes **at most one** maintenance request on the **current** model. There is no repair retry and no second summarizer model. Optional `/compact` instructions append to user policy for that call only. Maintenance forwards the frozen session thinking level on `openai-completions`, `openai-responses`, `openai-codex-responses` and `azure-openai-responses`, with native capability validation; `off` sends no explicit reasoning effort. Other APIs retain their existing raw-call behavior, so this is not an all-provider thinking guarantee. Its output planning reserve remains separate from the main turn and from the API's actual serialized cap (absent on uncapped routes).

The model returns one complete JSON object with required `priority` and `required` arrays, and optional `add`, `remove`, `update` and `toolResultEdits`. Omitted `add`/`remove` mean no additions/deletions; supplied null or wrong types fail. Omission never silently deletes a survivor:

- `update: [{id,text}]` replaces a whole body under its existing ID, relative position and nextId. Missing `update` keeps old responses compatible. Merge/split can still use remove plus add.

- `required` is a unique subset of `priority` identifying candidates needed for the whole continuing task, including actual materials and later-step dependencies (surviving slot IDs and addition keys). All declared required items are retained jointly. If an explicit `memory.hardMaxTokens` is configured and they cannot fit together, maintenance fails with `CAPACITY`; the advisory target may be exceeded to preserve required facts. Saved M and K stay unchanged. Required is for this maintenance, not a permanent pin.
- `priority` lists every survivor and addition exactly once. Optional items use remaining budget in that order. Surviving slots keep their relative order; unchanged bodies are reused exactly and updates use the complete revised body. Additions append. Priority does not reorder ordinary memory.

Slot prose follows the user's communication language, unless an explicit memory-language preference says otherwise. Keep normal spaces, readable sentences and precise paths/identifiers. Existing maintenance repairs noncompliant active bodies without rewriting compliant ones or historical evidence; user-confirmed UI bodies remain verbatim. Automatic maintenance and direct Agent writes share the same guidance. Details: [expression and operation contract](docs/EXTRACTION.md#42-json-操作协议与-markdown-正文).

Code validates references, whole-slot rendered budgets, and the retained-history cut. Policy text cannot keep an item that failed those checks. Empty memory and empty `required` are valid when nothing must continue.

On success Nunc hands Pi one compaction result: `summary`, `firstKeptEntryId`, `tokensBefore`, and `details.nunc = { version: 1, slots, nextId }`. Failure or cancellation before that handoff returns `{ cancel: true }` so Pi does not fall through to the default summarizer. After handoff, append, rebuild, and their errors belong to Pi. A maintenance event is not a persistence receipt; watch `session_compact` and the JSONL file.

Main requests are checked separately. Crossing Nunc’s softer memory-planning target does not reject a send. Oversized indivisible input still fails before HTTP. Details: [engine](docs/ENGINE.md), [capacity](docs/CAPACITY.md), [policy](docs/POLICY.md).

## Limits

- Same-session memory only. `/new` starts empty; `/tree`, `/fork`, and `/clone` follow Pi’s selected path.
- No cross-session memory database, proactive search, or document-writing service.
- Memory tools are optional via `--nunc-memory-tools` or Pi settings (`{"nunc": {"memoryTools": true}}` in global `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`); default off leaves the model toolset untouched while main requests inject one current M carrier at a stable legal boundary. Refined tool and extraction policy guidance texts are documented in [MEMORY-GUIDANCE.md](docs/MEMORY-GUIDANCE.md) (text modifications implemented; Gemini behavioral validation pending).
- Tool-result cleanup is implemented and independently configurable. Compaction can clean eligible completed business-tool results in retained K even on first maintenance or immediately after reopening, without a prior sent-M anchor; the newest completed group, pending groups and saved decisions stay protected. Non-compaction read/patch/UI cleanup still requires the sent-M source prefix. `memoryRefs` validates support in the approving commit's final M; later M revisions do not automatically reverse saved semantic cleanup. Source identity, full retained sources and tool associations remain checked. An enabled `nunc_memory_read` can return available active originals at the new tail; stored provenance alone does not guarantee current-model access, and retired history is not retrieved. Explicitly disabling cleanup restores active raw bodies through the existing admission checks.
- Ordinary turns do not require memory tools or usage counters.
- Token figures are planning estimates, not tokenizer proofs, cache guarantees, or cost proofs.
- Host support policy is stable stock Pi **1.x from 1.0.3**, with persistent sessions and the required public APIs. Verified releases have their recorded coverage; accepting a future minor version does not imply it has been individually tested. No all-provider claim.
- Images need model image input and remain native blocks. Missing `budget.imageTokens` uses Pi's heuristic instead of rejecting the request. Estimates can undercount or overcount; provider capacity failures remain possible. PDF, audio, and unknown blocks fail explicitly.
- Unload or downgrade without a later native compaction: stock Pi reads the last native summary, not unabsorbed manual edits.
- `scripts/check.mjs` requires the pinned Node and matching npm CLI. It also needs a local comparison baseline before `all`. See [local development](docs/DEVELOPMENT.md). Real TUI checks also need POSIX PTYs and `/usr/bin/python3`.
- Historical extraction acceptance recorded product `4f1f668` (423 tests / 52 files), UI human confirmation of IME/resize/theme, and disclosed comparison limits. That record is not proof of later source.

Long-term work belongs in code, documents, and other artifacts. Forgetting is how the working context stays finite.

## Development

`npm ci` and `npm run build` are not enough for `scripts/check.mjs all`. Prepare the [comparison baseline](docs/DEVELOPMENT.md#comparison-baseline-for-all), then run the inventory with the check runner’s Node/npm constraints in [local development](docs/DEVELOPMENT.md).

See also [bounded observations](docs/LIVE.md).

## Further documentation

- [Project constitution: scope, ownership, and limits](docs/CONSTITUTION.md)
- [Core design](docs/DESIGN.md)
- [Extraction, required items, and comparison scope](docs/EXTRACTION.md)
- [Pi extension loading, commands, and persistence](docs/PI.md)
- [Maintenance engine](docs/ENGINE.md)
- [Capacity ownership](docs/CAPACITY.md)
- [Slots/Context UI](docs/UI.md)
- [Active memory, CRUD model tools, and usage receipts](docs/ACTIVE-MEMORY.md)
- [Working-memory guidance refinements and behavioral validation](docs/MEMORY-GUIDANCE.md)
- [Tool-result cleanup on memory changes — implemented interfaces and evidence limits](docs/TOOL-RESULT-CLEANUP.md)
