import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FixedContext, Memory, Slot } from "../engine/index.js";
import { memoryPlan, memoryTokens } from "../engine/index.js";
import { EngineError, integer, keys, nonempty, record, requireThat, validateMemory } from "../engine/validation.js";
import { engineConfig, readConfig, type HostCompactionSettings } from "./config.js";
import { MANUAL_MEMORY_TYPE, memoryRevision, project, revisionApplies } from "./projection.js";

export type ManualSaveCode = "invalid" | "conflict" | "occupied" | "overbudget" | "unknown-budget" | "unconfirmed" | "cancelled";

export interface MemoryBudgetView {
  tokens: number;
  limit: number | null;
  unknown: boolean;
  overLimit: boolean;
}
export interface MemoryView {
  revision: string;
  memory: Memory;
  status: { occupied: boolean; unconfirmed: boolean };
  budget: MemoryBudgetView;
  contextLayout: { slotCount: number; activeEntries: number; latestCompactionId?: string };
}
export type ManualSaveResult =
  | { ok: true; revision: string; memory: Memory }
  | { ok: false; code: ManualSaveCode; message: string; view: MemoryView };

export interface MemoryPatchParams {
  expectedRevision: string;
  add?: Array<{ key: string; text: string }>;
  update?: Array<{ id: string; text: string }>;
  remove?: string[];
}

export type MemoryPatchResult =
  | { ok: true; revision: string; added: Record<string, string>; budget: { usedTokens: number; limitTokens: number | null }; memory: Memory }
  | { ok: false; code: ManualSaveCode; message: string; view: MemoryView };

export interface MemorySurface {
  read(ctx: ExtensionContext): MemoryView;
  replace(ctx: ExtensionContext, revision: string, slotId: string, text: string): ManualSaveResult;
  delete(ctx: ExtensionContext, revision: string, slotId: string): ManualSaveResult;
  patch(ctx: ExtensionContext, params: MemoryPatchParams, signal?: AbortSignal): MemoryPatchResult;
}
export interface MemoryFreeze extends MemorySurface {
  beginFreeze(): boolean;
  endFreeze(): void;
  noteForeignFailure(): boolean;
}

