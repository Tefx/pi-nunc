import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { convertToLlm, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ActiveEntry, Memory, ToolResultDecision, ToolResultRef } from "../engine/index.js";
import { applyToolResultCleanup, emptyMemory, renderMemory, legacyRenderMemory } from "../engine/index.js";
import { isSystemMessage } from "../engine/accounting.js";
import { EngineError, integer, record, validateMemory } from "../engine/validation.js";

/** Private CustomEntry type. Replaceable encoding; not a public SDK. */
export const MANUAL_MEMORY_TYPE = "nunc.memory";

export function isManualMemoryEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
  return entry.type === "custom" && entry.customType === MANUAL_MEMORY_TYPE;
}

type StoredDecision = ToolResultDecision & { sourceDigest: string };
const sourceDigest = (text: string) => createHash("sha256").update(JSON.stringify(text)).digest("hex");
const sourceText = (active: readonly ActiveEntry[], ref: ToolResultRef): string | undefined => {
  const message = active.find(entry => entry.entryId === ref.entryId)?.messages[ref.messageIndex];
  return message?.role === "toolResult" && Array.isArray(message.content) && message.content.every(block => block.type === "text")
    ? message.content.map(block => block.text).join("") : undefined;
};
export function sealDecisions(active: readonly ActiveEntry[], decisions: readonly ToolResultDecision[]): StoredDecision[] {
  return decisions.map(decision => {
    const text = sourceText(active, decision);
    if (text === undefined || text.length !== decision.originalLength) throw new EngineError("INPUT", "Cleanup source changed before native save");
    return { ...decision, sourceDigest: sourceDigest(text) };
  });
}
function readDecisions(data: unknown): { valid: StoredDecision[]; invalid: string[] } {
  if (!record(data) || !Array.isArray(data.toolResultCleanup)) return { valid: [], invalid: [] };
  const valid: StoredDecision[] = [], invalid: string[] = [];
  for (const value of data.toolResultCleanup) {
    if (record(value) && typeof value.entryId === "string" && integer(value.messageIndex) &&
        typeof value.toolCallId === "string" && typeof value.toolName === "string" && typeof value.text === "string" &&
        (value.kind === "semantic" || value.kind === "mechanical") &&
        integer(value.originalLength) && integer(value.cleanedLength) && value.cleanedLength === value.text.length &&
        integer(value.netSavings, 1) && value.netSavings === value.originalLength - value.cleanedLength &&
        typeof value.sourceDigest === "string" && /^[a-f0-9]{64}$/.test(value.sourceDigest)) valid.push(value as unknown as StoredDecision);
    else invalid.push(record(value) && typeof value.entryId === "string" && integer(value.messageIndex) ? `${value.entryId}:${value.messageIndex}` : "invalid saved cleanup decision");
  }
  return { valid, invalid };
}

export function decodeManualMemory(data: unknown): Memory {
  requireManual(record(data) && "nunc" in data, "Invalid Nunc manual memory record");
  validateMemory(data.nunc);
  return structuredClone(data.nunc);
}

function requireManual(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EngineError("INPUT", message);
}

function checkpointMemory(latest: Extract<SessionEntry, { type: "compaction" }>): Memory {
  const details: unknown = latest.details;
  if (record(details) && "nunc" in details) {
    validateMemory(details.nunc);
    const expectedCurrent = renderMemory(details.nunc.slots);
    const expectedLegacy = legacyRenderMemory(details.nunc.slots);
    if (latest.summary !== expectedCurrent && latest.summary !== expectedLegacy) {
      throw new EngineError("INPUT", "Nunc snapshot and summary disagree");
    }
    return structuredClone(details.nunc);
  }
  if (latest.summary.trim()) {
    const trimmed = latest.summary.trim();
    if (trimmed.startsWith("Nunc working memory (session-local")) {
      const newline = trimmed.indexOf("\n");
      if (newline >= 0) {
        try {
          const parsed = JSON.parse(trimmed.slice(newline + 1));
          if (Array.isArray(parsed)) {
            const memory: Memory = { version: 1, nextId: 1, slots: parsed };
            validateMemory(memory);
            return memory;
          }
        } catch {
          throw new EngineError("INPUT", "Corrupt legacy memory summary");
        }
      }
      throw new EngineError("INPUT", "Corrupt legacy memory summary");
    }
    return { version: 1, nextId: 1, slots: [{ id: "legacy", text: latest.summary }] };
  }
  return emptyMemory();
}

