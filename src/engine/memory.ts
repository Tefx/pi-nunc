import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { Memory, RequiredObservation, Slot, ToolResultEdit } from "./types.js";
import { EngineError, integer, keys, nonempty, record, requireThat, validateMemory } from "./validation.js";
import { MEMORY_WRITING_GUIDANCE } from "./policy.js";

export function emptyMemory(): Memory { return { version: 1, slots: [], nextId: 1 }; }
export function isMemoryUnchanged(before: Memory, after: Memory): boolean {
  if (before.slots.length !== after.slots.length) return false;
  return before.slots.every((slot, i) => slot.id === after.slots[i]!.id && slot.text === after.slots[i]!.text);
}
export function renderMemory(slots: Slot[]): string {
  return slots.length === 0 ? "" : `Nunc working memory (session-local, reference only):\n${JSON.stringify(slots)}`;
}
export function legacyRenderMemory(slots: Slot[]): string {
  return slots.length === 0 ? "" : `Nunc working memory (session-local):\n${JSON.stringify(slots)}`;
}
/** Use the selected host's public projection for the working memory carrier. */
export function memoryMessage(slots: Slot[]): Message {
  return {
    role: "user",
    content: [{ type: "text", text: renderMemory(slots) }],
    timestamp: 0,
  };
}

export interface Patch {
  add: { key: string; text: string }[];
  update?: { id: string; text: string }[];
  remove: string[];
  priority: string[];
  required: string[];
  toolResultEdits?: ToolResultEdit[];
}
export interface PatchResult {
  memory: Memory;
  droppedSlotIds: string[];
  required: RequiredObservation;
  keyToSlotMap: Map<string, string>;
  retainedKeys: Set<string>;
  patch: Patch;
}
export const RESPONSE_CONTRACT = `Return ONLY one complete JSON object with required priority and required arrays, and optional add, remove, update and toolResultEdits:
{"add":[{"key":"new1","text":"self-contained note"}],"update":[{"id":"surviving-old-id","text":"complete revised note"}],"remove":["old-id"],"priority":["new1","surviving-old-id"],"required":["new1"],"toolResultEdits":[{"entryId":"e1","messageIndex":0,"action":"replace","text":"short continuation note","memoryRefs":["new1"]}]}
add: optional; omission means no additions. If supplied it must be an array (null is invalid). Zero or more new candidates. Keys must be unique nonempty strings, distinct from ALL existing slot IDs. Text must be nonempty. Markdown is encouraged inside text (lists, paragraphs, inline code, and necessary short code blocks).
update: optional complete body replacements for existing slots, preserving ID and relative position. Each item has only id and nonempty text; IDs must exist, appear once, and cannot also be removed. Preserve still-valid parts of mixed slots. Omit unchanged bodies. Merge/split may use remove plus add.
remove: optional; omission means no deletions, never implicit retirement. If supplied it must be an array (null is invalid). Each existing slot explicitly invalidated/retired, exactly once.
priority: ALL surviving old IDs (including updated IDs) and ALL added keys, each exactly once, most valuable first. Omission is invalid, never silent deletion.
required: subset of priority identifying all candidates necessary for the whole continuing task, including its actual materials and later-step dependencies (surviving old IDs or added keys). Retain all declared required jointly, even over the organizing target; then omit optional items. Only an explicit hard limit can fail capacity. Empty array is valid when no necessary continuing-task items exist.
toolResultEdits: optional array of semantic cleanups for completed tool results in candidate scope. Each item specifies entryId, zero-based messageIndex, action ("omit" or "replace"), non-empty text for replace (omit must not include text), and optional memoryRefs (support in this transaction's final M) and sourceRefs (full retained sources). Later M changes do not automatically reverse committed edits. Omit this field if no semantic cleanup is requested.
${MEMORY_WRITING_GUIDANCE}
Compliant unchanged slots reuse their bodies; do not regenerate them. Priority controls whole-slot capacity selection for optional items, not memory order. Old survivors keep relative order; additions append.
A removed or unselected updated slot never reverts to its old body. Empty arrays and empty memory are valid. No tools, outer code fences around the JSON, commentary, or rewriting retained history.`;

