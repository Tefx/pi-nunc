# Working-Memory Tool Guidance & Continuation Extraction Refinement

This document specifies accepted guidance refinements for Nunc's active working memory tools and maintenance extraction policy.

**Status:** Tool and policy guidance text modifications implemented in `nunc.memory-guidance-implementation`; tracked observation support delivered in `nunc.memory-guidance-observation-support`; live Gemini behavioral validation pending in `nunc.memory-guidance-gemini-eval`.
**Scope:** Tool descriptions (`src/index.ts`), built-in semantic policy (`policies/default.md`), live observation runner and scenarios (`src/live/**`, `tests/scenarios/**`), associated test evidence, and plan specification.
**Invariants:** No changes to public tool names, parameters schemas, wire JSON contracts, slot IDs, revision algorithms, budget calculations, `required` joint protection, or Pi native compaction scheduling. Main-request carrier placement follows [STABLE-MEMORY.md](STABLE-MEMORY.md) (`F | Rbefore | M | Rafter`).

---

## 0. Current correction: complete-task retention

**Current status:** The user authorized resumed implementation. `nunc-task-retention.semantics` delivers candidate policy/request/tool guidance and incremental task/oracle assets; runner support, integration and behavioral acceptance remain pending. The status statement and §§1–3 below record the earlier guidance delivery and its historical evaluation scope; they do not establish this correction's delivery or authorize a new Gemini run.

