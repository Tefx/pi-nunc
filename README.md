# Nunc

**A bounded, rolling present for Pi.**

Nunc is a design-stage extension for [Pi Coding Agent](https://pi.dev). It keeps a persistent session's model-facing context finite by combining:

- a bounded free-text working memory `M`;
- a recent verbatim raw tail `R`;
- Pi's complete session JSONL for human inspection and resume.

At each Pi compaction, Nunc replaces `M` in full:

```text
M_(g+1) = E(M_g, B_g, K_g)
```

`B_g` is raw context leaving the active window. `K_g` is the raw suffix retained after compaction. At rollover, the extension sends all three regions in one independent extraction request to the main agent's current model. This lets the model apply newer corrections, bridge split tool turns, and avoid duplicating details that remain verbatim in `K_g`.

## Status

**DESIGN_ONLY — REVISED_AFTER_SCOPE_REVIEW**

The architecture has been reduced to an ordinary Pi extension. There is no Nunc implementation, executable acceptance result, integration result, or live-provider evidence yet.

## v1 contract

- Update memory only during rollover; ordinary turns do not mutate `M`.
- Store one complete free-text memory snapshot in `CompactionEntry.summary`.
- Keep recent raw messages through Pi's compaction boundary.
- Keep all existing persistent Pi JSONL entries intact while Pi appends the Nunc compaction entry.
- Let the model handling extraction decide semantic retention, revision, and forgetting.
- Use the main agent's current model for one isolated request containing serialized `M + B + K` and the sole output tool `nunc_memory(memory: string)`. The extension initiates this request; it does not create another agent or service.
- Allow at most one fresh retry with the same serialized source, prompt, and tool.
- Validate the tool call, schema, and memory token limit before returning a custom compaction.
- Cancel Nunc compaction on failure; do not silently fall back to Pi's native summary.
- Start `/new` without inherited memory. `/tree`, `/fork`, and `/clone` follow the active path selected or copied by Pi.
- Run Nunc-managed rollover only for persistent sessions. `--no-session` and in-memory sessions fail closed while Nunc is enabled.

Nunc does not create records, embeddings, a retrieval index, scores, TTLs, a reducer, a CAS ledger, per-turn commits, or an online secondary audit.

v1 excludes Codex CLI/App integration and Codex-specific compatibility work or acceptance tests. It also excludes a separately configured extraction model/provider. Pi remains the only host.

## Integration boundary

Nunc consumes Pi's public extension surfaces:

- `session_before_compact` and its `CompactionPreparation`;
- `ctx.sessionManager` read-only session access;
- `ctx.modelRegistry.complete()` for the isolated extraction request;
- Pi's custom `CompactionResult` append and rebuild path.

Pi owns session persistence, provider registration, authentication, transport composition, main-agent request construction, and fork/clone implementation. Nunc uses injected extension APIs and public Pi helpers, including token estimation and session-entry projection where appropriate. Runtime imports are selected and verified through the target Pi extension loader. Nunc requires no Pi core patch, global provider-wire guard, compaction-owner registry, or separate append transaction.

For boundaries created by Nunc, the extension normalizes `firstKeptEntryId` to the first context-visible legal cut entry. This preserves the same model-visible suffix while avoiding metadata IDs such as labels that stock Pi omits when copying a session path.

## Extraction source and budgets

Nunc builds one immutable data message with three regions:

```json
{
  "version": "nunc.source.v1",
  "previous_memory": "...",
  "retiring_context": "...",
  "retained_raw_tail": "..."
}
```

A Nunc-owned visitor serializes public Pi message values. Records retain semantic order, visible text, tool-call identity and arguments, tool-result correlation/error state, and visible tool output. Provider credentials, usage accounting, hidden reasoning, signatures, diagnostics, timestamps, and continuation handles are not memory source. Nunc does not use Pi's lossy `serializeConversation()` helper as its source contract.

Large tool/bash output uses deterministic head/tail clipping. Its size is an implementation parameter evaluated against the current model's effective window, rather than a fixed product limit. The completed source is frozen before the first request and reused unchanged for a retry. If the request still does not fit, Nunc cancels the rollover instead of making semantic trimming decisions.

Budget checks cover both the extraction request (source, extraction prompt, output tool and output/reasoning allowance) and the prospective main request (host prompt/tools, rendered memory, retained raw tail and reserved capacity). They use the current Pi model configuration and estimates with a margin; they do not assume a 32k or 1M window, require an exact provider tokenizer, or certify the final provider payload. Native prefix caching is compatible with request isolation and is left to Pi/provider defaults unless the selected integration requires an explicit option.

## Session behavior

- **Resume:** Pi rebuilds the latest compaction summary and retained entries from the same persistent JSONL.
- **`/new`:** starts with empty Nunc memory.
- **`/tree`:** uses the branch selected by Pi.
- **`/fork` and `/clone`:** use the path copied by Pi. Nunc-generated boundaries avoid label IDs; Nunc does not repair pre-existing malformed or legacy host compactions.
- **Other compaction implementations:** their latest summary can be consumed as legacy free-text memory on the next Nunc rollover. Nunc does not establish a permanent ownership epoch.

## Configuration

Optional file: `~/.pi/nunc/config.json`

```json
{
  "version": 1,
  "enabled": true,
  "memory": { "maxTokens": 4096 },
  "extraction": {
    "maxAttempts": 2
  },
  "ui": { "notifyOnSuccess": false }
}
```

Each rollover captures the current main model for its extraction request and any retry. v1 has no alternate extraction model setting.

Nunc does not read or store credentials. Pi may resolve configuration, refresh provider authentication, and persist credentials as part of its normal model-request path.

## Known host limitations

- Pi calls `session_before_compact` only after producing a valid preparation. A trailing oversized tool result with no later legal cut can prevent the hook from running.
- Pi owns JSONL append/rebuild failure behavior. Nunc has no independent state to reconcile and reports no successful rollover until the resulting compaction is observed.
- Multiple extensions returning custom compaction results are unsupported in v1; use one compaction owner by configuration.
- The inspected Pi 0.85.0 build may restore a previously length-truncated assistant message on resume. Nunc always marks incomplete assistant content when it appears in extraction source, but it does not rewrite Pi's durable history or main-provider payload.
- The tested bundled Pi 0.85.0 path-copy behavior can lose the raw suffix when a pre-existing compaction boundary points to a removed label. Nunc avoids creating that boundary shape but does not repair legacy session files. Compatibility observations apply to the tested loading mode, not every build with the same version.
- Provider/API support remains unverified until integration and live smoke tests run.

These are compatibility limits, not requirements to modify Pi core.

## Documentation

- [Design](docs/DESIGN.md)
- [Current design review](docs/DESIGN_REVIEW.md)
