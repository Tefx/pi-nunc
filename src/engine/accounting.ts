import { Buffer } from "node:buffer";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import type { ActiveEntry, EngineConfig, FixedContext, RequestBudget, Slot, UsageObservation } from "./types.js";
import { memoryMessage } from "./memory.js";
import { integer, record, requireThat } from "./validation.js";

/** Deliberately conservative local estimate, NOT a provider tokenizer/usage receipt. */
export function textTokens(text: string): number { return Buffer.byteLength(text, "utf8"); }
export function messageTokens(message: Message, imageTokens?: number): number {
  let tokens = 32 + textTokens(message.role);
  if (message.role === "toolResult") tokens += textTokens(message.toolCallId) + textTokens(message.toolName) + 8;
  if (typeof message.content === "string") return tokens + textTokens(message.content);
  for (const block of message.content) {
    tokens += 16;
    switch (block.type) {
      case "text": tokens += textTokens(block.text) + textTokens(block.textSignature ?? ""); break;
      case "thinking": tokens += textTokens(block.thinking) + textTokens(block.thinkingSignature ?? ""); break;
      case "toolCall": tokens += textTokens(JSON.stringify(block)); break;
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
export function inputLimit(model: Model<Api>, budget: RequestBudget): number {
  requireThat(integer(model.contextWindow, 1) && integer(model.maxTokens, 1), "CONFIG", "Invalid effective model capacity");
  requireThat(budget.outputTokens <= Math.min(model.maxTokens, budget.outputLimit ?? model.maxTokens), "CONFIG", "Configured total output (including thinking) exceeds model/provider output capacity");
  // Pi 0.85 Codex omits max_output_tokens; some Responses endpoints opt out too.
  // In those cases a requested small cap provides no safety: require the actual model ceiling.
  requireThat(!omitsSerializedOutputCap(model) || budget.outputTokens === model.maxTokens, "CONFIG", "Selected Pi API does not send an output cap; explicitly reserve model.maxTokens for this request");
  requireThat(!["openai-responses", "azure-openai-responses"].includes(model.api) || budget.outputTokens >= 16, "CONFIG", "Pi Responses APIs floor max_output_tokens at 16; reserve at least 16");
  const reserve = budget.nativeOutputReserve ?? budget.outputTokens;
  requireThat(budget.nativeOutputReserve === undefined || (!omitsSerializedOutputCap(model) && integer(reserve, 1) && reserve <= budget.outputTokens), "CONFIG", "Native output reserve requires a serialized cap and positive headroom within its ceiling");
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