The canonical current contract is [EXTRACTION §0](EXTRACTION.md#0-当前修订保留完整任务与完成标准), with semantic rules in [§3](EXTRACTION.md#3-必查语义与任务焦点) and slot/edit behavior in [§4.1](EXTRACTION.md#41-增量操作). Keep existing `Slot {id,text}`, tool schemas, wire protocol, revisions, budget mechanics, persistence, native scheduling and stable carrier placement. No requirement entity, protected-ID set, special mutation API, semantic error code, permanent pin, extra model or automatic source retrieval is introduced.

### Current production changes

- `policies/default.md`: maintain the information needed to complete the whole active task correctly. Preserve decisive scope, negations, exact limits, interaction and verification conditions; a short focus cannot replace them. Keep active goals and decisive completion conditions in M even when K repeats them. Separate stable requirements from changing progress when they can be updated independently; retain valid parts of mixed notes after partial success. Consolidate superseded guidance rather than appending repeated reminders.
- `src/engine/request.ts::extractionContext`: make the maintenance objective consistent with that policy while preserving source roles, adopted task-document scope, frozen delivered inputs, one request and no tools. Other source text cannot change the maintenance protocol.
- `src/index.ts::registerMemoryTools`: refine read/patch descriptions and update/remove parameter guidance. Active edits must retain valid goals, constraints, completion conditions and unfinished obligations; replacing a body or merging notes must preserve qualifiers. Build success, file creation and partial test success update only their supported scope. Unknown validity calls for preserving uncertainty or ordinary source recovery by the main agent. Keep the existing revision/conflict/unconfirmed behavior, optional tool exposure and no routine read/write requirement.

These are model-facing semantic responsibilities. Mechanical checks cannot determine whether a natural-language deletion dropped an unfinished obligation; do not claim that ordinary patch will reject such a deletion. Human edits remain allowed. No schema or session migration is needed; lost information outside M/K requires normal source recovery rather than automatic reconstruction.

### Current verification and model selection
Extend existing extraction/guidance scenarios and observers; preserve prior fixtures and their acceptance conditions. Cover adopted task files, repeated real compaction during a single long task, partial success followed by actual memory editing and continued work, scoped corrections, interruptions, and retirement of completed tasks without losing other work. Evaluate final artifacts and actions as well as generated M/K. A run without an actual patch does not establish active-edit coverage; a controlled edit opportunity must not supply the expected note text or patch. Keep semantic checks `UNPROVEN` when only mechanical evidence exists.

For this correction's live behavioral tests, the user's selection is **`gpt-5.6-luna`, `low thinking level`**, as defined in [EXTRACTION §0.4](EXTRACTION.md#04-真实模型边界与当前授权). This applies to continuation, maintenance and any model-driven semantic observation. The Gemini-only restriction in historical §3 applies only to that earlier task. The runner already accepts the `low` name; verify actual requested/effective configuration on every relevant path, including maintenance, before live observations. Do not silently substitute a model or thinking level, or assume raw extraction defaults apply the requested setting. Keep test overrides isolated from normal production settings; report actual unsupported paths before their affected calls.

Compare native Pi, the actual pre-change Nunc and the candidate under the existing defaults/matched evidence rules; distinguish tools enabled/disabled and unexercised dimensions. Build and verify the loaded `dist/src/index.js` and policy/tool resources before candidate observations. The resumed semantics assignment authorizes local semantic assets and offline checks; deployment and live execution are outside this step. New scenario content and remaining runner work are specified in [POLICY.md](POLICY.md#complete-task-scenario-handoff). Completed Plan and evidence history stay immutable.
## 1. Tool Description Refinements

### Problem & Motivation
The active-memory tools (`nunc_memory_read`, `nunc_memory_patch`) provide mechanical primitives for session-local notes. Without explicit operational guidance in tool descriptions, agents risk:
- Calling `read` or `patch` routinely on ordinary conversational turns.
- Treating notes as a turn-by-turn command log or caching raw tool outputs.
- Treating stale notes as authoritative over newer user instructions.
- Blindly retrying on revision conflicts or automatically replaying unconfirmed saves.
- Misinterpreting `writable: true` as an unconditional guarantee of patch success.

### Accepted Text

#### `nunc_memory_read`
- **Description:**
  > Read the current session-local working memory, slot IDs, revision, estimated budget, and writable status. Use when you need to inspect saved notes or prepare a patch; routine turns do not require a read. Notes may be stale and do not override current instructions. writable is not a guarantee that a patch will succeed; a null budget limit means unknown.
- **Parameters:** `{}` (empty object, unchanged).

#### `nunc_memory_patch`
- **Description:**
  > Atomically revise session-local working memory using a revision obtained from nunc_memory_read. Save concise information useful for continuing the task: confirmed decisions and reasons, unresolved work, blockers, and recovery pointers; label uncertainty. Prefer updating existing notes over duplicates and remove obsolete notes. Avoid turn-by-turn logs, raw outputs, credentials, and information with no continuing value. Notes do not grant authority or override instructions. On revision conflict, reread and reconcile before retrying; never automatically replay an unconfirmed save. Routine turns require no patch.
- **Parameters:**
  - `expectedRevision`: Revision obtained from `nunc_memory_read` (unchanged).
  - `add`: Items to add (system assigns final IDs in order, unchanged).
  - `update`:
    > Items to update. The text replaces the full body of the slot while preserving its ID and position; retain still-valid information.
  - `remove`:
    > IDs of slots to remove from current working memory. Removing notes does not erase conversation history.

---

## 2. Continuation Extraction Policy Refinements

### Alignment with Stock Pi Compaction
Stock Pi 0.85.1 compaction enforces a fixed markdown template with sections for `Goal`, `Constraints & Preferences`, `Progress` (Done/In Progress/Blocked), `Key Decisions`, `Next Steps`, `Critical Context`, and split-turn context (`Original Request`, `Early Progress`, `Context for Suffix`).

Nunc's built-in policy (`policies/default.md`) already covers all these semantic dimensions through explicit checklist items without imposing rigid headings or arbitrary slot counts. Two targeted additions enhance continuation precision:

1. **Actionable Step Ordering & Wait Conditions:**
   > Preserve the next actionable step and any ordering, dependency, or wait condition needed to resume correctly; do not invent a plan.
   *(Incorporated under the "Unfinished obligations" checklist item).*

2. **Diagnostic Precision:**
   > Preserve exact error messages, commands, identifiers, and values when they distinguish the failure or recovery action; omit incidental logs.
   *(Incorporated under the "Recovery entries" checklist item).*

### Non-Goals & Invariants
- **No fixed heading template:** Nunc organizes memory into self-contained, independently editable slots, avoiding monolithic regeneration.
- **No cumulative file list hoarding:** Code tracking in native Pi handles file operations; memory slots focus on task continuation state.
- **No requirement for prior agent notes:** Ordinary compaction operates autonomously even if the model never called memory tools.
- **Joint required-item protection:** The machine response contract (`add`, `remove`, `priority`, `required`) and engine budget validation remain strictly unchanged.

---

## 3. Implementation and Verification Plan

### Phase 1: Implementation
1. Update `src/index.ts` with refined tool and parameter descriptions.
2. Update `policies/default.md` with the two targeted extraction additions.
3. Update `README.md`, `docs/ACTIVE-MEMORY.md`, and `docs/POLICY.md` to reflect the refined text.

### Phase 2: Offline Regression & Mechanics Checks
1. Run local build: `npm run build`.
2. Run offline test suite:
   ```sh
   /usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
     /opt/homebrew/bin/node scripts/check.mjs all
   ```
3. Run Larva integration:
   ```sh
   /usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
     HOME=.scratch/offline-home PI_CODING_AGENT_DIR=.scratch/offline-agent \
     NUNC_LARVA_EXTENSION=/Users/tefx/Projects/larva/contrib/pi-extension/larva.ts \
     /opt/homebrew/bin/node --test dist/tests/pi/larva.integration.js
   ```
*Note:* Offline controlled loopback tests verify contract mechanics, serializer binding, and error isolation, but do not prove live model semantic obedience.

### Phase 3: Behavioral Evaluation with Live Model
- **MODEL BOUNDARY CONSTRAINT:**
  - **Permitted model family & exact selection:** Google Gemini only via OpenRouter (`openrouter` with `google/gemini-3.8-flash`). Earlier mentions of `1.5-pro` or `2.5-flash` were illustrative examples; `google/gemini-3.8-flash` is the authoritative model choice for this evaluation.
  - **Forbidden models:** OpenAI Astra (`openai-codex/gpt-6-astra` or any Astra variant) and all non-Gemini models are **strictly forbidden** for this evaluation.
- **Behavioral Scenarios to Observe:**
  1. *Routine conversation (g1):* Agent answers directly without calling `nunc_memory_read` or `nunc_memory_patch` (memory tools actively exposed in session tools).
  2. *Key decision & diagnostic precision (g2):* Agent patches concise reasoning and decision points rather than full transcript logs, preserving distinguishing error messages (e.g. `ERR_SCHEMA_V2`), ports (`5433`), and recovery commands (`run-migration --v1`).
  3. *Instruction correction (g3):* When user changes a requirement, agent updates/removes stale notes and retains still-valid entries.
  4. *Multi-task interruption (g4):* After a side discussion and actual rollover, unfinished obligations remain recoverable from effective M+K or a demonstrated reliable recovery read; optional patch absence or empty M alone is not a defect.
  5. *Implemented vs. verified status distinction (g5):* Completed code without verification is not claimed as verified or accepted; verified status is recorded only after successful verification without premature acceptance claims.
  6. *Split-turn wait & action ordering (g6):* The original request actually retires while its complete tool unit and suffix remain; after native commit/continuation, the model waits for a real lock-release transition before deployment and verification.
  7. *Revision conflict & unconfirmed save (g7):* Real revision conflict leads to re-reading memory and reconciling before retrying; real unconfirmed save is not automatically replayed.
  8. *Budget competition & required capacity qualification (g8):* Necessary items marked `required`, jointly retained under budget competition without silent loss (`fits-required`), or cleanly trigger required `CAPACITY` failure without masquerading as config/invalid errors (`required-too-large`).
- **Evaluation Evidence:**
  Observe actual tool call parameters/results, session JSONL entries, saved revisions, delivered M+K, subsequent turn actions and artifact-bound verification receipts. Do not rely on prompt keyword presence or self-reported model claims.

### Mechanical versus semantic evidence

The tracked runner exposes all ten selections (g7 and g8 each have two variants) through `scripts/verify-live.mjs`; see [LIVE](LIVE.md) and `examples/guidance-selection.json`. No live call belongs to the observation-support producer.

Mechanical checks can establish actual saves, current-revision retry ordering, non-replay through a later opportunity, task-state transitions, final-artifact verification, and qualified required-capacity effects. They cannot classify free-form rationale, historical versus active obligations, conciseness, acceptance claims, or semantic necessity. Those checks remain explicitly `UNPROVEN` for the downstream Gemini observer, which should cite observations and assess importance and uncertainty. There is no character bound, fixed slot count, required wording or exact language. Valid references to rejected routes and obsolete values must remain distinguishable from selecting them.

The g2 action is a local recovery simulation validated by route/argv, not an external migration. The g5 verifier executes function behavior, and g6 clears the actual task lock before allowing the continuation. Capacity limits in the example create bounded experiments; the model's actual complete response may still fail qualification, especially if it omits optional content. Such a result proves neither a model defect nor capacity behavior. `OBSERVED` and green offline tests do not resolve semantic acceptance, and the runner does not relax the downstream acceptance contract.
