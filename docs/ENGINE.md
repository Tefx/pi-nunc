# Maintenance engine contract

`src/engine/index.ts` exports the repository's maintenance transaction. The compiled public import is `pi-nunc/engine`. This component produces a candidate; the Pi adapter owns handoff to native persistence and recovery. This document describes the implemented engine, including per-maintenance required-item protection: declared `required` items are retained jointly or maintenance fails with `CAPACITY`. Historical extraction-acceptance evidence for product `4f1f668` recorded a complete offline inventory and disclosed comparison limits; that record is not proof of later source.

## Adapter input and handoff

```ts
import { maintain, piComplete, loadPolicy } from "pi-nunc/engine";
import type { MaintenanceInput } from "pi-nunc/engine";

// Populate from the current host state; this declaration is an interface example.
async function prepare(input: MaintenanceInput, registry: Parameters<typeof piComplete>[0]) {
  return maintain(input, piComplete(registry));
}
```

`MaintenanceInput` contains:

- `binding: {sessionId, leafId, generation}`. The adapter owns `generation` and advances it on session/path/model/options changes. This is a local lifecycle identifier, with no hash, ledger or CAS protocol.
- The current effective Pi `Model<Api>` and `fixed: {systemPrompt, tools}`. Supply definitions without executors. F excludes M. Raw `model.samplingParams` overrides are rejected because Pi can apply them after named budget/request fields.
- `memory: {version: 1, slots: [{id,text}], nextId}`. `emptyMemory()` starts a session. Preserve `nextId` with the slots; generated `sN` IDs skip existing IDs, including IDs removed in the same transaction. The counter advances even when a new candidate loses the capacity contest. Imported legacy summaries can use an arbitrary valid ID and `nextId: 1`; importing is adapter-owned.
- `active: ActiveEntry[]`: the complete public Pi projection of delivered active history at the maintenance freeze, grouped by original visible host entry ID, in order. Each entry carries its original `sourceRole` and one or more public pi-ai `Message`s. Include already-delivered new user messages, complete tool bodies, call arguments, result association/error status, visible bash/custom/branch-summary projections, and thinking visible in that projection. Exclude every compaction-summary carrier, non-visible metadata and messages not yet delivered. Supply current M exactly once through `memory`, discard superseded carriers, and preserve the original K entries across checkpoints. Later delivery D belongs to subsequent main requests, not this frozen transaction. The engine never reads a log, file attachment, retired history or task artifact to supplement this input.
- Optional `eligibleKeptEntryIds`: restrict genuinely host-valid start IDs before choosing K. Intersected with engine tool-pair legality; it cannot legalize an orphaned result. Empty eligibility produces explicit capacity failure. Unknown/duplicate IDs fail input validation. The adapter must preserve legal overlap across old checkpoints while excluding superseded summary carriers; it should not require all starts to follow the latest checkpoint merely to avoid old-summary replay.
- Frozen policy strings, configuration below, and the compaction `AbortSignal`.

The engine detaches and freezes task data before its first model await. Caller mutation cannot change the request, slots, model, policy or K already being maintained. Policy file reads happen through `loadPolicy()` before invoking `maintain()`. A subsequent policy edit affects the next load/maintenance only. Signals remain live.

A successful result has `ok: true`, the original `binding`, and one complete `candidate`:

```ts
{
  memory: { version: 1, slots, nextId },
  summary,                  // renderMemory(slots)
  firstKeptEntryId,
  kept,                     // detached ORIGINAL suffix, not reduced request data
  retiredEntryIds
}
```

Before handing this to Pi, the adapter must recheck the abort state and session/path/model/options binding, validate host eligibility and visibility of the boundary, and return one `summary/details/firstKeptEntryId` result. Persist `memory` in `details.nunc` with any adapter format metadata. Do not mutate saved slots or the retained boundary while awaiting the result. `summary` and slots come from the same candidate.

