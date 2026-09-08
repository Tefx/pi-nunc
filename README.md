# Nunc

**A bounded, rolling present for Pi.**

Nunc is a Pi extension project for continuing work within a finite context. It combines an overlapping window of recent verbatim history with bounded working-memory slots for the current session.

```text
Before rollover: host instructions/tools | memory M      | retiring B | retained K
After rollover:  host instructions/tools | updated M     | retained K | new messages
```

Current memory maintenance asks what would still be needed with effective host instructions F, retained history K and normal working tools. Existing memory fills those gaps; later evidence in K helps determine which parts of B remain useful. The accepted [next extraction design](docs/EXTRACTION.md) makes active-task focus and continuation coverage explicit and protects declared necessary items during budget selection; it is not implemented yet.

## Status

**Core, manual M, Context observation, compact footer and Slots/Context overlay implemented; manual UI acceptance pending** · Updated 2026-09-08.

The original core delivery and subsequent native/cooperative compatibility work have completed acceptance recorded in the managed plan. Later capacity-planning and command improvements are also in the tree; those historical acceptance records do not claim a fresh full acceptance of every later revision. Pi retains native compaction, persistence, model selection and transport, with Nunc request-capacity checks.

Manual M-only edits persist through native session entries and restore along the selected path. The typed Context layout/observation surface feeds the compact footer and the Slots/Context overlay in the [accepted UI design](docs/UI.md). IME candidate-window placement, real-window resize and theme appearance still need manual confirmation; CJK injection does not prove those observations.

## Scope

- An independent Pi extension; no Codex CLI/App integration, replacement launcher, core patch or dependency on another extension.
- One continuing session, with same-session resume through Pi's existing JSONL.
- All current memory is included automatically; no proactive memory search.
- No automatic cross-session memory, memory database or document-writing service.
- Ordinary turns perform normal work without memory-tool requirements or usage counters.
- One normal maintenance request at rollover, using the main agent's current model.
- Pi retains the full session log; Nunc does not automatically retrieve retired history.

Long-term work belongs in normal code, documents and other external artifacts. Forgetting controls the working context; preserving every historical detail is not the product goal.

## Design choices

**Extract from delivered history.** Maintenance freezes the current active path and sees complete M, B and K together. Messages delivered later remain verbatim input to subsequent requests; they are not predicted, consumed early or replayed. This follows Pi's native timing, at the cost of not using those later messages to guide the current memory selection.

**Keep continuity.** Recent work remains verbatim in K. Unchanged memory slots retain their text. Local correction, replacement and merging remain possible; obsolete text does not gain protection merely by surviving earlier rollovers.

**Roll in batches.** A configurable working threshold and retained-history target control context size and maintenance frequency. Pi's lifecycle handles triggering and persistence; its default threshold is not a fixed product choice.

**Check each request separately.** New input can exceed the space left by earlier maintenance. A queue-preserving admission check rejects requests exceeding supported main input capacity or an explicit input limit, while Pi owns native compaction/retry. Crossing Nunc's softer memory-planning target alone does not reject a main request. See [capacity ownership and host limitations](docs/CAPACITY.md). It does not replay user input, turn user cancellation into capacity recovery, or use the TUI stop action to withdraw queued instructions. Oversized indivisible input and unsupported accounting receive explicit diagnostics.

**Let the model judge content.** The model proposes changes and retention choices. Code validates references, enforces token budgets and preserves complete slots. The next policy requires task-focus and continuation-dimension checks while leaving slot organization flexible. Required-item retention needs an engine change; a prompt or priority order alone does not guarantee it. No weight language or routine whole-memory rewrite is introduced.

**Keep tool evidence.** Ordinary requests retain active tool-result bodies. Maintenance uses the complete source available at its frozen delivered-history boundary, with explicit extraction-only reduction when capacity requires it. Cache reuse depends on the actual request prefix and provider behavior.

**Submit one maintenance snapshot.** Nunc validates a complete memory snapshot and retained boundary before handing them to Pi. Failure or cancellation before handoff leaves the saved state unchanged. Once handed over, persistence, context rebuilding and their error handling belong to Pi. The implemented UI saves manual M-only revisions through native session entries, without changing K; revisions not yet folded into a compaction require the new Nunc extension to take effect.

## Pi defaults and verification

Nunc uses Pi's current effective model/provider/options and native authentication, including startup flags and runtime selection. It does not select another account, copy credentials or manage OAuth. Main output/thinking settings remain unchanged; APIs without a serialized output cap use planning headroom; consumption authorization remains separate. Unknown subscription billing remains unknown.

Verification isolates new task sessions, cwd/files and artifacts while reusing native configuration/authentication ownership. Only named test requirements justify invocation-local overrides, recorded with their reason and differences. Standalone startup resolves Pi defaults; an invoking runtime must forward its nonsecret effective selection through public context/invocation facilities to preserve unsaved choices. A separate process cannot discover those choices implicitly. Saved defaults and daily sessions remain protected; Pi owns ordinary credential refresh and persistence.

See [extension usage](docs/PI.md), [bounded observations](docs/LIVE.md) and [development checks](docs/DEVELOPMENT.md). Producer tests use fictional native profiles and controlled services. Reuse applicable completed evidence; new UI mechanics require their own native-host checks, without automatically repeating paid model observations.

## Delivery and acceptance

Implementation may proceed incrementally. Final acceptance applies to the integrated project and every necessary requirement in the design: rolling and memory behavior, capacity handling, failure and cancellation, Pi persistence, same-session recovery and compatibility. A working happy path or earlier component checks alone do not establish completion.

Acceptance requires a complete regression of the final integrated version, observed behavior in the selected real Pi host, authorized real-model evidence for rollover and continued work, and a per-requirement delivery judgment. This includes actual TUI queue/cancellation behavior, request admission with native recovery, repeated overlapping rollovers, and session/path/model changes. RPC probes do not substitute for TUI behavior. Missing required behavior or evidence keeps acceptance incomplete. Existing full-delivery authorization covers bounded real verification; execution binds the new task target and call/token/time/known-cost limits without another approval ceremony.

Historical core acceptance did not require benchmark superiority. The next extraction acceptance additionally compares native Pi, current Nunc and new Nunc under defaults and matched budgets; missing native-retained, continuation-relevant information counts as regression. No such comparative result has been established yet. The bounded session/platform scope remains unchanged.

## Documentation

- [Complete design and final acceptance requirements](docs/DESIGN.md)
- [Accepted next extraction contract and native-comparison requirements](docs/EXTRACTION.md)
- [Accepted UI design: compact status, Slots management, Context layout](docs/UI.md)
- [Current extension commands and UI compatibility](docs/PI.md)

Configuration names, protocol examples, numeric starting points and module layout remain implementation choices. Equivalent implementations may satisfy the same behavior and boundaries; optional alternatives need not all be implemented.