/** Entries after the latest native checkpoint on the selected path. Kept-range history is not replayed. */
export function entriesAfterLatestCheckpoint(entries: readonly SessionEntry[], latestId?: string): readonly SessionEntry[] {
  if (latestId === undefined) return entries;
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const leaf = entries.at(-1);
  if (!leaf || leaf.id === latestId) return [];
  const after: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && current.id !== latestId) {
    if (seen.has(current.id)) throw new EngineError("INPUT", "Session path cycle");
    seen.add(current.id);
    after.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return current ? after.reverse() : [];
}

export function memoryRevision(sessionId: string, leafId: string | null, entries: readonly SessionEntry[]): string {
  const latest = entries.find(entry => entry.type === "compaction");
  const head = entriesAfterLatestCheckpoint(entries, latest?.id).findLast(isManualMemoryEntry)?.id ?? "";
  return `${sessionId}\n${latest?.id ?? ""}\n${head}\n${leafId ?? ""}`;
}

/** Same session/checkpoint/manual head, and the read leaf is still the selected leaf or an ancestor of it. */
export function revisionApplies(revision: string, sessionId: string, leafId: string | null, entries: readonly SessionEntry[], branch: readonly { id: string }[]): boolean {
  const current = memoryRevision(sessionId, leafId, entries);
  const read = revision.split("\n");
  const now = current.split("\n");
  if (read.length !== 4 || now.length !== 4 || read[0] !== now[0] || read[1] !== now[1] || read[2] !== now[2]) return false;
  return read[3] === now[3] || Boolean(read[3] && branch.some(entry => entry.id === read[3]));
}

/** Input MUST be buildContextEntries() for the selected leaf, never getEntries(). */
export function project(entries: readonly SessionEntry[]): { memory: Memory; active: ActiveEntry[]; cleanup: ToolResultDecision[]; unavailable: string[]; latestId?: string } {
  const latest = entries.find(e => e.type === "compaction");
  let memory = emptyMemory();
  let saved = readDecisions(undefined);
  if (latest?.type === "compaction") {
    memory = checkpointMemory(latest);
    saved = readDecisions(latest.details);
  }
  for (const entry of entriesAfterLatestCheckpoint(entries, latest?.id)) {
    if (isManualMemoryEntry(entry)) {
      memory = decodeManualMemory(entry.data);
      saved = readDecisions(entry.data);
    }
  }
  const active: ActiveEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") continue;
    if (entry.type === "message" && isSystemMessage(entry.message)) continue;
    // Native transports omit failed assistants; overflow also removes the final
    // failed assistant from live state before retry. They cannot be a K boundary.
    if (entry.type === "message" && entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason)) continue;
    const raw = sessionEntryToContextMessages(entry).filter(m => m.role !== "compactionSummary");
    const messages = convertToLlm(raw);
    if (!messages.length) continue;
    const sourceRole = raw[0]?.role;
    if (!sourceRole || !["user", "assistant", "toolResult", "custom", "bashExecution", "branchSummary"].includes(sourceRole)) {
      throw new EngineError("UNSUPPORTED_INPUT", `Unsupported visible entry ${entry.id}`);
    }
    active.push({ entryId: entry.id, sourceRole: sourceRole as ActiveEntry["sourceRole"], messages: structuredClone(messages) });
  }
  const byId = new Map(active.map(entry => [entry.entryId, entry]));
  const unavailable: string[] = [...saved.invalid];
  const valid: ToolResultDecision[] = [];
  for (const decision of saved.valid) {
    const source = byId.get(decision.entryId)?.messages[decision.messageIndex];
    const text = sourceText(active, decision);
    if (source?.role !== "toolResult" || source.toolCallId !== decision.toolCallId || source.toolName !== decision.toolName ||
        text?.length !== decision.originalLength || text === undefined || sourceDigest(text) !== decision.sourceDigest) {
      unavailable.push(`${decision.entryId}:${decision.messageIndex}`);
    } else valid.push(decision);
  }
  const validIds = new Set(valid.map(d => `${d.entryId}:${d.messageIndex}`));
  const cleanup = valid.filter(d => !d.sourceRefs?.some(ref =>
    !byId.get(ref.entryId)?.messages[ref.messageIndex] || validIds.has(`${ref.entryId}:${ref.messageIndex}`)));
  for (const d of valid) if (!cleanup.includes(d)) unavailable.push(`${d.entryId}:${d.messageIndex}`);
  return { memory, active, cleanup, unavailable, ...(latest ? { latestId: latest.id } : {}) };
}

