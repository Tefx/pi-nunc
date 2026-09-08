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
- `scenarios: [{id: "c1" | "c2" | "c3" | "c4" | "c5", variant?: "full" | "capacity" | "late-d"}]`; c4 requires `full` or `capacity`. c1 may select `late-d`. Other cases have no variant.
- Optional `overrides: [{requirement, reason, model?: {provider,id}, smallerModel?: {provider,id}, thinking?, config?: {nunc?, compaction?, retentionCalibration?}}]`. Partial compaction overrides merge with native defaults. Calibration supplies `minFraction`/`maxFraction`; c5 requires a named smaller-model selection. Reports include before/after differences.
- Optional `observations`: `continuation` alone (default), or `stock_rpc`/`stock_tui` for controlled-only observations.

`examples/live-selection.json` is a path template using native defaults. Named live-route overrides bind catalog ids without probing accounts: `openai-codex`/`gpt-5.6-luna`, `openrouter`/`google/gemini-3.8-flash`, and `xai`/`grok-4.6` for Grok 500k reproduction, with `thinking: "low"` when the model advertises that level. No `authorization`, `models`, `credentials`, `receipt`, credential path or preparation fields are accepted on public stdin. Internal synthetic job fixtures under `tests/live` include normalized metadata solely to test private quota/worker interfaces; they are not operator templates.

Public `ModelRuntime.create` with an empty in-memory credential store and `refreshOnCreate:false` resolves nonsecret model configuration, including native models.json endpoint/capacity overrides, without opening native auth or constructing a session. The runner carries that native-resolved metadata; it does not reconstruct a provider-name or API support catalog or fall back to a hardcoded factory. Unsupported model headers/sampling overrides or endpoints containing credentials/query data fail before effects.

`PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` are Pi's public shell-tool forwarding path. Without those values, startup resolution uses saved settings and persisted/default project trust. No-call preflight refuses an unresolved startup model rather than probing accounts to choose one. Other running extensions' unsaved configuration and transient project-trust choices are not discoverable from another process; use a supported standalone invocation or explicitly forward the required nonsecret differences. Nunc itself always receives the active host's public context and actual request options.

The live observer extension registers `before_provider_request` observe-only then identity-return handlers so native runs compose callbacks. It records field names, never bodies or headers. Named override `payload-append` (with a test reason) inserts `-e dist/src/live/append.js` after the observer. That tracked extension appends the fixed synthetic last-user string `nunc-synthetic-last-user-append` through the public callback; it does not read ambient sensors, stdin text, or personal context. `payload-append-b` loads `dist/src/live/append-b.js` with a second distinct synthetic suffix so two append hooks compose. `provider-wrap` loads `dist/src/live/wrap.js`, which wraps the current native Provider once on `agent_settled` so the next turn re-captures the chain. Admission reports `transform: last-user-text-append` without the appended text. Maintenance header/auth proof uses public Provider/auth configuration; SDK-only header hooks are not claimed on `registry.complete`. The verification-only `bounded-observation` requirement records its restricted tools/context/resources, SSE and zero-retry differences. It preserves main output/thinking. The new scenario cwd receives only a narrow nonsecret task settings overlay (compaction and request/delivery options) through Pi's native project settings, with invocation-only `--approve`; no saved trust decision or existing repository/daily `.pi` directory is modified. Native global model configuration and credential ownership stay inherited. No whole profile is cloned.

`target` identifies the checkout and a new canonical task root beneath its `.scratch/` or the system temporary directory, plus retain/remove cleanup. `limits` bounds calls, total reserved tokens, time, total output and known costs. Both main and maintenance consume the same finite quota. Preserve single-use target binding and uncertain-effect reconciliation; do not rerun an executed target. No separate default-inheritance receipt or free-form approval is required.

Each reservation charges `model.contextWindow + authorized output` against `maxTotalTokens`. That charge is not a claim that input and catalog output occupy the window at once: product admission owns input headroom, native serializers clamp wire output, and the observer refuses only when the input estimate itself cannot leave the serializer floor. Grok-class 500k/500k main requests therefore reserve 1,000,000 tokens per call without being rejected before native clamp. Uncapped native Codex requests reserve `model.maxTokens`, without inventing `max_output_tokens`. The native provider owns serialization, compression, authentication and transport. `maxCostUsd: null` is user-authorized absence of a USD ceiling, not a free invoice; catalog estimates and native zero placeholders remain separately labeled and do not prove billing. Known costs enforce their configured bound. Reservations are never refunded. A completed failed independent scenario is not retried or replayed, but later authorized isolated scenarios may continue within remaining shared call/token/time/known-cost limits. Unresolved requests, user cancellation, exhausted shared limits, and binding or cleanup failures still stop further effects. Local cancellation cannot prove remote cancellation or final billing. Native provider failures report a small sanitized diagnostic (stage, fixed code, observed HTTP status, whether transport started) on the consumed terminal and report; they do not copy bodies, headers, URLs, stderr or credentials, and they do not invent a private log to inspect.