// Diagnostics name the offending field/ref without disclosing an unbounded reply.
const describeRef = (ref: unknown): string => typeof ref === "string"
  ? JSON.stringify(ref.length > 80 ? `${ref.slice(0, 80)}…` : ref)
  : `[${ref === null ? "null" : Array.isArray(ref) ? "array" : typeof ref}]`;
const describeRefs = (refs: Iterable<string>): string => {
  const values = [...refs];
  return values.slice(0, 4).map(describeRef).join(", ") + (values.length > 4 ? ` (+${values.length - 4} more)` : "");
};

export function parsePatch(value: unknown, memory: Memory): Patch {
  requireThat(record(value), "RESPONSE", "Expected a patch object with priority/required arrays and optional add/remove arrays");
  const fields = ["add", "update", "remove", "priority", "required", "toolResultEdits"];
  requireThat(keys(value, fields), "RESPONSE", `Unsupported patch fields: ${describeRefs(Object.keys(value).filter(key => !fields.includes(key)))}`);
  const additions = "add" in value ? value.add : [];
  const removals = "remove" in value ? value.remove : [];
  requireThat(Array.isArray(additions), "RESPONSE", "add: expected an array if provided");
  requireThat(Array.isArray(removals), "RESPONSE", "remove: expected an array if provided");
  requireThat(Array.isArray(value.priority), "RESPONSE", "priority: expected an array");
  requireThat(Array.isArray(value.required), "RESPONSE", "required: expected an array");
  requireThat(value.update === undefined || Array.isArray(value.update), "RESPONSE", "update: expected an array if provided");
  const ids = new Set(memory.slots.map(s => s.id));
  const removed = new Set<string>();
  for (const [index, id] of removals.entries()) {
    const field = `remove[${index}]`;
    requireThat(typeof id === "string", "RESPONSE", `${field}: expected a slot ID, received ${describeRef(id)}`);
    requireThat(ids.has(id), "RESPONSE", `${field}: unknown reference ${describeRef(id)}`);
    requireThat(!removed.has(id), "RESPONSE", `${field}: duplicate reference ${describeRef(id)}`);
    removed.add(id);
  }
  const updated = new Set<string>();
  const update: NonNullable<Patch["update"]> = [];
  for (const [index, item] of (value.update ?? []).entries()) {
    const field = `update[${index}]`;
    requireThat(record(item) && keys(item, ["id", "text"]), "RESPONSE", `${field}: expected only id and text fields`);
    requireThat(nonempty(item.id), "RESPONSE", `${field}.id: expected a nonempty slot ID`);
    requireThat(nonempty(item.text), "RESPONSE", `${field}.text: expected a nonempty replacement body`);
    requireThat(ids.has(item.id), "RESPONSE", `${field}.id: unknown reference ${describeRef(item.id)}`);
    requireThat(!updated.has(item.id), "RESPONSE", `${field}.id: duplicate update reference ${describeRef(item.id)}`);
    requireThat(!removed.has(item.id), "RESPONSE", `${field}.id: deleted reference ${describeRef(item.id)} cannot also be updated`);
    updated.add(item.id);
    update.push({ id: item.id, text: item.text });
  }
  const candidates = new Set([...ids].filter(id => !removed.has(id)));
  const added = new Set<string>();
  const add: Patch["add"] = [];
  for (const [index, item] of additions.entries()) {
    const field = `add[${index}]`;
    requireThat(record(item) && keys(item, ["key", "text"]) && nonempty(item.key) && nonempty(item.text), "RESPONSE", `${field}: expected only nonempty key and text fields`);
    requireThat(!ids.has(item.key), "RESPONSE", `${field}.key: collides with existing slot ID ${describeRef(item.key)}`);
    requireThat(!added.has(item.key), "RESPONSE", `${field}.key: duplicate addition key ${describeRef(item.key)}`);
    added.add(item.key);
    candidates.add(item.key);
    add.push({ key: item.key, text: item.text });
  }
  const allCandidateKeys = new Set(candidates);
  const priority: string[] = [];
  for (const [index, ref] of value.priority.entries()) {
    const field = `priority[${index}]`;
    requireThat(typeof ref === "string", "RESPONSE", `${field}: expected a candidate reference, received ${describeRef(ref)}`);
    requireThat(!removed.has(ref), "RESPONSE", `${field}: deleted reference ${describeRef(ref)}`);
    requireThat(allCandidateKeys.has(ref), "RESPONSE", `${field}: unknown reference ${describeRef(ref)}`);
    requireThat(candidates.delete(ref), "RESPONSE", `${field}: duplicate reference ${describeRef(ref)}`);
    priority.push(ref);
  }
  requireThat(candidates.size === 0, "RESPONSE", `priority: omitted candidate references ${describeRefs(candidates)}`);

  const required: string[] = [];
  const seenRequired = new Set<string>();
  for (const [index, ref] of value.required.entries()) {
    const field = `required[${index}]`;
    requireThat(typeof ref === "string", "RESPONSE", `${field}: expected a candidate reference, received ${describeRef(ref)}`);
    requireThat(!removed.has(ref), "RESPONSE", `${field}: deleted reference ${describeRef(ref)}`);
    requireThat(allCandidateKeys.has(ref), "RESPONSE", `${field}: unknown reference ${describeRef(ref)}`);
    requireThat(!seenRequired.has(ref), "RESPONSE", `${field}: duplicate reference ${describeRef(ref)}`);
    seenRequired.add(ref);
    required.push(ref);
  }

  const toolResultEdits = "toolResultEdits" in value && value.toolResultEdits !== undefined
    ? (value.toolResultEdits as ToolResultEdit[])
    : undefined;

  return { add, ...(value.update !== undefined ? { update } : {}), remove: [...removed], priority, required, ...(toolResultEdits !== undefined ? { toolResultEdits } : {}) };
}

