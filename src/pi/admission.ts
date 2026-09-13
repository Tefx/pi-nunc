import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Complete, EngineConfig, Memory } from "../engine/index.js";
import { admissionEstimate, inputLimit, mainAdmissionLimit, memoryTokens, messageTokens, omitsSerializedOutputCap, requestTokens, textTokens } from "../engine/accounting.js";
import { EngineError, integer, legalCuts, record } from "../engine/validation.js";
import { authorizePayload, classifyPayloadChange, codexSystemInstructionRewrite, jsonView, lastUserTextAppend, outputCapState, payloadMode, type PayloadObservation } from "./payload.js";

type Installation = { wrapper: Provider; original?: Provider; legacy?: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>> };
type CallRecord = {
  context: Context;
  effectiveContext?: Context | undefined;
  model: Model<Api>;
  signal: AbortSignal | undefined;
  simple: boolean;
  seen: WeakSet<Provider>;
};
interface MainReceipt {
  model: Model<Api>;
  systemPrompt: string | undefined;
  tools: unknown;
  rMessages: unknown;
  rCount: number;
  mTokens: number;
  hasM: boolean;
  response: unknown;
}
interface MainSnapshot {
  model: Model<Api>;
  systemPrompt: string | undefined;
  tools: unknown;
  rMessages: unknown;
  rCount: number;
  mTokens: number;
  hasM: boolean;
  generation: number;
  payloadBound: boolean;
}
/** In-process bound for completed receipts; not a call or token cap. */
const MAIN_RECEIPT_LIMIT = 8;
export const LARVA_RESOLVE_SYSTEM_PROMPT_EVENT = "larva:resolve-system-prompt:v1";
export type SystemPromptResolutionStatus = "resolved" | "legacy-no-reply" | "unavailable" | "protocol-error";
export type ResolveSystemPromptResult =
  | { status: "ok"; systemPrompt: string }
  | { status: "unavailable"; reason: string };
export type ResolveSystemPromptRequest = {
  scope: "main";
  systemPrompt: string;
  reply: (result: ResolveSystemPromptResult) => void;
};
export type AdmissionEstimateReason = "matching-receipt" | "no-receipt" | "model-mismatch" | "system-mismatch" | "tools-mismatch" | "messages-mismatch" | "payload-unbound" | "usage-unusable" | "lifecycle-reset";
export interface ReceiptBreakdown {
  observedU: number;
  deltaRTokens: number;
  currentMTokens: number;
  retainedOldMMargin: boolean;
  oldMTokensEstimate?: number;
}
export interface RequestProjectionBinding {
  sessionId: string;
  signal: AbortSignal | undefined;
  model: Model<Api>;
  messages: Context["messages"];
  /** Messages whose object identity survives Pi's public conversion. */
  identityMessages?: readonly object[];
  memory: Memory;
  memoryIndex?: number;
}
type BoundProjection = RequestProjectionBinding & { key: object; identities: ReadonlySet<object>; convertedSnapshots: unknown[]; carrierSnapshot: unknown; memoryIndex?: number };
function withoutIndex<T>(items: readonly T[], index: number | undefined): T[] {
  if (index === undefined) return [...items];
  return items.filter((_, i) => i !== index);
}
function carrierMatches(messages: Context["messages"], binding: BoundProjection): boolean {
  if (!binding.memory.slots.length) return true;
  const index = binding.memoryIndex;
  if (index === undefined || index < 0 || index >= messages.length) return false;
  return isDeepStrictEqual(jsonView(messages[index]), binding.carrierSnapshot);
}
export interface AdmissionObservation {
  kind: "main" | "maintenance" | "unknown";
  outcome: "delegate" | "reject";
  resolution?: SystemPromptResolutionStatus;
  inputTokens?: number;
  inputLimit?: number;
  plannedInputLimit?: number;
  inputExceededPlan?: boolean;
  outputTokens?: number;
  outputReserveTokens?: number;
  outputCapTokens?: number | null;
  estimator?: "pi-heuristic" | "pi-usage-backed";
  estimateReason?: AdmissionEstimateReason;
  hostPromptMatchesRequest?: boolean;
  anchorTrailingMessages?: number;
  receiptBreakdown?: ReceiptBreakdown;
  code?: string;
  payload?: PayloadObservation;
}
export interface AdmissionLayoutEvent {
  ctx: ExtensionContext;
  model: Model<Api>;
  context: Context;
  observation: AdmissionObservation;
  initialMetadataTokens?: number;
  projection?: { memory: Memory; rCount: number; memoryIndex?: number };
  payloadGrowth?: {
    grewTokens: number;
    inputGrewTokens: number;
    chargedTokens: number;
    append: boolean;
    addedTokens?: number;
    addedText?: string;
  };
}

