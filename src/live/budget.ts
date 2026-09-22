import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCurrentTools, type Api, type ApiStreamOptions, type AssistantMessage, type Context, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { omitsSerializedOutputCap, observeUsage, requestTokens } from "../engine/accounting.js";
import type { UsageObservation } from "../engine/types.js";
import { outputCapState } from "../pi/payload.js";
import { canonical, object, requireValue, RunnerError, type Limits, type RunInput } from "./contract.js";

export interface CallRecord { kind: "reserve"; id: number; model: string; inputEstimate: number; outputCeiling: number; reservedTokens: number; reservedCostUsd: number | null; catalogReservationUsd?: number; at: number; caseKey?: string }
export interface CallDiagnostic { code: string; stage: string; transport: "started" | "not-started" | "not-observed"; httpStatus?: number; networkCode?: string }
export interface CallEnd { kind: "terminal"; id: number; at: number; latencyMs: number; stopReason: string; usage: UsageObservation; diagnostic?: CallDiagnostic; caseKey?: string }
export type LedgerRecord = CallRecord | CallEnd;
export function readLedger(path: string): LedgerRecord[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  requireValue(!text || text.endsWith("\n"), "RECONCILIATION", "Incomplete ledger write; do not retry");
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line) as LedgerRecord) : [];
}
const LOCAL_GATE = new Set(["PREPARATION", "PAYLOAD", "ENDPOINT", "CALL_LIMIT", "MODEL", "AUTHORIZATION", "OUTPUT_LIMIT", "INPUT_LIMIT", "COST_LIMIT", "TOKEN_LIMIT", "TIME_LIMIT", "CONCURRENCY", "TERMINAL_FAILURE", "BILLING", "THINKING_UNAPPLIED"]);
const NETWORK_CODE = /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_[A-Z0-9_]{1,40}|AbortError|TimeoutError)$/;
function httpStatusOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
function networkCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const rec = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && NETWORK_CODE.test(rec.code)) return rec.code;
    if (typeof rec.name === "string" && (rec.name === "AbortError" || rec.name === "TimeoutError")) return rec.name;
    current = rec.cause;
  }
}
function describeFailure(code: string, observation: { wrapperEntries: number; transportStarted: boolean; httpStatus?: number; networkCode?: string }): CallDiagnostic & { message: string } {
  const transport = observation.transportStarted ? "started" as const : observation.wrapperEntries > 0 ? "not-started" as const : "not-observed" as const;
  const stage = observation.httpStatus === 200 ? "protocol" : observation.httpStatus !== undefined ? "http" : code === "PAYLOAD" ? "payload" : code === "ENDPOINT" ? "endpoint" : code === "THINKING_UNAPPLIED" ? "payload" : observation.transportStarted ? "transport" : LOCAL_GATE.has(code) ? "local" : "unknown";
  const diagnostic: CallDiagnostic = {
    code, stage, transport,
    ...(observation.httpStatus !== undefined ? { httpStatus: observation.httpStatus } : {}),
    ...(observation.networkCode && NETWORK_CODE.test(observation.networkCode) ? { networkCode: observation.networkCode } : {}),
  };
  const parts = [`nunc live stopped: ${code}`, `stage=${stage}`, `transport=${transport}`];
  if (diagnostic.httpStatus !== undefined) parts.push(`status=${diagnostic.httpStatus}`);
  if (diagnostic.networkCode) parts.push(`errno=${diagnostic.networkCode}`);
  return { ...diagnostic, message: parts.join("; ") };
}

/**
 * Compute the charged tokens for one call record.
 * Complete, trustworthy terminal actual usage settles and releases unused reserve.
 * Active, unknown, missing, interrupted, or untrusted usage remains covered worst-case.
 * Duplicate or inconsistent terminals cannot undercharge.
 */
