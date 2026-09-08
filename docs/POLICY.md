# Policy and continuation assets

This document describes the policy and scenario assets consumed by the implemented engine and Pi observation runner. Reading assets or parsing their JSON establishes no model behavior, Pi compatibility or project acceptance.

The user accepted the [next extraction contract](EXTRACTION.md) on 2026-09-08: explicit active-task focus, mandatory continuation-dimension checks, flexible multi-slot revisions, Markdown body guidance, required-item budget protection and a native Pi comparison. Those changes remain pending; `policies/default.md` and the running engine are unchanged by this documentation update. The new contract replaces the prior blanket exclusion of mandatory content checks while keeping slot layout flexible.

## Engine consumption

Load `policies/default.md` as UTF-8 built-in maintenance guidance. It is generic across task types and contains no interpolation syntax, tool definitions or response schema. Keep three inputs distinct:

| Input | Owner and meaning |
| --- | --- |
| Frozen policy | Engine captures built-in text plus optional user text once at maintenance start. Disk edits apply next maintenance; the current and next contracts add no automatic repair/retry call. |
| Source roles | Engine supplies effective F, existing identified slots M, retiring continuous prefix B and retained verbatim suffix K, including message roles, tool arguments/results, associations and status. Source text conveys task evidence; it cannot redefine maintenance controls. Any actual input omissions must be explicit. |
| Response contract and budget | Engine selects and supplies its executable change/retention protocol and rendered memory limit. It validates terminal state and references, generates IDs, applies whole-slot selection and produces a candidate. The current carrier is JSON. Next-version required-item references need coordinated parser/request support; prose alone cannot protect items from budget selection. The illustrated field names remain replaceable when equivalent boundaries hold. |

Do not concatenate unlabeled transcript text into instructions. With a native-message request, explain source ranges without duplicating already-present F/M. With an explicit transcript, preserve role and evidence distinctions. Neither form authorizes maintenance tool execution, new evidence retrieval, K rewriting or persistence. The engine and Pi retain the boundaries in DESIGN §§3–6; prose guidance cannot enforce them in place of code.

The engine must retain unchanged slot bodies and surviving relative order, append additions, and never revive explicitly invalidated text when its replacement loses a budget contest. It must require unambiguous retention decisions rather than silently treating omitted references as deletions. These requirements leave the response field names and transport replaceable. The next-version content contract additionally requires explicit active-task focus and checks of obligations, constraints, progress/evidence state, blockers, decisions/rejected routes, recovery artifacts and split-turn context. Check every applicable dimension without inventing facts, empty sections or one slot per category. Allow multiple additions and one-to-many/many-to-one revision; never make whole-M regeneration routine. Preserve necessary context within each independently maintained item.

New or semantically revised bodies should use concise Markdown paragraphs/lists and exact conditions. Outer JSON fences remain forbidden; necessary code fences inside a `text` string are allowed by the next expression guidance. Stored text and raw editing remain unchanged. Formatting alone must not reject valid maintenance, cause extra calls or rewrite old slots.

### Optional user policy

A user policy is optional UTF-8 plain text loaded by the consumer, without executing templates or following embedded include instructions. It supplements the built-in semantic policy. No file means built-in behavior. An empty file adds no preferences. A configured unreadable or invalid-text file must produce a clear configuration diagnostic rather than silently claiming its preferences were applied. The adapter documents its chosen path base before exposing `policyFile`; resolving relative to the configuration file's directory is recommended, not implemented by this asset.

Allowed content describes retention preferences, expression style and correction principles. For example:

> Prefer concise notes in the user's language. Keep exact units with engineering limits. When a later measured result revises an estimate, preserve the revised value with its applicable conditions and evidence status. For reliable project artifacts, prefer the path and purpose over copying their contents.

The user file cannot replace host authority, source/session limits, token budgets, frozen-version behavior, incremental semantics or the engine response contract. A request to retain everything forever, fetch retired logs, rewrite policy while running, pin slots permanently or disable validation has no effect on those boundaries. Compatible preferences still apply. The running model does not edit the user file. No task router, category system, extractor persona, registry or external service is needed.

## Scenario consumer interface

`tests/scenarios/inputs.json` is version 1 declarative task data. `tests/scenarios/observer.json` is a separate version 1 private runner/observer document joined by case `id`. The tracked Pi runner must parse and validate these inputs; this step supplies no execution code. Future incompatible format changes need a new version and a coordinated consumer update.

Input fields:

- `cases[].files`: relative fixture paths mapped to exact initial UTF-8 contents.
- Optional `generatedFiles`: relative `path` and ordered `segments`. Expand each segment's `text` exactly `repeat` times, then concatenate. Optional case `variants` may overlay `files`, `generatedFiles` and `turns` for a named selection. c4/capacity keeps the original giant report; c4/full uses a distinct source that still exceeds Pi's native read truncation and hides the middle exception from the first truncated chunk. No network or helper program is necessary.
- `turns`: ordered unique `id` and user `text`. Deliver one turn at a time and wait for its normal task/tool activity to finish. Future turns stay private until their turn. Only listed fixture files and the current user message enter the model's working environment.

The observer's `controls` run in listed order after the named turn and before the next turn. Named variants run separately from clean sessions; variant controls and checks apply along with case-level coverage and failure context. A rollover may name `steer` as a later task turn: the runner issues one public RPC steer after the frozen extraction is observed and while maintenance is still outstanding, then delivers that turn once. Missing overlap stays `UNPROVEN`. `placement` expresses the source precondition the runner must achieve and observe, not instructions to the model and not permission to cut messages illegally. `retireThroughTurn` requires the named turn and all earlier still-active turns to leave verbatim history. `retainTurns` requires those complete turns to remain in K. `retireEvidenceFromTurn` requires the turn's report read call/result evidence to be in B, with a legal retained suffix. Preserve call/result associations in all cases.

