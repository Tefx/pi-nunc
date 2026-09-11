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

export function withEffectiveMemory<T extends { role: string; stopReason?: string; customType?: string; summary?: string }>(messages: readonly T[], memory: Memory): T[] {
  const out: T[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.stopReason && ["error", "aborted"].includes(message.stopReason)) continue;
    if (message.role === "compactionSummary") continue;
    if (message.role === "custom" && message.customType === "nunc.memory") continue;
    if (carriers.has(message)) continue;
    out.push(message);
  }
  if (memory.slots.length > 0) {
    const carrier = {
      role: "user",
      content: [{ type: "text", text: renderMemory(memory.slots) }],
      timestamp: 0,
    } as unknown as T;
    carriers.add(carrier);
    out.push(carrier);
  }
  return out;
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
