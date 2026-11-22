import { readdir, readFile, stat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { project } from "../pi/projection.js";
import { isDeepStrictEqual } from "node:util";
import { getSystemMessageText, renderSystemMessageUpdate } from "@earendil-works/pi-ai";
import type { CheckResult } from "./scenarios.js";
import type { NuncConfig } from "../pi/config.js";
import type { RequestObservation } from "./comparison-observation.js";
import type { CallEnd, LedgerRecord } from "./budget.js";

/** Observe only this isolated task directory, never historical session files. */
export async function qualifyMemoryOnly(turn: string, entries: readonly SessionEntry[], cwd: string): Promise<CheckResult> {
  const values = ["cedar-17", "maple-29"], active = project(entries);
  const history = JSON.stringify(active.active), memory = JSON.stringify(active.memory.slots);
  let complete = true;
  const matches: string[] = [];
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) { complete = false; continue; }
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) {
        if ((await stat(path)).size > 1000000) { complete = false; continue; }
        const body = await readFile(path, "utf8");
        if (values.some(v => body.includes(v))) matches.push(path);
      }
    }
  }
  try { await scan(cwd); } catch { complete = false; }
  const historyMatches = values.filter(v => history.includes(v)), memoryValues = values.filter(v => memory.includes(v));
  const expected = turn === "b2" ? [values[0]] : turn === "d2" ? [values[1]] : [];
  const memoryQualified = JSON.stringify(memoryValues) === JSON.stringify(expected);
  return { check: `M-only ${turn}: source values unavailable in current R/task files and current M has the required state`,
    status: complete && !matches.length && !historyMatches.length && memoryQualified ? "PROVEN" : "UNPROVEN",
    observed: { turn, activeEntryIds: active.active.map(e => e.entryId), memory: active.memory, taskScanComplete: complete, taskMatches: matches, historyMatches, memoryValues } };
}
/** Retain observed model output outside task visibility before later continuation. */
export async function archiveMemoryArtifact(turn: string, caseRoot: string): Promise<{ path: string; value: unknown } | undefined> {
  const path = turn === "b2" ? "initial.json" : turn === "d2" ? "corrected.json" : undefined;
  if (!path) return;
  let value: unknown;
  try { value = JSON.parse(await readFile(join(caseRoot, "task", path), "utf8")); } catch { return; }
  await mkdir(join(caseRoot, "observed-artifacts"), { recursive: true });
  await rename(join(caseRoot, "task", path), join(caseRoot, "observed-artifacts", path));
  return { path, value };
}

export interface LayoutObservation {
  turn: string; model: string; kind: string; callId?: number;
  messageCount: number; memoryIndex?: number; memoryContent?: string;
  legalTailIndex?: number; memoryBoundaryLegal?: boolean;
  memoryPresent?: boolean; uniqueCarrier: boolean;
  deliveredMemoryMatches?: boolean;
  payloadSyntheticMissing?: boolean;
  input?: number; cacheRead?: number; cacheWrite?: number; keepRecentFraction?: number;
}
export interface PositionEpoch { content: string; indexes: number[]; observedInputs: Array<number | undefined>; firstAtLegalTail: boolean | undefined }
function text(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.some(b => !["text", "input_text", "output_text"].includes(b?.type))) return;
  return value.map(b => b.text).join("");
}
/** Scope: final native OpenAI chat-completions and Responses payloads. Unsupported shapes are unknown.
 * Compare tool-result records with the actual Context, so genuine text saying
 * 'No result provided' is never mistaken for a serializer-created result.
 */
