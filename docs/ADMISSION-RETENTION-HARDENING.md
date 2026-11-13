# Admission, Retention, and Diagnostic Hardening

Status: **Accepted design specification (pre-reviewed; ready for Vectl planning and implementation).**

This specification defines `pi-nunc`-only changes addressing three production telemetry issues observed on `v0.2.3`:

1. Premature compaction triggered by oversized catalog output caps on `main` capped routes (e.g., `openrouter/google/gemini-4-*` advertising `maxTokens = 943,718` on a `1,048,576` window).
2. Repeated compaction storms on `272K` models (e.g., `openai/gpt-6.1-sol`) driven by a fixed `100,000`-token default retention ceiling, blocked mechanical cleanup when `M` is unchanged, and missing post-compaction runway diagnostics.
3. Opaque `Nunc local CONFIG; Larva system prompt is currently unavailable` refusals whose `.jsonl` telemetry drops Larva's diagnostic category.

Pi core and `@earendil-works/pi-ai` remain untouched.

## Binding Contract

### 1. Shared Route-Cap and Output-Floor Primitives (`MUST`)

- **Canonical uncapped-route predicate**: Define one shared predicate `omitsRouteOutputCap(model, registry)` that returns `true` iff `omitsSerializedOutputCap(model)` or `model.api === "openai-responses" && subscriptionBilling(model, registry)`. All call sites in `src/index.ts` and `src/pi/admission.ts` MUST use this predicate rather than mixing `subscriptionBilling` alone (which misclassifies Anthropic OAuth as omitting `max_tokens`).
- **Canonical serializer output floor**: Define one shared helper `outputFloor(model)` (`16` for `openai-responses` and `azure-openai-responses`, `1` otherwise) and reuse it across `src/engine/accounting.ts`, `src/pi/config.ts`, `src/pi/payload.ts`, and `src/pi/admission.ts`.
- **Unified startup / `model_select` diagnostic helper**: Consolidate model-level startup and selection checks in `src/index.ts`, deduplicated per `${model.provider}/${model.id}` across the active session reset boundary (and not cleared on `thinking_level_select`).
- **Extension-loader compatibility**: All runtime imports under `src/` MUST remain strictly inside the Pi extension loader virtual-module allowlist verified by `tests/pi/compat.test.ts`.

### 2. Main-Request Output-Cap Over-Reservation Mitigation (Issue A, `MUST`)

