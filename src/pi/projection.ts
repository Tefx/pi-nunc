import { isDeepStrictEqual } from "node:util";
import { convertToLlm, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ActiveEntry, Memory } from "../engine/index.js";
import { emptyMemory, renderMemory, legacyRenderMemory } from "../engine/index.js";
import { EngineError, record, validateMemory } from "../engine/validation.js";

/** Private CustomEntry type. Replaceable encoding; not a public SDK. */
export const MANUAL_MEMORY_TYPE = "nunc.memory";

export function isManualMemoryEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
  return entry.type === "custom" && entry.customType === MANUAL_MEMORY_TYPE;
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
export function project(entries: readonly SessionEntry[]): { memory: Memory; active: ActiveEntry[]; latestId?: string } {
  const latest = entries.find(e => e.type === "compaction");
  let memory = emptyMemory();
  if (latest?.type === "compaction") memory = checkpointMemory(latest);
  for (const entry of entriesAfterLatestCheckpoint(entries, latest?.id)) {
    if (isManualMemoryEntry(entry)) memory = decodeManualMemory(entry.data);
  }
  const active: ActiveEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") continue;
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
  return { memory, active, ...(latest ? { latestId: latest.id } : {}) };
}

// Provenance stays process-local and cannot be copied with message text/fields.
const carriers = new WeakSet<object>();
const LAYOUT_KEY = Symbol.for("nunc.memory.observer-layout");
const anchors = new Map<string, MemoryAnchor>();
const CARRIER_PREFIX = "Nunc working memory (session-local, reference only)";

interface MemoryAnchor {
  sessionId: string;
  content: string;
  prefixLength: number;
  prefixSnapshot: unknown[];
  prefixEntryIds: string[];
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
  if (!idsStillOnPath(anchor.prefixEntryIds, active.map(entry => entry.entryId))) return;
  const mapped = active.filter(entry => anchor.prefixEntryIds.includes(entry.entryId)).reduce((n, entry) => n + entry.messages.length, 0);
  if (mapped !== anchor.prefixLength) return;
  return anchor.prefixLength;
}
export function isNuncCarrier(message: object): boolean {
  return carriers.has(message);
}
export function carrierIndexIn(messages: readonly object[]): number | undefined {
  const index = messages.findIndex(message => carriers.has(message));
  return index >= 0 ? index : undefined;
}
/** Locate the injected carrier in cloned/serialized views. Not used to choose an anchor. */
export function injectedCarrierIndex(messages: readonly LayoutMessage[]): number | undefined {
  const hits: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || Number(message.timestamp ?? 0) !== 0) continue;
    if (carrierText(message).startsWith(CARRIER_PREFIX)) hits.push(index);
  }
  return hits.length === 1 ? hits[0] : undefined;
}
function carrierText(message: LayoutMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((block): block is { type: "text"; text: string } => !!block && block.type === "text" && typeof block.text === "string").map(block => block.text).join("");
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
function sameMessage(left: unknown, right: unknown): boolean {
  const a = snapshot(left), b = snapshot(right);
  return a !== undefined && b !== undefined && isDeepStrictEqual(a, b);
}
function sourceUnits(entries: readonly SessionEntry[]): { entryId: string; messages: ReturnType<typeof sessionEntryToContextMessages> }[] {
  const units: { entryId: string; messages: ReturnType<typeof sessionEntryToContextMessages> }[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") continue;
    if (entry.type === "message" && entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason)) continue;
    const raw = sessionEntryToContextMessages(entry).filter(message => message.role !== "compactionSummary" && !(message.role === "custom" && message.customType === "nunc.memory"));
    if (!raw.length) continue;
    units.push({ entryId: entry.id, messages: raw });
  }
  return units;
}
function matchesAt(hook: readonly LayoutMessage[], start: number, unit: readonly object[]): boolean {
  return unit.every((message, offset) => sameMessage(hook[start + offset], message));
}
function mappedEntryIds(hook: readonly LayoutMessage[], end: number, units: readonly { entryId: string; messages: readonly object[] }[]): string[] {
  const prefix = hook.slice(0, end);
  let cursor = 0;
  const ids: string[] = [];
  for (const unit of units) {
    while (cursor + unit.messages.length <= prefix.length && !matchesAt(prefix, cursor, unit.messages)) cursor++;
    if (cursor + unit.messages.length > prefix.length || !matchesAt(prefix, cursor, unit.messages)) break;
    ids.push(unit.entryId);
    cursor += unit.messages.length;
  }
  return ids;
}
function idsStillOnPath(needed: readonly string[], current: readonly string[]): boolean {
  let start = 0;
  for (const id of needed) {
    const found = current.findIndex((entryId, index) => index >= start && entryId === id);
    if (found < 0) return false;
    start = found + 1;
  }
  return true;
}
function prefixSnapshotEqual(messages: readonly LayoutMessage[], anchor: MemoryAnchor): boolean {
  if (anchor.prefixSnapshot.length !== anchor.prefixLength) return false;
  return anchor.prefixSnapshot.every((item, index) => sameMessage(messages[index], item));
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
  if (memory.slots.length === 0) {
    if (session) anchors.delete(session.sessionId);
    return stripped;
  }
  const content = renderMemory(memory.slots);
  const units = session?.entries ? sourceUnits(session.entries) : [];
  const existing = session && !observerMoving() ? anchors.get(session.sessionId) : undefined;
  const reusable = existing &&
    existing.content === content &&
    existing.prefixLength <= stripped.length &&
    prefixSnapshotEqual(stripped, existing) &&
    !hasPendingTools(stripped, existing.prefixLength) &&
    idsStillOnPath(existing.prefixEntryIds, units.map(unit => unit.entryId));
  const index = reusable ? existing.prefixLength : legalTail(stripped);
  const carrier = {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp: 0,
  } as unknown as T;
  carriers.add(carrier);
  if (session) {
    const prefix = stripped.slice(0, index);
    const ids = mappedEntryIds(prefix, prefix.length, units);
    anchors.set(session.sessionId, {
      sessionId: session.sessionId,
      content,
      prefixLength: index,
      prefixSnapshot: prefix.map(message => snapshot(message)),
      prefixEntryIds: ids,
    });
  }
  return [...stripped.slice(0, index), carrier, ...stripped.slice(index)];
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
