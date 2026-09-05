import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { Memory, Slot } from "./types.js";
import { integer, keys, nonempty, record, requireThat, validateMemory } from "./validation.js";

export function emptyMemory(): Memory { return { version: 1, slots: [], nextId: 1 }; }
export function renderMemory(slots: Slot[]): string {
  return slots.length === 0 ? "" : `Nunc working memory (session-local):\n${JSON.stringify(slots)}`;
}
/** Use the selected host's public projection so its summary envelope is budgeted too. */
export function memoryMessage(slots: Slot[]): Message {
  const message = convertToLlm([{ role: "compactionSummary", summary: renderMemory(slots), tokensBefore: 0, timestamp: 0 }])[0];
  requireThat(message, "INPUT", "Pi did not project the compaction summary");
  return message;
}

interface Patch { add: { key: string; text: string }[]; remove: string[]; priority: string[] }
export const RESPONSE_CONTRACT = `Return ONLY one JSON object, with exactly these required fields:
{"add":[{"key":"new1","text":"self-contained note"}],"remove":["old-id"],"priority":["new1","surviving-old-id"]}
add: zero or more new candidates. Keys must be unique nonempty strings, distinct from ALL existing slot IDs. Text must be nonempty.
remove: each existing slot explicitly invalidated/retired, exactly once. Replacement/merge means removing the old IDs AND adding a candidate.
priority: ALL surviving old IDs and ALL added keys, each exactly once, most valuable first. Omission is invalid, never silent deletion.
Unchanged slots reuse their bodies; do not regenerate them. Priority controls whole-slot capacity selection, not memory order. Old survivors keep relative order; additions append.
An invalidated old slot stays removed even if its replacement cannot fit. Empty arrays and empty memory are valid. No tools, code fences, commentary, or rewriting retained history.`;

function parsePatch(value: unknown, memory: Memory): Patch {
  requireThat(record(value) && keys(value, ["add", "remove", "priority"]) && Array.isArray(value.add) && Array.isArray(value.remove) && Array.isArray(value.priority), "RESPONSE", "Expected exactly add/remove/priority arrays");
  const ids = new Set(memory.slots.map(s => s.id));
  const removed = new Set<string>();
  for (const id of value.remove) {
    requireThat(typeof id === "string" && ids.has(id) && !removed.has(id), "RESPONSE", "Unknown or duplicate removal");
    removed.add(id);
  }
  const candidates = new Set([...ids].filter(id => !removed.has(id)));
  const added = new Set<string>();
  const add: Patch["add"] = [];
  for (const item of value.add) {
    requireThat(record(item) && keys(item, ["key", "text"]) && nonempty(item.key) && nonempty(item.text), "RESPONSE", "Invalid addition");
    requireThat(!ids.has(item.key) && !added.has(item.key), "RESPONSE", "Addition key collides with an old id or another addition");
    added.add(item.key); candidates.add(item.key); add.push({ key: item.key, text: item.text });
  }
  const priority: string[] = [];
  for (const ref of value.priority) {
    requireThat(typeof ref === "string" && candidates.delete(ref), "RESPONSE", "Unknown or duplicate priority reference");
    priority.push(ref);
  }
  requireThat(candidates.size === 0, "RESPONSE", "priority omitted surviving/addition references");
  return { add, remove: [...removed], priority };
}

export function applyPatch(memory: Memory, value: unknown, limit: number, measure: (slots: Slot[]) => number): { memory: Memory; droppedSlotIds: string[] } {
  validateMemory(memory);
  requireThat(integer(limit), "CONFIG", "Invalid memory budget");
  const patch = parsePatch(value, memory);
  const removed = new Set(patch.remove);
  const allIds = new Set(memory.slots.map(s => s.id));
  let nextId = memory.nextId;
  const candidates = memory.slots.filter(s => !removed.has(s.id)).map(slot => ({ key: slot.id, slot: { ...slot } }));
  for (const addition of patch.add) {
    let id: string;
    do {
      requireThat(integer(nextId + 1, 1), "INPUT", "Memory ID counter exhausted");
      id = `s${nextId++}`;
    } while (allIds.has(id));
    allIds.add(id);
    candidates.push({ key: addition.key, slot: { id, text: addition.text } });
  }
  const natural = candidates.map(c => c.slot);
  const selected = new Set<string>();
  if (measure(natural) <= limit) candidates.forEach(c => selected.add(c.key));
  else {
    const lookup = new Map(candidates.map(c => [c.key, c.slot]));
    for (const key of patch.priority) {
      // Measure in final rendering order, including each ID and all wrapping.
      const proposal = candidates.filter(c => selected.has(c.key) || c.key === key).map(c => c.slot);
      requireThat(lookup.has(key), "RESPONSE", "Missing validated priority reference");
      if (measure(proposal) <= limit) selected.add(key);
    }
  }
  return {
    memory: { version: 1, nextId, slots: candidates.filter(c => selected.has(c.key)).map(c => c.slot) },
    droppedSlotIds: candidates.filter(c => !selected.has(c.key)).map(c => c.slot.id),
  };
}