export function callChargedTokens(r: CallRecord, terminals: CallEnd[] | undefined): number {
  if (!terminals || terminals.length === 0) return r.reservedTokens;
  if (terminals.length > 1) {
    return Math.max(r.reservedTokens, ...terminals.map(t => typeof t.usage?.totalTokens === "number" && Number.isFinite(t.usage.totalTokens) ? t.usage.totalTokens : r.reservedTokens));
  }
  const t = terminals[0]!;
  const tokens = t.usage?.totalTokens;
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 && tokens <= r.reservedTokens &&
      (t.stopReason === "stop" || t.stopReason === "toolUse") && (!t.diagnostic || t.diagnostic.code === "OK")) {
    return tokens;
  }
  return r.reservedTokens;
}

/**
 * Compute the charged cost in USD for one call record.
 * Costs are independently known and enforced; unknown costs never settle to 0.
 * Token settlement does not imply known cost.
 * Duplicate or inconsistent terminals cannot undercharge.
 */
export function callChargedCost(r: CallRecord, terminals: CallEnd[] | undefined): number | null {
  const baseCost = r.reservedCostUsd;
  if (baseCost === null) return null;
  if (!terminals || terminals.length === 0) return baseCost;
  if (terminals.length > 1) {
    return Math.max(baseCost, ...terminals.map(t => typeof t.usage?.cost === "number" && Number.isFinite(t.usage.cost) ? t.usage.cost : baseCost));
  }
  const t = terminals[0]!;
  const cost = t.usage?.cost;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= baseCost &&
      (t.stopReason === "stop" || t.stopReason === "toolUse") && (!t.diagnostic || t.diagnostic.code === "OK")) {
    return cost;
  }
  return baseCost;
}

/**
 * Resolve batch timing and prior ledgers across invocations.
 * Uses caller-supplied authority or earliest dispatch timestamp from prior records.
 * Expired authorization refuses before transport.
 */
export function resolveBatchContext(input: RunInput): {
  priorLedgerPaths: string[];
  firstDispatchAt: number | null;
  deadline: number;
} {
  const lim = input.limits as any;
  const rawPaths: string[] = [
    ...(input.batch?.priorLedgers ?? []),
    ...(input.authority?.priorLedgers ?? []),
    ...(lim?.priorLedgers ?? []),
    ...(input.batch?.sharedLedger ? [input.batch.sharedLedger] : []),
    ...(input.authority?.sharedLedger ? [input.authority.sharedLedger] : []),
    ...(lim?.sharedLedger ? [lim.sharedLedger] : []),
  ];
  const priorLedgerPaths = [...new Set(rawPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0))];
  const priorRecords = priorLedgerPaths.flatMap(p => existsSync(p) ? readLedger(p) : []);
  const firstPriorCall = priorRecords.find(r => r.kind === "reserve");

  const explicitFirst = input.batch?.firstDispatchAt ?? input.authority?.firstDispatchAt ?? lim?.firstDispatchAt;
  const firstDispatchAt = explicitFirst !== undefined
    ? (typeof explicitFirst === "string" ? new Date(explicitFirst).getTime() : explicitFirst)
    : (firstPriorCall?.at ?? null);

  const explicitDeadline = input.batch?.deadline ?? input.authority?.deadline ?? lim?.deadline;
  const parsedExplicit = explicitDeadline !== undefined
    ? (typeof explicitDeadline === "string" ? new Date(explicitDeadline).getTime() : explicitDeadline)
    : undefined;

  const origin = firstDispatchAt ?? Date.now();
  const calculatedDeadline = origin + input.limits.maxDurationMs;
  const deadline = parsedExplicit !== undefined
    ? Math.min(parsedExplicit, calculatedDeadline)
    : calculatedDeadline;

  return { priorLedgerPaths, firstDispatchAt, deadline };
}

/** Reservations are settled by trustworthy terminal actual usage. Missing usage or killed requests consume full reservation. */
export class BudgetLedger {
  private active = false;
  constructor(readonly path: string, readonly limits: Limits, readonly deadline: number, readonly signal: AbortSignal, readonly caseKey?: string, readonly priorLedgerPaths: string[] = []) {}