export function createMemorySurface(options: {
  pi: ExtensionAPI;
  fixed: (ctx: ExtensionContext) => FixedContext;
  settings: (ctx: ExtensionContext) => { compaction: HostCompactionSettings; blockImages: boolean };
  onCommitted: () => void;
}): MemoryFreeze {
  const state = { occupied: false, ignoreFailed: 0 };
  const viewOf = (ctx: ExtensionContext): MemoryView => {
    const entries = ctx.sessionManager.buildContextEntries();
    const projected = project(entries);
    const budget = measureBudget(ctx, options, projected.memory.slots);
    return {
      revision: memoryRevision(ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), entries),
      memory: projected.memory,
      status: { occupied: state.occupied, unconfirmed: sessionUnconfirmed(ctx.sessionManager) },
      budget,
      contextLayout: {
        slotCount: projected.memory.slots.length,
        activeEntries: projected.active.length,
        ...(projected.latestId ? { latestCompactionId: projected.latestId } : {}),
      },
    };
  };
  const surface: MemoryFreeze = {
    beginFreeze() {
      if (state.occupied) { state.ignoreFailed++; return false; }
      state.occupied = true; return true;
    },
    endFreeze() { state.occupied = false; state.ignoreFailed = 0; },
    noteForeignFailure() {
      if (state.ignoreFailed > 0) { state.ignoreFailed--; return true; }
      return false;
    },
    read: viewOf,
    patch(ctx, params, signal) {
      if (signal?.aborted) return fail("cancelled", "Memory patch cancelled before commit", viewOf(ctx));
      if (sessionUnconfirmed(ctx.sessionManager)) return fail("unconfirmed", UNCONFIRMED_MESSAGE, viewOf(ctx));
      if (state.occupied) return fail("occupied", "Maintenance has not finished native commit; draft was not saved", viewOf(ctx));
      const current = viewOf(ctx);
      if (!record(params) || !keys(params, ["expectedRevision", "add", "update", "remove"])) {
        return fail("invalid", "Invalid patch parameters: must be object containing only allowed fields (expectedRevision, add, update, remove)", current);
      }
      if (typeof params.expectedRevision !== "string") {
        return fail("invalid", "Expected expectedRevision string in patch parameters", current);
      }
      if (!revisionApplies(params.expectedRevision, ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), ctx.sessionManager.buildContextEntries(), ctx.sessionManager.getBranch())) {
        return fail("conflict", "Session path or memory revision changed; re-read before saving", current);
      }
      if (params.add !== undefined && (!Array.isArray(params.add) || params.add === null)) {
        return fail("invalid", "add must be an array of addition items if provided", current);
      }
      if (params.update !== undefined && (!Array.isArray(params.update) || params.update === null)) {
        return fail("invalid", "update must be an array of update items if provided", current);
      }
      if (params.remove !== undefined && (!Array.isArray(params.remove) || params.remove === null)) {
        return fail("invalid", "remove must be an array of slot ID strings if provided", current);
      }

      const existingSlots = current.memory.slots;
      const existingIdSet = new Set(existingSlots.map(s => s.id));
      const addList = params.add ?? [];
      const updateList = params.update ?? [];
      const removeList = params.remove ?? [];

      // Check additions
      const addedKeys = new Set<string>();
      for (const item of addList) {
        if (!record(item) || !keys(item, ["key", "text"]) || typeof item.key !== "string" || typeof item.text !== "string" || !nonempty(item.key) || !nonempty(item.text)) {
          return fail("invalid", "Invalid addition item: must contain only non-empty string fields key and text", current);
        }
        if (addedKeys.has(item.key) || existingIdSet.has(item.key)) {
          return fail("invalid", `Addition key ${item.key} collides with an existing slot ID or another addition`, current);
        }
        addedKeys.add(item.key);
      }

      // Check updates
      const updatedIds = new Set<string>();
      for (const item of updateList) {
        if (!record(item) || !keys(item, ["id", "text"]) || typeof item.id !== "string" || typeof item.text !== "string" || !nonempty(item.id) || !nonempty(item.text)) {
          return fail("invalid", "Invalid update item: must contain only string id and non-empty string text", current);
        }
        if (!existingIdSet.has(item.id)) {
          return fail("invalid", `Update target slot ${item.id} does not exist`, current);
        }
        if (updatedIds.has(item.id)) {
          return fail("invalid", `Duplicate update target slot ${item.id}`, current);
        }
        updatedIds.add(item.id);
      }

      // Check removals
      const removedIds = new Set<string>();
      for (const id of removeList) {
        if (typeof id !== "string" || !nonempty(id)) {
          return fail("invalid", "Invalid remove item: slot id must be a non-empty string", current);
        }
        if (!existingIdSet.has(id)) {
          return fail("invalid", `Remove target slot ${id} does not exist`, current);
        }
        if (removedIds.has(id)) {
          return fail("invalid", `Duplicate remove target slot ${id}`, current);
        }
        if (updatedIds.has(id)) {
          return fail("invalid", `Slot ${id} cannot be both updated and removed in the same patch`, current);
        }
        removedIds.add(id);
      }

      // Build candidate slots
      const updateMap = new Map(updateList.map(u => [u.id, u.text]));
      const survivingSlots: Slot[] = [];
      for (const slot of existingSlots) {
        if (removedIds.has(slot.id)) continue;
        if (updateMap.has(slot.id)) {
          survivingSlots.push({ id: slot.id, text: updateMap.get(slot.id)! });
        } else {
          survivingSlots.push({ id: slot.id, text: slot.text });
        }
      }

      // Assign IDs for additions
      let nextId = current.memory.nextId;
      const allIds = new Set(existingSlots.map(s => s.id));
      const addedMap: Record<string, string> = Object.create(null);
      const newSlots: Slot[] = [];
      for (const item of addList) {
        let id: string;
        do {
          try {
            requireThat(integer(nextId + 1, 1), "INPUT", "Memory ID counter exhausted");
          } catch (e) {
            return fail("invalid", e instanceof Error ? e.message : "ID counter exhausted", current);
          }
          id = `s${nextId++}`;
        } while (allIds.has(id));
        allIds.add(id);
        Object.defineProperty(addedMap, item.key, { value: id, enumerable: true, writable: true, configurable: true });
        newSlots.push({ id, text: item.text });
      }

      const nextMemory: Memory = {
        version: 1,
        nextId,
        slots: [...survivingSlots, ...newSlots],
      };

      try {
        validateMemory(nextMemory);
      } catch (error) {
        return fail("invalid", error instanceof Error ? error.message : "Invalid memory candidate", current);
      }

      // Measure budget
      const budget = measureBudget(ctx, options, nextMemory.slots);
      const grew = budget.tokens > current.budget.tokens;
      if (grew && budget.unknown) {
        return fail("unknown-budget", "Memory budget cannot be computed; growing edit was not saved", current);
      }
      if (grew && budget.limit !== null && budget.tokens > budget.limit) {
        return fail("overbudget", `Growing edit estimate ${budget.tokens} exceeds M budget ${budget.limit}`, { ...current, budget });
      }

      // No-op check
      if (isDeepStrictEqual(nextMemory, current.memory)) {
        return {
          ok: true,
          revision: current.revision,
          memory: current.memory,
          added: addedMap,
          budget: { usedTokens: current.budget.tokens, limitTokens: current.budget.limit },
        };
      }

      // Cancellation check before commit
      if (signal?.aborted) return fail("cancelled", "Memory patch cancelled before commit", current);

      const leaf = ctx.sessionManager.getLeafId();
      try {
        options.pi.appendEntry(MANUAL_MEMORY_TYPE, { nunc: nextMemory });
      } catch (error) {
        const advanced = ctx.sessionManager.getLeafId();
        if (advanced && advanced !== leaf) markUnconfirmed(ctx.sessionManager, advanced);
        return fail("unconfirmed", `Save unconfirmed: ${error instanceof Error ? error.message : "native append failed"}. ${UNCONFIRMED_MESSAGE}`, viewOf(ctx));
      }

      options.onCommitted();
      const saved = viewOf(ctx);
      return {
        ok: true,
        revision: saved.revision,
        memory: saved.memory,
        added: addedMap,
        budget: { usedTokens: saved.budget.tokens, limitTokens: saved.budget.limit },
      };
    },
    replace(ctx, revision, slotId, text) {
      const res = surface.patch(ctx, { expectedRevision: revision, update: [{ id: slotId, text }] });
      if (res.ok) return { ok: true, revision: res.revision, memory: res.memory };
      return res;
    },
    delete(ctx, revision, slotId) {
      const res = surface.patch(ctx, { expectedRevision: revision, remove: [slotId] });
      if (res.ok) return { ok: true, revision: res.revision, memory: res.memory };
      return res;
    },
  };
  options.pi.events.on("nunc:memory-bind", reply => {
    if (typeof reply === "function") {
      try { (reply as (surface: MemorySurface) => void)(surface); } catch { /* Consumer only. */ }
    }
  });
  return surface;
}

