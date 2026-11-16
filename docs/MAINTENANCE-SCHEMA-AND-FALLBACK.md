# Maintenance Constrained Schema Decoding, Mechanical Window Roll Fallback, and Calibration Deduplication

Status: **Accepted design specification (ready for Vectl planning and implementation).**

This specification defines `pi-nunc`-only changes addressing the maintenance compaction failure and session-bricking dead end observed on `v0.3.0` (`google-vertex/gemini-4-argon` session `01a1e3e0`):

1. **Unconstrained JSON generation on Google maintenance calls:** On 500K-token maintenance transcripts, `google-vertex/gemini-4-argon` emitted unescaped `"` characters inside a multi-kilobyte `add[0].text` Markdown string, failing `JSON.parse(text)` with `RESPONSE: Maintenance response is not one complete JSON object`.
2. **Session bricking when LLM extraction fails:** Returning `{ cancel: true }` on non-abort/non-error `RESPONSE` failures aborts native compaction without retiring any history, trapping interactive, background `vectl-orchestrator`, and headless `larva_subagent` sessions above the compaction threshold.
3. **Repeated `nunc.maintenance-calibration` custom-entry appends on failed compactions:** Unconditionally appending an already-recorded `nunc.maintenance-calibration` entry mutates `SessionManager.getLeafId()`, defeating `provider-resilience`'s same-leaf guard and re-triggering `ctx.compact()` every 60s.

Pi core and `@earendil-works/pi-ai` remain untouched.

## Binding Contract

### 1. Google Maintenance Constrained JSON-Schema Decoding (`MUST`)

- **Canonical maintenance response JSON schema & `RESPONSE_CONTRACT` alignment (`src/engine/memory.ts`)**:
  - Export `PATCH_RESPONSE_JSON_SCHEMA` as a frozen plain JSON Schema object matching `Patch` validation in `parsePatch()`:
    - Top-level `type: "object"`, `additionalProperties: false`, `required: ["priority", "required"]`.
    - `priority` and `required`: arrays of strings (`{ type: "array", items: { type: "string" } }`).
    - Optional `remove`: `{ type: "array", items: { type: "string" } }`.
    - Optional `add`: array of objects with `additionalProperties: false`, `required: ["key", "text"]`, string `key` and `text`.
    - Optional `update`: array of objects with `additionalProperties: false`, `required: ["id", "text"]`, string `id` and `text`.
    - Optional `toolResultEdits`: array of objects with `additionalProperties: false`, `required: ["entryId", "messageIndex", "action"]`, string `entryId`, integer `messageIndex`, `action` enum `["omit", "replace"]`, optional string `text`, optional string-array `memoryRefs`, and optional `sourceRefs` array of `{ entryId: string, messageIndex: integer }` objects.
  - In `RESPONSE_CONTRACT`, include `"sourceRefs": [{"entryId": "e2", "messageIndex": 0}]` in the `toolResultEdits` JSON example and explicitly specify that `memoryRefs` is an array of string slot IDs/keys while `sourceRefs` is an array of `{"entryId", "messageIndex"}` objects.
  - Omit the duplicate `${MEMORY_WRITING_GUIDANCE}` interpolation inside `RESPONSE_CONTRACT` (since `extractionContext()` in `src/engine/request.ts` already embeds `input.policy.builtin`, which contains the full `## Shared writing and applicability policy` section, and `nunc_memory_patch` in `src/index.ts` embeds `MEMORY_WRITING_GUIDANCE` in the tool description).
- **Google maintenance `onPayload` injection (`src/engine/pi-model.ts`)**:
  - In `piComplete()`, when `model.api === "google-vertex" || model.api === "google-generative-ai"`, attach an `onPayload` callback that returns a cloned payload with `config: { ...(record(payload.config) ? payload.config : {}), responseMimeType: "application/json", responseJsonSchema: PATCH_RESPONSE_JSON_SCHEMA }`.
  - Preserve existing `rawThinking()` behavior unchanged (do **not** lower or override `thinking` on Google or other APIs).
- **Maintenance-scoped payload authorization (`src/pi/payload.ts`, `src/pi/admission.ts`)**:
  - Extend `authorizePayload()` / payload classification with an explicit maintenance-only authorization (`allowGoogleMaintenanceJsonSchema?: boolean`, `true` iff `kind === "maintenance"`).
  - When `allowGoogleMaintenanceJsonSchema` is `true` and `model.api === "google-vertex" || model.api === "google-generative-ai"`, permit `config.responseMimeType === "application/json"` and `config.responseJsonSchema` matching `PATCH_RESPONSE_JSON_SCHEMA` without classifying them as `"unsupported"` or charging the static schema declaration as external hook `grewTokens` against window-clamped maintenance input limits.
  - On `main` requests (`allowGoogleMaintenanceJsonSchema !== true`), or when `responseMimeType` / `responseJsonSchema` differs from the canonical maintenance schema, or when any other `config` control field changes (`candidateCount`, `cachedContent`, `responseModalities`, `systemInstruction`, `tools`, `thinkingConfig`, expanded `maxOutputTokens`), preserve zero-send `CONFIG` / `CAPACITY` rejection before HTTP.

