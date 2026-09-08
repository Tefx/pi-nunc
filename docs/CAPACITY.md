# Capacity ownership on stock Pi 0.85.1

Nunc remains a standalone extension. This repair changes only this project: no Pi core edits, private hooks, installed-package patches, scheduler replacement or prompt replay.

## Separate planning from main admission

Pi owns normal compaction scheduling, output sizing and provider overflow recovery. Nunc's memory/retention planning continues to reserve output, safety and post-maintenance growth. Crossing that planning target alone must not reject an ordinary main request.

On the already supported native context-clamped and uncapped routes, main admission uses `min(model.contextWindow - serializerOutputFloor, configured inputLimit)`; the floor is 16 for capped Responses and 1 otherwise. The explicit input limit remains binding. The native serializer still owns the actual output cap; uncapped routes retain no cap. Unknown context-sizing routes retain fixed-output-reserve accounting until their native behavior is verified.

For the default 272000-window Codex route:

- Pi compaction threshold: 255616.
- Nunc memory/retention input planning target: 254592.
- Nunc main input guard: 271999.

A 254598 estimate is above the memory planning target and below the main guard. It delegates normally, including when default `keepRecentTokens=20000` would leave Pi without a summarizable prefix. This removes the independent soft-budget overflow that caused the reported recurrence. Main observations expose `plannedInputLimit` and `inputExceededPlan` separately from the enforced `inputLimit`; plan overruns do not emit warning spam or mutate settings.

This deliberately replaces the old contract that enforced the output/safety planning reserve on main requests. Safety and growth budgets still bind extraction, memory edits and maintenance candidates. Model-window guards are heuristic checks, not tokenizer proofs or guarantees about simultaneous native input plus maximum output.

## Protections that remain

Nunc checks final Context shape, associations, native media and configured overhead before delegation. Supported payload text/metadata growth is charged against the same main guard; native serialized output room is checked for text append. Unknown rewrites, altered models, output-cap expansion, unsupported media and actual admission overruns still fail before HTTP. Independent calls retain their own native behavior.

Extraction retains its separate output and safety reserve, complete delivered-source projection, one configured tool-text reduction, candidate growth checks, and joint retention of all declared required items. When the declared required set exceeds available memory or leaves insufficient growth space, extraction fails explicitly with CAPACITY; no partial candidate is admitted, no body is truncated, and no fallback summarization is triggered. Temporary context/payload additions never become persisted source. Only a native checkpoint establishes saved memory; `reject` does not mean `sent`, and a candidate does not mean `saved`.

## Recovery boundary

Actual capacity errors retain native bounded overflow and threshold recovery. Each maintenance opportunity dispatches exactly one engine extraction transaction; Nunc never initiates retries, automatic prompt resubmissions, or model repair loops. When required-capacity maintenance fails, compaction cancels cleanly: no compaction checkpoint is written, no default summary fallback runs, and saved M and K remain unchanged. Stock Pi's two native threshold opportunities (pre-prompt `_compactBeforeNextAssistantResponse` on prior history, and post-turn `_checkCompaction` when the turn completes with context still above threshold) are distinct native evaluation points with different causal inputs; each executes its single transaction and terminates without unbounded loops, duplicate prompt delivery, or duplicate tool effects. Automatic compaction disabled stays disabled; explicit `/compact` remains available. Nunc does not abort then resubmit a user prompt, read pending queues, force a cut, or patch Pi's recovery state.

Stock Pi can return before `session_before_compact` when its default character-based preparation finds no summarizable prefix. This project cannot fix that host path. The repair avoids entering it merely because a request exceeds Nunc's soft planning target. A complete extraction `stop` is not discarded because reported input+cache exceeds the catalog window; that path cancelled auto-compaction and retried the same oversized turn. Explicit extraction `inputLimit`, output caps and candidate growth still bind. True oversized/unretirable input or a failed native/provider recovery can still require operator intervention; no automatic-recovery guarantee is claimed.

## Regression evidence required

- Exact `254598` usage-backed request delegates under defaults instead of producing local CAPACITY.
- High usage/short visible history with keep=20000, auto enabled and disabled; no fabricated maintenance or duplicate input.
- Fresh estimates and supported payload growth can cross the planning target while fitting main admission.
- Explicit input limits and model-window overruns still reject before transport.
- Repeated native threshold rollovers save checkpoints and continue, with original input/tool delivery preserved.
- Declared required items are retained jointly; optional items are dropped by priority without skipping required items or disturbing natural order.
- Required set exceeding memory or growth capacity yields explicit CAPACITY failure, unchanged M/K, no default compaction fallback, single tool execution, and bounded host recovery across manual, threshold, and overflow paths with verified opportunity counts.
- Existing extraction, payload, cancellation, native loader/transport and persistence checks remain valid.