/** Admission owns no session or queue mutations. Captured native transport owns I/O. */
export class Admission {
  private readonly maintenance = new AsyncLocalStorage<{ request: Parameters<Complete>[0]; used: boolean }>();
  /** One delegated request: same Context/model/signal/mode, each wrapper visited at most once as inner pass-through. */
  private readonly call = new AsyncLocalStorage<CallRecord>();
  private readonly installed = new Map<string, Installation>();
  private cancelledRun = false;
  private generation = 0;
  private receipts: MainReceipt[] = [];
  private activeProjections = new WeakMap<object, BoundProjection>();
  bindProjection(binding: RequestProjectionBinding): void {
    const identities = new Set(binding.identityMessages ?? binding.messages);
    const key = binding.messages.find(message => identities.has(message));
    if (!key) return; // No surviving object provenance: fresh accounting, no receipt.
    this.activeProjections.set(key, {
      ...binding, key, identities,
      convertedSnapshots: binding.messages.map(message => identities.has(message) ? undefined : jsonView(message)),
      model: structuredClone(binding.model),
      messages: [...binding.messages],
      memory: structuredClone(binding.memory),
      ...(binding.memoryIndex !== undefined ? { memoryIndex: binding.memoryIndex } : {}),
      carrierSnapshot: binding.memory.slots.length && binding.memoryIndex !== undefined ? jsonView(binding.messages[binding.memoryIndex]) : undefined,
    });
  }
  invalidateUsage(): void { this.receipts = []; this.generation++; this.activeProjections = new WeakMap(); }
  private takeProjection(ctx: ExtensionContext, model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined): BoundProjection | undefined {
    // Unknown/maintenance calls must never consume a prepared main projection.
    if (!ctx.signal || options?.signal !== ctx.signal || options.sessionId !== ctx.sessionManager.getSessionId()) return;
    const candidates = new Set(context.messages.flatMap(message => {
      const binding = this.activeProjections.get(message);
      return binding ? [binding] : [];
    }));
    if (candidates.size !== 1) return;
    const binding = [...candidates][0]!;
    if (binding.sessionId !== options.sessionId || binding.signal !== options.signal || !isDeepStrictEqual(binding.model, model)) return;
    if (!this.matchesProjection(context, binding)) return;
    this.activeProjections.delete(binding.key);
    // Identity proves origin; a separate snapshot comparison proves the delivered M.
    // A later context hook may have edited this very object before serialization.
    if (!carrierMatches(context.messages, binding)) return;
    return binding;
  }
  private matchesProjection(context: Context, binding: BoundProjection): boolean {
    // Known native objects establish provenance. Custom/bash/branch conversions
    // create new objects: validate their native mapping only AFTER that identity
    // match, never infer an association from their text or from a session key.
    return context.messages.length === binding.messages.length && context.messages.every((message, i) =>
      binding.identities.has(binding.messages[i]!) ? message === binding.messages[i]
        : isDeepStrictEqual(jsonView(message), binding.convertedSnapshots[i]));
  }
  private readonly rejected = new Map<string, AbortSignal>();
  constructor(private readonly pi: ExtensionAPI, private readonly config: (ctx: ExtensionContext, model: Model<Api>) => EngineConfig, private readonly onLayout?: (event: AdmissionLayoutEvent) => void) {}