- **Model diagnostic**: At `session_start` and `model_select`, when `!omitsRouteOutputCap(model, registry)` and `model.maxTokens >= 0.8 * model.contextWindow`, emit a bounded one-time diagnostic warning noting that oversized catalog output caps may trigger early provider rejections on dense inputs.
- **Best-effort post-authorization clamp (`main` capped routes only)**:
  - **Ordering**: In `Admission`'s `onPayload` wrapper, execute clamping strictly **after** `authorizePayload` validates all `before_provider_request` hook changes, so downstream hook over-budget mutations remain rejected rather than masked.
  - **Scope & thinking-budget coupling guard**: Operate across all present serialized output cap fields identified by `outputCapPaths()` (`max_tokens`, `max_output_tokens`, `max_completion_tokens`, `generationConfig.maxOutputTokens`, `config.maxOutputTokens`). Skip clamping if `!omitsRouteOutputCap(model, registry)` is false, if `outputCapState(after)` is not `"value"`, or if the payload carries any strictly positive coupled thinking budget (`thinking.budget_tokens > 0`, `{,config.,generationConfig.}thinkingConfig.thinkingBudget > 0`, or `{,thinking.}thinking_budget / thinking_token_budget / thinking_budget_tokens > 0`). A zero budget (such as Gemini `thinkingBudget: 0` when thinking is `"off"`) MUST NOT block clamping.
  - **Conservative input bound (no prefix double-counting)**:
    - When `selected.receipt` matches: start from `receiptBreakdown.observedU` (already provider-measured; never multiply or re-charge the serialized prefix) and add a worst-case bound (`<= 1 token/char`, e.g. `Math.max(messageTokens, charLength)`) for **only** unmeasured trailing items (`deltaR`, `additionalM`, `initialMetadataTokens`, and `onPayload` growth).
    - When no receipt matches: compute the worst-case bound (`<= 1 token/char`) over the serialized input fields (`messages`/`input`/`contents`, `system`/`instructions`, `tools`/`functions`) plus metadata/growth.
  - **Safe operational floor & non-feasibility boundary**: Let `safeFloor = Math.min(serializedCap, Math.max(outputFloor(model), reserveTokens, Math.min(32768, Math.floor(model.contextWindow * 0.25))))`, deriving `reserveTokens` from `model.contextWindow - config.triggerTokens`. Only when `conservativeInput + serializedCap > model.contextWindow` and `model.contextWindow - conservativeInput - safetyMargin >= safeFloor`, clamp the serialized output cap path(s) on a cloned payload to `Math.max(safeFloor, model.contextWindow - conservativeInput - safetyMargin)` and return that modified payload from `onPayload` (even when the downstream hook returned `undefined`).
  - **No impossible guarantee near full context**: When remaining conservative headroom is below `safeFloor`, leave `serializedCap` untouched so Pi's native overflow/threshold compaction handles true full-context limits. Never fabricate a default local `CAPACITY` error from this bound.
  - **Observation & receipt integrity**: Update `AdmissionObservation.outputCapTokens` to the final sent cap prior to emitting `nunc:admission` / layout observation. Keep `observation.mode` and `observation.categories` describing downstream hook changes only, and preserve `MainSnapshot.payloadBound` on output-only clamps.

### 3. Proportional Default Retention, Compaction Mechanical Cleanup, and Runway Diagnostics (Issue B, `MUST`)

- **Proportional default `keepRecentTargetTokens`**:
  - In `src/pi/config.ts` (`engineConfig()`), when both `rolling.targetTokens` and `rolling.keepRecentFraction` are omitted, set `keepRecentTargetTokens` to `Math.min(100000, Math.max(1, settings.keepRecentTokens, Math.floor(triggerTokens * 0.25)))`.
  - Preserve exact existing semantics whenever `rolling.targetTokens` or `rolling.keepRecentFraction` is explicitly configured, and retain `100,000` as the upper bound for `>= 400K` / `1M` windows.
- **Compaction-scoped mechanical cleanup when `M` is unchanged**:
  - Do **not** rewrite active `R` automatically in `context` projection between compactions (preserving provider prompt-cache prefixes and `MainReceipt` prefix matching), and keep manual `nunc_memory_patch` (`src/pi/manual.ts`) returning no-op without cleanup-only commits when `M` is unchanged.
  - Extend `decideToolResultCleanup` (`src/engine/cleanup.ts`) with an explicit opt-in option enabled by native compaction (`maintain`), allowing deterministic lossless mechanical rules (`strip_boilerplate`, `deduplicate`, `compact_toc`, `compact_json`, `clean_terminal`) to run across `candidateScope` intersected with `retainedEntries` even when `!mChanged`.
  - **Skip-reason precedence**: When `disabled` is true, return immediately with `not_in_candidate_scope` for any `semanticEdits`. Otherwise, when `!mChanged`, record `reason: "m_unchanged"` for every item in `semanticEdits` upfront and leave `candidateSemanticEdits` empty **before** filtering against `candidateScopeSet`; only then execute mechanical rules when opted in.
- **Distinct post-compaction runway diagnostic**:
  - Keep `normalHeadroomSufficient` dedicated strictly to normal-trigger extraction feasibility.
  - Derive post-compaction growth runway directly from existing `accounting.mainAfterTokens`, `accounting.effectiveTrigger`, and `accounting.growthTokens` (without redundant fields on `Accounting`). Surface this candidate forecast in `/nunc details` (`maintenanceLines`) and emit a one-time warning (`runwayWarned`, reset alongside `headroomWarned` in `invalidate()`) when projected post-compaction `growthTokens` leaves narrow runway (e.g., `< 0.35 * effectiveTrigger`). Never advise increasing `compaction.reserveTokens` for narrow post-compaction runway.