### 2. Automatic Escape Hatch: Deterministic `Mechanical Window Roll` on LLM Response Failure (`MUST`)

- **No extra slash commands or cross-model switching**: Do not add `/nunc roll` or `/nunc compact-with`, and do not switch models on failure.
- **Pre-computed deterministic fallback candidate (`src/engine/types.ts`, `src/engine/engine.ts`)**:
  - In `maintain()`, once input validation and `chooseCut()` succeed and `!target` (ordinary maintenance, not `/nunc compact-for`), deterministically construct the `M`-preserving fallback candidate before extraction capacity/model execution:
    - `memory: structuredClone(frozen.memory)` (preserving all existing slots, IDs, and `nextId` verbatim),
    - `summary: renderMemory(frozen.memory.slots)`,
    - `firstKeptEntryId: kept[0]!.entryId`,
    - `kept` (detached original retained suffix `K`),
    - `retiredEntryIds: frozen.active.slice(0, cut).map(e => e.entryId)`,
    - `toolResultCleanup`: deterministic lossless mechanical cleanup computed via `decideToolResultCleanup` with `initialMemory: frozen.memory`, `finalMemory: frozen.memory`, `candidateScope: frozen.cleanupCandidateScope`, `retainedEntries: kept`, `omissions: []`, `disabled: config.toolResultCleanup === false`, and `mechanicalWhenMemoryUnchanged: true`.
  - Keep `maintain()` returning `ok: false` on failure so engine-level callers and `nunc:maintenance` observers continue to see the exact `code` (`RESPONSE`, `CAPACITY`, etc.) and `observations`.
  - Attach `fallbackCandidate` to the `ok: false` `MaintenanceResult` iff `!target`, `!signal.aborted`, `result.code === "RESPONSE"`, and `observations.stopReason !== "error" && observations.stopReason !== "aborted"` (covering completed `"stop"` responses with malformed JSON/invalid patch structure/references, `"length"` truncations, and unexpected `"toolUse"` / non-complete model outputs, while leaving HTTP `"error"` / `providerOverflow` calibration and `CAPACITY` / `hardMaxTokens` refusals cancelling as before).
- **Automatic handoff in `session_before_compact` (`src/index.ts`)**:
  - When `!result.ok` in `session_before_compact`, if `!intent` and `result.fallbackCandidate` is present and `eligibleStarts(branch, current.active, current.latestId).includes(result.fallbackCandidate.firstKeptEntryId)`:
    - Construct `mechanicalFallback: MechanicalFallbackInfo = { code: result.code, message: result.message, retiredEntryCount: result.fallbackCandidate.retiredEntryIds.length, firstKeptEntryId: result.fallbackCandidate.firstKeptEntryId }`.
    - Commit the compaction checkpoint using `result.fallbackCandidate` with `summary: renderMemoryWithFallback(result.fallbackCandidate.memory.slots, mechanicalFallback)` and `details: { nunc: result.fallbackCandidate.memory, toolResultCleanup: sealDecisions(projected.active, nextDecisions), mechanicalFallback, ...(savedCalibration ? { maintenanceCalibration: savedCalibration } : {}) }`.

### 3. Strong User & Model Visibility on Mechanical Fallback (`MUST`)

- **Explicit marker in persisted `compaction.summary` and LLM-visible Nunc carrier (`src/engine/memory.ts`, `src/pi/projection.ts`, `src/pi/admission.ts`)**:
  - Define a deterministic banner helper `formatMechanicalFallbackNotice(fallback: MechanicalFallbackInfo): string` producing:
    `[Nunc Mechanical Roll Fallback: LLM extraction failed (${fallback.code}: ${fallback.message}); retired ${fallback.retiredEntryCount} entries before ${fallback.firstKeptEntryId} without updating M. Use nunc_memory_read / nunc_memory_patch if retired history needs to be recorded.]`
  - Define `renderMemoryWithFallback(slots: Slot[], fallback?: MechanicalFallbackInfo): string` that returns `renderMemory(slots)` when `fallback` is absent, `${renderMemory(slots)}\n\n${formatMechanicalFallbackNotice(fallback)}` when `slots.length > 0`, and `formatMechanicalFallbackNotice(fallback)` when `slots.length === 0`.
  - In `checkpointMemory()` (`src/pi/projection.ts`), validate `details.mechanicalFallback` when present and accept `latest.summary === renderMemoryWithFallback(details.nunc.slots, mechanicalFallback)` alongside `expectedCurrent` and `expectedLegacy`.
  - In `project(entries)` (`src/pi/projection.ts`), expose `mechanicalFallback?: MechanicalFallbackInfo` from the latest `compaction` entry on the active path when no subsequent manual memory commit (`nunc.memory`) or subsequent normal `compaction` entry has superseded it (a subsequent normal `compaction` entry clears it; a manual `nunc.memory` patch after the fallback checkpoint updates `M` and clears `mechanicalFallback` because `M` has been explicitly reconciled).
  - In `withEffectiveMemory()` (`src/pi/projection.ts`) and `Admission` carrier matching (`src/pi/admission.ts`, `src/index.ts`), when `mechanicalFallback` is active on the current projection, inject the Nunc carrier with `renderMemoryWithFallback(memory.slots, mechanicalFallback)` **even when `memory.slots.length === 0`**, so both main sessions and headless `larva_subagent` runs with empty `M` receive the fallback notice in LLM context.
