import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Api, ApiStreamOptions, AssistantMessage, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { omitsSerializedOutputCap, observeUsage, requestTokens } from "../engine/accounting.js";
import type { UsageObservation } from "../engine/types.js";
import { canonical, object, requireValue, RunnerError, type Limits } from "./contract.js";

export interface CallRecord { kind: "reserve"; id: number; model: string; inputEstimate: number; outputCeiling: number; reservedTokens: number; reservedCostUsd: number | null; catalogReservationUsd?: number; at: number }
export interface CallEnd { kind: "terminal"; id: number; at: number; latencyMs: number; stopReason: string; usage: UsageObservation }
export type LedgerRecord = CallRecord | CallEnd;
export function readLedger(path: string): LedgerRecord[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  requireValue(!text || text.endsWith("\n"), "RECONCILIATION", "Incomplete ledger write; do not retry");
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line) as LedgerRecord) : [];
}
/** Reservations are never refunded. Missing usage or a killed request consumes its full reservation. */
export class BudgetLedger {
  private active = false;
  constructor(readonly path: string, readonly limits: Limits, readonly deadline: number, readonly signal: AbortSignal) {}
  reserve(model: Model<Api>, context: Context, outputCeiling: number): CallRecord {
    this.signal.throwIfAborted();
    requireValue(Date.now() < this.deadline, "TIME_LIMIT", "Run deadline reached");
    requireValue(!this.active, "CONCURRENCY", "Concurrent model calls are unsupported");
    requireValue(outputCeiling >= 16 && outputCeiling <= this.limits.maxOutputTokens && outputCeiling <= model.maxTokens && (!omitsSerializedOutputCap(model) || outputCeiling === model.maxTokens), "OUTPUT_LIMIT", "Request exceeds its output authorization");
    const inputEstimate = requestTokens(context);
    requireValue(inputEstimate + outputCeiling <= model.contextWindow, "INPUT_LIMIT", "Request estimate plus output exceeds model capacity");
    // Full-window reservation tolerates estimator error, cached tokens, and unavailable usage.
    const reservedTokens = model.contextWindow + outputCeiling;
    const rates = [model.cost, ...(model.cost.tiers ?? [])];
    const knownRates = rates.every(r => [r.input, r.output, r.cacheRead, r.cacheWrite].every(n => Number.isFinite(n) && n >= 0)) && (this.limits.maxCostUsd !== null || rates.some(r => Math.max(r.input, r.output, r.cacheRead, r.cacheWrite) > 0));
    const catalogReservationUsd = knownRates ? Math.max(...rates.map(r => (model.contextWindow * Math.max(r.input, r.cacheRead, r.cacheWrite) + outputCeiling * r.output) / 1e6)) : undefined;
    const reservedCostUsd = this.limits.maxCostUsd === null ? null : catalogReservationUsd;
    requireValue(model.api !== "openai-codex-responses" || this.limits.maxCostUsd === null, "COST_LIMIT", "Subscription billing is unknown; bind token/call limits explicitly");
    requireValue(reservedCostUsd !== undefined, "COST_LIMIT", "Unknown pricing cannot establish a USD reservation");
    const records = readLedger(this.path), calls = records.filter((r): r is CallRecord => r.kind === "reserve");
    const terminals = records.filter((r): r is CallEnd => r.kind === "terminal");
    const ended = new Set(terminals.map(r => r.id));
    requireValue(terminals.every(r => r.stopReason === "stop" || r.stopReason === "toolUse"), "TERMINAL_FAILURE", "Earlier request failed or truncated; no retries or further effects allowed");
    requireValue(calls.every(r => ended.has(r.id)), "RECONCILIATION", "Earlier request has no terminal receipt; no further effects allowed");
    requireValue(calls.length < this.limits.maxCalls, "CALL_LIMIT", "Call ceiling reached");
    requireValue(calls.reduce((n, r) => n + r.reservedTokens, 0) + reservedTokens <= this.limits.maxTotalTokens, "TOKEN_LIMIT", "Remaining token authorization cannot reserve another full request");
    if (this.limits.maxCostUsd !== null) requireValue(reservedCostUsd !== null && calls.every(r => r.reservedCostUsd !== null) && calls.reduce((n, r) => n + (r.reservedCostUsd ?? 0), 0) + reservedCostUsd <= this.limits.maxCostUsd, "COST_LIMIT", "Remaining cost authorization cannot reserve another full request");
    const record: CallRecord = { kind: "reserve", id: calls.length + 1, model: `${model.provider}/${model.id}`, inputEstimate, outputCeiling, reservedTokens, reservedCostUsd, ...(catalogReservationUsd === undefined ? {} : { catalogReservationUsd }), at: Date.now() };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600, flush: true }); this.active = true;
    return record;
  }
  finish(record: CallRecord, message: AssistantMessage): void {
    const usage = observeUsage(message.usage);
    requireValue((usage.contextInput === null || usage.contextInput <= record.reservedTokens - record.outputCeiling) && (usage.output === null || usage.output <= record.outputCeiling) && (usage.totalTokens === null || usage.totalTokens <= record.reservedTokens), "USAGE_LIMIT", "Observed usage exceeds the reserved native model allowance; retain and reconcile");
    if (record.reservedCostUsd === null) usage.cost = null;
    const terminal: CallEnd = { kind: "terminal", id: record.id, at: Date.now(), latencyMs: Date.now() - record.at, stopReason: message.stopReason, usage };
    appendFileSync(this.path, `${JSON.stringify(terminal)}\n`, { mode: 0o600, flush: true }); this.active = false;
  }
}
export function ledgerSummary(records: LedgerRecord[]) {
  const calls = records.filter((r): r is CallRecord => r.kind === "reserve");
  const terminal = records.filter((r): r is CallEnd => r.kind === "terminal");
  const ended = new Set(terminal.map(r => r.id));
  const sum = (key: keyof UsageObservation): number | null => terminal.length !== calls.length || terminal.some(r => r.usage[key] === null) ? null : terminal.reduce((n, r) => n + (r.usage[key] ?? 0), 0);
  return { calls: calls.length, reservedTokens: calls.reduce((n, r) => n + r.reservedTokens, 0), reservedCostUsd: calls.some(r => r.reservedCostUsd === null) ? null : calls.reduce((n, r) => n + (r.reservedCostUsd ?? 0), 0), catalogReservationUsd: calls.every(r => r.catalogReservationUsd !== undefined) ? calls.reduce((n, r) => n + (r.catalogReservationUsd ?? 0), 0) : null, input: sum("input"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), contextInput: sum("contextInput"), output: sum("output"), totalTokens: sum("totalTokens"), costUsd: sum("cost"), unreconciledCallIds: calls.filter(r => !ended.has(r.id)).map(r => r.id) };
}
function errorMessage(model: Model<Api>, reason: string): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: reason, timestamp: Date.now() };
}
function payloadOutputCeiling(body: Record<string, unknown>): unknown {
  if (typeof body.max_tokens === "number" || typeof body.max_output_tokens === "number" || typeof body.max_completion_tokens === "number") return body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens;
  return object(body.generationConfig) ? body.generationConfig.maxOutputTokens : undefined;
}
function assertAuthorizedDestination(baseUrl: string, requestUrl: string): void {
  requireValue(typeof baseUrl === "string" && baseUrl.trim().length > 0, "ENDPOINT", "Authorized model baseUrl is missing");
  let authorized: URL | undefined, url: URL | undefined;
  try { authorized = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`); } catch { /* named below */ }
  requireValue(authorized, "ENDPOINT", "Authorized model baseUrl is not an absolute URL");
  requireValue(!authorized.username && !authorized.password && !authorized.hash, "ENDPOINT", "Authorized model endpoint contains private URL data");
  try { url = new URL(requestUrl); } catch { /* named below */ }
  requireValue(url, "ENDPOINT", "Transport target is not an absolute URL");
  requireValue(!url.username && !url.password && !url.hash, "ENDPOINT", "Transport target contains private URL data");
  requireValue(url.origin === authorized.origin, "ENDPOINT", "Transport origin differs from authorized model baseUrl");
  const prefix = authorized.pathname.replace(/\/+$/, "") || "/";
  requireValue(prefix === "/" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`), "ENDPOINT", "Transport path is outside authorized model baseUrl");
}
/** Public provider decorator; the wrapped Pi adapter builds and sends the real HTTP request. */
export function boundedProvider(base: Provider, models: Model<Api>[], ledger: BudgetLedger, options: { controlled?: boolean; fetch?: typeof fetch; checkAuth?: (model: Model<Api>) => void; onContext?: (model: Model<Api>, context: Context, kind: "main" | "maintenance") => void } = {}): Provider {
  function stream(model: Model<Api>, context: Context, original: SimpleStreamOptions | ApiStreamOptions<Api> | undefined, simple: boolean): AssistantMessageEventStream {
    const output = new AssistantMessageEventStream();
    void (async () => {
      let reservation: CallRecord | undefined;
      try {
        const selected = models.find(m => m.id === model.id && m.provider === model.provider);
        requireValue(selected && ["id", "provider", "api", "baseUrl", "contextWindow", "maxTokens", "cost"].every(key => canonical(selected[key as keyof Model<Api>]) === canonical(model[key as keyof Model<Api>])), "MODEL", "Request changed its authorized model");
        options.checkAuth?.(model);
        const maxTokens = original?.maxTokens ?? model.maxTokens;
        requireValue(typeof model.baseUrl === "string" && model.baseUrl.trim().length > 0, "ENDPOINT", "Authorized model baseUrl is missing");
        reservation = ledger.reserve(model, context, maxTokens);
        // Agent tools also carry executable callbacks. Observe only the public model-facing Tool fields.
        options.onContext?.(model, structuredClone({ ...context, ...(context.tools ? { tools: context.tools.map(({ name, description, parameters, constrainedSampling }) => ({ name, description, parameters, ...(constrainedSampling === undefined ? {} : { constrainedSampling }) })) } : {}) }), simple ? "main" : "maintenance");
        const combined = AbortSignal.any([ledger.signal, ...(original?.signal ? [original.signal] : [])]);
        let sends = 0, payloadChecked = false;
        const onPayload = async (payload: unknown, selected: Model<Api>) => {
          const replacement = await original?.onPayload?.(payload, selected);
          const body = replacement === undefined ? payload : replacement;
          requireValue(object(body), "PAYLOAD", "Native payload is not a JSON object");
          requireValue(body.stream === true && body.background !== true, "PAYLOAD", "Native payload is not a single SSE request");
          if (Object.hasOwn(body, "model")) requireValue(body.model === model.id, "PAYLOAD", "Native payload model differs from authorization");
          const ceiling = payloadOutputCeiling(body);
          if (ceiling === undefined) requireValue(maxTokens === model.maxTokens, "PAYLOAD", "Payload omits an output cap; reserve the full native model.maxTokens allowance");
          else requireValue(typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0 && ceiling <= maxTokens, "PAYLOAD", "Native serialized output cap exceeds authorization");
          payloadChecked = true; return replacement;
        };
        const boundedFetch: typeof fetch = async (resource, init) => {
          combined.throwIfAborted();
          requireValue(++sends === 1, "CALL_LIMIT", "Transport retry or auxiliary request refused");
          const request = new Request(resource, init);
          requireValue(request.method === "POST", "ENDPOINT", "Transport method is outside authorization");
          assertAuthorizedDestination(model.baseUrl, request.url);
          // Codex compresses JSON after onPayload. Validate that public seam;
          // forward native compressed bytes unchanged, never invent an output cap.
          requireValue(payloadChecked, "PAYLOAD", "Native payload validation did not precede HTTP");
          return (options.fetch ?? original?.fetch ?? fetch)(request, { signal: AbortSignal.any([combined, request.signal]), redirect: "error" });
        };
        const bounded = { ...original, onPayload, maxRetries: 0, timeoutMs: Math.max(1, ledger.deadline - Date.now()), signal: combined, transport: "sse" as const, fetch: boundedFetch };
        // The two public entry points have distinct API-specific option unions; preserve the caller's entry point.
        const source = simple ? base.streamSimple(model, context, bounded as SimpleStreamOptions) : base.stream(model, context, bounded);
        let terminal: AssistantMessage | undefined;
        for await (const event of source) {
          if (event.type === "done") terminal = event.message;
          if (event.type === "error") terminal = event.error;
          if (terminal) {
            if (terminal.errorMessage) terminal.errorMessage = "Native provider request failed; inspect authorized host privately";
            requireValue(options.controlled || sends === 1, "TRANSPORT", "No bounded HTTP transport was observed");
            ledger.finish(reservation, terminal);
          }
          output.push(event);
        }
        requireValue(terminal, "RECONCILIATION", "Provider ended without a terminal event");
        output.end(terminal);
      } catch (error) {
        // Never copy provider exception bodies/headers (or credentials) into reports.
        const code = error instanceof RunnerError ? error.code : ledger.signal.aborted ? "CANCELLED" : "PROVIDER_ERROR";
        const message = errorMessage(model, `nunc live runner stopped: ${code}`);
        // Failure after reservation remains unresolved if a real request may have started.
        if (reservation && options.controlled) ledger.finish(reservation, message);
        output.push({ type: "error", reason: "error", error: message }); output.end(message);
      }
    })();
    return output;
  }
  return {
    ...base,
    getModels: () => base.getModels(),
    stream: (model, context, options) => stream(model, context, options, false),
    streamSimple: (model, context, options) => stream(model, context, options, true),
  };
}
