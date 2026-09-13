import { isDeepStrictEqual } from "node:util";
import type { CheckResult } from "./scenarios.js";
import type { NuncConfig } from "../pi/config.js";
import type { RequestObservation } from "./comparison-observation.js";
import type { CallEnd, LedgerRecord } from "./budget.js";

export interface LayoutObservation {
  turn: string; model: string; kind: string; callId?: number;
  messageCount: number; memoryIndex?: number; memoryContent?: string;
  memoryPresent?: boolean; uniqueCarrier: boolean;
  deliveredMemoryMatches?: boolean;
  payloadSyntheticMissing?: boolean;
  input?: number; cacheRead?: number; cacheWrite?: number; keepRecentFraction?: number;
}
export interface PositionEpoch { content: string; indexes: number[] }
function text(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.some(b => !["text", "input_text", "output_text"].includes(b?.type))) return;
  return value.map(b => b.text).join("");
}
/** Scope: final native OpenAI chat-completions payload. Unsupported shapes are unknown.
 * Compare tool-result records with the actual Context, so genuine text saying
 * 'No result provided' is never mistaken for a serializer-created result.
 */
export function serializedEvidence(request: RequestObservation): { memory?: boolean; synthetic?: boolean } {
  const payload = request.finalPayload as any;
  if (request.model.api !== "openai-completions" || !Array.isArray(payload?.messages)) return {};
  const actual = payload.messages as any[];
  const expectedResults = request.context.messages.filter(m => m.role === "toolResult");
  const results = actual.filter(m => m.role === "tool");
  const resultsMatch = results.length === expectedResults.length && results.every((m, i) => {
    const expected = expectedResults[i]!;
    return m.tool_call_id === expected.toolCallId && text(m.content) === text(expected.content);
  });
  const expectedCalls = request.context.messages.flatMap(m => m.role === "assistant" ? m.content.filter(b => b.type === "toolCall").map(b => b.id) : []);
  const calls = actual.flatMap(m => m.role === "assistant" ? (m.tool_calls ?? []).map((c: any) => c.id) : []);
  // A changed result can be a legitimate later hook; it disproves preservation,
  // without assigning the cause to the serializer from a literal substring.
  const synthetic = !(resultsMatch && isDeepStrictEqual(calls, expectedCalls));
  const admission = request.admission;
  if (admission?.memoryPresent === undefined) return { synthetic };
  if (!admission.memoryPresent) return { synthetic, memory: admission.memoryCarrierCount === 0 && admission.memoryIndex === undefined };
  const index = admission.memoryIndex;
  if (index === undefined) return { synthetic, memory: false };
  const users = actual.filter(m => m.role === "user");
  const contextUsers = request.context.messages.filter(m => m.role === "user");
  const ordinal = request.context.messages.slice(0, index).filter(m => m.role === "user").length;
  return { synthetic, memory: users.length === contextUsers.length && text(users[ordinal]?.content) === admission.memoryContent };
}
export function layoutsFromRequests(requests: readonly RequestObservation[], ledger: readonly LedgerRecord[], keepRecentFraction?: number): LayoutObservation[] {
  const terminals = ledger.filter((row): row is CallEnd => row.kind === "terminal");
  return requests.filter(request => request.kind === "main").map(request => {
    const a = request.admission;
    const terminal = terminals.filter(row => row.id === request.callId);
    const usage = terminal.length === 1 ? terminal[0]!.usage : undefined;
    const wire = serializedEvidence(request);
    const contextContent = a?.memoryIndex === undefined ? undefined : text(request.context.messages[a.memoryIndex]?.content);
    return {
      turn: request.turn, model: `${request.model.provider}/${request.model.id}`, kind: request.kind, callId: request.callId,
      messageCount: request.context.messages.length,
      uniqueCarrier: a?.memoryPresent === true && a.memoryCarrierCount === 1 && a.memoryIndex !== undefined && contextContent === a.memoryContent,
      ...(a?.memoryPresent !== undefined ? { memoryPresent: a.memoryPresent } : {}),
      ...(a?.memoryIndex !== undefined ? { memoryIndex: a.memoryIndex } : {}),
      ...(a?.memoryContent !== undefined ? { memoryContent: a.memoryContent } : {}),
      ...(wire.memory !== undefined ? { deliveredMemoryMatches: wire.memory } : {}),
      ...(wire.synthetic !== undefined ? { payloadSyntheticMissing: wire.synthetic } : {}),
      ...(usage?.input != null ? { input: usage.input } : {}),
      ...(usage?.cacheRead != null ? { cacheRead: usage.cacheRead } : {}),
      ...(usage?.cacheWrite != null ? { cacheWrite: usage.cacheWrite } : {}),
      ...(keepRecentFraction !== undefined ? { keepRecentFraction } : {}),
    };
  });
}
export function mainLayouts(rows: readonly LayoutObservation[]): LayoutObservation[] { return rows.filter(row => row.kind === "main"); }
export function unchangedContentEpochs(rows: readonly LayoutObservation[], expectedContent?: string): PositionEpoch[] {
  const epochs: PositionEpoch[] = [];
  let previous: PositionEpoch | undefined;
  for (const row of mainLayouts(rows)) {
    if (!row.uniqueCarrier || row.memoryIndex === undefined || row.memoryContent === undefined || (expectedContent !== undefined && row.memoryContent !== expectedContent)) { previous = undefined; continue; }
    if (previous?.content === row.memoryContent) previous.indexes.push(row.memoryIndex);
    else { previous = { content: row.memoryContent, indexes: [row.memoryIndex] }; epochs.push(previous); }
  }
  return epochs;
}
export function positionStable(rows: readonly LayoutObservation[], expectedContent?: string): boolean {
  const epochs = unchangedContentEpochs(rows, expectedContent).filter(e => e.indexes.length >= 2);
  return uniqueCarriers(rows) && epochs.length > 0 && epochs.every(e => e.indexes.every(i => i === e.indexes[0]));
}
export function movingUsesTail(rows: readonly LayoutObservation[], expectedContent?: string): boolean {
  const placed = mainLayouts(rows).filter(r => r.memoryPresent === true && (expectedContent === undefined || r.memoryContent === expectedContent));
  return uniqueCarriers(rows) && placed.length >= 2 && placed.every(r => r.memoryIndex === r.messageCount - 1);
}
export function noSyntheticMissing(rows: readonly LayoutObservation[]): boolean | undefined {
  const main = mainLayouts(rows);
  if (main.some(row => row.payloadSyntheticMissing === true)) return false;
  if (!main.length || main.some(row => row.payloadSyntheticMissing === undefined)) return;
  return true;
}
export function uniqueCarriers(rows: readonly LayoutObservation[], expectedContent?: string): boolean {
  const main = mainLayouts(rows);
  return main.length > 0 && main.every(row => row.memoryPresent === true
    ? row.uniqueCarrier && row.memoryIndex !== undefined && typeof row.memoryContent === "string" && row.memoryContent.length > 0 && (expectedContent === undefined || row.memoryContent === expectedContent)
    : row.memoryPresent === false && row.memoryContent === "" && !row.uniqueCarrier && row.memoryIndex === undefined);
}
export function explicitKeepFraction(config: { nunc?: NuncConfig }, expected: 0.5 | 0.67): boolean { return config.nunc?.rolling?.keepRecentFraction === expected; }
export function scoreStableMemory(input: { id: string; variant?: string; layouts: LayoutObservation[]; config: { nunc?: NuncConfig; retentionCalibration?: unknown }; expectedContent?: string }): CheckResult[] {
  const rows = mainLayouts(input.layouts);
  const results: CheckResult[] = [{ check: "unique injected M carrier on main requests", status: uniqueCarriers(rows, input.expectedContent) ? "PROVEN" : "UNPROVEN", observed: { scope: "projection-bound provider Context; explicit empty M allowed", layouts: rows } }];
  const delivered = rows.length > 0 && rows.every(r => r.deliveredMemoryMatches === true);
  results.push({ check: "final serialized M matches bound content", status: delivered ? "PROVEN" : rows.some(r => r.deliveredMemoryMatches === false) ? "DISPROVEN" : "UNPROVEN", reason: "OpenAI chat-completions user ordinal mapping only; unsupported or missing payloads remain unproven" });
  const synthetic = noSyntheticMissing(rows);
  results.push({ check: "no serializer-synthesized missing tool results", status: synthetic === true ? "PROVEN" : synthetic === false ? "DISPROVEN" : "UNPROVEN", reason: "Complete per-call final OpenAI chat-completions payload tool calls/results compared to Context; other native formats require independent raw-payload observation" });
  if (input.id === "m1") {
    results.push({ check: input.variant === "fixed" ? "fixed layout keeps M at a stable request index across an unchanged-content epoch" : "moving baseline places M at the request tail", status: (input.variant === "fixed" ? positionStable(rows, input.expectedContent) : movingUsesTail(rows, input.expectedContent)) ? "PROVEN" : "UNPROVEN" });
    const epochs = unchangedContentEpochs(rows);
    // Qualification is input scale and two warmup opportunities on each side of
    // a real content update, never a promise about a provider's cache threshold.
    const qualified = epochs.filter(e => e.indexes.length >= 3 && rows.filter(r => r.memoryContent === e.content && (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0) >= 17000).length >= 3);
    results.push({ check: "large unchanged-M warmup and updated-M rewarm epochs", status: qualified.length >= 2 ? "PROVEN" : "UNPROVEN", observed: { minimumObservedInput: 17000, epochs: epochs.map(e => ({ requests: e.indexes.length, indexes: e.indexes })) } });
  }
  if (input.id === "m4") {
    const expected = input.variant === "keep-0.67" ? 0.67 : 0.5;
    results.push({ check: `explicit keepRecentFraction ${expected} without retentionCalibration`, status: explicitKeepFraction(input.config, expected) && input.config.retentionCalibration === undefined ? "PROVEN" : "UNPROVEN", observed: { keepRecentFraction: input.config.nunc?.rolling?.keepRecentFraction } });
  }
  return results;
}
