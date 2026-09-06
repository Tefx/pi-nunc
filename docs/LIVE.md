# Bounded stock-host observations

`scripts/verify-live.mjs` consumes one nonsecret JSON object on stdin and runs the locked stock Pi CLI/RPC or actual PTY/TUI. It supplies verification tools, without replacing the product launcher or constructing an SDK host. Node 26.7.0 and Pi/pi-ai 0.85.1 are the selected targets.

## Defaults and ownership

Required input is `target`, `limits`, and `scenarios`. Pi resolves its effective native model/provider/options/configuration; callers do not reconstruct a model catalog or repeat approval text. Existing full-delivery authorization applies. Only named test requirements justify `overrides`, with their reason and actual differences recorded.

Standalone invocation resolves Pi's startup defaults. To preserve an invoking runtime's unsaved current choice, forward its nonsecret effective selection from public Pi context/invocation facilities. Another process cannot implicitly discover that selection. Static settings must never override the forwarded choice. Default main output/thinking remains unchanged; capacity failure requires a diagnostic or a named test override.

New task sessions, cwd/files, artifacts and bounded effects are isolated. The existing native configuration/authentication owner stays in place. Nunc does not copy a profile or credential record, export tokens, manage OAuth storage/refresh/login, or require an API-key account. There is no auth-handoff command or authentication preparation phase. Pi performs ordinary credential lookup/refresh/persistence; native credential bytes are not promised frozen. Existing daily sessions and saved settings/default selections remain protected. Credential values and source locations are excluded from recorded stdin, argv and reports.

Producer tests use fictional pre-existing native profiles and controlled services only. Real native authentication and model observations belong to the downstream runtime owner. Controlled transport/compaction fixtures prove mechanics, with no claim about memory quality or live authentication.

## Invocation and bounds

```sh
/usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  /opt/homebrew/bin/node scripts/verify-live.mjs --preflight < selection.json
# Execute the same selection after successful no-effect preflight:
/usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  /opt/homebrew/bin/node scripts/verify-live.mjs < selection.json
```

`--preflight` resolves nonsecret configuration, checks the locked build and actual target/limits, and makes no model call, auth resolution/copy, new task session or installation. `--observe-stock` runs named controlled RPC/TUI checks. Missing prerequisites fail explicitly; RPC cannot substitute for TUI. `PI_OFFLINE` suppresses startup/catalog refresh, without limiting model calls itself.

The exact public schema is:

- `target: {repository, stateRoot, cleanup: "retain" | "remove"}` with canonical absolute paths.
- `limits: {maxCalls, maxTotalTokens, maxDurationMs, maxOutputTokens, maxCostUsd}` with positive finite integer counts/time/output; `maxCostUsd` is positive for a known-cost reservation or null for unknown billing. Codex defaults an omitted cost ceiling to null. Omitted `maxOutputTokens` resolves to the selected native output allowance; it never lowers Pi's main output.
- `scenarios: [{id: "c1" | "c2" | "c3" | "c4" | "c5", variant?: "full" | "capacity"}]`; c4 requires its variant.
- Optional `overrides: [{requirement, reason, model?: {provider,id}, smallerModel?: {provider,id}, thinking?, config?: {nunc?, compaction?, retentionCalibration?}}]`. Partial compaction overrides merge with native defaults. Calibration supplies `minFraction`/`maxFraction`; c5 requires a named smaller-model selection. Reports include before/after differences.
- Optional `observations`: `continuation` alone (default), or `stock_rpc`/`stock_tui` for controlled-only observations.

`examples/live-selection.json` is a path template using native defaults. No `authorization`, `models`, `credentials`, `receipt`, credential path or preparation fields are accepted on public stdin. Internal synthetic job fixtures under `tests/live` include normalized metadata solely to test private quota/worker interfaces; they are not operator templates.

Public `ModelRuntime.create` with an empty in-memory credential store and `refreshOnCreate:false` resolves nonsecret model configuration, including native models.json endpoint/capacity overrides, without opening native auth or constructing a session. Supported verification providers are Anthropic, OpenAI and OpenAI Codex. Unsupported model headers/sampling overrides or endpoints containing credentials/query data fail before effects.

`PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` are Pi's public shell-tool forwarding path. Without those values, startup resolution uses saved settings and persisted/default project trust. No-call preflight refuses an unresolved startup model rather than probing accounts to choose one. Other running extensions' unsaved configuration and transient project-trust choices are not discoverable from another process; use a supported standalone invocation or explicitly forward the required nonsecret differences. Nunc itself always receives the active host's public context and actual request options.

The verification-only `bounded-observation` requirement records its restricted tools/context/resources, SSE and zero-retry differences. It preserves main output/thinking. The new scenario cwd receives only a narrow nonsecret task settings overlay (compaction and request/delivery options) through Pi's native project settings, with invocation-only `--approve`; no saved trust decision or existing repository/daily `.pi` directory is modified. Native global model configuration and credential ownership stay inherited. No whole profile is cloned.

`target` identifies the checkout and a new canonical task root beneath its `.scratch/` or the system temporary directory, plus retain/remove cleanup. `limits` bounds calls, total reserved tokens, time, total output and known costs. Both main and maintenance consume the same finite quota. Preserve single-use target binding and uncertain-effect reconciliation; do not rerun an executed target. No separate default-inheritance receipt or free-form approval is required.

Uncapped native Codex requests reserve `model.maxTokens`, without inventing `max_output_tokens`. The native provider owns serialization, compression, authentication and transport. Subscription billing is unknown/null; catalog estimates and native zero placeholders do not prove an invoice or absolute USD cap. Known costs enforce their configured bound. Failed or unresolved calls stop later effects; reservations are not refunded. Local cancellation cannot prove remote cancellation or final billing.

The orchestration worker runs in the checked repository cwd and retains the supervisor's `TMPDIR` (including its absence), so both validate targets against the same allowed temporary root. The native task host alone redirects temporary files into `<stateRoot>/tmp`; no additional filesystem roots are allowed.

Worker boundary rejections appear in `children[].diagnostic` as a bounded code and fixed nonsecret message, and the supervisor's `reason` preserves that code. The separate IPC diagnostic does not capture stdout/stderr, exception bodies, environment, authentication or model responses. A terminated worker without a structured rejection still has its exit/signal/timeout receipt. Retained completed runs write `owner.json.status: "terminal"` with the report result and cleanup disposition after writing the terminal report. This marks local orchestration completion only; unresolved calls remain unresolved and the target remains single-use.

The supervisor propagates signals/deadline cancellation, waits for child exit, and escalates termination after a bounded grace. Failures retain task state and reports for reconciliation. Successful `remove` cleanup follows exited children and reconciled calls, preserving evidence in the returned report first. Native configuration/authentication outside task state is never removed.

## Continuation and evidence

Each scenario uses a fresh persistent session and task cwd. Public tools are bounded to scenario files. The model sees tracked input turns and seeded task files only; observer criteria and future turns remain private. Native RPC compact/model changes, saved JSONL and actual process restart establish lifecycle. No manual M, manufactured checkpoints, scripted expected answers or replayed prompts establish continuation quality.

- c1: Retire a provisional conclusion while its corrective evidence remains in K.
- c2: Three rollovers precede checks of exact continuing constraints.
- c3: Pause and restart the same saved session, then resume unfinished work without repeating excluded actions.
- c4/full: Complete giant tool evidence, including its middle exception, enters extraction and retires. Native truncation cannot count as complete evidence.
- c4/capacity: Observe bounded extraction omission/failure and unchanged state after cancellation; failed continuation remains unproven.
- c5: A named smaller-model override changes only task runtime state, then checks native model-change persistence and recalculated budgets.

Optional retention calibration is a named test override within its declared fraction interval. It derives legal source placement from actual F/M/R and tool units, then changes only task configuration. Impossible placement stops before maintenance. Nunc still selects its own K and Pi persists one native snapshot. Actual checks confirm candidate/summary/boundary agreement, unchanged K/order, no retired source, and only the latest summary carrier.

Reports record resolved nonsecret defaults, named override differences, call/token/time and known/unknown costs, usage/cache usage, budgets/omissions, tool actions/artifacts, native session/lifecycle observations and limitations. Artifact checks require real files and setup prerequisites; semantic criteria remain independent judgments. `OBSERVED` establishes completed mechanical observations only. Real-model continuation, policy effectiveness and final integrated acceptance require downstream evidence.
