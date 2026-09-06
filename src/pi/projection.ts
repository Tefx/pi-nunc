import { convertToLlm, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ActiveEntry, Memory } from "../engine/index.js";
import { emptyMemory, renderMemory } from "../engine/index.js";
import { EngineError, record, validateMemory } from "../engine/validation.js";

/** Input MUST be buildContextEntries() for the selected leaf, never getEntries(). */
export function project(entries: readonly SessionEntry[]): { memory: Memory; active: ActiveEntry[]; latestId?: string } {
  const latest = entries.find(e => e.type === "compaction");
  let memory = emptyMemory();
  if (latest?.type === "compaction") {
    const details: unknown = latest.details;
    if (record(details) && "nunc" in details) {
      validateMemory(details.nunc);
      if (renderMemory(details.nunc.slots) !== latest.summary) throw new EngineError("INPUT", "Nunc snapshot and summary disagree");
      memory = structuredClone(details.nunc);
    } else if (latest.summary.trim()) {
      memory = { version: 1, nextId: 1, slots: [{ id: "legacy", text: latest.summary }] };
    }
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

/** Visible real history may overlap earlier checkpoints. Summary normalization
 * belongs to context/source projection, never to an artificially advanced cut.
 */
export function eligibleStarts(branch: readonly SessionEntry[], active: readonly ActiveEntry[], latestId?: string): string[] {
  const index = latestId === undefined ? -1 : branch.findIndex(e => e.id === latestId);
  if (latestId !== undefined && index < 0) throw new EngineError("INPUT", "Latest snapshot is outside the current branch");
  const visible = new Set(active.map(e => e.entryId));
  return branch.filter(e => visible.has(e.id)).map(e => e.id);
}