Every failure has `ok: false`, `code`, `message`, observations and an optional local `cause`. It has no candidate. The adapter must return `{cancel: true}` with a useful diagnostic, including when preparation, policy loading or handoff checks fail. Empty returns or uncaught errors can let Pi run default summarization. The engine does not append, rebuild, retry a handoff or roll back Pi's writes.

The adapter separately owns main-request admission for newly delivered input. That check must not generate memory, append a custom snapshot, replay prompts, withdraw queued messages or route maintenance calls recursively through the main-request gate. The source-boundary revision changes what the adapter supplies; it does not change the engine's candidate type or incremental protocol.

### Selected Pi seams

The adapter candidate selects and locks Pi **0.85.1** for both engine and stock-host checks. Component bridge evidence and actual CLI/RPC/TUI evidence have separate coverage; neither establishes real-model continuation or final acceptance. The engine uses public `ModelRegistry.complete(model, context, options)` and `convertToLlm()` exports. The bridge uses the actual registry/runtime, preserving host authentication resolution without inspecting or transporting credentials itself. It selects raw `complete`, `maxTokens`, `maxRetries: 0`, `cacheRetention: "none"`, SSE, a fresh routing session ID and the original signal. It does not use `completeSimple`, which can add a thinking budget to the requested output size. Provider/auth headers resolved by `ModelRuntime.prepareRequest` apply; session SDK `before_provider_headers` / `before_provider_request` / `after_provider_response` hooks do not run on this path. No tools are dispatched and no extractor agent is created.

The adapter inherits the current runtime model rather than reselecting from static defaults. Main output/thinking remain native. Extraction outputTokens defaults to min(8192, model.maxTokens): a planning reserve and, only on capped APIs, a requested total output cap. Uncapped APIs do not force full-capability input reservations. Native authentication remains Pi-owned. Consumption authorization is separate: the live observer still reserves the full model output allowance on uncapped routes.

Extraction does not inherit a main-turn reasoning-effort setting. It uses the selected raw API's defaults, bounded by the **total** output ceiling, including any native reasoning. Main-request budgeting must instead receive the main request's actual total reserve, after the host's thinking/output adjustments. An adapter must not pass an answer-only limit while omitting thinking tokens.

Inspected public docs: Pi README, `docs/extensions.md`, `docs/compaction.md`, `docs/settings.md`, `docs/sdk.md`, `docs/session-format.md`, pi-ai README, and `examples/extensions/custom-compaction.ts`. Checked the corresponding installed public types and implementations for `ModelRegistry`, `ModelRuntime`, `convertToLlm`, and API output limits. The installed session-format prose mentions `retainedTail`; the selected types/implementation still use `firstKeptEntryId`. Do not infer a persistence seam from that prose. The default example's `serializeConversation()` truncates tool bodies; Nunc never uses it. Its fall-through error handling and different-model selection also do not implement Nunc's contract.

`ctx.getSystemPrompt()` does not reflect payload rewrites by other extensions. The adapter must supply the effective projection it claims to support and account for extra request overhead. JSON-byte payload growth on the composed `onPayload` path is charged against the same planning input estimate; unaccounted growth, output expansion and illegal fields fail before HTTP. Compatibility with competing custom-compaction owners still requires explicit integration evidence.

## Protocol and window

The selected request is a short maintenance system prompt plus an explicit semantic transcript. F/M appear once in a labeled source record. Each B/K record has a nunc-transcript-v2 JSON header containing role, source ID, status/tool associations, and textLengths. Numeric content/text/thinking references index visibly labeled `[Nunc text N]` raw bodies below the header. UTF-16 lengths support mechanical readers; the model can use the labels directly. Tool arguments remain JSON; native images follow their record with indexed associations. Raw text is never re-escaped or scanned for extra source records. Opaque/redacted replay data, signatures, usage, cost, timestamps and provider/model bookkeeping are excluded. Public readable thinking, text, tool arguments/names/IDs/status and native images remain evidence. Returned K and saved history remain original native messages. readSourceRecords() is the shared mechanical reader for observation consumers. Active business tools are source definitions under F; extraction Context.tools stays empty. No prefix/cache reuse guarantee follows.

