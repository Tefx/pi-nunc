import type { Message } from "@earendil-works/pi-ai";
import type { ActiveEntry, EngineConfig, FailureCode, Memory } from "./types.js";

export class EngineError extends Error {
  constructor(readonly code: FailureCode, message: string, options?: ErrorOptions) { super(message, options); }
}
export function requireThat(condition: unknown, code: FailureCode, message: string): asserts condition {
  if (!condition) throw new EngineError(code, message);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function integer(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}
export function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
export function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
export function validateMemory(value: unknown): asserts value is Memory {
  requireThat(record(value) && value.version === 1 && Array.isArray(value.slots) && integer(value.nextId, 1), "INPUT", "Invalid memory snapshot/version/nextId");
  const ids = new Set<string>();
  for (const slot of value.slots) {
    requireThat(record(slot) && typeof slot.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(slot.id) && nonempty(slot.text), "INPUT", "Invalid memory slot");
    requireThat(!ids.has(slot.id), "INPUT", `Duplicate memory id ${slot.id}`);
    ids.add(slot.id);
  }
}
export function validateConfig(c: EngineConfig): void {
  requireThat(record(c) && record(c.memory) && record(c.main) && record(c.extraction), "CONFIG", "Missing budget configuration");
  requireThat(integer(c.triggerTokens, 1) && integer(c.growthTokens, 1), "CONFIG", "Trigger and growth tokens must be positive integers");
  requireThat(Number.isFinite(c.memory.fraction) && c.memory.fraction >= 0 && c.memory.fraction < 1, "CONFIG", "memory.fraction must be in [0,1)");
  requireThat(Number.isFinite(c.keepRecentFraction) && c.keepRecentFraction > 0 && c.keepRecentFraction < 1, "CONFIG", "keepRecentFraction must be in (0,1)");
  requireThat(c.memory.maxTokens === undefined || integer(c.memory.maxTokens, 1), "CONFIG", "memory.maxTokens must be positive");
  requireThat(c.imageTokens === undefined || integer(c.imageTokens, 1), "CONFIG", "imageTokens must be a positive provider bound");
  for (const b of [c.main, c.extraction]) {
    requireThat(integer(b.outputTokens, 1) && integer(b.safetyTokens, 1) && integer(b.extraInputTokens), "CONFIG", "Output/safety must be positive; extra input must be nonnegative");
    requireThat(b.inputLimit === undefined || integer(b.inputLimit, 1), "CONFIG", "inputLimit must be positive");
    requireThat(b.outputLimit === undefined || integer(b.outputLimit, 1), "CONFIG", "outputLimit must be positive");
    requireThat(b.nativeOutputReserve === undefined || (integer(b.nativeOutputReserve, 1) && b.nativeOutputReserve <= b.outputTokens), "CONFIG", "Native output reserve must be positive and within the output ceiling");
  }
  requireThat(c.extraction.nativeOutputReserve === undefined, "CONFIG", "Raw extraction requires a fixed output reserve");
  requireThat(["full", "auto"].includes(c.extraction.toolResults) && integer(c.extraction.headTailChars, 1), "CONFIG", "Invalid extraction reduction settings");
}

function validateJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  requireThat(value !== null && typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), "INPUT", "Tool arguments must be losslessly representable JSON");
  requireThat(!seen.has(value), "INPUT", "Cyclic tool arguments");
  seen.add(value);
  for (const child of Object.values(value)) validateJson(child, seen);
  seen.delete(value);
}

function validateMessage(value: unknown, where: string): asserts value is Message {
  requireThat(record(value) && ["user", "assistant", "toolResult"].includes(String(value.role)), "UNSUPPORTED_INPUT", `${where}: expected Pi's effective Message projection`);
  requireThat(typeof value.timestamp === "number" && Number.isFinite(value.timestamp), "INPUT", `${where}: invalid timestamp`);
  if (value.role === "user" && typeof value.content === "string") return;
  requireThat(Array.isArray(value.content), "INPUT", `${where}: invalid content`);
  if (value.role === "toolResult") {
    requireThat(nonempty(value.toolCallId) && nonempty(value.toolName) && typeof value.isError === "boolean", "INPUT", `${where}: invalid tool result association/status`);
  }
  if (value.role === "assistant") {
    requireThat(nonempty(value.model) && nonempty(value.api) && nonempty(value.provider) && nonempty(value.stopReason), "INPUT", `${where}: invalid assistant metadata`);
    requireThat(["stop", "length", "toolUse", "error", "aborted"].includes(value.stopReason), "INPUT", `${where}: unsettled or unsupported source assistant status`);
  }
  for (const block of value.content) {
    requireThat(record(block), "INPUT", `${where}: invalid content block`);
    switch (block.type) {
      case "text": requireThat(typeof block.text === "string", "INPUT", `${where}: invalid text`); break;
      case "thinking":
        requireThat(value.role === "assistant" && typeof block.thinking === "string", "INPUT", `${where}: invalid thinking`); break;
      case "toolCall":
        requireThat(value.role === "assistant" && nonempty(block.id) && nonempty(block.name) && record(block.arguments), "INPUT", `${where}: invalid tool call`);
        validateJson(block.arguments); break;
      case "image":
        requireThat(value.role !== "assistant" && nonempty(block.data) && nonempty(block.mimeType), "INPUT", `${where}: invalid native image`); break;
      default: throw new EngineError("UNSUPPORTED_INPUT", `${where}: unsupported content block ${String(block.type)}; no textual media substitute`);
    }
  }
}

/** Validate all associations, then expose entry boundaries with no crossing calls. */
export function legalCuts(active: ActiveEntry[]): number[] {
  requireThat(Array.isArray(active) && active.length > 0, "INPUT", "No active visible history");
  const entries = new Set<string>(), seenCalls = new Set<string>();
  const pending = new Map<string, string>();
  const cuts: number[] = [];
  for (const [index, entry] of active.entries()) {
    requireThat(record(entry) && nonempty(entry.entryId) && !entries.has(entry.entryId), "INPUT", "Invalid/duplicate active entry id");
    requireThat(["user", "assistant", "toolResult", "custom", "bashExecution", "branchSummary"].includes(entry.sourceRole), "INPUT", "Only visible entries; old compaction is excluded from R");
    requireThat(Array.isArray(entry.messages) && entry.messages.length > 0, "INPUT", `${entry.entryId}: empty projection cannot be a retained boundary`);
    entries.add(entry.entryId);
    if (index > 0 && pending.size === 0) cuts.push(index);
    for (const message of entry.messages) {
      validateMessage(message, entry.entryId);
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") {
          requireThat(!seenCalls.has(block.id), "INPUT", `Duplicate tool call ${block.id}`);
          seenCalls.add(block.id); pending.set(block.id, block.name);
        }
      } else if (message.role === "toolResult") {
        requireThat(pending.get(message.toolCallId) === message.toolName, "INPUT", `Orphan/duplicate/mismatched result ${message.toolCallId}`);
        pending.delete(message.toolCallId);
      }
    }
  }
  requireThat(pending.size === 0, "INPUT", `Unresolved tool calls: ${[...pending.keys()].join(", ")}`);
  return cuts;
}

/** Copy on entry, not after awaiting the provider. Freeze only detached plain task data. */
export function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(v: unknown): void {
    if (v !== null && typeof v === "object") {
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  }
  freeze(copy);
  return copy;
}
