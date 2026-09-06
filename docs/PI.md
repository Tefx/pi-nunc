# Stock Pi extension

Target: **Pi/pi-ai 0.85.1**, persistent sessions. Nunc is an independent public extension. Stock Pi owns its CLI/TUI/RPC, compaction lifecycle, scheduling, retry, JSONL writes and context rebuilding. The extension requires no SDK host, replacement launcher, private patch, another extension or global installation.

## Load and configure

Build with the locked local tools (`npm run build`), then choose the extension explicitly for one Pi invocation:

```sh
/opt/homebrew/bin/node /absolute/pi-nunc/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  -e /absolute/pi-nunc/dist/src/index.js --nunc-config /absolute/nunc.json
```

`package.json` also declares `pi.extensions`. Omit the flag for Nunc defaults. Relative configuration paths resolve from Pi's cwd; `policyFile` resolves from the configuration file's directory. Nunc reads these files without writing them. `/nunc` shows the current slot count, threshold and support diagnostics without making a request. Remove the extension resource and use stock `/reload`, or start without it, to unload. Existing summaries remain readable by stock Pi.

```json
{
  "policyFile": "./preferences.md",
  "memory": { "fraction": 0.1, "maxTokens": 2000 },
  "rolling": { "keepRecentFraction": 0.67 },
  "extraction": { "toolResults": "auto", "headTailChars": 200, "outputTokens": 4096 },
  "budget": { "safetyTokens": 1024, "growthTokens": 1024 }
}
```

All fields are optional. Unknown fields/types fail explicitly. Memory fraction is `[0,1)`, kept fraction is `(0,1)`; integer bounds are positive. Optional `budget.extraMainInputTokens`, `extraExtractionInputTokens`, `inputLimit` and `imageTokens` express justified provider framing/input/media bounds; extra inputs may be zero. `policyFile` supplies UTF-8 supplemental preferences. Whole-slot, reference, terminal-response and capacity checks always apply.

Pi's effective `compaction.reserveTokens` sets `H = model.contextWindow - reserveTokens`. Require positive reserve/H and `0 <= keepRecentTokens < H`. Pi's `keepRecentTokens` affects native preparation; Nunc independently chooses a legal suffix using its retained fraction. A nonempty retiring prefix and legal retained unit are still necessary. The controlled fixture's window 60,000/reserve 36,000/initial keep 1 gives H=24,000; these numbers are mechanics fixtures, not general recommendations. Measure the selected model's full extraction overhead and trigger earlier when needed.

The extension inherits `ctx.model`, current thinking and actual native request options, so startup/runtime model selection takes precedence over static saved defaults. No authentication setup command is part of Nunc. Verification isolates task sessions/files and records only nonsecret effective metadata; named test overrides stay invocation-local. Standalone runner startup resolves its own defaults; preserving another runtime's unsaved selection requires explicit nonsecret forwarding from that runtime's public context.

Stock settings are read through public `SettingsManager.create(cwd, getAgentDir(), {projectTrusted: ctx.isProjectTrusted()})`; declined project settings remain excluded. Component fixtures may supply the exported read-only `bindHostSettings` callback on their loader event bus. The supported stock route needs no callback. A disagreement with actual native preparation cancels maintenance.

## Delivered source and native handoff

At `session_before_compact`, Nunc freezes the selected, already-delivered `R = B | K` plus existing M and effective system/tools F. Public `buildContextEntries()` → `sessionEntryToContextMessages()` → `convertToLlm()` supplies evidence. Nunc does not inspect Pi's pending queues, reconstruct inputs, consume future D, or open retired history/log references. A pre-prompt threshold can therefore run before the new prompt is delivered. Pi appends that original prompt afterward; actual request admission checks it then.

Full visible tool bodies, arguments, associations, errors, custom messages, bash results and branch summaries remain source. Excluded bash and plain custom state are absent. Failed/aborted assistant output is excluded consistently with native request/overflow handling. Every compaction entry is a summary carrier and is excluded from R. Current memory is decoded once from the newest checkpoint.

Legal real K entries may precede earlier checkpoint entries. Nunc retains those entries unchanged and excludes every obsolete summary carrier from extraction and ordinary context. It does not move the boundary past the newest checkpoint merely to avoid old summaries. The ordinary context hook keeps exactly the newest native summary, without rewriting real K.

`auto` extraction uses complete F/M/B/K first. Only measured capacity overshoot permits one explicit, marked tool-body reduction; `full` prohibits reduction. Neither mode alters Pi's original retained K. Images require advertised support and a justified per-image upper bound. Unknown/audio/PDF blocks and invalid tool associations fail explicitly.

The engine produces one complete candidate. Nunc checks cancellation, session/file/leaf/generation, selected model/thinking, effective F, settings and configuration before handoff. Model/session/path changes abort in-flight extraction. Policy text freezes for one transaction; edits apply on the next. Preparation, policy, extraction and validation failures return `{cancel:true}` and cannot fall through to the default summarizer.