export function memorySurface(pi: { events: { emit: (channel: string, data: unknown) => void } }): MemorySurface | undefined {
  let found: MemorySurface | undefined;
  pi.events.emit("nunc:memory-bind", (surface: MemorySurface) => { found = surface; });
  return found;
}

type FailResult = { ok: false; code: ManualSaveCode; message: string; view: MemoryView };
function fail(code: ManualSaveCode, message: string, view: MemoryView): FailResult {
  return { ok: false, code, message, view };
}

const UNCONFIRMED_MESSAGE = "Resource /reload does not reread the session file; resume or switchSession this file before writing";
const UNCONFIRMED = Symbol.for("nunc.memory.unconfirmed");
function unconfirmedMarks(): WeakMap<object, string> {
  const g = globalThis as typeof globalThis & { [UNCONFIRMED]?: WeakMap<object, string> };
  return g[UNCONFIRMED] ??= new WeakMap();
}
type SessionHandle = ExtensionContext["sessionManager"];
function markUnconfirmed(manager: SessionHandle, leaf: string): void {
  unconfirmedMarks().set(manager, leaf);
}
function entryOnDisk(file: string | undefined, id: string): boolean {
  if (!file) return false;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try { if ((JSON.parse(line) as { id?: string }).id === id) return true; } catch { /* skip malformed */ }
    }
  } catch { return false; }
  return false;
}
function sessionUnconfirmed(manager: SessionHandle): boolean {
  const marked = unconfirmedMarks().get(manager);
  if (!marked) return false;
  if (!manager.getEntry(marked) || entryOnDisk(manager.getSessionFile(), marked)) {
    unconfirmedMarks().delete(manager);
    return false;
  }
  return true;
}

function measureBudget(ctx: ExtensionContext, options: Parameters<typeof createMemorySurface>[0], slots: Slot[]): MemoryBudgetView {
  const tokens = memoryTokens(slots);
  try {
    if (!ctx.model) return { tokens, limit: null, unknown: true, overLimit: false };
    const config = engineConfig(readConfig(options.pi.getFlag("nunc-config"), ctx.cwd).config, ctx.model, options.settings(ctx).compaction);
    const plan = memoryPlan(options.fixed(ctx), ctx.model, config);
    const used = memoryTokens(slots, config.imageTokens);
    return { tokens: used, limit: plan.memoryLimit, unknown: false, overLimit: used > plan.memoryLimit };
  } catch {
    return { tokens, limit: null, unknown: true, overLimit: false };
  }
}
