import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Complete, EngineConfig } from "../engine/index.js";
import { inputLimit, requestTokens, textTokens } from "../engine/accounting.js";
import { EngineError, legalCuts } from "../engine/validation.js";
import { authorizePayload, classifyPayloadChange, jsonView, payloadMode, type PayloadObservation } from "./payload.js";

type Installation = { wrapper: Provider; original?: Provider; legacy?: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>> };
export interface AdmissionObservation { kind: "main" | "maintenance" | "unknown"; outcome: "delegate" | "reject"; inputTokens?: number; inputLimit?: number; outputTokens?: number; code?: string; payload?: PayloadObservation }

/** Admission owns no session or queue mutations. Captured native transport owns I/O. */
export class Admission {
  private readonly maintenance = new AsyncLocalStorage<{ request: Parameters<Complete>[0]; used: boolean }>();
  private readonly installed = new Map<string, Installation>();
  private cancelledRun = false;
  private readonly rejected = new Map<string, AbortSignal>();
  constructor(private readonly pi: ExtensionAPI, private readonly config: (ctx: ExtensionContext, model: Model<Api>) => EngineConfig) {}

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
    this.installed.clear(); this.rejected.clear(); this.cancelledRun = false;
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
  private observe(value: AdmissionObservation): void {
    try { this.pi.events.emit("nunc:admission", value); } catch { /* Notification-only consumers. */ }
  }
  private dispatch(ctx: ExtensionContext, wrapper: Provider, delegate: Provider, model: Model<Api>, context: Context, options: SimpleStreamOptions | Parameters<Provider["stream"]>[2], simple: boolean, legacyStream: boolean) {
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
    try {
      if (kind === "unknown") {
        this.observe({ kind, outcome: "delegate" });
        return simple ? delegate.streamSimple(model, context, options as SimpleStreamOptions) : delegate.stream(model, context, options);
      }
      options?.signal?.throwIfAborted();
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
        inputTokens = requestTokens(context, config.imageTokens) + config.main.extraInputTokens + textTokens(JSON.stringify(options?.metadata ?? {}));
        limit = inputLimit(model, config.main);
        if (inputTokens > limit) throw new EngineError("CAPACITY", `Delivered input estimate ${inputTokens} exceeds safe input ${limit}; Pi may compact and retry once when automatic compaction is enabled. Otherwise compact explicitly, reduce input or select a larger model`);
      }
      if (kind === "maintenance") {
        const config = this.config(ctx, model);
        outputTokens = scope!.request.outputTokens;
        inputTokens = requestTokens(context, config.imageTokens) + config.extraction.extraInputTokens + textTokens(JSON.stringify(options?.metadata ?? {}));
        limit = inputLimit(model, config.extraction);
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
        const delta = classifyPayloadChange(before, after, payloadMode(before, after, replacement, payload));
        const observation: PayloadObservation = { mode: delta.mode, categories: delta.categories };
        try {
          authorizePayload({ model: selected, delta, after: final, inputTokens: inputTokens!, inputLimit: limit!, authorizedOutput: outputTokens! });
          this.observe({ kind, outcome: "delegate", inputTokens: inputTokens!, inputLimit: limit!, outputTokens: outputTokens!, payload: observation });
          return replacement;
        } catch (error) {
          const code = error instanceof EngineError ? error.code : "CONFIG";
          const aborted = options?.signal?.aborted === true || code === "CANCELLED";
          const capacity = kind === "main" && code === "CAPACITY" && !aborted;
          const errorMessage = `${capacity ? "context_length_exceeded: " : ""}Nunc local ${code}; request=${randomUUID()}; ${error instanceof Error ? error.message : "Request rejected"}`;
          if (capacity && options?.signal) this.rejected.set(errorMessage, options.signal);
          this.observe({ kind, outcome: "reject", code, inputTokens: inputTokens!, inputLimit: limit!, outputTokens: outputTokens!, payload: observation });
          throw new EngineError(code, errorMessage);
        }
      } };
      this.observe({ kind, outcome: "delegate", ...(inputTokens === undefined ? {} : { inputTokens, inputLimit: limit!, outputTokens: outputTokens! }) });
      // The simple branch receives SimpleStreamOptions from wrapper.streamSimple;
      // raw stream options differ only in API-specific fields and never enter it.
      return simple ? delegate.streamSimple(model, context, forwarded as SimpleStreamOptions) : delegate.stream(model, context, forwarded);
    } catch (error) {
      const aborted = options?.signal?.aborted === true || error instanceof EngineError && error.code === "CANCELLED";
      const code = error instanceof EngineError ? error.code : aborted ? "CANCELLED" : "INPUT";
      const capacity = kind === "main" && code === "CAPACITY" && !aborted;
      const errorMessage = `${capacity ? "context_length_exceeded: " : ""}Nunc local ${code}; request=${randomUUID()}; ${error instanceof Error ? error.message : "Request rejected"}`;
      if (capacity && options?.signal) this.rejected.set(errorMessage, options.signal);
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message }); stream.end();
      this.observe({ kind, outcome: "reject", code, ...(inputTokens === undefined ? {} : { inputTokens, inputLimit: limit!, outputTokens: outputTokens! }) });
      return stream;
    }
  }
}
