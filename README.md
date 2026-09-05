# Nunc

**A bounded, rolling present for Pi.**

Nunc is a design-stage Pi extension for continuing work within a finite context. It combines an overlapping window of recent verbatim history with bounded working-memory slots for the current session.

```text
Before rollover: host instructions/tools | memory M      | retiring B | retained K
After rollover:  host instructions/tools | updated M     | retained K | new messages
```

Memory maintenance asks: **If only the retained history K and normal working tools remained, what would the agent still need to continue this session?** Existing memory fills those gaps; later evidence in K helps determine which parts of B remain useful.

## Status

**DESIGN_ONLY — RECOMMENDED_DESIGN** · Updated 2026-09-05.

The current design makes explicit choices based on the intended workflow and mechanism reasoning. Nunc has no implementation or task benchmark yet.

## Scope

- Pi only; no Codex CLI/App integration.
- One continuing session, with same-session resume through Pi's existing JSONL.
- All current memory is included automatically; no proactive memory search.
- No automatic cross-session memory, memory database or document-writing service.
- Ordinary turns perform normal work without memory-tool requirements or usage counters.
- One normal maintenance request at rollover, using the main agent's current model.
- Pi retains the full session log; Nunc does not automatically retrieve retired history.

Long-term work belongs in normal code, documents and other external artifacts. Forgetting controls the working context; preserving every historical detail is not the product goal.

## Design choices

**Extract when history leaves.** Maintenance sees M, B and K together. Later progress can clarify which earlier hypotheses, constraints and results are still useful.

**Keep continuity.** Recent work remains verbatim in K. Unchanged memory slots retain their text. Local correction, replacement and merging remain possible; obsolete text does not gain protection merely by surviving earlier rollovers.

**Roll in batches.** A configurable working threshold and retained-history target control context size and maintenance frequency. Physical model capacity is a safety constraint. Pi's lifecycle handles triggering and persistence; its default threshold is not a fixed product choice.

**Let the model judge content.** The model proposes changes and retention choices. Code validates references, enforces token budgets and preserves complete slots. A stable policy can support mixed tasks without mandatory content categories or a weight language.

**Keep tool evidence.** Ordinary requests retain active tool-result bodies. Maintenance starts from the same complete source, with explicit input reduction only when capacity requires it. Cache reuse depends on the actual request prefix and provider behavior.

**Submit one snapshot.** Nunc validates a complete memory snapshot and retained boundary before handing them to Pi. Failure or cancellation before handoff leaves the saved state unchanged. Once handed over, persistence, context rebuilding and their error handling belong to Pi.

## Documentation

- [Complete design: motivation, rolling behavior, memory policy, budgets and Pi integration](docs/DESIGN.md)

Configuration names, protocol examples, numeric starting points and module layout remain implementation choices.
