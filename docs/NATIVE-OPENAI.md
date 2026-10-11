# Native OpenAI subscription routing and observations

Current relational-memory comparisons use `openai/gpt-6.1-sol`, API `openai-responses`, native **OpenAI (ChatGPT subscription)** OAuth, and explicit **medium** thinking on both main and maintenance requests. This follows the user's provider migration and subsequent medium-setting authorization. Historical `openai-codex`/`openai-codex-responses` observations and their minimal/low settings remain historical evidence; they are not same-configuration causal controls.

## Native ownership and thinking

Pi owns authentication resolution, normal OAuth refresh/storage and transport. Nunc reads the public synchronous `ModelRegistry.isUsingOAuth(model)` and provider `auth.oauth.isSubscription` metadata; it never reads, copies or logs a credential. A non-refreshing status check is available when authorized:

```sh
PI_OFFLINE=1 node /path/to/pi/dist/bundle/cli.js auth check --provider openai --json --no-refresh
```

Do not add `--credentials` or use credential-printing commands. The status check performs no model inference and does not prove a later request succeeds.

Stock session main requests use the effective thinking level. For raw Responses maintenance calls, Nunc passes the frozen current session level as `reasoningEffort` through `ModelRegistry.complete`; raw complete does not otherwise inherit session thinking. Unsupported requested levels fail explicitly. Changing thinking during extraction invalidates the candidate just like a model change. Other APIs retain their existing raw-maintenance options; this migration does not add provider-specific thinking mappings for them.

The Sol catalog supports low/medium/high/xhigh/max and does not support minimal/off. The current comparison protocol requires medium and must confirm actual session selection and serialized effort, rather than accepting a clamp. Native compaction retains Pi's own summarization lifecycle; no second summarizer or maintenance scheduler is introduced.

## Billing and output-cap observations

Provider `openai` supports both API keys and subscription OAuth. Provider/API identity alone cannot distinguish billing:

- Native OAuth plus a provider that declares subscription authentication makes actual USD billing unknown. Nunc maintenance observations use `usage.cost: null`; catalog prices or provider cost fields remain estimates, not a subscription invoice or zero charge.
- The metadata-only live preflight does not inspect authentication. Its OpenAI default is `maxCostUsd: null`. An explicit positive API-key cost ceiling remains selectable at preflight; actual subscription metadata causes the runtime budget gate to reject that ceiling before a reservation or transport.
- API-key requests keep their existing priced-reservation behavior. A null USD ceiling disables a USD guarantee without disabling finite call/token/time limits.
- Catalog reservation estimates remain separately recorded as `catalogReservationUsd`. The unchanged native model includes input/cache/output prices and any context-size pricing tiers; these do not establish actual subscription pricing.

The native Sign in with ChatGPT serializer omits `max_output_tokens`, while the same static API-key model may serialize that field. Nunc keeps the existing planning headroom and records a null wire cap for the actual subscription route, authorizing the native full model output capability. It does not invent a cap, alter model metadata, change the engine's accounting algorithms or claim a hard per-request output ceiling.

## Serialization and compatibility

Native `openai-responses` sends system/developer messages and user messages in `input`, with separate `function_call` and `function_call_output` items. The observation code now checks this real native shape, current M, tool names/arguments/results and `call_id` correspondence. Missing payloads, opaque IDs, non-text results and unsupported tool encodings remain unknown. A changed result or saved M disproves preservation; a literal `No result provided` string is not independently treated as synthetic data.

Legacy Codex keeps its subscription billing restriction and separate string `instructions` mapper. The mapper is deliberately not enabled for `openai-responses`, whose native system messages reside in `input`. Existing OpenAI API-key behavior, legacy transport, tool associations, persistence, cancellation, frozen cuts and current-M reserve remain intact. The change does not rename old fixtures or rewrite prior protocols/reports.

## Execution boundary

The migration delivers source, controlled native serializer/loader tests and new protocol preparation. It performs no real main or maintenance inference. After integration, the controller freezes the final migrated commit; the existing live owner then executes the unchanged three six-branch old/new comparisons followed by exactly one six-session MemoryArena comparison. All fresh arms use medium and the corrected provider/API. The historical semantic-policy baseline stays immutable; any necessary common mechanical compatibility patch must be identified separately and must not modify either arm's policy or inject answers.

Keep all original case inputs, hidden later questions/gold, group ordering, official tools/scorer, 16K pressure, q=0.5, elastic default memory, disabled memory tools and finite limits. Never tune after scoring or retry for a score. The selected same-session/early-pressure MemoryArena protocol does not represent the full upstream leaderboard or default 272K deployment. Actual proposals, saved M/K, requests, receipts, answers, costs, failures and final cleanup remain live obligations.