Pi receives one native `CompactionEntry` result: `summary`, `firstKeptEntryId`, `tokensBefore`, and `details.nunc = {version:1,slots,nextId}`. Nunc writes no session entries or second memory store. Pi owns later append/rebuild failures; its in-memory state may advance before a failed file append. Reconcile native session/file state before retrying a failed write. Nunc supplies no rollback or replay.

## Main-request admission

Nunc captures the current public native `Provider` through `ModelRegistry.getProvider`, wraps its `stream`/`streamSimple`, and delegates to the captured original transport. It uses the stock model's total default `maxTokens` ceiling, including thinking; native context clamping can only reduce that ceiling. Extraction has its separate raw-call ceiling. Native `openai-codex-responses` omits a serialized output cap; some `openai-responses` models opt out through `compat.supportsMaxOutputTokens === false`. Those requests reserve the complete `model.maxTokens` allowance. A smaller extraction allowance is invalid rather than an enforceable cap.

Each main context event issues one ticket bound to the actual converted messages, run signal, selected model and session. The provider wrapper checks that ticket against the actual request, including F/tools, media, metadata and configured framing bounds, before original transport dispatch. Maintenance has a one-shot `AsyncLocalStorage` binding to the engine's exact context, model, signal and output ceiling. Nested foreign requests cannot reuse it. Prompt text, empty tools or matching model IDs never establish maintenance identity. Unknown raw/nested calls and changed contexts fail before dispatch.

An oversized, owned main request produces a local capacity error recognized by Pi's native overflow logic. The rejection makes no HTTP request. Pi alone decides whether to compact and retry. With auto-compaction disabled it stays disabled; explicit `/compact`, smaller input or a larger supported model remains available. Indivisible input or a request without a legal retiring prefix fails without a recovery loop. Nunc never calls `ctx.abort`, initiates compaction from the context hook, withdraws queues or resubmits a prompt.

Actual user cancellation takes precedence over owned capacity errors. Stock TUI also flushes its compaction queue after Escape. When the native automatic-maintenance signal is aborted, Nunc rejects resulting main transports until that run settles. Pi still owns queue delivery, persistence and editor behavior; Nunc does not restore or remove queued text. A new explicit request after settlement can continue normally.

Observe-only payload callbacks and public header hooks remain composed. Payload mutation is rejected by a wrapper around the final native `onPayload` callback before HTTP. A later public provider registration is captured on the next context; teardown restores a predecessor only while Nunc still owns that registration. The extension does not replace host authentication. Codex OAuth, refresh, request compression and transport remain native. Its subscription cost placeholders do not establish USD billing; Nunc maintenance observations report billing as unknown. The bounded runner uses the native SSE path and full output reservations, without adding `max_output_tokens`.

## Supported boundary and evidence

- Persistent stock Pi **0.85.1** only; `--no-session` is unsupported. No minimum-version/all-provider claim.
- Request accounting and live endpoint/payload checks are established from the selected model's public `api` metadata for `openai-completions`, `openai-responses`, `anthropic-messages`, and `openai-codex-responses`. That is fail-closed native-serializer handling, not a provider-name support catalog. Other APIs fail before dispatch. Codex OAuth remains a native route when that model is selected.
- One custom compaction owner. Legacy stream overrides, raw sampling payload overrides, constrained tool sampling (absent from public maintenance `ToolInfo`), per-main-call `maxTokens` overrides, context/payload rewriting and provider changes during a prepared request are unsupported. Registering a replacement between settled requests is tested; arbitrary concurrent registration cannot establish compatibility.
- Capacity estimates are conservative software bounds, not proof of provider tokenization, cache reuse, cost or memory quality. Native images need an operator-justified bound.
- Resume reads the selected saved M/K. New sessions start empty; tree/fork/clone follow the selected path. No cross-session memory cache exists. Legacy external summaries enter M as one slot; malformed Nunc snapshots fail explicitly.

`nunc:admission` reports classification, delegation/rejection and estimates without source/credentials. `nunc:maintenance` reports a detached attempt result; it is **not a persistence receipt**. Observe native `session_compact` and JSONL for persistence. `nunc:diagnostic` reports configuration/preparation failures. Notification consumers cannot change a candidate.

The [complete check](DEVELOPMENT.md) executes stock CLI/RPC and a real PTY/TUI, native transports against loopback SSE, repeated overlapping rollovers, queues/future images, cancellation, lifecycle and public composition. Public-SDK component fixtures supplement these tests. Codex coverage uses fictional native stored OAuth, the actual Codex serializer/zstd/SSE parser and real stock tool/compaction calls. Pi's existing credential owner performs normal lookup/refresh/persistence; Nunc and its runner never copy, export or manage credentials. Producer tests never read real authentication. All service responses are controlled; [separately authorized continuation observations](LIVE.md) and final integrated acceptance remain outstanding.