export function effectiveActive(projected: ReturnType<typeof project>, enabled: boolean): ActiveEntry[] {
  return enabled ? applyToolResultCleanup(projected.active, projected.cleanup) : structuredClone(projected.active);
}

export function eligibleCleanupScope(active: ActiveEntry[], prefixEntryIds: readonly string[], saved: readonly ToolResultDecision[]): ToolResultRef[] {
  if (!prefixEntryIds.length || active.length <= prefixEntryIds.length ||
      !prefixEntryIds.every((id, index) => active[index]?.entryId === id)) return [];
  const groups: { index: number; business: boolean; pending: Set<string>; results: ToolResultRef[] }[] = [];
  const open = new Map<string, { group: typeof groups[number]; name: string }>();
  for (const [index, entry] of active.entries()) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        const calls = message.content.filter(b => b.type === "toolCall");
        if (calls.length) {
          const group = { index, business: calls.some(c => !c.name.startsWith("nunc_memory_")), pending: new Set(calls.map(c => c.id)), results: [] as ToolResultRef[] };
          groups.push(group);
          for (const call of calls) {
            if (open.has(call.id)) return []; // ambiguous pending association
            open.set(call.id, { group, name: call.name });
          }
        }
      } else if (message.role === "toolResult") {
        const call = open.get(message.toolCallId);
        if (!call || call.name !== message.toolName) return [];
        call.group.results.push({ entryId: entry.entryId, messageIndex });
        call.group.pending.delete(message.toolCallId);
        open.delete(message.toolCallId);
      }
    }
  }
  const newestBusiness = groups.findLast(group => group.business && group.pending.size === 0);
  const savedKeys = new Set(saved.map(d => `${d.entryId}:${d.messageIndex}`));
  const allowed = new Set(groups.filter(group => group.business && group.pending.size === 0 && group !== newestBusiness)
    .flatMap(group => group.results).map(ref => `${ref.entryId}:${ref.messageIndex}`));
  return active.slice(prefixEntryIds.length).flatMap(entry => entry.messages.flatMap((message, messageIndex) => {
    const key = `${entry.entryId}:${messageIndex}`;
    return message.role === "toolResult" && allowed.has(key) && !savedKeys.has(key) ? [{ entryId: entry.entryId, messageIndex }] : [];
  }));
}

export function originalResults(projected: ReturnType<typeof project>, refs: ToolResultRef[]): { ref: ToolResultRef; text?: string; error?: string; toolName?: string; isError?: boolean }[] {
  return refs.map(ref => {
    const message = projected.active.find(entry => entry.entryId === ref.entryId)?.messages[ref.messageIndex];
    if (message?.role !== "toolResult") return { ref, error: "Original unavailable on selected path" };
    if (!Array.isArray(message.content) || !message.content.every(b => b.type === "text")) return { ref, error: "Original contains non-text blocks" };
    return { ref, text: message.content.map(b => b.text).join(""), toolName: message.toolName, isError: message.isError };
  });
}