The orchestration worker runs in the checked repository cwd and retains the supervisor's `TMPDIR` (including its absence), so both validate targets against the same allowed temporary root. The native task host alone redirects temporary files into `<stateRoot>/tmp`; no additional filesystem roots are allowed.

Worker boundary rejections appear in `children[].diagnostic` as a bounded code and fixed nonsecret message, and the supervisor's `reason` preserves that code. The separate IPC diagnostic does not capture stdout/stderr, exception bodies, environment, authentication or model responses. A terminated worker without a structured rejection still has its exit/signal/timeout receipt. Retained completed runs write `owner.json.status: "terminal"` with the report result and cleanup disposition after writing the terminal report. This marks local orchestration completion only; unresolved calls remain unresolved and the target remains single-use.

The supervisor propagates signals/deadline cancellation, waits for child exit, and escalates termination after a bounded grace. Failures retain task state and reports for reconciliation. Successful `remove` cleanup follows exited children and reconciled calls, preserving evidence in the returned report first. Native configuration/authentication outside task state is never removed.

## Continuation and evidence

Each scenario uses a fresh persistent session and task cwd. Public tools are bounded to scenario files. `read` of the task cwd itself is allowed so the native file tool can return its ordinary directory error; write/edit of that root, traversal, protected names and external symlinks stay denied. Observer denials distinguish path, deadline, tool-kind and write-size without collapsing them into one outside-scope sentence. The model sees tracked input turns and seeded task files only; observer criteria and future turns remain private. Native RPC compact/model changes, saved JSONL and actual process restart establish lifecycle. No manual M, manufactured checkpoints, scripted expected answers or replayed prompts establish continuation quality.

- c1: Retire a provisional conclusion while its corrective evidence remains in K.
- c1/late-d: After the frozen maintenance extraction is observed, one public RPC `steer` is accepted while compact is still outstanding. D is absent from that frozen source and forbids cache without establishing another route. The private oracle fails cache selection; justified uncertainty is not a cache-refusal failure, and an unsupported alternative stays distinguishable from an evidence-backed decision. The runner records the accepted steer and never reissues it as `prompt` or `clear_queue`. Native continuation or a later ordinary turn drains the queued D so the first post-freeze main request includes D once. Missing overlap, including a race where maintenance ends before the steer ACK, stays `UNPROVEN`. Cancelled maintenance cannot continue later effects.
- c2: Three rollovers precede checks of exact continuing constraints.
- c3: Pause and restart the same saved session, then resume unfinished work without repeating excluded actions.
- c4/full: A giant fixture distinct from the original capacity source still exceeds native read truncation, hides the middle exception from the first chunk, and requires complete tool exposure. Full extraction, retirement and later artifact qualification cannot succeed if those prerequisites fail.
- c4/capacity: Keep the original giant source. Observe bounded extraction omission/failure and unchanged state after cancellation; failed continuation remains unproven. Preserve native context/output in reports. A named stricter Nunc `budget.inputLimit` with a lower H can make actual full extraction miss while leaving measured trigger-headroom advice (actual request failure is `CAPACITY`). `extraInputTokens` remain justified provider framing only. Downstream real runs may still bind a strictly smaller native model.
- c5: A named smaller-model override changes only task runtime state, then checks native model-change persistence and recalculated budgets.

Optional retention calibration is a named test override within its declared fraction interval. It derives legal source placement from actual F/M/R and tool units, then changes only task configuration. Impossible placement stops before maintenance. Nunc still selects its own K and Pi persists one native snapshot. Actual checks confirm candidate/summary/boundary agreement, unchanged K/order, no retired source, and only the latest summary carrier.

Reports record resolved nonsecret defaults, named override differences, call/token/time and known/unknown costs, usage/cache usage, budgets/omissions, tool actions/artifacts, native session/lifecycle observations and limitations. Artifact checks require real files and setup prerequisites; semantic criteria remain independent judgments. `OBSERVED` establishes completed mechanical observations only. Real-model continuation, policy effectiveness and final integrated acceptance require downstream evidence.

## Three-way extraction comparison runner

`scripts/compare-extraction.mjs` consumes a bounded JSON object on stdin and runs the three groups (`native`, `current`, `candidate`) across documented modes (`defaults`, `matched`):

```sh
# Preflight without model calls, session creation, or installation:
/usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  /opt/homebrew/bin/node scripts/compare-extraction.mjs --preflight < comparison-selection.json

# Execute the comparison after prepared targets:
/usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  /opt/homebrew/bin/node scripts/compare-extraction.mjs < comparison-selection.json
```