### 4. Categorical Larva Unavailability Diagnostics (Issue C, `MUST`)

- **Preserve fail-closed refusal and `resolution` union**: Maintain hard `CONFIG` refusal (zero fallback to unprojected prompts) on `{ status: "unavailable", reason }`, and keep the 4-value `resolution` field (`"resolved" | "legacy-no-reply" | "unavailable" | "protocol-error"`) intact for existing consumers and tests.
- **Safe categorical `resolutionDetail`**:
  - Map Larva `unavailable` reasons strictly by exact allowlist to fixed safe tokens: `"not ready"`, `"damaged managed boundaries"`, `"ambiguous managed boundaries"`, `"damaged legacy boundaries"`, `"invalid request"`; map any other nonempty valid `unavailable` reason to `"unavailable"` (never rejecting unknown nonempty reasons as protocol errors, and never echoing or truncating untrusted text).
  - Map `protocol-error` failures to `"duplicate-reply"`, `"invalid-payload"`, or `"dispatch-error"`.
- **Symmetric reporting**: Preserve `"Larva system prompt is currently unavailable"` as the prefix of the `unavailable` `EngineError("CONFIG", ...)` message (appending ` (${detail})`), and expose `resolutionDetail` consistently on `AdmissionObservation`, `LastMainContext` (`src/pi/context.ts`), `/nunc details` (`src/ui/status.ts`), F7 Context tree `Last main` (`src/ui/context-tree.ts`), and `ui.noteDiagnostic` (`src/index.ts`).

### 5. Synchronized Documentation and Test Updates (`MUST`)

- Update `docs/PI.md`, `docs/ENGINE.md`, `docs/CAPACITY.md`, `docs/TOOL-RESULT-CLEANUP.md`, and `docs/LARVA-PROMPT.md` to reflect the revised default ceiling, compaction mechanical cleanup under unchanged `M`, post-authorization `main` output-cap clamp, and `resolutionDetail`.
- Update `tests/pi/config.test.ts` default full-window `keepTarget` expectation (`6000` when `triggerTokens = 24000`), and add behavioral regressions proving all new postconditions without weakening existing assertions.

## Implementation Notes & Hazard Map (`ADVISORY`)

- **`src/pi/admission.ts` (`Admission.enter`, `onPayload`)**: `config = this.config(ctx, model)` is already resolved before `onPayload`; reuse `model.contextWindow - config.triggerTokens` for `reserveTokens` instead of adding new constructor callbacks. Ensure clamping clones the payload container + nested `config`/`generationConfig` object along `outputCapPaths()` without mutating caller-owned references in place if `replacement === undefined`.
- **`tests/pi/payload-google.test.ts` & `scripts/observe-grok-budget.mjs`**: Verify that receipt-matched `observedU + delta` does not trigger false clamping on `gemini-2.5-flash` (`observedU = 988,041`, `cap = 56,436`) and that `<= 1 token/char` unmeasured sizing on Turn 1 preserves `firstCap > 400,000` on `grok-4.6`.
- **`src/engine/cleanup.ts` (`decideToolResultCleanup`)**: Verify `tests/engine/cleanup.test.ts` still reports `"m_unchanged"` (not `"not_in_candidate_scope"`) when `cleanupCandidateScope` is empty and `M` did not change.
- **Telemetry expectation on `272K` models**: Proportional `keepRecentTargetTokens` reduces full-window retained `R` from `100,000` to `63,904` heuristic tokens (~36K recovered when `R` was pinned at the ceiling), but does not eliminate compactions driven by large `F + M` or single-turn multi-file reads; keep documentation and diagnostics explicit about this scope.
