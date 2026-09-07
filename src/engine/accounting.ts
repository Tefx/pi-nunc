import { estimateTextTokens, estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import type { ActiveEntry, EngineConfig, FixedContext, RequestBudget, Slot, UsageObservation } from "./types.js";
import { memoryMessage } from "./memory.js";
import { integer, record, requireThat } from "./validation.js";

/** Pi's planning heuristic, NOT a tokenizer or a hard upper bound. */
export function textTokens(text: string): number { return estimateTextTokens(text); }
export function messageTokens(message: Message, imageTokens?: number): number {
  let tokens = 32 + textTokens(message.role);
  if (message.role === "toolResult") tokens += textTokens(message.toolCallId) + textTokens(message.toolName) + 8;
  if (typeof message.content === "string") return tokens + textTokens(message.content);
  for (const block of message.content) {
    tokens += 16;
    switch (block.type) {
      case "text": tokens += textTokens(block.text); break;
      case "thinking": tokens += textTokens(block.thinking); break;
      case "toolCall": tokens += textTokens(block.id) + textTokens(block.name) + textTokens(JSON.stringify(block.arguments)); break;
      case "image":
        requireThat(integer(imageTokens, 1), "UNSUPPORTED_INPUT", "Native image input needs a provider-specific imageTokens upper bound");
        tokens += imageTokens; break;
    }
  }
  return tokens;
}
export function requestTokens(context: Context, imageTokens?: number): number {
  return 64 + textTokens(context.systemPrompt ?? "") + textTokens(JSON.stringify(context.tools ?? []))
    + context.messages.reduce((sum, m) => sum + messageTokens(m, imageTokens), 0);
}
/** Caller must establish unchanged model/prefix before allowing historical usage. */
export function admissionEstimate(context: Context, model: Model<Api>, imageTokens?: number, allowUsage = false, minimumUsageIndex = 0): { tokens: number; estimator: "pi-heuristic" | "pi-usage-backed" } {
  // Validate every native image even when a usage receipt covers its token cost.
  const fresh = requestTokens(context, imageTokens);
  if (allowUsage && context.messages.every(m => m.role !== "assistant" || record(m.usage) && [m.usage.input, m.usage.output, m.usage.cacheRead, m.usage.cacheWrite, m.usage.totalTokens].every(n => integer(n)))) {
    const estimate = estimateContextTokens(context);
    const anchor = estimate.lastUsageIndex === null ? undefined : context.messages[estimate.lastUsageIndex];
    if (estimate.lastUsageIndex !== null && estimate.lastUsageIndex >= minimumUsageIndex && anchor?.role === "assistant" && anchor.model === model.id && anchor.provider === model.provider && anchor.api === model.api) {
      const trailing = context.messages.slice(estimate.lastUsageIndex! + 1);
      // Pi's usage includes F and earlier messages. Add our explicit framing/media
      // estimate only for new messages, without charging the prefix twice.
      return { tokens: estimate.usageTokens + trailing.reduce((n, m) => n + messageTokens(m, imageTokens), 0), estimator: "pi-usage-backed" };
    }
  }
  return { tokens: fresh, estimator: "pi-heuristic" };
}
export function mainContext(fixed: FixedContext, slots: Slot[], active: ActiveEntry[]): Context {
  return { ...fixed, messages: [memoryMessage(slots), ...active.flatMap(e => e.messages)] };
}
export function memoryTokens(slots: Slot[], imageTokens?: number): number {
  return messageTokens(memoryMessage(slots), imageTokens) - messageTokens(memoryMessage([]), imageTokens);
}
/** Native serializers that omit an output cap; a smaller configured ceiling is not enforceable. */
export function omitsSerializedOutputCap(model: Model<Api>): boolean {
  return model.api === "openai-codex-responses" || (model.api === "openai-responses" && record(model.compat) && model.compat.supportsMaxOutputTokens === false);
}
/** Shared F/M planning numbers for maintenance and manual M edits. */
export function memoryPlan(fixed: FixedContext, model: Model<Api>, config: EngineConfig) {
  const mainInputLimit = inputLimit(model, config.main);
  const extractionInputLimit = inputLimit(model, config.extraction);
  const effectiveTrigger = Math.min(config.triggerTokens, mainInputLimit);
  const fixedTokens = requestTokens(mainContext(fixed, [], []), config.imageTokens) + config.main.extraInputTokens;
  const available = effectiveTrigger - fixedTokens;
  requireThat(available > 0, "CAPACITY", "A <= 0: effective F and summary envelope exhaust the work budget");
  const memoryLimit = Math.floor(Math.min(config.memory.fraction * available, config.memory.maxTokens ?? Infinity));
  const keepTarget = Math.floor(config.keepRecentFraction * (available - memoryLimit));
  return { mainInputLimit, extractionInputLimit, effectiveTrigger, fixedTokens, available, memoryLimit, keepTarget };
}
export function inputLimit(model: Model<Api>, budget: RequestBudget): number {
  requireThat(integer(model.contextWindow, 1) && integer(model.maxTokens, 1), "CONFIG", "Invalid effective model capacity");
  requireThat(budget.outputTokens <= Math.min(model.maxTokens, budget.outputLimit ?? model.maxTokens), "CONFIG", "Configured total output (including thinking) exceeds model/provider output capacity");
  // Output planning and enforceable caps are distinct. Uncapped APIs can use a
  // smaller planning reserve; provider overflow/length recovery remains native.
  requireThat(!["openai-responses", "azure-openai-responses"].includes(model.api) || budget.outputTokens >= 16, "CONFIG", "Pi Responses APIs floor max_output_tokens at 16; reserve at least 16");
  const reserve = budget.nativeOutputReserve ?? budget.outputTokens;
  requireThat(budget.nativeOutputReserve === undefined || (integer(reserve, 1) && reserve <= budget.outputTokens), "CONFIG", "Output planning reserve must be positive and within model output capability");
  requireThat(!["openai-responses", "azure-openai-responses"].includes(model.api) || reserve >= 16, "CONFIG", "Pi Responses input headroom must cover its minimum output of 16");
  // Main headroom follows host policy while Pi sizes output with its own estimate.
  // It is not a simultaneous reservation of the catalog output upper bound.
  const limit = Math.min(model.contextWindow - reserve, budget.inputLimit ?? model.contextWindow) - budget.safetyTokens;
  requireThat(limit > 0, "CAPACITY", "Output and safety reserves leave no input capacity");
  return limit;
}
export function chooseCut(active: ActiveEntry[], cuts: number[], fixedTokens: number, memoryLimit: number, keepTarget: number, trigger: number, config: EngineConfig): { cut: number; keptTokens: number } {
  const sizes = active.map(e => e.messages.reduce((sum, m) => sum + messageTokens(m, config.imageTokens), 0));
  const suffix: number[] = new Array(sizes.length + 1).fill(0);
  for (let i = sizes.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + sizes[i]!;
  const feasible = cuts.map(cut => ({ cut, keptTokens: suffix[cut]! })).filter(c => fixedTokens + memoryLimit + c.keptTokens + config.growthTokens <= trigger);
  requireThat(feasible.length > 0, "CAPACITY", "No nonempty B/K boundary fits memory reserve and growth; an indivisible recent message/tool unit may be too large");
  // Largest suffix under target. If rounding cannot reach target, smallest feasible complete unit above it.
  return feasible.find(c => c.keptTokens <= keepTarget) ?? feasible[feasible.length - 1]!;
}
export function unknownUsage(): UsageObservation {
  return { input: null, cacheRead: null, cacheWrite: null, contextInput: null, output: null, reasoning: null, totalTokens: null, cost: null };
}
/** Pi input excludes cache reads/writes; reasoning is a SUBSET of output. */
export function observeUsage(value: unknown): UsageObservation {
  if (!record(value)) return unknownUsage();
  const count = (v: unknown): number | null => integer(v) ? v : null;
  const input = count(value.input), cacheRead = count(value.cacheRead), cacheWrite = count(value.cacheWrite);
  const output = count(value.output), reasoning = count(value.reasoning), totalTokens = count(value.totalTokens);
  // Pi initializes usage to zeros even when the provider reports nothing.
  if ([input, cacheRead, cacheWrite, output, totalTokens].every(n => n === null || n === 0)) return unknownUsage();
  const contextInput = input === null || cacheRead === null || cacheWrite === null ? null : input + cacheRead + cacheWrite;
  const cost = record(value.cost) && typeof value.cost.total === "number" && Number.isFinite(value.cost.total) && value.cost.total >= 0 ? value.cost.total : null;
  return { input, cacheRead, cacheWrite, contextInput, output, reasoning, totalTokens, cost };
}