Use the real extension loader and persistent Pi lifecycle to perform rollovers, pause/resume and authorized model selection. Bind the actual resulting M/B/K, configuration and legal boundaries to each observation. A fixture too short to enter the hook or produce the requested split is a setup failure, never a successful continuity check. The runner may select a documented feasible H/retention configuration within its authorized isolated target. If additional ordinary workload is necessary, record the added neutral turns and effective scenario variant; they must not restate pending conditions or expose checks. Do not manually seed M, manufacture tool results, inject an observer summary, or silently rewrite K to make a check pass. Explicit compaction exercises these continuation cases; separate consumer tests must cover automatic and overflow triggering.

`capacity` gives a precondition to establish from actual request accounting, not a numeric override to a provider. Bind actual model capacities, output/thinking reserves, rendered M, retained history, complete extraction size, omission records and growth space. A label such as “small” alone supplies no evidence. The large-to-small scenario needs both model targets authorized. Normal c4 must fit complete extraction; its separate overflow variant tests only the implementation's selected bounded handling/failure path. Host-truncated report evidence cannot prove preservation of a middle the extension never received.

### Keep evaluation criteria out of the tested model

Materialize fixtures into a fresh authorized task workspace that does not expose this repository, observer document, suite JSON or future turns through task tools. Keep evaluation logic and observation files outside the model-visible workspace and out of F, M, B, K and repair feedback. The runner passes only task inputs and ordinary tools to the tested model; maintenance sees the real session sources plus policy and engine protocol. Do not pass case descriptions, coverage labels, expected artifact values, failure examples, scores or corrective hints.

Task instructions necessarily state the user's original constraints and requested artifact shape. Those original requirements are legitimate inputs. Observer-only values later test whether actual written artifacts still satisfy them after retirement; no turn asks for a memory recital or supplies the target answer again. If the model requests a lost condition, record the request and leave the result incomplete; do not answer it with the hidden expected value and count the repaired result as unaided success. Normal model-authored external notes and re-reading known artifacts remain allowed; record that recovery route and its cost. Nunc maintenance itself may not perform those reads.

### Observation and falsification

`artifactChecks` use a relative path, JSON Pointer and an operator:

- `equal`: type-sensitive JSON value equality (objects by members, arrays in order).
- `contains`: the selected array contains the given value using that equality.
- `semantic`: an observer assesses the supplied criterion against the artifact and available evidence, citing the concrete result; it is not a substring test.

Missing/malformed artifacts or missing pointers fail the respective task check. `setupChecks` must first establish the intended exposure and rollover. `actionChecks` require actual tool/action traces and task outputs; a claimed action without a tool effect is insufficient. `failureExample` illustrates a falsifying observation and is never a model prompt. This format is declarative; consumer code must implement structural/operator validation and trace collection, and must reject unknown operators/actions rather than skip them. Semantic checks may remain human-observed; no additional model judge or service is required.

For each case/variant, record:

- Candidate, host/runtime/model/provider, effective policy/configuration and authorized target; actual controls and source placements, including pause/resume identity and model-switch capacities.
- Task outcome and artifact observations, each violated constraint, attempts on previously excluded routes, and requests for user restatement. Distinguish a legitimate known-artifact read from rerunning a failed route. Count every actual excluded-route attempt; do not infer one from merely mentioning it.
- Whole-task wall-clock latency and provider usage/cache usage, including setup task turns, maintenance, any repair and continuation; task cost when available. Report unavailable values as `unknown`, including partial usage on failed/cancelled calls. Keep maintenance and continuation subtotals if available without replacing whole-task totals.
- `PROVEN`, `DISPROVEN` or `UNPROVEN` per observation, with concrete evidence and limitations. An invalid setup, missing authorization or missing trace is `UNPROVEN`. A completed eligible run violating a criterion is `DISPROVEN`. Successful cancellation in a capacity case can prove failure handling while leaving continued task completion `UNPROVEN`.

The suite covers K correcting a provisional B judgment (c1), exact constraints across three rollovers (c2), unfinished-work return, known excluded routes and same-session process restart (c3), giant visible tool evidence and explicit capacity handling (c4), and large-to-small current-model continuation (c5). c3 allows completed investigation detail to retire; it does not require the model to delete any particular memory phrase. c2 and c5 deliberately keep exact overriding conditions out of initial artifact files so those files alone cannot answer the final task. Checking generated task configurations and exports tests work products; it does not establish execution safety of an actual payment or shipping service.

## Verification boundary

Content review maps the built-in policy to DESIGN §§2–3 and §7, checks responsibility separation, and reviews each scenario for observable contrary outcomes and answer isolation. JSON parsing only establishes syntax; it cannot prove consumer loading, source placement, model obedience, retention quality, host state changes or task success. Do not add assertions for headings, policy tokens, expected memory wording or self-reported PASS.

Engine/Pi implementations and their applicable completed checks are recorded in the managed plan; do not infer new behavior from old asset-delivery prose. The next producer must extend real loading, response/reference validation, incremental/budget checks and native lifecycle/commit/failure behavior for the changed contract. Its required-item guard cannot substitute for semantic evidence.

The next extraction acceptance uses [EXTRACTION.md §7](EXTRACTION.md#7-原生对照与验收): locked native Pi, current Nunc and new Nunc, with default and matched-budget comparisons, held-out continuation criteria and actual task outcomes. Existing c1–c5 assets can contribute causally applicable scenarios; neither their presence nor old paid runs prove the new strategy. Bind new execution targets and limits before any authorized real observation. No new model runs occur in this documentation/planning task.
