import type { Message } from "@earendil-works/pi-ai";
import type { CheckResult } from "./scenarios.js";
import type { NuncConfig } from "../pi/config.js";

export const CARRIER_PREFIX = "Nunc working memory (session-local, reference only)";

export interface LayoutObservation {
  turn: string;
  model: string;
  kind: string;
  messageCount: number;
  memoryIndex?: number;
  uniqueCarrier: boolean;
  syntheticMissingResults: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  keepRecentFraction?: number;
}

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((block: { type?: string; text?: string }) => block?.type === "text" && typeof block.text === "string").map((block: { text: string }) => block.text).join("");
}

/** Cloned/serialized request view. Timestamp 0 plus the envelope identifies the injected carrier; lookalike users keep real timestamps. */
export function uniqueCarrierIndex(messages: readonly { role?: string; timestamp?: number; content?: unknown }[]): number | undefined {
  const hits: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || Number(message.timestamp ?? 0) !== 0) continue;
    if (messageText(message).startsWith(CARRIER_PREFIX)) hits.push(index);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

export function syntheticMissingResults(messages: readonly { role?: string; content?: unknown }[]): number {
  return messages.filter(message => message.role === "toolResult" && messageText(message).includes("No result provided")).length;
}

export function layoutFromContext(input: {
  turn: string;
  model: string;
  kind: string;
  messages: readonly { role?: string; timestamp?: number; content?: unknown }[];
  keepRecentFraction?: number;
  usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
}): LayoutObservation {
  const memoryIndex = uniqueCarrierIndex(input.messages);
  return {
    turn: input.turn,
    model: input.model,
    kind: input.kind,
    messageCount: input.messages.length,
    uniqueCarrier: memoryIndex !== undefined || !input.messages.some(message => messageText(message).startsWith(CARRIER_PREFIX)),
    syntheticMissingResults: syntheticMissingResults(input.messages),
    ...(memoryIndex !== undefined ? { memoryIndex } : {}),
    ...(input.usage?.input !== undefined ? { input: input.usage.input } : {}),
    ...(input.usage?.cacheRead !== undefined ? { cacheRead: input.usage.cacheRead } : {}),
    ...(input.usage?.cacheWrite !== undefined ? { cacheWrite: input.usage.cacheWrite } : {}),
    ...(input.keepRecentFraction !== undefined ? { keepRecentFraction: input.keepRecentFraction } : {}),
  };
}

export function mainLayouts(rows: readonly LayoutObservation[]): LayoutObservation[] {
  return rows.filter(row => row.kind === "main");
}

export function positionStable(rows: readonly LayoutObservation[]): boolean {
  const indexes = mainLayouts(rows).map(row => row.memoryIndex).filter((index): index is number => index !== undefined);
  return indexes.length >= 2 && indexes.every(index => index === indexes[0]);
}

export function movingUsesTail(rows: readonly LayoutObservation[]): boolean {
  const placed = mainLayouts(rows).filter(row => row.memoryIndex !== undefined);
  return placed.length >= 2 && placed.every(row => row.memoryIndex === row.messageCount - 1);
}

export function noSyntheticMissing(rows: readonly LayoutObservation[]): boolean {
  return rows.length > 0 && rows.every(row => row.syntheticMissingResults === 0);
}

export function uniqueCarriers(rows: readonly LayoutObservation[]): boolean {
  return mainLayouts(rows).length > 0 && mainLayouts(rows).every(row => row.uniqueCarrier);
}

export function explicitKeepFraction(config: { nunc?: NuncConfig }, expected: 0.5 | 0.67): boolean {
  const value = config.nunc?.rolling?.keepRecentFraction;
  if (expected === 0.5) return value === 0.5 || value === undefined;
  return value === expected;
}

export function scoreStableMemory(input: {
  id: string;
  variant?: string;
  layouts: LayoutObservation[];
  config: { nunc?: NuncConfig; retentionCalibration?: unknown };
}): CheckResult[] {
  const results: CheckResult[] = [
    { check: "unique injected M carrier on main requests", status: uniqueCarriers(input.layouts) ? "PROVEN" : "UNPROVEN", observed: { layouts: input.layouts } },
    { check: "no serializer-synthesized missing tool results", status: noSyntheticMissing(input.layouts) ? "PROVEN" : "UNPROVEN" },
  ];
  if (input.id === "m1" && input.variant === "fixed") {
    results.push({ check: "fixed layout keeps M at a stable request index", status: positionStable(input.layouts) ? "PROVEN" : "UNPROVEN" });
  }
  if (input.id === "m1" && input.variant === "moving") {
    results.push({ check: "moving baseline places M at the request tail", status: movingUsesTail(input.layouts) ? "PROVEN" : "UNPROVEN" });
  }
  if (input.id === "m4") {
    const expected = input.variant === "keep-0.67" ? 0.67 : 0.5;
    results.push({
      check: `explicit keepRecentFraction ${expected} without retentionCalibration`,
      status: explicitKeepFraction(input.config, expected) && input.config.retentionCalibration === undefined ? "PROVEN" : "UNPROVEN",
      observed: { keepRecentFraction: input.config.nunc?.rolling?.keepRecentFraction ?? 0.5 },
    });
  }
  return results;
}

export function usageFromAssistant(messages: readonly Message[]): { input?: number; cacheRead?: number; cacheWrite?: number } | undefined {
  const last = [...messages].reverse().find(message => message.role === "assistant" && message.usage);
  if (!last || last.role !== "assistant" || !last.usage) return;
  return { input: last.usage.input, cacheRead: last.usage.cacheRead, cacheWrite: last.usage.cacheWrite };
}