  readAllRecords(): LedgerRecord[] {
    const seen = new Set<string>();
    const records: LedgerRecord[] = [];
    for (const p of [...this.priorLedgerPaths, this.path]) {
      const canonicalPath = resolve(p);
      if (seen.has(canonicalPath)) continue;
      seen.add(canonicalPath);
      if (existsSync(p)) records.push(...readLedger(p));
    }
    return records;
  }

  reserve(model: Model<Api>, context: Context | TranscriptContext, outputCeiling: number): CallRecord {
    this.signal.throwIfAborted();
    requireValue(Date.now() < this.deadline, "TIME_LIMIT", "Run deadline reached");
    requireValue(!this.active, "CONCURRENCY", "Concurrent model calls are unsupported");
    requireValue(outputCeiling >= 16 && outputCeiling <= this.limits.maxOutputTokens && outputCeiling <= model.maxTokens && (!omitsSerializedOutputCap(model) || outputCeiling === model.maxTokens), "OUTPUT_LIMIT", "Request exceeds its output authorization");
    const inputEstimate = requestTokens(context);
    // Product admission owns input headroom; native serializers clamp wire output.
    // Reservation charge is window+authorized output, not simultaneous occupancy.
    const outputFloor = omitsSerializedOutputCap(model) ? 1 : ["openai-responses", "azure-openai-responses"].includes(model.api) ? 16 : 1;
    requireValue(inputEstimate + outputFloor <= model.contextWindow, "INPUT_LIMIT", "Request estimate exceeds model input capacity");
    const reservedTokens = model.contextWindow + outputCeiling;
    const rates = [model.cost, ...(model.cost.tiers ?? [])];
    const knownRates = rates.every(r => [r.input, r.output, r.cacheRead, r.cacheWrite].every(n => Number.isFinite(n) && n >= 0)) && (this.limits.maxCostUsd !== null || rates.some(r => Math.max(r.input, r.output, r.cacheRead, r.cacheWrite) > 0));
    const catalogReservationUsd = knownRates ? Math.max(...rates.map(r => (model.contextWindow * Math.max(r.input, r.cacheRead, r.cacheWrite) + outputCeiling * r.output) / 1e6)) : undefined;
    const reservedCostUsd = this.limits.maxCostUsd === null ? null : catalogReservationUsd;
    requireValue(model.api !== "openai-codex-responses" || this.limits.maxCostUsd === null, "COST_LIMIT", "Subscription billing is unknown; maxCostUsd must be null");
    requireValue(reservedCostUsd !== undefined, "COST_LIMIT", "Unknown pricing cannot establish a USD reservation");
    const records = this.readAllRecords(), calls = records.filter((r): r is CallRecord => r.kind === "reserve");
    const terminals = records.filter((r): r is CallEnd => r.kind === "terminal");
    const ended = new Set(terminals.map(r => r.id));
    const sameCase = new Set(calls.filter(r => (r.caseKey ?? "") === (this.caseKey ?? "")).map(r => r.id));
    requireValue(terminals.filter(r => sameCase.has(r.id)).every(r => r.stopReason === "stop" || r.stopReason === "toolUse"), "TERMINAL_FAILURE", "Earlier request in this scenario failed or truncated; no retries or further effects allowed");
    requireValue(calls.every(r => ended.has(r.id)), "RECONCILIATION", "Earlier request has no terminal receipt; no further effects allowed");
    if (this.limits.maxCalls !== null) requireValue(calls.length < this.limits.maxCalls, "CALL_LIMIT", "Call ceiling reached");

    const terminalsById = new Map<number, CallEnd[]>();
    for (const t of terminals) {
      const list = terminalsById.get(t.id) ?? [];
      list.push(t);
      terminalsById.set(t.id, list);
    }

    const chargedTokens = calls.reduce((n, r) => n + callChargedTokens(r, terminalsById.get(r.id)), 0);
    if (this.limits.maxTotalTokens !== null) {
      requireValue(chargedTokens + reservedTokens <= this.limits.maxTotalTokens, "TOKEN_LIMIT", "Remaining token authorization cannot reserve another full request");
    }

    if (this.limits.maxCostUsd !== null) {
      requireValue(reservedCostUsd !== null && calls.every(r => r.reservedCostUsd !== null), "COST_LIMIT", "Unknown pricing cannot establish a USD reservation");
      const chargedCostUsd = calls.reduce((n, r) => n + (callChargedCost(r, terminalsById.get(r.id)) ?? 0), 0);
      requireValue(chargedCostUsd + reservedCostUsd <= this.limits.maxCostUsd, "COST_LIMIT", "Remaining cost authorization cannot reserve another full request");
    }

    const record: CallRecord = { kind: "reserve", id: calls.length + 1, model: `${model.provider}/${model.id}`, inputEstimate, outputCeiling, reservedTokens, reservedCostUsd, ...(catalogReservationUsd === undefined ? {} : { catalogReservationUsd }), at: Date.now(), ...(this.caseKey ? { caseKey: this.caseKey } : {}) };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600, flush: true }); this.active = true;
    return record;
  }
  finish(record: CallRecord, message: AssistantMessage, diagnostic?: CallDiagnostic): void {
    const usage = observeUsage(message.usage);
    requireValue((usage.contextInput === null || usage.contextInput <= record.reservedTokens - record.outputCeiling) && (usage.output === null || usage.output <= record.outputCeiling) && (usage.totalTokens === null || usage.totalTokens <= record.reservedTokens), "USAGE_LIMIT", "Observed usage exceeds the reserved native model allowance; retain and reconcile");
    if (record.reservedCostUsd === null) usage.cost = null;
    const terminal: CallEnd = { kind: "terminal", id: record.id, at: Date.now(), latencyMs: Date.now() - record.at, stopReason: message.stopReason, usage, ...(record.caseKey ? { caseKey: record.caseKey } : {}), ...(diagnostic ? { diagnostic } : {}) };
    appendFileSync(this.path, `${JSON.stringify(terminal)}\n`, { mode: 0o600, flush: true }); this.active = false;
  }
}
export function ledgerSummary(records: LedgerRecord[], limits?: Limits) {
  const calls = records.filter((r): r is CallRecord => r.kind === "reserve");
  const terminal = records.filter((r): r is CallEnd => r.kind === "terminal");
  const ended = new Set(terminal.map(r => r.id));
  const terminalsById = new Map<number, CallEnd[]>();
  for (const t of terminal) {
    const list = terminalsById.get(t.id) ?? [];
    list.push(t);
    terminalsById.set(t.id, list);
  }
  const sum = (key: keyof UsageObservation): number | null => terminal.length !== calls.length || terminal.some(r => r.usage[key] === null) ? null : terminal.reduce((n, r) => n + (r.usage[key] ?? 0), 0);

  const reservedTokens = calls.reduce((n, r) => n + r.reservedTokens, 0);
  const chargedTokens = calls.reduce((n, r) => n + callChargedTokens(r, terminalsById.get(r.id)), 0);
  const reservedCostUsd = calls.some(r => r.reservedCostUsd === null) ? null : calls.reduce((n, r) => n + (r.reservedCostUsd ?? 0), 0);
  const chargedCostUsd = calls.some(r => r.reservedCostUsd === null) ? null : calls.reduce((n, r) => n + (callChargedCost(r, terminalsById.get(r.id)) ?? 0), 0);
  const catalogReservationUsd = calls.every(r => r.catalogReservationUsd !== undefined) ? calls.reduce((n, r) => n + (r.catalogReservationUsd ?? 0), 0) : null;

  const actualTokens = sum("totalTokens");
  const actualCostUsd = sum("cost");

  const activeCalls = calls.filter(r => !ended.has(r.id));
  const activeReservedTokens = activeCalls.reduce((n, r) => n + r.reservedTokens, 0);
  const activeReservedCostUsd = activeCalls.some(r => r.reservedCostUsd === null) ? null : activeCalls.reduce((n, r) => n + (r.reservedCostUsd ?? 0), 0);

  const remainingCalls = limits?.maxCalls !== null && limits?.maxCalls !== undefined ? Math.max(0, limits.maxCalls - calls.length) : null;
  const remainingTokens = limits?.maxTotalTokens !== null && limits?.maxTotalTokens !== undefined ? Math.max(0, limits.maxTotalTokens - chargedTokens) : null;
  const remainingCostUsd = limits?.maxCostUsd !== null && limits?.maxCostUsd !== undefined && chargedCostUsd !== null ? Math.max(0, limits.maxCostUsd - chargedCostUsd) : null;

  return {
    calls: calls.length,
    reservedTokens,
    chargedTokens,
    actualTokens,
    reservedCostUsd,
    chargedCostUsd,
    actualCostUsd,
    activeReservedTokens,
    activeReservedCostUsd,
    catalogReservationUsd,
    input: sum("input"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    contextInput: sum("contextInput"),
    output: sum("output"),
    totalTokens: actualTokens,
    costUsd: actualCostUsd,
    remainingCalls,
    remainingTokens,
    remainingCostUsd,
    unreconciledCallIds: activeCalls.map(r => r.id),
  };
}
function errorMessage(model: Model<Api>, reason: string): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: reason, timestamp: Date.now() };
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
export function boundedProvider(base: Provider, models: Model<Api>[], ledger: BudgetLedger, options: { controlled?: boolean; capturePayload?: boolean; fetch?: typeof fetch; checkAuth?: (model: Model<Api>) => void; onContext?: (model: Model<Api>, context: Context, kind: "main" | "maintenance") => void; onResponse?: (model: Model<Api>, message: AssistantMessage, kind: "main" | "maintenance") => void; beforeRequest?: () => void; classify?: (simple: boolean) => "main" | "maintenance"; onRequest?: (data: { callId: number; kind: "main" | "maintenance"; model: Model<Api>; outputPlanning: number | null; reasoning: unknown; context: Context }) => void; onPayload?: (data: { callId: number; cap: ReturnType<typeof outputCapState>; finalPayload?: unknown }) => void; effectiveThinking?: string | undefined; maintenanceThinking?: string | undefined; requireThinkingLevel?: string | undefined } = {}): Provider {
  function stream(model: Model<Api>, context: Context | TranscriptContext, original: SimpleStreamOptions | ApiStreamOptions<Api> | undefined, simple: boolean): AssistantMessageEventStream {
    const output = new AssistantMessageEventStream();
    const kind = options.classify?.(simple) ?? (simple ? "main" : "maintenance");
    void (async () => {
      let reservation: CallRecord | undefined, finished = false, ended = false;
      let wrapperEntries = 0, transportStarted = false, payloadChecked = false, localCode: string | undefined;
      let httpStatus: number | undefined, net: string | undefined;
      const snapshot = () => ({ wrapperEntries, transportStarted, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(net ? { networkCode: net } : {}) });
      const complete = (message: AssistantMessage, diagnostic?: CallDiagnostic) => {
        if (finished || !reservation) return;
        ledger.finish(reservation, message, diagnostic); finished = true;
        options.onResponse?.(model, message, kind);
      };
      try {
        options.beforeRequest?.(); // A failed boundary must stop before reservation and transport.
        const selected = models.find(m => m.id === model.id && m.provider === model.provider);
        requireValue(selected && ["id", "provider", "api", "baseUrl", "contextWindow", "maxTokens", "cost"].every(key => canonical(selected[key as keyof Model<Api>]) === canonical(model[key as keyof Model<Api>])), "MODEL", "Request changed its authorized model");
        options.checkAuth?.(model);
        if (options.requireThinkingLevel && options.requireThinkingLevel !== "off") {
          requireValue(selected.reasoning === true, "THINKING_UNAPPLIED", `Model ${selected.id} does not support reasoning/thinking, but thinking level "${options.requireThinkingLevel}" was required.`);
        }
        // Planning values on uncapped APIs cannot lower consumption authorization.
        const maxTokens = omitsSerializedOutputCap(model) ? model.maxTokens : original?.maxTokens ?? model.maxTokens;
        requireValue(typeof model.baseUrl === "string" && model.baseUrl.trim().length > 0, "ENDPOINT", "Authorized model baseUrl is missing");
        reservation = ledger.reserve(model, context, maxTokens);
        // Agent tools also carry executable callbacks. Observe only the public model-facing Tool fields.
        const activeTools = ("tools" in context && Array.isArray(context.tools)) ? context.tools : getCurrentTools(context.messages);
        options.onContext?.(model, structuredClone({ ...context, tools: activeTools.map(({ name, description, parameters, constrainedSampling }) => ({ name, description, parameters, ...(constrainedSampling === undefined ? {} : { constrainedSampling }) })) }), kind);
        options.onRequest?.({ callId: reservation.id, kind, model,
          outputPlanning: original?.maxTokens ?? null, reasoning: (original as SimpleStreamOptions | undefined)?.reasoning ?? null,
          context: { ...context, tools: activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })) } });
        const combined = AbortSignal.any([ledger.signal, ...(original?.signal ? [original.signal] : [])]);
        const onPayload = async (payload: unknown, selected: Model<Api>) => {
          const replacement = await original?.onPayload?.(payload, selected);
          try {
            const body = replacement === undefined ? payload : replacement;
            requireValue(object(body), "PAYLOAD", "Native payload is not a JSON object");
            requireValue(body.stream === true && body.background !== true, "PAYLOAD", "Native payload is not a single SSE request");
            if (Object.hasOwn(body, "model") || options.requireThinkingLevel) requireValue(body.model === model.id, "PAYLOAD", "Native payload model differs from authorization");
            const caps = outputCapState(body);
            requireValue(caps.kind !== "invalid" && caps.kind !== "conflict", "PAYLOAD", "Native serialized output cap is invalid");
            if (caps.kind === "missing") requireValue(maxTokens === model.maxTokens, "PAYLOAD", "Payload omits an output cap; reserve the full native model.maxTokens allowance");
            else requireValue(caps.value > 0 && caps.value <= maxTokens, "PAYLOAD", "Native serialized output cap exceeds authorization");
            if (options.requireThinkingLevel) {
              let payloadEffort: string | undefined;
              if (object(body.reasoning) && typeof (body.reasoning as any).effort === "string") {
                payloadEffort = (body.reasoning as any).effort;
              } else if (typeof (body as any).reasoning_effort === "string") {
                payloadEffort = (body as any).reasoning_effort;
              }
              const expectedEffort = options.requireThinkingLevel;
              if (expectedEffort !== undefined && expectedEffort !== "off") {
                requireValue(payloadEffort === expectedEffort, "THINKING_UNAPPLIED", `${kind} request payload for ${selected.id} does not apply required thinking level "${expectedEffort}"; observed "${payloadEffort ?? "none"}"`);
              } else if (kind === "maintenance" && options.requireThinkingLevel !== "off" && !options.maintenanceThinking) {
                if (payloadEffort !== options.requireThinkingLevel) {
                  throw new RunnerError("THINKING_UNAPPLIED", `Maintenance request payload for ${selected.id} does not apply specified thinking level "${options.requireThinkingLevel}"; observed "${payloadEffort ?? "none"}". Raw maintenance defaults to effort none; apply maintenance-thinking override for isolated observation.`);
                }
              }
            }
            options.onPayload?.({ callId: reservation!.id, cap: caps, ...(options.capturePayload ? { finalPayload: structuredClone(body) } : {}) });
            payloadChecked = true; return replacement;
          } catch (error) { if (error instanceof RunnerError) localCode = error.code; throw error; }
        };
        const boundedFetch: typeof fetch = async (resource, init) => {
          combined.throwIfAborted();
          let request: Request;
          try {
            requireValue(++wrapperEntries === 1, "CALL_LIMIT", "Transport retry or auxiliary request refused");
            request = new Request(resource, init);
            requireValue(request.method === "POST", "ENDPOINT", "Transport method is outside authorization");
            assertAuthorizedDestination(model.baseUrl, request.url);
            // Codex compresses JSON after onPayload. Validate that public seam;
            // forward native compressed bytes unchanged, never invent an output cap.
            requireValue(payloadChecked, "PAYLOAD", "Native payload validation did not precede HTTP");
          } catch (error) { if (error instanceof RunnerError) localCode = error.code; throw error; }
          transportStarted = true;
          try {
            const response = await (options.fetch ?? original?.fetch ?? fetch)(request, { signal: AbortSignal.any([combined, request.signal]), redirect: "error" });
            httpStatus = httpStatusOf(response.status);
            return response;
          } catch (error) {
            net = networkCode(error);
            throw error;
          }
        };
        const bounded: Record<string, unknown> = { ...original, onPayload, maxRetries: 0, timeoutMs: Math.max(1, ledger.deadline - Date.now()), signal: combined, transport: "sse" as const, fetch: boundedFetch };
        if (kind === "maintenance" && options.maintenanceThinking) {
          bounded.reasoningEffort = options.maintenanceThinking;
          bounded.reasoning = options.maintenanceThinking;
        }
        // The two public entry points have distinct API-specific option unions; preserve the caller's entry point.
        // Historical comparison targets own their older Context API. Do not
        // normalize their input with the candidate's library before delegation.
        const source = simple ? base.streamSimple(model, context as TranscriptContext, bounded as SimpleStreamOptions) : base.stream(model, context as TranscriptContext, bounded);
        let terminal: AssistantMessage | undefined;
        for await (const event of source) {
          if (event.type === "done") terminal = event.message;
          if (event.type === "error") terminal = event.error;
          if (terminal) {
            const failed = terminal.stopReason === "error" || terminal.stopReason === "aborted" || Boolean(terminal.errorMessage);
            if (failed) {
              delete terminal.diagnostics;
              const code = localCode ?? (terminal.stopReason === "aborted" || ledger.signal.aborted ? "CANCELLED" : httpStatus === 200 ? "PROVIDER_PROTOCOL" : httpStatus !== undefined ? "PROVIDER_HTTP" : transportStarted ? (net ? "NETWORK" : "PROVIDER_ERROR") : "PROVIDER_ERROR");
              const info = describeFailure(code, snapshot());
              terminal.errorMessage = info.message;
              if (options.controlled || transportStarted || (localCode && !transportStarted)) complete(terminal, info);
            } else {
              requireValue(options.controlled || transportStarted, "TRANSPORT", "No bounded HTTP transport was observed");
              complete(terminal);
            }
          }
          output.push(event);
        }
        requireValue(terminal, "RECONCILIATION", "Provider ended without a terminal event");
        ended = true; output.end(terminal);
      } catch (error) {
        const aborted = ledger.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
        const code = error instanceof RunnerError ? error.code : aborted ? "CANCELLED" : net ? "NETWORK" : "PROVIDER_ERROR";
        const info = describeFailure(code, snapshot());
        const message = errorMessage(model, info.message);
        const provenLocal = !transportStarted && (Boolean(localCode) || error instanceof RunnerError && LOCAL_GATE.has(error.code));
        if (provenLocal || (options.controlled && !transportStarted)) complete(message, info);
        if (!ended) { ended = true; output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message }); output.end(message); }
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
