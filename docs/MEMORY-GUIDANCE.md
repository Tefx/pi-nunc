# Working-Memory Tool Guidance & Continuation Extraction Refinement

This document specifies accepted guidance refinements for Nunc's active working memory tools and maintenance extraction policy.

**Status:** Tool and policy guidance text modifications implemented in `nunc.memory-guidance-implementation`; tracked observation support delivered in `nunc.memory-guidance-observation-support`; live Gemini behavioral validation pending in `nunc.memory-guidance-gemini-eval`.
**Scope:** Tool descriptions (`src/index.ts`), built-in semantic policy (`policies/default.md`), live observation runner and scenarios (`src/live/**`, `tests/scenarios/**`), associated test evidence, and plan specification.
**Invariants:** No changes to public tool names, parameters schemas, wire JSON contracts, slot IDs, revision algorithms, budget calculations, `required` joint protection, F → R → M carrier projection, or Pi native compaction scheduling.

---

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
  4. *Multi-task interruption (g4):* Unfinished main task obligations remain preserved across side discussions.
  5. *Implemented vs. verified status distinction (g5):* Completed code without verification is not claimed as verified or accepted; verified status is recorded only after successful verification without premature acceptance claims.
  6. *Split-turn wait & action ordering (g6):* Next actionable step and wait conditions/dependencies are respected before subsequent actions.
  7. *Revision conflict & unconfirmed save (g7):* Real revision conflict leads to re-reading memory and reconciling before retrying; real unconfirmed save is not automatically replayed.
  8. *Budget competition & required capacity qualification (g8):* Necessary items marked `required`, jointly retained under budget competition without silent loss (`fits-required`), or cleanly trigger required `CAPACITY` failure without masquerading as config/invalid errors (`required-too-large`).
- **Evaluation Evidence:**
  Observe actual tool call parameters, session JSONL entries, and subsequent turn actions. Do not rely on prompt keyword presence or self-reported model claims.
