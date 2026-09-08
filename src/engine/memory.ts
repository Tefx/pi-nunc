import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { Memory, RequiredObservation, Slot } from "./types.js";
import { EngineError, integer, keys, nonempty, record, requireThat, validateMemory } from "./validation.js";

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

export interface Patch {
  add: { key: string; text: string }[];
  remove: string[];
  priority: string[];
  required: string[];
}
export interface PatchResult {
  memory: Memory;
  droppedSlotIds: string[];
  required: RequiredObservation;
}
export const RESPONSE_CONTRACT = `Return ONLY one JSON object, with exactly these four required fields:
{"add":[{"key":"new1","text":"self-contained note"}],"remove":["old-id"],"priority":["new1","surviving-old-id"],"required":["new1"]}
add: zero or more new candidates. Keys must be unique nonempty strings, distinct from ALL existing slot IDs. Text must be nonempty. Markdown is encouraged inside text (lists, paragraphs, inline code, and necessary short code blocks).
remove: each existing slot explicitly invalidated/retired, exactly once. Replacement/merge means removing the old IDs AND adding a candidate.
priority: ALL surviving old IDs and ALL added keys, each exactly once, most valuable first. Omission is invalid, never silent deletion.
required: subset of priority identifying the active task focus and all necessary continuation items (surviving old IDs or added keys). Every declared required slot must be retained jointly; if the required set cannot fit within capacity, maintenance fails. Empty array is valid when no active focus or necessary continuation items exist.
Unchanged slots reuse their bodies; do not regenerate them. Priority controls whole-slot capacity selection for optional items, not memory order. Old survivors keep relative order; additions append.
An invalidated old slot stays removed even if its replacement cannot fit. Empty arrays and empty memory are valid. No tools, outer code fences around the JSON, commentary, or rewriting retained history.`;

export function parsePatch(value: unknown, memory: Memory): Patch {
  requireThat(
    record(value) &&
    keys(value, ["add", "remove", "priority", "required"]) &&
    Array.isArray(value.add) &&
    Array.isArray(value.remove) &&
    Array.isArray(value.priority) &&
    Array.isArray(value.required),
    "RESPONSE",
    "Expected exactly add/remove/priority/required arrays"
  );
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
    added.add(item.key);
    candidates.add(item.key);
    add.push({ key: item.key, text: item.text });
  }
  const allCandidateKeys = new Set(candidates);
  const priority: string[] = [];
  for (const ref of value.priority) {
    requireThat(typeof ref === "string" && candidates.delete(ref), "RESPONSE", "Unknown or duplicate priority reference");
    priority.push(ref);
  }
  requireThat(candidates.size === 0, "RESPONSE", "priority omitted surviving/addition references");

  const required: string[] = [];
  const seenRequired = new Set<string>();
  for (const ref of value.required) {
    requireThat(
      typeof ref === "string" && allCandidateKeys.has(ref) && !seenRequired.has(ref),
      "RESPONSE",
      "Unknown or duplicate required reference"
    );
    seenRequired.add(ref);
    required.push(ref);
  }

  return { add, remove: [...removed], priority, required };
}

export function applyPatch(
  memory: Memory,
  value: unknown,
  limit: number,
  measure: (slots: Slot[]) => number
): PatchResult {
  validateMemory(memory);
  requireThat(integer(limit), "CONFIG", "Invalid memory budget");
  const patch = parsePatch(value, memory);
  const removed = new Set(patch.remove);
  const allIds = new Set(memory.slots.map(s => s.id));
  let nextId = memory.nextId;
  const candidates = memory.slots
    .filter(s => !removed.has(s.id))
    .map(slot => ({ key: slot.id, slot: { ...slot } }));
  for (const addition of patch.add) {
    let id: string;
    do {
      requireThat(integer(nextId + 1, 1), "INPUT", "Memory ID counter exhausted");
      id = `s${nextId++}`;
    } while (allIds.has(id));
    allIds.add(id);
    candidates.push({ key: addition.key, slot: { id, text: addition.text } });
  }

  const requiredKeys = new Set(patch.required);
  // Verify that all declared required items can jointly fit within limit.
  const requiredCandidates = candidates.filter(c => requiredKeys.has(c.key));
  const requiredProposal = requiredCandidates.map(c => c.slot);
  if (measure(requiredProposal) > limit) {
    const err = new EngineError("CAPACITY", "Declared required memory items cannot fit within memory limit");
    (err as unknown as { required: RequiredObservation }).required = {
      declared: patch.required,
      retainedSlotIds: [],
      failed: true,
    };
    throw err;
  }

  const natural = candidates.map(c => c.slot);
  const selected = new Set<string>(patch.required);
  if (measure(natural) <= limit) {
    candidates.forEach(c => selected.add(c.key));
  } else {
    for (const key of patch.priority) {
      if (selected.has(key)) continue;
      // Measure in final rendering order, including each ID and all wrapping.
      const proposal = candidates.filter(c => selected.has(c.key) || c.key === key).map(c => c.slot);
      if (measure(proposal) <= limit) {
        selected.add(key);
      }
    }
  }

  const finalSlots = candidates.filter(c => selected.has(c.key)).map(c => c.slot);
  const retainedSlotMap = new Map(candidates.map(c => [c.key, c.slot.id]));
  const retainedRequiredSlotIds = patch.required.map(key => retainedSlotMap.get(key)!);

  return {
    memory: { version: 1, nextId, slots: finalSlots },
    droppedSlotIds: candidates.filter(c => !selected.has(c.key)).map(c => c.slot.id),
    required: {
      declared: patch.required,
      retainedSlotIds: retainedRequiredSlotIds,
      failed: false,
    },
  };
}