// Provenance stays process-local and cannot be copied with message text/fields.
const carriers = new WeakSet<object>();
const LAYOUT_KEY = Symbol.for("nunc.memory.observer-layout");
const anchors = new Map<string, MemoryAnchor>();

interface MemoryAnchor {
  sessionId: string;
  content: string;
  prefixLength: number;
  prefixEntryIds: string[];
  boundary?: { entryId: string; messages: unknown[] };
}
type LayoutMessage = {
  role: string;
  stopReason?: string;
  customType?: string;
  summary?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
};
export type MemorySession = {
  sessionId: string;
  latestId?: string | undefined;
  entries?: readonly SessionEntry[];
  decisions?: readonly ToolResultDecision[];
  enabled?: boolean;
};

/** Observer/test baseline only. Production never sets this; missing/other values stay stable. */
export function setObserverMemoryLayout(mode: "stable" | "moving"): void {
  (globalThis as Record<symbol, unknown>)[LAYOUT_KEY] = mode === "moving" ? "moving" : "stable";
}
function observerMoving(): boolean {
  return (globalThis as Record<symbol, unknown>)[LAYOUT_KEY] === "moving";
}
export function clearMemoryAnchors(sessionId?: string): void {
  if (sessionId === undefined) anchors.clear();
  else anchors.delete(sessionId);
}
export function peekMemoryAnchor(sessionId: string): { content: string; prefixLength: number; prefixEntryIds: string[] } | undefined {
  const anchor = anchors.get(sessionId);
  return anchor ? { content: anchor.content, prefixLength: anchor.prefixLength, prefixEntryIds: [...anchor.prefixEntryIds] } : undefined;
}
/** Current UI index only when the stored prefix still corresponds to visible selected-path entries. */
export function currentMemoryIndex(sessionId: string, memory: Memory, active: readonly { entryId: string; messages: readonly unknown[] }[]): number | undefined {
  const anchor = anchors.get(sessionId);
  if (!anchor || memory.slots.length === 0 || anchor.content !== renderMemory(memory.slots)) return;
  if (!anchor.boundary) return;
  const index = active.findIndex(entry => entry.entryId === anchor.boundary!.entryId);
  if (index < 0) return;
  return active.slice(0, index + 1).reduce((n, entry) => n + entry.messages.length, 0);
}
export function isNuncCarrier(message: object): boolean {
  return carriers.has(message);
}
export function carrierIndexIn(messages: readonly object[]): number | undefined {
  const index = messages.findIndex(message => carriers.has(message));
  return index >= 0 ? index : undefined;
}
/** Process-local provenance only. Cloned/serialized views need an explicit bound snapshot. */
export function injectedCarrierIndex(messages: readonly LayoutMessage[]): number | undefined {
  const hits = messages.flatMap((message, index) => carriers.has(message) ? [index] : []);
  return hits.length === 1 ? hits[0] : undefined;
}
function recordToolId(block: unknown): string[] {
  if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") return [];
  return [String("id" in block ? block.id ?? "" : "")];
}
function applyToolBoundary(pending: Set<string>, message: LayoutMessage): void {
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const id of message.content.flatMap(block => recordToolId(block))) if (id) pending.add(id);
  } else if (message.role === "toolResult" && message.toolCallId) {
    pending.delete(String(message.toolCallId));
  }
}
function hasPendingTools(messages: readonly LayoutMessage[], end: number): boolean {
  const pending = new Set<string>();
  for (let i = 0; i < end; i++) applyToolBoundary(pending, messages[i]!);
  return pending.size > 0;
}
function legalTail(messages: readonly LayoutMessage[]): number {
  let last = 0;
  const pending = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    applyToolBoundary(pending, messages[i]!);
    if (pending.size === 0) last = i + 1;
  }
  return last;
}
function snapshot(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}
type MessageKey = (value: unknown) => string | undefined;
/** Request-local keys preserve JSON snapshot equality, including unordered object
 * fields. Never retain this cache across calls: another hook can mutate an object.
 */