### Public schema

Bounded JSON on stdin requires `target`, `limits`, `scenarios`, and `comparison`:

- `target: {repository, stateRoot, cleanup: "retain" | "remove"}` with canonical absolute paths.
- `limits: {maxCalls, maxTotalTokens, maxDurationMs, maxOutputTokens, maxCostUsd}` shared across all groups and scenarios in a single global budget ledger (`calls.jsonl`).
- `scenarios: [{id: "e1" | "e2" | "e3" | "e4" | "c1" | "c2" | "c3" | "c4" | "c5", variant?: "fits-required" | "required-too-large" | "full" | "capacity" | "late-d"}]`. Tasks `e1`–`e4` consume `tests/scenarios/extraction-inputs.json` and `tests/scenarios/extraction-observer.json`.
- `comparison: {modes: ("defaults" | "matched")[], targets: {native: {repository}, current: {repository}, candidate: {repository}}}`.

`examples/comparison-selection.json` provides a template.

### Three prepared targets

1. `native`: Real stock Pi 0.85.1 with no Nunc hook. Pi's native compaction runs and produces a structured markdown summary (`## Goal`, `## Constraints`, etc.) and cumulative file operations list (`readFiles`/`modifiedFiles`).
2. `current`: Product baseline `70dacad`, loading `70dacad`'s compiled `dist/src/index.js` (three-field protocol `add`, `remove`, `priority`).
3. `candidate`: New candidate checkout, loading candidate `dist/src/index.js` (four-field protocol with `required` and joint capacity guard).

Preflight verifies baseline identity (`git rev-parse HEAD` at `70dacad`), compiled distribution (`dist/src/index.js`), Pi 0.85.1 dependencies, and clean working tree for candidate before effects.

### Comparison modes and public seam status

- `defaults`: Reports actual differences in hook threshold H, cut point, retained K, summary/M size, output planning/caps, calls, tokens, latency, and native file list overhead without hiding default divergence.
- `matched`: Runs new sessions; it never relabels defaults observations. Before every rollover, actual source entries determine a legal native `keepRecentTokens` and the loaded target's Nunc retention fraction. The supervisor passes the native case's matching rollover receipt (including every pause/resume segment) to current/candidate preparation. Nunc attempts the native realized memory envelope after subtracting its fixed empty envelope, and the observed single-call output cap. Split or uncapped output and infeasible accounting remain explicit limitations. This outcome-bound preparation cannot establish equal memory constraints: native Pi appends wrappers/file lists and has no enforced rendered-memory ceiling. Parity therefore remains `UNPROVEN` for that dimension. Output planning, serialized caps and rendered-memory units stay separate.
- `rollover_at_tool_boundary` (e3): An awaited public `turn_end` holds the complete persisted matching tool batch. The worker checks the exact original request, successful complete read, all sibling associations, public native cut selection and the loaded target's accounting. It updates only task configuration through a public command `reload`, then releases the existing agent loop for native threshold compaction and continuation. Reload tears down the observer provider registration to prevent nested reservations. A failed inequality stops before another reservation/transport; no abort/replay, custom native summary or JSONL editing occurs. The real suffix finishes before a same-session process restart and turn b.

`rawSegments[].rollovers` retains each native preparation, actual model/thinking/configuration, frozen branch/active entries, dispatched call IDs, maintenance result and persisted snapshot. `requests` retains contexts and observed serialized caps, with main admission observations separately from planning. `matrix[].rollovers` gives derived measurements; missing observations are null. Wrapper and file-list differences are measured, without requiring identical formats. `ledger`, all raw segments, artifacts/actions and native sessions remain in the returned report before successful removal. Call-ID joins prevent resumed history from inflating segment/case/group totals. `OBSERVED` denotes completed mechanical observations, independently of semantic qualification and matched parity.


### Extraction qualification evidence

E2 source checks bind the original request and correction to actual source entry IDs. The probe must be the successful `read` of the exact task-local `probe.json` in turn `c`, with the complete matching call/result in K. Retirement of turn `b` is checked against the second maintenance result; a later retirement cannot satisfy that earlier prerequisite. Mixed-slot semantic qualification remains independent.

Candidate E4 capacity qualification requires one complete response from the current maintenance, its frozen M/nextId, and the actual accounting limit agreeing with the dispatched request. Missing inputs, invalid references and empty necessary sets remain `UNPROVEN`; no configuration estimate substitutes for an unobserved limit. Generated IDs include collision handling and wrapping, and growth is not subtracted twice. These capacity predicates are recorded separately from ordinary continuation eligibility. Failure-path recovery requires a recorded required-capacity failure, one delivery of turn `c`, a complete native response, unchanged saved compaction state and no additional maintenance. An ordinary successful response alone does not prove recovery.