Current response: exactly one JSON object with required `add`, `remove`, `priority`, `required` arrays, with no outer fences or extra prose. Example:

```json
{"add":[{"key":"replacement","text":"The corrected conditional conclusion."}],"remove":["s1"],"priority":["replacement","s2"],"required":["replacement"]}
```

`remove` references existing IDs explicitly. Addition keys are unique and cannot collide with any old ID, including removed IDs. `priority` must contain **every** surviving ID and addition key exactly once. `required` is a unique subset of `priority` identifying active task focus and necessary continuation items. Invalid structure, duplicate/unknown references, missing `required` array, or references to deleted IDs fail the whole transaction with explicit `RESPONSE`. Empty memory and empty arrays are legitimate.

Every declared required slot must be retained jointly. If the required subset cannot fit within the memory limit or leaves insufficient growth space, maintenance fails with explicit `CAPACITY`; no candidate is returned, and saved M and K remain unchanged. Optional items use remaining budget in priority order without skipping required items or disturbing natural order (surviving old slots keep their relative order and exact text; additions append in response order). Priority never reorders ordinary memory. Explicit removals stay removed even if a replacement/merge loses the budget contest. No partial bodies, fixed category schema, weighting system or routine rewrite pass is introduced.

This implementation enforces the required-item protection contract in [EXTRACTION.md §5](EXTRACTION.md#5-必要项预算保护): the model identifies necessary continuation items and the engine retains all of them in any accepted candidate, or fails explicitly without another model request. The `required` reference array is the implemented private encoding. Request contract and parser are coordinated, stored `Memory`/`Slot` compatibility is preserved, and observations distinguish required-capacity failure from optional whole-slot drops. The guard verifies retention of declared items, not semantic completeness. Mandatory task-focus coverage does not impose fixed categories or a permanent pin.

B and K are nonempty contiguous prefix/suffix partitions at visible entry boundaries. All tool calls must have exactly one subsequent result with matching name/ID, and no boundary may separate a call from any of its results. Multiple calls and interleaved records are handled. Unknown/duplicate/orphan/unresolved calls fail explicitly. Long turns can split at later assistant entries once their preceding tool unit is complete.

Choose the largest feasible suffix at or below the retention target; when no complete unit falls below the target, choose the smallest feasible suffix above it. Final feasibility reserves the entire configured memory allowance and growth room. An indivisible recent message/tool unit can therefore cause an explicit capacity limitation.

## Configuration and capacity

There is no second memory-maintenance scheduler. The adapter supplies `triggerTokens = effective contextWindow - Pi compaction.reserveTokens`; it must also check Pi's `keepRecentTokens` preparation can enter the hook. This maintenance trigger does not replace the separate safety check on a main request after new input is delivered. An illustrative engine configuration is:

```json
{
  "triggerTokens": 25000,
  "memory": {"fraction": 0.1},
  "keepRecentFraction": 0.67,
  "growthTokens": 2000,
  "main": {"outputTokens": 4096, "safetyTokens": 512, "extraInputTokens": 0},
  "extraction": {
    "outputTokens": 4096, "safetyTokens": 512, "extraInputTokens": 0,
    "toolResults": "auto", "headTailChars": 200
  }
}
```

These numbers are test/example values, not validated settings for an arbitrary live model. Each request can additionally specify a narrower provider `inputLimit` and `outputLimit`. `outputTokens` and `safetyTokens` are positive integers, extra overhead is nonnegative. Memory fraction is in `[0,1)`, optional `memory.maxTokens` is positive, retained fraction is in `(0,1)`, and growth must be positive. Every maintenance recalculates using the current frozen model/configuration. `outputTokens` is a planning reserve on uncapped extraction routes, and also a requested cap on capped routes. Explicit legacy values remain effective; the stock adapter warns when a legacy Codex full-capability override defeats the new default.

Maintenance/candidate planning equations (these do not schedule Pi or reject a native main request):

```text
headroom = main.nativeOutputReserve when provided, otherwise outputTokens
safe input = min(model window - headroom, independent input limit) - safety
actual trigger = min(Pi H, main safe input)
F = effective system/tools + request framing + empty Pi summary envelope + main extra input
A = actual trigger - F                          (must be > 0)
M_limit = floor(min(memory.fraction * A, optional absolute cap))
K_target = floor(keepRecentFraction * (A - M_limit))
L = main request with the candidate summary and original K
L < actual trigger; actual trigger - L >= growthTokens
```

The summary envelope is generated by the selected host's **public `convertToLlm` projection** and is counted even with empty memory. `memoryTokens()` measures the additional rendered content over that empty envelope. This avoids double-counting F/M. Before a session's first compaction, the before-count conservatively includes the future empty envelope even if the host has not injected one yet.

The pi-heuristic estimator uses Pi estimateTextTokens (UTF-16 characters/4) plus explicit request/message/block framing and provider-specific image bounds. Opaque signatures are not text tokens. Maintenance and candidate M/K always receive a fresh estimate; historical assistant usage is never reused for a newly shaped prefix. Main admission can use Pi usage-backed accounting only after a prior delegated request with the same model, system/tools and unchanged message prefix. Native JSON-enumerable snapshots exclude tool executors. Compaction, session/path/model changes and payload transformations invalidate usage attribution. Missing/malformed usage falls back to a fresh estimate; cached tokens count. Estimates, output reserves and safety margins are planning values, not hard tokenizer bounds. Provider overflow and length recovery remain native.

Extraction separately estimates F/M/B/K, policy, protocol, native images, final controls and configured overhead. normalExtractionAtTrigger = fullExtractionTokens - mainBeforeTokens + actualTrigger is advisory. normalHeadroomSufficient and suggestedReserveTokens report sustainable-trigger guidance; they never veto the current request or bounded recovery. First check actual full extraction, then perform the configured one-pass tool-text reduction if needed. If the selected request still exceeds planned input, return CAPACITY without dispatch. Repeated reduction warrants an earlier Pi trigger; Nunc warns once per context and never writes settings.

The optional main-only nativeOutputReserve selects planning headroom for verified native context-clamped routes and uncapped APIs. It is positive, within model output capability and covers the serializer floor. The stock adapter derives it from Pi compaction.reserveTokens. Main outputTokens still reports native output capability. Raw extraction instead uses outputTokens as its own planning reserve. Unknown native context-sizing routes retain fixed-reserve accounting. inputLimit() is shared by extraction admission, memory/maintenance planning and calibration. mainAdmissionLimit() independently uses the native model window minus its minimum output floor, bounded by an explicit input limit, without enforcing the softer output/safety planning reserve. Unknown native sizing retains the fixed-reserve guard. The lower planning target still binds candidate growth and manual M edits. These estimates provide no worst-case joint input-plus-maximum-output guarantee. See [capacity ownership](CAPACITY.md).

**Pi output-cap exceptions:** Codex omits max_output_tokens; OpenAI Responses can opt out with compat.supportsMaxOutputTokens:false. outputCapTokens is null on these routes. A small extraction planning value is valid and never presented as an enforced cap. Capped Responses requests retain their minimum of 16. Reported output beyond an uncapped planning reserve sets outputExceededPlan and may still produce a valid candidate. Reported input beyond planned input, including occupancy above the catalog window, sets inputExceededPlan. A complete `stop` extraction is not discarded solely because reported input+cache exceeds the catalog window; that veto cancelled native compaction and retried forever. An explicit extraction `inputLimit`, serialized/capped output, model output capability and candidate growth still bind. Nonterminal responses never commit. Raw sampling overrides remain unsupported; no all-provider output contract is claimed.

### Capacity recovery and media

Only after the **full extraction exceeds its input limit**, `auto` runs one pass over tool-result text blocks: keep `headTailChars` Unicode code points at each end, insert an omission marker and record entry/message/block indexes, tool-call ID and omitted count. It never truncates user/assistant text, tool arguments, M or native images, and never mutates the saved source or returned K. `full` disables this pass. If the reduced request still cannot fit, fail before making a request. There is no K-reference removal, sequential chunking or multi-stage repair path.

Middle tool evidence can be lost in this exceptional path; omissions explicitly prevent a claim that unseen evidence was checked. Full-mode normal requests preserve all visible evidence, including bodies beyond Pi's default serializer limit.

Images are supported as real native blocks only when the current model advertises image input **and** `imageTokens` supplies a justified provider-specific per-image upper bound. Missing image accounting, unsupported image models, PDF/audio/unknown blocks or unsettled source messages produce explicit input limitations. No text placeholder substitutes for media facts. Provider validation of actual image bytes remains provider-owned; fixtures establish transport preservation, not vision understanding.

## Failure and observations

Codes: `CONFIG`, `INPUT`, `UNSUPPORTED_INPUT`, `CAPACITY`, `RESPONSE`, `MODEL`, `CANCELLED`. The engine accepts only an assistant response with the frozen model/provider/API, `stopReason: "stop"`, no false `endTurn`, error or deferred handle, and text/thinking content without tool calls. Parseable `length`, pending, tool-use, error, aborted and deferred responses never become candidates. No optional structure repair is implemented: one normal request, zero retries/replays.

Cancellation propagates to Pi. The engine also releases its wait and removes its listener if a provider fails to cooperate. Such an underlying call may still settle later; the engine never commits or retries it, and reports unknown usage. The adapter/host owns provider shutdown and reconciliation. A later caller cancellation must still be checked at the adapter handoff.

`observations` records request count, elapsed time, planning accounting, omissions, dropped slots, required item evaluation (`required: { declared, retainedSlotIds, failed }`) and service usage. Accounting distinguishes outputReserveTokens from outputCapTokens (null when absent), sustainable-trigger advice and input/output planning overruns. Main admission events identify pi-heuristic or pi-usage-backed estimates and observe the actual serialized cap when available. They report the enforced inputLimit separately from plannedInputLimit/inputExceededPlan; exceeding the latter alone is not a rejection. Pi input excludes cacheRead/cacheWrite; contextInput sums them. Reasoning is already part of output. Unknown/all-zero usage remains unknown; known zero cost remains zero except Codex subscription billing, which is unknown. Maintenance events are not persistence receipts. Local causes may contain provider details and must not be indiscriminately persisted or sent to notifications.

The engine freshly estimates every maintenance source and candidate. Applicable previous main-request usage can anchor admission only while its model and prefix remain valid. Task totals, actual cost, cache observations and continued-task effectiveness belong to runtime verification; local arithmetic does not prove live accuracy.

## Evidence boundary

Engine tests execute the transaction, not a reimplementation of its algorithm. Coverage includes full bodies/arguments/status/custom/pending input, paired cuts, stable incremental edits/merges, invalidation without resurrection, malformed references/omissions, whole-slot capacity, request accounting and model/config changes, cached/unknown usage, growth limitations, one-pass omissions with original K, native media restrictions, policy loading/freezing, cancellation and nonterminal failures.

The bridge test imports the public package export and runs through real Pi `ModelRegistry`/`ModelRuntime` and the public pi-ai provider machinery. Only the service is controlled with a faux provider and memory-only credentials/catalog state. This proves the component's dispatch/projection seam, with simulated usage. It does **not** prove extension loader/hook behavior, Pi JSONL append/rebuild/resume, live model maintenance or task continuation. Those require their own applicable host/runtime evidence. [EXTRACTION.md §7](EXTRACTION.md#7-原生对照与验收) comparison coverage has historical gate evidence at product `4f1f668` (423 tests / 52 files) with disclosed limits; that record is not proof of later source.
