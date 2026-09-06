# Maintenance engine contract

`src/engine/index.ts` exports the repository's maintenance transaction. The compiled public import is `pi-nunc/engine`. This component produces a candidate; the Pi adapter, persistence/recovery integration and real-model acceptance remain separate work.

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

The adapter candidate selects and locks Pi **0.85.1** for both engine and stock-host checks. Component bridge evidence and actual CLI/RPC/TUI evidence have separate coverage; neither establishes real-model continuation or final acceptance. The engine uses public `ModelRegistry.complete(model, context, options)` and `convertToLlm()` exports. The bridge uses the actual registry/runtime, preserving host authentication resolution without inspecting or transporting credentials itself. It selects raw `complete`, `maxTokens`, `maxRetries: 0`, `cacheRetention: "none"`, SSE, a fresh routing session ID and the original signal. It does not use `completeSimple`, which can add a thinking budget to the requested output size. No tools are dispatched and no extractor agent is created.

The adapter inherits the current runtime model rather than reselecting from static defaults. Main output/thinking remain native; the extraction protocol's separate output controls serve the named maintenance operation. Native authentication lookup/refresh/persistence belongs to the existing Pi owner, with no credential copying or Nunc auth store. Uncapped APIs reserve their full native allowance.

Extraction does not inherit a main-turn reasoning-effort setting. It uses the selected raw API's defaults, bounded by the **total** output ceiling, including any native reasoning. Main-request budgeting must instead receive the main request's actual total reserve, after the host's thinking/output adjustments. An adapter must not pass an answer-only limit while omitting thinking tokens.

Inspected public docs: Pi README, `docs/extensions.md`, `docs/compaction.md`, `docs/settings.md`, `docs/sdk.md`, `docs/session-format.md`, pi-ai README, and `examples/extensions/custom-compaction.ts`. Checked the corresponding installed public types and implementations for `ModelRegistry`, `ModelRuntime`, `convertToLlm`, and API output limits. The installed session-format prose mentions `retainedTail`; the selected types/implementation still use `firstKeptEntryId`. Do not infer a persistence seam from that prose. The default example's `serializeConversation()` truncates tool bodies; Nunc never uses it. Its fall-through error handling and different-model selection also do not implement Nunc's contract.

`ctx.getSystemPrompt()` does not reflect payload rewrites by other extensions. The adapter must supply the effective projection it claims to support and account for extra request overhead. Compatibility with competing context/payload rewriting or custom-compaction extensions requires explicit integration evidence; this component does not establish it.

## Protocol and window

The selected request is a short maintenance system prompt plus an **explicit full transcript**. F/M appear once in a labeled source record; each B/K entry is a JSON source record preserving roles and all projected message fields. Native image blocks follow their owning record with indexed associations. Active business tools appear only as source definitions under F; the extraction `Context.tools` is empty. The final user block requests the response. This shape makes no prefix/cache reuse guarantee.

Response: exactly one JSON object with required `add`, `remove`, `priority` arrays, with no fences or extra prose. Example:

```json
{"add":[{"key":"replacement","text":"The corrected conditional conclusion."}],"remove":["s1"],"priority":["replacement","s2"]}
```

`remove` references existing IDs explicitly. Addition keys are unique and cannot collide with any old ID, including removed IDs. `priority` must contain **every** surviving ID and addition key exactly once. Invalid structure, duplicate/unknown references and omissions fail the whole transaction. Empty memory and empty changes are legitimate.

If all candidates fit, keep all. Otherwise, visit priority order, retain whole slots that fit, and skip oversized slots. Measure the proposed final rendering, including generated IDs and wrapping. Surviving old slots keep their relative order and exact text; additions append in response order. Priority never reorders ordinary memory. Explicit removals stay removed even if a replacement/merge loses the budget contest. No partial bodies, mandatory categories, weighting system or routine rewrite pass is introduced.

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

These numbers are test/example values, not validated settings for an arbitrary live model. Each request can additionally specify a narrower provider `inputLimit` and `outputLimit`. `outputTokens` and `safetyTokens` are positive integers, extra overhead is nonnegative. Memory fraction is in `[0,1)`, optional `memory.maxTokens` is positive, retained fraction is in `(0,1)`, and growth must be positive. Every maintenance recalculates using the current frozen model/configuration.

Budget equations:

```text
safe input = min(model window - total output reserve, independent input limit) - safety
actual trigger = min(Pi H, main safe input)
F = effective system/tools + request framing + empty Pi summary envelope + main extra input
A = actual trigger - F                          (must be > 0)
M_limit = floor(min(memory.fraction * A, optional absolute cap))
K_target = floor(keepRecentFraction * (A - M_limit))
L = main request with the candidate summary and original K
L < actual trigger; actual trigger - L >= growthTokens
```

The summary envelope is generated by the selected host's **public `convertToLlm` projection** and is counted even with empty memory. `memoryTokens()` measures the additional rendered content over that empty envelope. This avoids double-counting F/M. Before a session's first compaction, the before-count conservatively includes the future empty envelope even if the host has not injected one yet.