  complete(call: Complete): Complete {
    return request => this.maintenance.run({ request, used: false }, () => call(request));
  }
  ensure(ctx: ExtensionContext): void {
    if (!ctx.model) return;
    const id = ctx.model.provider;
    const previous = this.installed.get(id);
    if (previous && ctx.modelRegistry.getRegisteredNativeProvider(id) === previous.wrapper) return;
    // Another public registration replaced us. Capture its current registration;
    // never restore a stale predecessor over a later owner's provider.
    const delegate = ctx.modelRegistry.getProvider(id);
    if (!delegate) throw new EngineError("CONFIG", `Provider unavailable: ${id}`);
    const original = ctx.modelRegistry.getRegisteredNativeProvider(id);
    const legacy = ctx.modelRegistry.getRegisteredProviderConfig(id);
    const wrapper: Provider = {
      ...delegate,
      stream: (model, context, options) => this.dispatch(ctx, wrapper, delegate, model, context, options, false, Boolean(legacy?.streamSimple)),
      streamSimple: (model, context, options) => this.dispatch(ctx, wrapper, delegate, model, context, options, true, Boolean(legacy?.streamSimple)),
    };
    this.installed.set(id, { wrapper, ...(original ? { original } : {}), ...(legacy ? { legacy } : {}) });
    this.pi.registerProvider(wrapper);
  }
  close(ctx: ExtensionContext): void {
    for (const [id, entry] of this.installed) {
      if (ctx.modelRegistry.getRegisteredNativeProvider(id) !== entry.wrapper) continue;
      if (entry.original) this.pi.registerProvider(entry.original);
      else if (entry.legacy) { this.pi.unregisterProvider(id); this.pi.registerProvider(id, entry.legacy); }
      else this.pi.unregisterProvider(id);
    }
    this.installed.clear(); this.rejected.clear(); this.cancelledRun = false; this.invalidateUsage();
  }
  /** Only errors constructed here are candidates for cancellation precedence. */
  finalized(message: AssistantMessage): AssistantMessage | undefined {
    const key = message.errorMessage;
    if (!key) return;
    const signal = this.rejected.get(key) ?? [...this.rejected.entries()].find(([stored]) => key.includes(stored))?.[1];
    if (!signal) return;
    if (signal.aborted) return { ...message, stopReason: "aborted", errorMessage: "Nunc: request cancelled before capacity recovery" };
  }
  recoveryCancelled(): boolean { return [...this.rejected.values()].some(signal => signal.aborted); }
  cancelRun(): void { this.cancelledRun = true; }
  settled(): void { this.rejected.clear(); this.cancelledRun = false; }
  private hostPromptMatches(ctx: ExtensionContext, context: Context): boolean | undefined {
    try { return ctx.getSystemPrompt() === context.systemPrompt; } catch { return undefined; }
  }
  private assistantUsageUsable(message: unknown, model: Model<Api>): boolean {
    if (!record(message) || message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return false;
    if (message.model !== model.id || message.provider !== model.provider || message.api !== model.api) return false;
    const usage = message.usage;
    if (!record(usage) || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(n => integer(n))) return false;
    return integer(this.assistantUsageTokens(message), 1);
  }
  private assistantUsageTokens(message: unknown): number {
    if (!record(message) || !record(message.usage)) return 0;
    const usage = message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
    // U is input (including both cache fields) + output; reasoning is already
    // part of output. Do not substitute an inconsistent reported total.
    return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  }
  private responseView(message: { role?: string; timestamp?: number; content?: unknown; stopReason?: string; model?: string; provider?: string; api?: string; usage?: unknown }): unknown {
    return jsonView({
      role: message.role,
      timestamp: message.timestamp,
      content: message.content,
      stopReason: message.stopReason,
      model: message.model,
      provider: message.provider,
      api: message.api,
      usage: message.usage,
    });
  }
  private selectReceipt(
    effectiveContext: Context,
    model: Model<Api>,
    imageTokens?: number,
    binding?: BoundProjection,
    ctx?: ExtensionContext,
  ): {
    reason: AdmissionEstimateReason;
    validAssociation: boolean;
    receipt?: MainReceipt;
    receiptTokens: number;
    anchorTrailingMessages?: number;
    receiptBreakdown?: ReceiptBreakdown;
    rMessages: Context["messages"];
    currentMTokens: number;
    hasM: boolean;
  } {
    let validAssociation = false;
    let rMessages: Context["messages"] = [];
    let currentMTokens = 0;
    let hasM = false;

    if (binding && ctx && binding.sessionId === ctx.sessionManager.getSessionId() &&
        this.matchesProjection(effectiveContext, binding) &&
        carrierMatches(effectiveContext.messages, binding)) {
      validAssociation = true;
      hasM = binding.memory.slots.length > 0;
      rMessages = withoutIndex(effectiveContext.messages, hasM ? binding.memoryIndex : undefined);
      currentMTokens = hasM ? memoryTokens(binding.memory.slots, imageTokens) : 0;
    }

    if (!validAssociation) {
      return { reason: "messages-mismatch", validAssociation: false, receiptTokens: 0, rMessages: effectiveContext.messages, currentMTokens, hasM };
    }

    if (!this.receipts.length) {
      return { reason: "no-receipt", validAssociation: true, receiptTokens: 0, rMessages, currentMTokens, hasM };
    }

    let reason: AdmissionEstimateReason = "messages-mismatch";
    let best: { receipt: MainReceipt; deltaRTokens: number; uTokens: number; trailing: number } | undefined;
    const tools = jsonView(effectiveContext.tools ?? []);

    for (const receipt of this.receipts) {
      if (!isDeepStrictEqual(receipt.model, model)) { if (!best) reason = "model-mismatch"; continue; }
      if (receipt.systemPrompt !== effectiveContext.systemPrompt) { if (!best) reason = "system-mismatch"; continue; }
      if (!isDeepStrictEqual(receipt.tools, tools)) { if (!best) reason = "tools-mismatch"; continue; }
      if (rMessages.length <= receipt.rCount) { if (!best) reason = "messages-mismatch"; continue; }
      if (!isDeepStrictEqual(jsonView(rMessages.slice(0, receipt.rCount)), receipt.rMessages)) { if (!best) reason = "messages-mismatch"; continue; }
      const anchor = rMessages[receipt.rCount];
      if (!anchor || !this.assistantUsageUsable(anchor, model)) { if (!best) reason = "usage-unusable"; continue; }
      if (!isDeepStrictEqual(this.responseView(anchor), receipt.response)) { if (!best) reason = "messages-mismatch"; continue; }

      const deltaR = rMessages.slice(receipt.rCount + 1);
      const deltaRTokens = deltaR.reduce((sum, m) => sum + messageTokens(m, imageTokens), 0);
      const uTokens = this.assistantUsageTokens(anchor);
      const trailing = deltaR.length;
      if (!best || receipt.rCount >= best.receipt.rCount) {
        best = { receipt, deltaRTokens, uTokens, trailing };
      }
    }

    if (best) {
      const receiptTokens = best.uTokens + best.deltaRTokens + currentMTokens;
      const receiptBreakdown: ReceiptBreakdown = {
        observedU: best.uTokens,
        deltaRTokens: best.deltaRTokens,
        currentMTokens,
        retainedOldMMargin: best.receipt.hasM,
        ...(best.receipt.hasM ? { oldMTokensEstimate: best.receipt.mTokens } : {}),
      };
      return {
        reason: "matching-receipt",
        validAssociation: true,
        receipt: best.receipt,
        receiptTokens,
        anchorTrailingMessages: best.trailing,
        receiptBreakdown,
        rMessages,
        currentMTokens,
        hasM,
      };
    }

    return {
      reason,
      validAssociation: true,
      receiptTokens: 0,
      rMessages,
      currentMTokens,
      hasM,
    };
  }
  private remember(receipt: MainReceipt): void {
    const dup = this.receipts.findIndex(existing => existing.rCount === receipt.rCount && existing.systemPrompt === receipt.systemPrompt && isDeepStrictEqual(existing.model, receipt.model) && isDeepStrictEqual(existing.tools, receipt.tools));
    if (dup >= 0) this.receipts.splice(dup, 1);
    this.receipts.push(receipt);
    while (this.receipts.length > MAIN_RECEIPT_LIMIT) this.receipts.shift();
  }
  private watchCompletion(stream: { result: () => Promise<AssistantMessage> }, snapshot: MainSnapshot): void {
    void stream.result().then(message => {
      if (snapshot.generation !== this.generation || !snapshot.payloadBound) return;
      if (!this.assistantUsageUsable(message, snapshot.model)) return;
      this.remember({
        model: snapshot.model,
        systemPrompt: snapshot.systemPrompt,
        tools: snapshot.tools,
        rMessages: snapshot.rMessages,
        rCount: snapshot.rCount,
        mTokens: snapshot.mTokens,
        hasM: snapshot.hasM,
        response: this.responseView(message),
      });
    }, () => { /* Failed stream; no receipt. */ });
  }
  private observe(value: AdmissionObservation, detail?: Omit<AdmissionLayoutEvent, "observation">): void {
    try { this.pi.events.emit("nunc:admission", value); } catch { /* Notification-only consumers. */ }
    if (!detail || (value.kind !== "main" && value.kind !== "maintenance")) return;
    try { this.onLayout?.({ ...detail, observation: value }); } catch { /* Read-only observer. */ }
  }
  private sameCall(record: CallRecord | undefined, model: Model<Api>, context: Context, options: SimpleStreamOptions | Parameters<Provider["stream"]>[2], simple: boolean): record is CallRecord {
    return !!record &&
      (record.context === context || (record.effectiveContext !== undefined && record.effectiveContext === context)) &&
      record.model === model &&
      record.signal === options?.signal &&
      record.simple === simple;
  }
  private dispatch(ctx: ExtensionContext, wrapper: Provider, delegate: Provider, model: Model<Api>, context: Context, options: SimpleStreamOptions | Parameters<Provider["stream"]>[2], simple: boolean, legacyStream: boolean) {
    const entry = this.installed.get(model.provider);
    if (!entry) {
      return simple ? delegate.streamSimple(model, context, options as SimpleStreamOptions) : delegate.stream(model, context, options);
    }
    const record = this.call.getStore();
    if (this.sameCall(record, model, context, options, simple) && entry.wrapper !== wrapper && !record.seen.has(wrapper)) {
      record.seen.add(wrapper);
      return simple ? delegate.streamSimple(model, context, options as SimpleStreamOptions) : delegate.stream(model, context, options);
    }
    // Only the first outer main entry can claim a projection. Reentry, held calls
    // and independent nested Context/model/signal/mode invocations get fresh gates.
    const binding = !record && simple ? this.takeProjection(ctx, model, context, options as SimpleStreamOptions) : undefined;
    const next: CallRecord = { context, model, signal: options?.signal, simple, seen: new WeakSet() };
    next.seen.add(wrapper);
    return this.call.run(next, () => this.enter(ctx, wrapper, delegate, model, context, options, simple, legacyStream, binding));
  }
  private resolveSystemPrompt(rawPrompt: string): { status: "resolved"; systemPrompt: string } | { status: "legacy-no-reply" } | { status: "unavailable"; error: EngineError } | { status: "protocol-error"; error: EngineError } {
    let windowClosed = false;
    type CapturedReply =
      | { kind: "ok"; systemPrompt: string }
      | { kind: "unavailable"; reason: string }
      | { kind: "invalid" };
    const replies: CapturedReply[] = [];
    const reply = (result: unknown) => {
      if (windowClosed) return;
      try {
        if (!record(result)) {
          replies.push({ kind: "invalid" });
          return;
        }
        const status = result.status;
        if (status === "ok") {
          const prompt = result.systemPrompt;
          if (typeof prompt === "string") {
            replies.push({ kind: "ok", systemPrompt: prompt });
          } else {
            replies.push({ kind: "invalid" });
          }
        } else if (status === "unavailable") {
          const reason = result.reason;
          if (typeof reason === "string" && reason.length > 0) {
            replies.push({ kind: "unavailable", reason });
          } else {
            replies.push({ kind: "invalid" });
          }
        } else {
          replies.push({ kind: "invalid" });
        }
      } catch {
        replies.push({ kind: "invalid" });
      }
    };
    try {
      this.pi.events.emit(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, {
        scope: "main",
        systemPrompt: rawPrompt,
        reply,
      } satisfies ResolveSystemPromptRequest);
    } catch {
      windowClosed = true;
      return {
        status: "protocol-error",
        error: new EngineError("CONFIG", "Larva system prompt resolution event dispatch threw an exception"),
      };
    }
    windowClosed = true;

    if (replies.length === 0) {
      return { status: "legacy-no-reply" };
    }
    if (replies.length > 1) {
      return {
        status: "protocol-error",
        error: new EngineError("CONFIG", "Larva system prompt resolution received duplicate replies"),
      };
    }
    const candidate = replies[0]!;
    if (candidate.kind === "ok") {
      return { status: "resolved", systemPrompt: candidate.systemPrompt };
    }
    if (candidate.kind === "unavailable") {
      return {
        status: "unavailable",
        error: new EngineError("CONFIG", "Larva system prompt is currently unavailable"),
      };
    }
    return {
      status: "protocol-error",
      error: new EngineError("CONFIG", "Larva system prompt resolution returned invalid payload"),
    };
  }

  private enter(ctx: ExtensionContext, wrapper: Provider, delegate: Provider, model: Model<Api>, context: Context, options: SimpleStreamOptions | Parameters<Provider["stream"]>[2], simple: boolean, legacyStream: boolean, binding?: BoundProjection) {
    const scope = this.maintenance.getStore();
    const ownedMaintenance = !simple && scope && !scope.used && scope.request.context === context &&
      scope.request.signal === options?.signal && scope.request.outputTokens === options.maxTokens &&
      scope.request.model.id === model.id && scope.request.model.provider === model.provider;
    const running = ctx.signal;
    const mainSession = simple && running !== undefined && options?.signal === running && options.sessionId === ctx.sessionManager.getSessionId();
    // Same-context stream() inside the ALS run is Nunc's own maintenance call, even when
    // already used or the output/signal/model binding drifted. Independent nested calls
    // use a different Context object and do not inherit that budget.
    const kind = ownedMaintenance || !simple && scope && scope.request.context === context ? "maintenance"
      : mainSession ? "main" : "unknown";
    if (ownedMaintenance) scope.used = true;
    let inputTokens: number | undefined, limit: number | undefined, outputTokens: number | undefined;
    let initialMetadataTokens = 0;
    let budgetObservation: Pick<AdmissionObservation, "resolution" | "estimator" | "outputReserveTokens" | "outputCapTokens" | "plannedInputLimit" | "inputExceededPlan" | "estimateReason" | "hostPromptMatchesRequest" | "anchorTrailingMessages"> = {};
    let snapshot: MainSnapshot | undefined;
    let projection: AdmissionLayoutEvent["projection"];
    let effectiveContext = context;
    try {
      if (kind === "unknown") {
        this.observe({ kind, outcome: "delegate" });
        return simple ? delegate.streamSimple(model, context, options as SimpleStreamOptions) : delegate.stream(model, context, options);
      }
      options?.signal?.throwIfAborted();
      initialMetadataTokens = textTokens(JSON.stringify(options?.metadata ?? {}));
      if (ctx.modelRegistry.getRegisteredNativeProvider(model.provider) !== wrapper) throw new EngineError("CONFIG", "Provider changed after request preparation; reload before continuing");
      if (legacyStream) throw new EngineError("CONFIG", "Legacy stream overrides are unsupported; select a native Provider without a legacy stream override");
      if (model.samplingParams && Object.keys(model.samplingParams).length || options?.samplingParams && Object.keys(options.samplingParams).length) throw new EngineError("CONFIG", "Raw sampling payload overrides are unsupported");
      if (kind === "maintenance" && !ownedMaintenance) throw new EngineError("INPUT", "Nunc maintenance request already used or changed binding");
      if (kind === "main") {
        // Stock TUI flushes its compaction queue even after Escape. Reject any
        // resulting request until this run settles; leave scheduling/UI to Pi.
        if (this.cancelledRun) throw new EngineError("CANCELLED", "User cancelled native maintenance; no main transport before run settlement");
        if (ctx.model?.id !== model.id || ctx.model.provider !== model.provider) throw new EngineError("CONFIG", "Selected model does not match the current session model");
        const config = this.config(ctx, model);
        if (context.tools?.some(tool => tool.constrainedSampling)) throw new EngineError("CONFIG", "Constrained tool sampling is unsupported: Pi's maintenance ToolInfo omits that metadata");
        // Keep stock Pi output sizing. outputTokens reports an upper bound;
        // nativeOutputReserve is admission headroom, not a simultaneous output cap.
        if (options?.maxTokens !== undefined) throw new EngineError("CONFIG", "Main maxTokens overrides are unsupported; use stock model defaults");
        outputTokens = config.main.outputTokens;
        // Validate projected media/blocks/associations, without inventing source IDs.
        if (context.messages.length) legalCuts(context.messages.map((m, i) => ({ entryId: String(i), sourceRole: m.role, messages: [m] })));
        if (!model.input.includes("image") && context.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image"))) throw new EngineError("UNSUPPORTED_INPUT", "Current model does not support images");
        if (context.systemPrompt !== undefined && typeof context.systemPrompt !== "string") throw new EngineError("INPUT", "System prompt must be a string or undefined");

        const resolved = this.resolveSystemPrompt(context.systemPrompt ?? "");
        if (resolved.status === "resolved") {
          effectiveContext = { ...context, systemPrompt: resolved.systemPrompt };
          const currentRecord = this.call.getStore();
          if (currentRecord) currentRecord.effectiveContext = effectiveContext;
        } else if (resolved.status === "unavailable" || resolved.status === "protocol-error") {
          budgetObservation = { resolution: resolved.status };
          throw resolved.error;
        }

        const selected = this.selectReceipt(effectiveContext, model, config.imageTokens, binding, ctx);
        let estimateTokens: number;
        let estimator: "pi-heuristic" | "pi-usage-backed";
        if (selected.receipt) {
          estimator = "pi-usage-backed";
          estimateTokens = selected.receiptTokens;
        } else {
          estimator = "pi-heuristic";
          estimateTokens = admissionEstimate(effectiveContext, model, config.imageTokens).tokens;
        }
        inputTokens = estimateTokens + config.main.extraInputTokens + initialMetadataTokens;
        const plannedInputLimit = inputLimit(model, config.main);
        const hostPromptMatchesRequest = this.hostPromptMatches(ctx, effectiveContext);
        budgetObservation = {
          resolution: resolved.status,
          estimator,
          plannedInputLimit,
          inputExceededPlan: inputTokens > plannedInputLimit,
          outputReserveTokens: config.main.nativeOutputReserve ?? config.main.outputTokens,
          estimateReason: selected.reason,
          ...(selected.receipt ? { anchorTrailingMessages: selected.anchorTrailingMessages } : {}),
          ...(hostPromptMatchesRequest === undefined ? {} : { hostPromptMatchesRequest }),
          ...(omitsSerializedOutputCap(model) ? { outputCapTokens: null } : {}),
          ...(selected.receiptBreakdown ? { receiptBreakdown: selected.receiptBreakdown } : {}),
        };
        limit = mainAdmissionLimit(model, config.main);
        if (selected.validAssociation) projection = { memory: structuredClone(binding!.memory), rCount: selected.rMessages.length, ...(binding!.memoryIndex !== undefined ? { memoryIndex: binding!.memoryIndex } : {}) };
        if (inputTokens > limit) throw new EngineError("CAPACITY", `Delivered input estimate ${inputTokens} exceeds main input limit ${limit} (${estimator}); native recovery requires automatic compaction and a summarizable prefix. Otherwise compact explicitly, reduce input or select a larger model`);
        if (selected.validAssociation) {
          snapshot = {
            model: structuredClone(model),
            systemPrompt: effectiveContext.systemPrompt,
            tools: jsonView(effectiveContext.tools ?? []),
            rMessages: jsonView(selected.rMessages),
            rCount: selected.rMessages.length,
            mTokens: selected.currentMTokens,
            hasM: selected.hasM,
            generation: this.generation,
            payloadBound: true,
          };
        }
      }
      if (kind === "maintenance") {
        const config = this.config(ctx, model);
        outputTokens = omitsSerializedOutputCap(model) ? model.maxTokens : scope!.request.outputTokens;
        budgetObservation = { estimator: "pi-heuristic", outputReserveTokens: scope!.request.outputTokens, outputCapTokens: omitsSerializedOutputCap(model) ? null : scope!.request.outputTokens };
        inputTokens = requestTokens(context, config.imageTokens) + config.extraction.extraInputTokens + initialMetadataTokens;
        limit = inputLimit(model, config.extraction);
        if (inputTokens > limit) throw new EngineError("CAPACITY", `Maintenance input estimate ${inputTokens} exceeds planned input ${limit}; no recursive recovery`);
      }
      const onPayload = options?.onPayload;
      // Pi composes before_provider_request in load order and returns the current
      // payload object when handlers return undefined. Compare JSON bytes, not
      // prototypes; re-check only capacity-relevant growth/output/illegal fields.
      const forwarded = { ...options, onPayload: async (payload: unknown, selected: Model<Api>) => {
        const before = jsonView(payload);
        const replacement = await onPayload?.(payload, selected);
        options?.signal?.throwIfAborted();
        const final = replacement === undefined ? payload : replacement;
        const after = jsonView(final);
        const cap = outputCapState(after);
        budgetObservation.outputCapTokens = cap.kind === "value" ? cap.value : null;
        const delta = classifyPayloadChange(before, after, payloadMode(before, after, replacement, payload));
        if (snapshot && delta.categories.some(c => c !== "output")) snapshot.payloadBound = false;
        const rewrite = kind === "main" ? codexSystemInstructionRewrite(selected, before, after) : { ok: false } as const;
        const append = rewrite.ok ? rewrite.append : lastUserTextAppend(before, after);
        const observation: PayloadObservation = rewrite.ok
          ? { mode: delta.mode, categories: delta.categories, transform: "codex-system-instructions" }
          : append.ok ? { mode: delta.mode, categories: delta.categories, transform: "last-user-text-append" }
          : { mode: delta.mode, categories: delta.categories };
        const chargedTokens = Math.max(delta.grewTokens, delta.inputGrewTokens, append.ok ? append.addedTokens : 0, rewrite.ok ? rewrite.addedTokens : 0);
        const payloadGrowth = {
          grewTokens: delta.grewTokens,
          inputGrewTokens: delta.inputGrewTokens,
          chargedTokens,
          append: append.ok,
          ...(append.ok ? { addedTokens: append.addedTokens, addedText: append.addedText } : {}),
        };
        const finalInputTokens = inputTokens! + chargedTokens;
        if (budgetObservation.plannedInputLimit !== undefined) budgetObservation.inputExceededPlan = finalInputTokens > budgetObservation.plannedInputLimit;
        const layout = { ctx, model, context: effectiveContext, payloadGrowth, initialMetadataTokens, ...(projection ? { projection } : {}) };
        try {
          authorizePayload({ model: selected, delta, before, after: final, inputTokens: inputTokens!, inputLimit: limit!, authorizedOutput: outputTokens!, context: effectiveContext, allowSystemInstructionRewrite: kind === "main" });
          this.observe({ kind, outcome: "delegate", ...budgetObservation, inputTokens: finalInputTokens, inputLimit: limit!, outputTokens: outputTokens!, payload: observation }, layout);
          return replacement;
        } catch (error) {
          const code = error instanceof EngineError ? error.code : "CONFIG";
          const aborted = options?.signal?.aborted === true || code === "CANCELLED";
          const capacity = kind === "main" && code === "CAPACITY" && !aborted;
          const errorMessage = `${capacity ? "context_length_exceeded: " : ""}Nunc local ${code}; request=${randomUUID()}; ${error instanceof Error ? error.message : "Request rejected"}`;
          if (capacity && options?.signal) this.rejected.set(errorMessage, options.signal);
          this.observe({ kind, outcome: "reject", code, ...budgetObservation, inputTokens: finalInputTokens, inputLimit: limit!, outputTokens: outputTokens!, payload: observation }, layout);
          throw new EngineError(code, errorMessage);
        }
      } };
      this.observe({ kind, outcome: "delegate", ...budgetObservation, ...(inputTokens === undefined ? {} : { inputTokens, inputLimit: limit!, outputTokens: outputTokens! }) }, { ctx, model, context: effectiveContext, initialMetadataTokens, ...(projection ? { projection } : {}) });
      // The simple branch receives SimpleStreamOptions from wrapper.streamSimple;
      // raw stream options differ only in API-specific fields and never enter it.
      const stream = simple ? delegate.streamSimple(model, effectiveContext, forwarded as SimpleStreamOptions) : delegate.stream(model, effectiveContext, forwarded);
      if (snapshot) this.watchCompletion(stream, snapshot);
      return stream;
    } catch (error) {
      const aborted = options?.signal?.aborted === true || error instanceof EngineError && error.code === "CANCELLED";
      const code = aborted ? "CANCELLED" : error instanceof EngineError ? error.code : "INPUT";
      const capacity = kind === "main" && code === "CAPACITY" && !aborted;
      const errorMessage = `${capacity ? "context_length_exceeded: " : ""}Nunc local ${code}; request=${randomUUID()}; ${error instanceof Error ? error.message : "Request rejected"}`;
      if (capacity && options?.signal) this.rejected.set(errorMessage, options.signal);
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message }); stream.end();
      this.observe({ kind, outcome: "reject", code, ...budgetObservation, ...(inputTokens === undefined ? {} : { inputTokens, inputLimit: limit!, outputTokens: outputTokens! }) }, { ctx, model, context: effectiveContext, initialMetadataTokens, ...(projection ? { projection } : {}) });
      return stream;
    }
  }
}