export function serializedEvidence(request: RequestObservation): { memory?: boolean; synthetic?: boolean } {
  const payload = request.finalPayload as any;
  if (["openai-responses", "openai-codex-responses"].includes(request.model.api)) return serializedResponsesEvidence(request, payload);
  if (request.model.api !== "openai-completions" || !Array.isArray(payload?.messages)) return {};
  const actual = payload.messages as any[];
  if (actual.some(m => !m || typeof m.role !== "string" || (m.tool_calls !== undefined && !Array.isArray(m.tool_calls)))) return {};
  const expectedResults = request.context.messages.filter(m => m.role === "toolResult");
  const results = actual.filter(m => m.role === "tool");
  const resultsMatch = results.length === expectedResults.length && results.every((m, i) => {
    const expected = expectedResults[i]!;
    return m.tool_call_id === expected.toolCallId && text(m.content) === text(expected.content);
  });
  // A changed result can be a legitimate later hook; it disproves preservation,
  // without assigning the cause to the serializer from a literal substring.
  const textual = results.every(m => text(m.content) !== undefined) && expectedResults.every(m => text(m.content) !== undefined);
  const callGroups = (messages: any[], native: boolean) => messages.filter(m => m.role === "assistant").map(m => native
    ? (m.tool_calls ?? []).map((c: any) => { try { return { id: c.id, name: c.function?.name, arguments: JSON.parse(c.function?.arguments) }; } catch { return null; } })
    : m.content.filter((b: any) => b.type === "toolCall").map((b: any) => ({ id: b.id, name: b.name, arguments: b.arguments })));
  const synthetic = textual ? !(resultsMatch && isDeepStrictEqual(callGroups(actual, true), callGroups(request.context.messages, false))) : undefined;
  const admission = request.admission;
  if (admission?.memoryPresent === undefined) return synthetic === undefined ? {} : { synthetic };
  // Preserve ordered multimodal blocks and bind calls to their own assistant message.
  // Unsupported blocks never compare equal merely because both text projections are undefined.
  const blocks = (value: any, native: boolean): unknown[] | undefined => {
    if (typeof value === "string") return [{ type: "text", text: value }];
    if (!Array.isArray(value)) return;
    const result: unknown[] = [];
    for (const block of value) {
      if (block?.type === "text" && typeof block.text === "string") result.push({ type: "text", text: block.text });
      else if (!native && block?.type === "image") result.push({ type: "image", url: `data:${block.mimeType};base64,${block.data}` });
      else if (native && block?.type === "image_url" && typeof block.image_url?.url === "string") result.push({ type: "image", url: block.image_url.url });
      else return;
    }
    return result;
  };
  const compat = request.model.compat;
  const developer = request.model.reasoning && !(compat && "supportsDeveloperRole" in compat && compat.supportsDeveloperRole === false);
  const expectedMessages = request.context.messages.map((m, i) => ({
    role: m.role === "toolResult" ? "tool" : m.role === "system" && developer ? "developer" : m.role,
    content: m.role === "system" ? blocks(i === 0 ? getSystemMessageText(m) : renderSystemMessageUpdate(m), false) :
      m.role === "assistant" ? blocks(text(m.content.filter(b => b.type === "text")) ?? "", false) : blocks(m.content, false),
    ...(m.role === "assistant" ? { calls: callGroups([m], false)[0] } : {}),
    ...(m.role === "toolResult" ? { callId: m.toolCallId } : {}),
  }));
  const actualMessages = actual.map(m => ({ role: m.role,
    content: blocks(m.role === "assistant" && m.content == null ? "" : m.content, true),
    ...(m.role === "assistant" ? { calls: callGroups([m], true)[0] } : {}),
    ...(m.role === "tool" ? { callId: m.tool_call_id } : {}),
  }));
  if (expectedMessages.some(m => m.content === undefined) || actualMessages.some(m => m.content === undefined)) return synthetic === undefined ? {} : { synthetic };
  const sameMessages = isDeepStrictEqual(actualMessages, expectedMessages);
  if (!admission.memoryPresent) return { ...(synthetic !== undefined ? { synthetic } : {}), memory: sameMessages && admission.memoryCarrierCount === 0 && admission.memoryIndex === undefined };
  const index = admission.memoryIndex;
  if (index === undefined) return { ...(synthetic !== undefined ? { synthetic } : {}), memory: false };
  const users = actual.filter(m => m.role === "user");
  const contextUsers = request.context.messages.filter(m => m.role === "user");
  const ordinal = request.context.messages.slice(0, index).filter(m => m.role === "user").length;
  return { ...(synthetic !== undefined ? { synthetic } : {}), memory: sameMessages && users.length === contextUsers.length && text(users[ordinal]?.content) === admission.memoryContent };
}
// Native Responses serializes Pi's "call_id|item_id" as a separate call_id and
// item id. Only safe native call IDs are comparable; unsupported/opaque shapes
// remain unknown instead of supplying positive serializer evidence.
function codexCallId(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const parts = value.split("|");
  if (parts.length > 2 || !parts.every(part => /^[a-zA-Z0-9_-]{1,64}$/.test(part))) return;
  return parts[0];
}
function serializedResponsesEvidence(request: RequestObservation, payload: any): { memory?: boolean; synthetic?: boolean } {
  if (!Array.isArray(payload?.input) || payload.input.some((item: any) => !item || typeof item !== "object")) return {};
  const actual = payload.input as any[];
  // Other tool encodings need their own mapping. Ignoring one could fabricate
  // a complete call/result correspondence.
  if (actual.some(item => typeof item.type === "string" && /call|tool/i.test(item.type) &&
    item.type !== "function_call" && item.type !== "function_call_output" && item.type !== "additional_tools")) return {};
  const expectedCalls = request.context.messages.flatMap(message => message.role === "assistant"
    ? message.content.filter(block => block.type === "toolCall") : []);
  const expectedResults = request.context.messages.filter(message => message.role === "toolResult");
  const calls = actual.filter(item => item.type === "function_call");
  const results = actual.filter(item => item.type === "function_call_output");
  let synthetic: boolean | undefined;
  const known = expectedCalls.every(block => codexCallId(block.id) !== undefined) &&
    expectedResults.every(message => codexCallId(message.toolCallId) !== undefined && text(message.content) !== undefined) &&
    calls.every(item => typeof item.call_id === "string" && typeof item.name === "string" && typeof item.arguments === "string") &&
    results.every(item => typeof item.call_id === "string" && typeof item.output === "string");
  if (known) {
    const callsMatch = calls.length === expectedCalls.length && calls.every((item, index) => {
      const expected = expectedCalls[index]!;
      try { return item.call_id === codexCallId(expected.id) && item.name === expected.name &&
        isDeepStrictEqual(JSON.parse(item.arguments), expected.arguments); } catch { return false; }
    });
    const resultsMatch = results.length === expectedResults.length && results.every((item, index) =>
      item.call_id === codexCallId(expectedResults[index]!.toolCallId) && item.output === text(expectedResults[index]!.content));
    synthetic = !(callsMatch && resultsMatch);
  }
  const admission = request.admission;
  if (admission?.memoryPresent === undefined) return synthetic === undefined ? {} : { synthetic };
  // Compare the complete supported sequence, not just its user-message projection.
  // Responses emits one message per assistant text block, interleaved with calls.
  const blocks = (content: unknown): string[] | undefined => {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content) || content.some(b => !b || !["text", "input_text", "output_text"].includes(b.type) || typeof b.text !== "string")) return;
    return content.map(b => b.text);
  };
  const expectedSequence: unknown[] = [], actualSequence: unknown[] = [];
  const compat = request.model.compat;
  const instructionRole = request.model.reasoning && !(compat && "supportsDeveloperRole" in compat && compat.supportsDeveloperRole === false) ? "developer" : "system";
  for (const [i, message] of request.context.messages.entries()) {
    if (message.role === "system") {
      const content = i === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message);
      if (i === 0 && payload.instructions !== undefined) {
        if (payload.instructions !== content) return {};
      } else if (content) expectedSequence.push({ role: instructionRole, content: [content] });
    } else if (message.role === "user") {
      const content = blocks(message.content);
      if (!content) return {};
      if (content.length) expectedSequence.push({ role: "user", content });
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") expectedSequence.push({ role: "assistant", content: [block.text] });
        else if (block.type === "thinking") {
          // Unsigned thinking is omitted by the native serializer. Signed replay is ordered evidence.
          if (block.thinkingSignature) {
            try {
              const item = JSON.parse(block.thinkingSignature);
              if (item?.type !== "reasoning") return {};
              expectedSequence.push(item);
            } catch { return {}; }
          }
        }
        else if (block.type === "toolCall" && codexCallId(block.id) !== undefined) expectedSequence.push({ type: "function_call", callId: codexCallId(block.id), name: block.name, arguments: block.arguments });
        else return {};
      }
    } else if (message.role === "toolResult" && codexCallId(message.toolCallId) !== undefined && text(message.content) !== undefined) {
      expectedSequence.push({ type: "function_call_output", callId: codexCallId(message.toolCallId), output: text(message.content) });
    } else return {};
  }
  if (payload.instructions !== undefined && request.context.messages[0]?.role !== "system" &&
      !(request.model.api === "openai-codex-responses" && payload.instructions === "You are a helpful assistant.")) return {};
  for (const item of actual) {
    // Native reasoning controls carry no messages and do not affect sequence preservation.
    if (item.type === "configuration_update" || item.type === "additional_tools") continue;
    if (item.type === "reasoning") { actualSequence.push(item); continue; }
    if (item.type === "function_call") {
      try { actualSequence.push({ type: item.type, callId: item.call_id, name: item.name, arguments: JSON.parse(item.arguments) }); }
      catch { return {}; }
    } else if (item.type === "function_call_output") {
      actualSequence.push({ type: item.type, callId: item.call_id, output: item.output });
    } else if ((item.type === undefined || item.type === "message") && ["system", "developer", "user", "assistant"].includes(item.role)) {
      const content = blocks(item.content);
      if (!content) return {};
      actualSequence.push({ role: item.role, content });
    } else return {};
  }
  const sameSequence = isDeepStrictEqual(actualSequence, expectedSequence);
  const users = actual.filter(item => item.role === "user" && (item.type === undefined || item.type === "message"));
  if (!admission.memoryPresent) return { ...(synthetic !== undefined ? { synthetic } : {}),
    memory: sameSequence && admission.memoryCarrierCount === 0 && admission.memoryIndex === undefined };
  const index = admission.memoryIndex;
  const ordinal = index === undefined ? -1 : request.context.messages.slice(0, index).filter(message => message.role === "user").length;
  return { ...(synthetic !== undefined ? { synthetic } : {}),
    memory: sameSequence && ordinal >= 0 && text(users[ordinal]?.content) === admission.memoryContent };
}
/** Independent Context oracle: tool-call/result intervals exclude interrupted boundaries.
 * Unlike the production selector, enumerate boundaries after validating the complete
 * observed associations. Missing results remain open intervals; malformed traces are unknown.
 */