`utf8-upper-estimate-v1` counts one token per UTF-8 byte of visible text/arguments/signatures/schema plus explicit per-request/message/block framing. This deliberately conservative local estimator replaces no provider tokenizer. Safety and `extraInputTokens` cover estimation error and additional provider framing/options; adapters must include overhead not represented by the public Context. Report these estimates separately from actual usage. No universal provider token-accuracy or cache-hit claim follows from component tests.

Extraction separately counts full F/M/B/K, policy, output protocol, source metadata/native images, final control message, extra input, total output and safety. `normalExtractionAtTrigger = fullExtractionTokens - mainBeforeTokens + actualTrigger` checks measured full-request overhead at H. If this exceeds the extraction input limit, return `CONFIG`: lower H/increase reserve rather than using loss as routine operation. Overshoot beyond a valid H may take the bounded recovery below. Different future escaping/media/metadata can change overhead; check the actual frozen request again each maintenance.

**Pi output-cap exceptions:** the selected Codex API omits `max_output_tokens`; OpenAI Responses can opt out with `compat.supportsMaxOutputTokens: false`. Such requests must explicitly reserve `model.maxTokens`, otherwise preflight fails. Ordinary capped requests reserve the configured amount rather than maximum output capability. OpenAI/Azure Responses clamp tiny requests up to 16, so lower reserves are rejected. Raw sampling payload overrides are unsupported. Custom registered providers must honor the public `maxTokens` semantics or declare equivalent capacity through the adapter; no all-provider compatibility is claimed.

### Capacity recovery and media

Only after the **full extraction exceeds its input limit**, `auto` runs one pass over tool-result text blocks: keep `headTailChars` Unicode code points at each end, insert an omission marker and record entry/message/block indexes, tool-call ID and omitted count. It never truncates user/assistant text, tool arguments, M or native images, and never mutates the saved source or returned K. `full` disables this pass. If the reduced request still cannot fit, fail before making a request. There is no K-reference removal, sequential chunking or multi-stage repair path.

Middle tool evidence can be lost in this exceptional path; omissions explicitly prevent a claim that unseen evidence was checked. Full-mode normal requests preserve all visible evidence, including bodies beyond Pi's default serializer limit.

Images are supported as real native blocks only when the current model advertises image input **and** `imageTokens` supplies a justified provider-specific per-image upper bound. Missing image accounting, unsupported image models, PDF/audio/unknown blocks or unsettled source messages produce explicit input limitations. No text placeholder substitutes for media facts. Provider validation of actual image bytes remains provider-owned; fixtures establish transport preservation, not vision understanding.

## Failure and observations

Codes: `CONFIG`, `INPUT`, `UNSUPPORTED_INPUT`, `CAPACITY`, `RESPONSE`, `MODEL`, `CANCELLED`. The engine accepts only an assistant response with the frozen model/provider/API, `stopReason: "stop"`, no false `endTurn`, error or deferred handle, and text/thinking content without tool calls. Parseable `length`, pending, tool-use, error, aborted and deferred responses never become candidates. No optional structure repair is implemented: one normal request, zero retries/replays.

Cancellation propagates to Pi. The engine also releases its wait and removes its listener if a provider fails to cooperate. Such an underlying call may still settle later; the engine never commits or retries it, and reports unknown usage. The adapter/host owns provider shutdown and reconciliation. A later caller cancellation must still be checked at the adapter handoff.

`observations` records request count, elapsed milliseconds, accounting when available, specific omissions, capacity-dropped slot IDs and service usage. Pi's `input` excludes `cacheRead`/`cacheWrite`; `contextInput` sums all three. Reasoning is already a subset of output. Missing/invalid fields are `null`, and Pi's unreported all-zero initialization is treated as unknown. Known zero cost on positive usage remains zero. Partial valid fields survive. `observeUsage()` is also exported for adapter/main-turn accounting. Reported extraction cached input or output above the checked ceilings rejects the candidate.

The engine does not infer request size from old assistant usage: F, M and every active body are estimated again, so stale/unknown/cache-heavy history never becomes zero-size context. Full task totals, main-turn usage and actual cost/latency observations across maintenance/continuation belong to the adapter/runtime consumer. Local error `cause` values can contain provider details and should not be indiscriminately persisted or sent to notifications.

## Evidence boundary

Engine tests execute the transaction, not a reimplementation of its algorithm. Coverage includes full bodies/arguments/status/custom/pending input, paired cuts, stable incremental edits/merges, invalidation without resurrection, malformed references/omissions, whole-slot capacity, request accounting and model/config changes, cached/unknown usage, growth limitations, one-pass omissions with original K, native media restrictions, policy loading/freezing, cancellation and nonterminal failures.

The bridge test imports the public package export and runs through real Pi `ModelRegistry`/`ModelRuntime` and the public pi-ai provider machinery. Only the service is controlled with a faux provider and memory-only credentials/catalog state. This proves the component's dispatch/projection seam, with simulated usage. It does **not** prove extension loader/hook behavior, Pi JSONL append/rebuild/resume, live model maintenance or task continuation. Those remain required downstream evidence.
