import { performance } from "node:perf_hooks";
import type { Complete, MaintenanceInput, MaintenanceResult, Observations } from "./types.js";
import { applyPatch, renderMemory } from "./memory.js";
import { chooseCut, inputLimit, mainContext, memoryTokens, observeUsage, omitsSerializedOutputCap, requestTokens, unknownUsage } from "./accounting.js";
import { extractionContext, reduceToolBodies } from "./request.js";
import { EngineError, freezeCopy, legalCuts, nonempty, record, requireThat, validateConfig, validateMemory } from "./validation.js";

function cancelled(signal: AbortSignal): void {
  requireThat(!signal.aborted, "CANCELLED", "Maintenance cancelled before candidate handoff");
}
/** Abort promptly even if the provider's wait fails to cooperate; never retry detached work. */
async function withCancellation<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  cancelled(signal);
  let onAbort: () => void = () => {};
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new EngineError("CANCELLED", "Maintenance cancelled while awaiting the model; usage may be unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work(), abort]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** No persistence or business tools. Exactly zero or one model request; no repair/replay. */
export async function maintain(input: MaintenanceInput, complete: Complete): Promise<MaintenanceResult> {
  const start = performance.now();
  const signal = input.signal;
  const observations: Observations = { requests: 0, elapsedMs: 0, usage: unknownUsage(), accounting: null, omissions: [], droppedSlotIds: [] };
  try {
    cancelled(signal);
    // Validate JSON serializability before recursive freezing; host data must be plain snapshots.
    try { JSON.stringify({ ...input, signal: undefined }); }
    catch (cause) { throw new EngineError("INPUT", "Maintenance input is not JSON serializable", { cause }); }
    const { signal: _signal, ...data } = input;
    let frozen: typeof data;
    try { frozen = freezeCopy(data); }
    catch (cause) { throw new EngineError("INPUT", "Cannot freeze the plain maintenance snapshot", { cause }); }
    validateConfig(frozen.config);
    validateMemory(frozen.memory);
    requireThat(record(frozen.binding) && Object.values(frozen.binding).length === 3 && nonempty(frozen.binding.sessionId) && nonempty(frozen.binding.leafId) && nonempty(frozen.binding.generation), "INPUT", "Missing session/path/options binding");
    requireThat(record(frozen.fixed) && typeof frozen.fixed.systemPrompt === "string" && Array.isArray(frozen.fixed.tools), "INPUT", "Missing effective F projection");
    const toolNames = new Set<string>();
    for (const tool of frozen.fixed.tools) {
      requireThat(record(tool) && nonempty(tool.name) && !toolNames.has(tool.name) && typeof tool.description === "string" && record(tool.parameters), "INPUT", "Invalid/duplicate effective tool definition");
      toolNames.add(tool.name);
    }
    requireThat(record(frozen.policy) && nonempty(frozen.policy.builtin) && typeof frozen.policy.user === "string", "CONFIG", "Expected a loaded policy snapshot");
    requireThat(record(frozen.model) && nonempty(frozen.model.id) && nonempty(frozen.model.provider) && nonempty(frozen.model.api) && Array.isArray(frozen.model.input) && frozen.model.input.includes("text"), "UNSUPPORTED_INPUT", "Current model cannot accept text maintenance input");
    requireThat(!frozen.model.samplingParams || Object.keys(frozen.model.samplingParams).length === 0, "CONFIG", "Raw model samplingParams can override request/budget fields; use a model without raw payload overrides");
    let cuts = legalCuts(frozen.active);
    if (frozen.eligibleKeptEntryIds !== undefined) {
      const eligible = frozen.eligibleKeptEntryIds;
      requireThat(Array.isArray(eligible) && eligible.every(id => typeof id === "string" && frozen.active.some(e => e.entryId === id)) && new Set(eligible).size === eligible.length, "INPUT", "Invalid host retained-boundary restriction");
      cuts = cuts.filter(cut => eligible.includes(frozen.active[cut]!.entryId));
    }
    const config = frozen.config;
    for (const e of frozen.active) for (const m of e.messages) if (typeof m.content !== "string" && m.content.some(b => b.type === "image")) {
      requireThat(frozen.model.input.includes("image"), "UNSUPPORTED_INPUT", "Current model does not accept native images; refusing silent removal");
    }
    const mainInputLimit = inputLimit(frozen.model, config.main);
    const extractionInputLimit = inputLimit(frozen.model, config.extraction);
    const effectiveTrigger = Math.min(config.triggerTokens, mainInputLimit);
    const fixedTokens = requestTokens(mainContext(frozen.fixed, [], []), config.imageTokens) + config.main.extraInputTokens;
    const available = effectiveTrigger - fixedTokens;
    requireThat(available > 0, "CAPACITY", "A <= 0: effective F and summary envelope exhaust the work budget");
    const memoryLimit = Math.floor(Math.min(config.memory.fraction * available, config.memory.maxTokens ?? Infinity));
    const keepTarget = Math.floor(config.keepRecentFraction * (available - memoryLimit));
    const { cut, keptTokens } = chooseCut(frozen.active, cuts, fixedTokens, memoryLimit, keepTarget, effectiveTrigger, config);
    const mainBeforeTokens = requestTokens(mainContext(frozen.fixed, frozen.memory.slots, frozen.active), config.imageTokens) + config.main.extraInputTokens;
    let context = extractionContext(frozen, cut, memoryLimit, frozen.active, []);
    const fullExtractionTokens = requestTokens(context, config.imageTokens) + config.extraction.extraInputTokens;
    // Sustainable-trigger advice must never veto an executable current request.
    const normalExtractionAtTrigger = fullExtractionTokens - mainBeforeTokens + effectiveTrigger;
    const outputCapTokens = omitsSerializedOutputCap(frozen.model) ? null : config.extraction.outputTokens;
    observations.accounting = {
      estimator: "pi-heuristic", outputReserveTokens: config.extraction.outputTokens, outputCapTokens,
      normalHeadroomSufficient: normalExtractionAtTrigger <= extractionInputLimit,
      suggestedReserveTokens: Math.max(1, Math.ceil(frozen.model.contextWindow - extractionInputLimit + fullExtractionTokens - mainBeforeTokens)),
      inputExceededPlan: false, outputExceededPlan: false,
      fixedTokens, mainBeforeTokens, mainInputLimit, extractionInputLimit,
      effectiveTrigger, memoryLimit, keepTarget, keptTokens, fullExtractionTokens, extractionTokens: fullExtractionTokens,
      normalExtractionAtTrigger, mainAfterTokens: null, memoryTokens: null, growthTokens: null,
    };
    if (fullExtractionTokens > extractionInputLimit && config.extraction.toolResults === "auto") {
      const reduced = reduceToolBodies(frozen.active, config.extraction.headTailChars);
      observations.omissions = reduced.omissions;
      context = extractionContext(frozen, cut, memoryLimit, reduced.source, reduced.omissions);
      observations.accounting.extractionTokens = requestTokens(context, config.imageTokens) + config.extraction.extraInputTokens;
    }
    requireThat(observations.accounting.extractionTokens <= extractionInputLimit, "CAPACITY", "Full extraction cannot fit; selected bounded handling is disabled or insufficient. No candidate is handed off");
    cancelled(signal);
    observations.requests = 1;
    const response = await withCancellation(() => complete({ model: frozen.model, context: freezeCopy(context), outputTokens: config.extraction.outputTokens, signal }), signal);
    if (record(response)) observations.usage = observeUsage(response.usage);
    cancelled(signal);
    requireThat(record(response) && response.role === "assistant", "RESPONSE", "Expected an assistant response");
    requireThat(response.model === frozen.model.id && response.provider === frozen.model.provider && response.api === frozen.model.api && (!response.responseModel || response.responseModel === frozen.model.id), "RESPONSE", "Maintenance response changed model/provider/API");
    requireThat(response.stopReason === "stop" && response.endTurn !== false && !response.deferred && !response.errorMessage, "RESPONSE", `Non-complete maintenance response: ${String(response.stopReason)}`);
    const usage = observations.usage;
    observations.accounting.inputExceededPlan = usage.contextInput !== null && usage.contextInput > extractionInputLimit;
    observations.accounting.outputExceededPlan = usage.output !== null && usage.output > config.extraction.outputTokens;
    const hardInputLimit = Math.min(frozen.model.contextWindow, config.extraction.inputLimit ?? Infinity);
    const hardOutputLimit = Math.min(frozen.model.maxTokens, config.extraction.outputLimit ?? Infinity, outputCapTokens ?? Infinity);
    requireThat(usage.contextInput === null || usage.contextInput <= hardInputLimit, "CAPACITY", "Reported extraction input exceeded the model/provider input limit");
    requireThat(usage.output === null || usage.output <= hardOutputLimit, "CAPACITY", "Reported output including reasoning exceeded the model/provider output limit or serialized cap");
    requireThat((usage.totalTokens === null || usage.totalTokens <= frozen.model.contextWindow) && (usage.contextInput === null || usage.output === null || usage.contextInput + usage.output <= frozen.model.contextWindow), "CAPACITY", "Reported extraction input and output exceeded the model window");
    requireThat(Array.isArray(response.content) && response.content.every(b => record(b) && ((b.type === "text" && typeof b.text === "string") || (b.type === "thinking" && typeof b.thinking === "string"))), "RESPONSE", "Unexpected maintenance content or tool call; tools are never executed");
    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    let patch: unknown;
    try { patch = JSON.parse(text); }
    catch (cause) { throw new EngineError("RESPONSE", "Maintenance response is not one complete JSON object", { cause }); }
    const applied = applyPatch(frozen.memory, patch, memoryLimit, slots => memoryTokens(slots, config.imageTokens));
    observations.droppedSlotIds = applied.droppedSlotIds;
    const kept = frozen.active.slice(cut);
    const mainAfterTokens = requestTokens(mainContext(frozen.fixed, applied.memory.slots, kept), config.imageTokens) + config.main.extraInputTokens;
    const growth = effectiveTrigger - mainAfterTokens;
    observations.accounting.mainAfterTokens = mainAfterTokens;
    observations.accounting.memoryTokens = memoryTokens(applied.memory.slots, config.imageTokens);
    observations.accounting.growthTokens = growth;
    requireThat(mainAfterTokens <= mainInputLimit && mainAfterTokens < effectiveTrigger && growth >= config.growthTokens, "CAPACITY", "Candidate lacks safe input capacity or post-rollover growth space");
    cancelled(signal);
    observations.elapsedMs = performance.now() - start;
    return { ok: true, binding: frozen.binding, candidate: {
      memory: applied.memory, summary: renderMemory(applied.memory.slots), firstKeptEntryId: kept[0]!.entryId,
      kept, retiredEntryIds: frozen.active.slice(0, cut).map(e => e.entryId),
    }, observations };
  } catch (cause) {
    observations.elapsedMs = performance.now() - start;
    const error = cause instanceof EngineError ? cause : new EngineError("MODEL", "Maintenance failed before candidate handoff", { cause });
    return { ok: false, code: signal.aborted ? "CANCELLED" : error.code, message: error.message, observations, cause };
  }
}