function memoryBoundaryEvidence(request: RequestObservation): Pick<LayoutObservation, "legalTailIndex" | "memoryBoundaryLegal"> {
  const a = request.admission, index = a?.memoryIndex;
  if (a?.memoryPresent !== true || a.memoryCarrierCount !== 1 || index === undefined ||
      !Number.isInteger(index) || index < 0 || index >= request.context.messages.length ||
      request.context.messages[index]?.role !== "user" || text(request.context.messages[index]?.content) !== a.memoryContent) return {};
  const history = request.context.messages.filter((_message, i) => i !== index);
  const intervals: Array<{ at: number; name: string; end?: number }> = [];
  const pending = new Map<string, typeof intervals[number]>();
  for (const [i, message] of history.entries()) {
    if (message.role === "user" || message.role === "system") continue;
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) return {};
      for (const block of message.content) if (block.type === "toolCall") {
        if (!block.id || !block.name || pending.has(block.id)) return {};
        const interval = { at: i, name: block.name };
        intervals.push(interval);
        pending.set(block.id, interval);
      }
    } else if (message.role === "toolResult") {
      const call = pending.get(message.toolCallId);
      if (!call || call.name !== message.toolName) return {};
      call.end = i;
      pending.delete(message.toolCallId);
    } else return {};
  }
  const boundaries = Array.from({ length: history.length + 1 }, (_v, i) => i).filter(i =>
    (i === 0 || history[i - 1]!.role !== "toolResult") &&
    intervals.every(call => i <= call.at || i > (call.end ?? history.length)));
  return { legalTailIndex: boundaries.at(-1)!, memoryBoundaryLegal: boundaries.includes(index) };
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
      ...memoryBoundaryEvidence(request),
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
    const observedInput = row.input !== undefined && row.cacheRead !== undefined && row.cacheWrite !== undefined ? row.input + row.cacheRead + row.cacheWrite : undefined;
    if (previous?.content === row.memoryContent) { previous.indexes.push(row.memoryIndex); previous.observedInputs.push(observedInput); }
    else { previous = { content: row.memoryContent, indexes: [row.memoryIndex], observedInputs: [observedInput], firstAtLegalTail: row.legalTailIndex === undefined || row.memoryBoundaryLegal === undefined ? undefined : row.memoryBoundaryLegal && row.memoryIndex === row.legalTailIndex }; epochs.push(previous); }
  }
  return epochs;
}
export function positionStable(rows: readonly LayoutObservation[], expectedContent?: string): boolean {
  const epochs = unchangedContentEpochs(rows, expectedContent).filter(e => e.indexes.length >= 2);
  return uniqueCarriers(rows) && mainLayouts(rows).every(r => r.memoryPresent === false || r.memoryBoundaryLegal === true) &&
    epochs.length > 0 && epochs.every(e => e.indexes.every(i => i === e.indexes[0]));
}
export function movingUsesTail(rows: readonly LayoutObservation[], expectedContent?: string): boolean {
  const placed = mainLayouts(rows).filter(r => r.memoryPresent === true && (expectedContent === undefined || r.memoryContent === expectedContent));
  return uniqueCarriers(rows) && placed.length >= 2 && placed.every(r => r.memoryBoundaryLegal === true && r.legalTailIndex !== undefined && r.memoryIndex === r.legalTailIndex);
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
    : row.memoryPresent === false && row.memoryContent === "" && !row.uniqueCarrier && row.memoryIndex === undefined && (expectedContent === undefined || expectedContent === ""));
}
export function explicitKeepFraction(config: { nunc?: NuncConfig }, expected: 0.5 | 0.67): boolean { return config.nunc?.rolling?.keepRecentFraction === expected; }
export function scoreStableMemory(input: { id: string; variant?: string; layouts: LayoutObservation[]; config: { nunc?: NuncConfig; retentionCalibration?: unknown }; expectedContent?: string }): CheckResult[] {
  const rows = mainLayouts(input.layouts);
  const results: CheckResult[] = [{ check: "unique injected M carrier on main requests", status: uniqueCarriers(rows, input.expectedContent) ? "PROVEN" : "UNPROVEN", observed: { scope: "projection-bound provider Context; explicit empty M allowed", layouts: rows } }];
  const delivered = rows.length > 0 && rows.every(r => r.deliveredMemoryMatches === true);
  results.push({ check: "final serialized M matches bound content", status: delivered ? "PROVEN" : rows.some(r => r.deliveredMemoryMatches === false) ? "DISPROVEN" : "UNPROVEN", reason: "Complete textual OpenAI chat-completions or native Codex Responses payload required; unsupported or missing payloads remain unproven" });
  const synthetic = noSyntheticMissing(rows);
  results.push({ check: "no serializer-synthesized missing tool results", status: synthetic === true ? "PROVEN" : synthetic === false ? "DISPROVEN" : "UNPROVEN", reason: "Complete per-call final chat-completions or native Codex Responses tool calls/results compared to Context; other formats remain unproven" });
  if (input.id === "m1") {
    results.push({ check: input.variant === "fixed" ? "fixed layout keeps M at a stable request index across an unchanged-content epoch" : "moving baseline places M at the legal request tail", status: (input.variant === "fixed" ? positionStable(rows, input.expectedContent) : movingUsesTail(rows, input.expectedContent)) ? "PROVEN" : "UNPROVEN" });
    const epochs = unchangedContentEpochs(rows);
    // Qualification is input scale and two warmup opportunities on each side of
    // a real content update, never a promise about a provider's cache threshold.
    const qualified = epochs.filter(e => e.observedInputs.filter(n => n !== undefined && n >= 17000).length >= 3);
    results.push({ check: "large unchanged-M warmup and updated-M rewarm epochs", status: qualified.length >= 2 && qualified.every(e => e.firstAtLegalTail === true) ? "PROVEN" : "UNPROVEN", observed: { minimumObservedInput: 17000, epochs: epochs.map(e => ({ requests: e.indexes.length, indexes: e.indexes })) } });
  }
  if (input.id === "m4") {
    const expected = input.variant === "keep-0.67" ? 0.67 : 0.5;
    results.push({ check: `explicit keepRecentFraction ${expected} without retentionCalibration`, status: explicitKeepFraction(input.config, expected) && input.config.retentionCalibration === undefined ? "PROVEN" : "UNPROVEN", observed: { keepRecentFraction: input.config.nunc?.rolling?.keepRecentFraction } });
  }
  return results;
}