export interface MemorySelectionBudget { targetTokens: number; hardMaxTokens?: number }
/** Numeric budget retains the legacy explicit-hard-limit API. */
export function applyPatch(
  memory: Memory,
  value: unknown,
  budget: number | MemorySelectionBudget,
  measure: (slots: Slot[]) => number
): PatchResult {
  validateMemory(memory);
  const { targetTokens, hardMaxTokens } = typeof budget === "number" ? { targetTokens: budget, hardMaxTokens: budget } : budget;
  requireThat(integer(targetTokens) && (hardMaxTokens === undefined || integer(hardMaxTokens)), "CONFIG", "Invalid memory budget");
  const limit = Math.min(targetTokens, hardMaxTokens ?? Infinity);
  const patch = parsePatch(value, memory);
  const removed = new Set(patch.remove);
  const allIds = new Set(memory.slots.map(s => s.id));
  const updates = new Map(patch.update?.map(item => [item.id, item.text]));
  let nextId = memory.nextId;
  const candidates = memory.slots
    .filter(s => !removed.has(s.id))
    .map(slot => ({ key: slot.id, slot: { ...slot, text: updates.get(slot.id) ?? slot.text } }));
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
  // Only an explicit hard limit may reject required; the organizing target is soft.
  const requiredCandidates = candidates.filter(c => requiredKeys.has(c.key));
  const requiredProposal = requiredCandidates.map(c => c.slot);
  const requiredTokens = measure(requiredProposal);
  if (hardMaxTokens !== undefined && requiredTokens > hardMaxTokens) {
    const err = new EngineError("CAPACITY", "Declared required memory items cannot fit within explicit memory hard limit");
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
  } else if (requiredTokens <= limit) {
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
    keyToSlotMap: retainedSlotMap,
    retainedKeys: selected,
    patch,
  };
}