function messageKeys(): MessageKey {
  const cache = new WeakMap<object, string | undefined>();
  return value => {
    const object = typeof value === "object" && value !== null ? value : undefined;
    if (object && cache.has(object)) return cache.get(object);
    const normalized = snapshot(value);
    const key = normalized === undefined ? undefined : JSON.stringify(normalized, (_name, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
    if (object) cache.set(object, key);
    return key;
  };
}
function sameMessage(left: unknown, right: unknown, key: MessageKey): boolean {
  const a = key(left), b = key(right);
  return a !== undefined && b !== undefined && a === b;
}
function sourceUnits(entries: readonly SessionEntry[]): { entryId: string; messages: ReturnType<typeof sessionEntryToContextMessages> }[] {
  const units: { entryId: string; messages: ReturnType<typeof sessionEntryToContextMessages> }[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") continue;
    if (entry.type === "message" && isSystemMessage(entry.message)) continue;
    if (entry.type === "message" && entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason)) continue;
    const raw = sessionEntryToContextMessages(entry).filter(message => message.role !== "compactionSummary" && !(message.role === "custom" && message.customType === "nunc.memory"));
    if (!raw.length) continue;
    units.push({ entryId: entry.id, messages: raw });
  }
  return units;
}
function matchesAt(hook: readonly LayoutMessage[], start: number, unit: readonly object[], key: MessageKey): boolean {
  return unit.every((message, offset) => sameMessage(hook[start + offset], message, key));
}
type SourceUnit = { entryId: string; messages: readonly object[] };
/** A whole native unit must have a unique correspondence in both views.
 * Unmapped/transformed or repeated units never establish source provenance.
 */
function mappedBoundaries(hook: readonly LayoutMessage[], units: readonly SourceUnit[], key: MessageKey): { unit: SourceUnit; end: number }[] {
  const unitKeys = units.map(unit => key(unit.messages));
  const counts = new Map<string, number>();
  for (const value of unitKeys) if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  const positions = new Map<string, number[]>();
  for (const [index, message] of hook.entries()) {
    const value = key(message);
    if (value === undefined) continue;
    const starts = positions.get(value);
    if (starts) starts.push(index); else positions.set(value, [index]);
  }
  return units.flatMap((unit, index) => {
    const value = unitKeys[index];
    if (value === undefined || counts.get(value) !== 1 || !unit.messages.length) return [];
    const first = key(unit.messages[0]);
    if (first === undefined) return [];
    let end: number | undefined;
    for (const start of positions.get(first) ?? []) {
      if (start + unit.messages.length > hook.length || !matchesAt(hook, start, unit.messages, key)) continue;
      if (end !== undefined) return []; // A second exact occurrence is ambiguous.
      end = start + unit.messages.length;
    }
    return end === undefined ? [] : [{ unit, end }];
  });
}
function reusableIndex(messages: readonly LayoutMessage[], anchor: MemoryAnchor, mapped: ReturnType<typeof mappedBoundaries>, key: MessageKey): number | undefined {
  const boundary = anchor.boundary;
  if (!boundary) return;
  const found = mapped.find(item => item.unit.entryId === boundary.entryId && sameMessage(item.unit.messages, boundary.messages, key));
  if (!found) return;
  const index = found.end;
  if (!hasPendingTools(messages, index)) return index;
}

export function withEffectiveMemory<T extends LayoutMessage>(messages: readonly T[], memory: Memory, session?: MemorySession): T[] {
  const stripped: T[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.stopReason && ["error", "aborted"].includes(message.stopReason)) continue;
    if (message.role === "compactionSummary") continue;
    if (message.role === "custom" && message.customType === "nunc.memory") continue;
    if (carriers.has(message)) continue;
    stripped.push(message);
  }
  const content = renderMemory(memory.slots);
  const key = messageKeys();
  const units = session?.entries ? sourceUnits(session.entries) : [];
  const decisions = new Map((session?.decisions ?? []).map(d => [`${d.entryId}:${d.messageIndex}`, d]));
  // Pi can carry a previous context-hook projection into the next turn. Match
  // either immutable native units or our *exact* earlier replacement and first
  // restore only that known replacement. A foreign or ambiguous rewrite remains
  // unmapped; disabling cleanup then really restores current active originals.
  const ownUnits = units.map(unit => ({ entryId: unit.entryId, messages: unit.messages.map((message, i) => {
    const d = decisions.get(`${unit.entryId}:${i}`);
    return d && message.role === "toolResult" && message.toolCallId === d.toolCallId && message.toolName === d.toolName &&
      Array.isArray(message.content) && message.content.every(b => b.type === "text") && message.content.map(b => b.text).join("").length === d.originalLength
      ? { ...structuredClone(message), content: [{ type: "text" as const, text: d.text }] } : message;
  }) }));
  const patched = [...stripped];
  const rawMapped = mappedBoundaries(stripped, units, key);
  for (const owned of mappedBoundaries(stripped, ownUnits, key)) {
    const index = units.findIndex(unit => unit.entryId === owned.unit.entryId);
    if (index < 0 || rawMapped.some(item => item.unit === units[index])) continue;
    const raw = units[index]!;
    const start = owned.end - raw.messages.length;
    raw.messages.forEach((message, offset) => { patched[start + offset] = structuredClone(message) as T; });
  }
  // Match immutable native source units before changing any tool body. A foreign
  // hook rewrite or ambiguous repeated unit cannot establish provenance.
  const nativeMapped = mappedBoundaries(patched, units, key);
  const effectiveUnits = units.map(unit => {
    const found = nativeMapped.find(item => item.unit === unit);
    const start = found ? found.end - unit.messages.length : -1;
    return { entryId: unit.entryId, messages: unit.messages.map((message, messageIndex) => {
      const decision = session?.enabled === false ? undefined : decisions.get(`${unit.entryId}:${messageIndex}`);
      if (start < 0 || !decision || message.role !== "toolResult" ||
          message.toolCallId !== decision.toolCallId || message.toolName !== decision.toolName ||
          !Array.isArray(message.content) || !message.content.every(b => b.type === "text") ||
          message.content.map(b => b.text).join("").length !== decision.originalLength) return message;
      const replaced = { ...structuredClone(message), content: [{ type: "text" as const, text: decision.text }] };
      patched[start + messageIndex] = replaced as unknown as T;
      return replaced;
    }) };
  });
  if (memory.slots.length === 0) {
    if (session) anchors.delete(session.sessionId);
    return patched;
  }
  const existing = session && !observerMoving() ? anchors.get(session.sessionId) : undefined;
  const mapped = mappedBoundaries(patched, effectiveUnits, key);
  const reuse = existing?.content === content ? reusableIndex(patched, existing, mapped, key) : undefined;
  const index = reuse ?? legalTail(patched);
  const carrier = {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp: 0,
  } as unknown as T;
  carriers.add(carrier);
  if (session) {
    // Bind only an actual source endpoint. An unmapped/transformed/extension
    // tail has no reusable source provenance; preserve it and rebuild next time.
    const prior = mapped.filter(item => item.end <= index).sort((a, b) => a.end - b.end);
    const last = prior.find(item => item.end === index);
    anchors.set(session.sessionId, {
      sessionId: session.sessionId, content, prefixLength: index,
      prefixEntryIds: prior.map(item => item.unit.entryId),
      ...(last ? { boundary: { entryId: last.unit.entryId, messages: last.unit.messages.map(snapshot) } } : {}),
    });
  }
  return [...patched.slice(0, index), carrier, ...patched.slice(index)];
}

/** Visible real history may overlap earlier checkpoints. Summary normalization
 * belongs to context/source projection, never to an artificially advanced cut.
 */
export function eligibleStarts(branch: readonly SessionEntry[], active: readonly ActiveEntry[], latestId?: string): string[] {
  const index = latestId === undefined ? -1 : branch.findIndex(e => e.id === latestId);
  if (latestId !== undefined && index < 0) throw new EngineError("INPUT", "Latest snapshot is outside the current branch");
  const visible = new Set(active.map(e => e.entryId));
  return branch.filter(e => visible.has(e.id)).map(e => e.id);
}