- **Persistent UI status bar indicator & diagnostic reporting (`src/ui/status.ts`, `src/ui/index.ts`, `src/pi/context.ts`, `src/index.ts`)**:
  - In `session_before_compact` (`src/index.ts`), emit a warning via `notify(ctx, `${result.code}: ${result.message}; rolled window mechanically preserving current M (${result.fallbackCandidate.memory.slots.length} slots) and recent K (@ ${result.fallbackCandidate.firstKeptEntryId}) so session can continue`, "warning")`.
  - In `CompactFooterInput` and `compactFooter()` (`src/ui/status.ts`), add `fallback?: boolean`. When `input.fallback` is `true` (driven from `project(entries).mechanicalFallback` on `CurrentContext` / `MemoryView`), render `{ text: `🧠 !${n}·roll`, tone: "warning" }` (taking precedence over normal `dim` states and surviving `ui.recover()` across `session_compact` and subsequent `main` `delegate` events until cleared by a subsequent normal compaction or manual memory reconciliation).
  - In `LastMaintenanceContext` (`src/pi/context.ts`) and `maintenanceLines()` / `detailsLines()` (`src/ui/status.ts`), record when native save succeeded via mechanical fallback (`fallback?: MechanicalFallbackInfo`) and surface `Mechanical fallback: active (${code}: ${message})` in `/nunc details` and the F7 overlay.

### 4. Calibration Append Deduplication (`MUST`)

- **No duplicate `nunc.maintenance-calibration` appends (`src/engine/calibration.ts`, `src/index.ts`)**:
  - Define a helper `hasEquivalentCalibrationRecord(existing: readonly unknown[], candidate: MaintenanceCalibrationRecord): boolean` (or equivalent in `src/engine/calibration.ts`).
  - Before calling `pi.appendEntry(MAINTENANCE_CALIBRATION_TYPE, savedCalibration)` on a cancelled compaction in `src/index.ts`, check whether `maintenanceInput.calibration` (or the selected branch's existing `nunc.maintenance-calibration` / checkpoint calibration records) already contains an equivalent record for the same `provider`, `api`, `modelId`, `sourceDigest`, `limitsDigest`, `contextDigest`, `headTailChars`, `providerOverflow`, and `measurement`.
  - When an equivalent record already exists on the branch, skip `pi.appendEntry()`, preventing failed compactions from advancing `SessionManager.getLeafId()` and re-triggering `provider-resilience`'s `agent_settled` auto-compaction loop.

### 5. Synchronized Documentation and Regression Tests (`MUST`)

- Update `docs/CONSTITUTION.md`, `docs/ENGINE.md`, `docs/EXTRACTION.md`, `docs/PI.md`, and `docs/UI.md` to document Google maintenance JSON-schema decoding, automatic `Mechanical Window Roll` fallback on `RESPONSE` failures, persistent UI/carrier fallback visibility, and calibration append deduplication.
- Update `tests/pi/lifecycle.test.ts` and `tests/pi/reporting.test.ts` where `RESPONSE` failures (`stopReason: "stop" | "length" | "toolUse"`) previously asserted `Compaction cancelled`, verifying that they now commit the mechanical fallback checkpoint while preserving `result.ok === false`, `result.code === "RESPONSE"`, unchanged `M`, retained `K`, carrier notice, and persistent `🧠 !N·roll` status; add targeted unit/integration tests for Google maintenance `responseMimeType` + `responseJsonSchema` serialization/authorization and calibration append deduplication.

## Implementation Notes & Hazard Map (`ADVISORY`)

- **`src/pi/admission.ts` & `src/pi/projection.ts` carrier identity**: When `memory.slots.length === 0` and `mechanicalFallback` is active, `withEffectiveMemory` injects a carrier containing `formatMechanicalFallbackNotice(mechanicalFallback)`. Ensure `Admission.bindProjection`, `carrierMatches`, `selectReceipt`, and `currentMemoryIndex` use the same rendered carrier string (`renderMemoryWithFallback(memory.slots, mechanicalFallback)`) and treat `hasM = memory.slots.length > 0 || mechanicalFallback !== undefined` so receipt accounting and carrier provenance remain consistent.
- **`src/pi/context.ts` (`noteEngine` / `noteNative`)**: When `!result.ok` and `result.fallbackCandidate` is committed in `session_before_compact`, `current.engine` remains `"fail"` while `current.native` becomes `"saved"` and `current.fallback` / `current.after` records the preserved `M` and `K`. Ensure `tests/pi/reporting.test.ts:224-236` still sees `view.lastMaintenance?.stopReason === "length"` and `Response stop reason: length` in `detailsLines`.
- **`tests/pi/compat.test.ts`**: Keep all runtime imports inside the Pi extension loader virtual-module allowlist.
