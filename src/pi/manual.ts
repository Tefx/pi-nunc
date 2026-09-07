import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FixedContext, Memory, Slot } from "../engine/index.js";
import { memoryPlan, memoryTokens } from "../engine/index.js";
import { EngineError, nonempty, validateMemory } from "../engine/validation.js";
import { engineConfig, readConfig, type HostCompactionSettings } from "./config.js";
import { MANUAL_MEMORY_TYPE, memoryRevision, project, revisionApplies } from "./projection.js";

export type ManualSaveCode = "invalid" | "conflict" | "occupied" | "overbudget" | "unknown-budget" | "unconfirmed";

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

export interface MemorySurface {
  read(ctx: ExtensionContext): MemoryView;
  replace(ctx: ExtensionContext, revision: string, slotId: string, text: string): ManualSaveResult;
  delete(ctx: ExtensionContext, revision: string, slotId: string): ManualSaveResult;
}
export interface MemoryFreeze extends MemorySurface {
  beginFreeze(): boolean;
  endFreeze(): void;
  noteForeignFailure(): boolean;
  clearUnconfirmed(): void;
}

export function createMemorySurface(options: {
  pi: ExtensionAPI;
  fixed: (ctx: ExtensionContext) => FixedContext;
  settings: (ctx: ExtensionContext) => { compaction: HostCompactionSettings; blockImages: boolean };
  onCommitted: () => void;
}): MemoryFreeze {
  const state = { occupied: false, ignoreFailed: 0, unconfirmed: false };
  const viewOf = (ctx: ExtensionContext): MemoryView => {
    const entries = ctx.sessionManager.buildContextEntries();
    const projected = project(entries);
    const budget = measureBudget(ctx, options, projected.memory.slots);
    return {
      revision: memoryRevision(ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), entries),
      memory: projected.memory,
      status: { occupied: state.occupied, unconfirmed: state.unconfirmed },
      budget,
      contextLayout: {
        slotCount: projected.memory.slots.length,
        activeEntries: projected.active.length,
        ...(projected.latestId ? { latestCompactionId: projected.latestId } : {}),
      },
    };
  };
  const commit = (ctx: ExtensionContext, revision: string, next: Memory | ManualSaveResult): ManualSaveResult => {
    if ("ok" in next) return next;
    if (state.unconfirmed) return fail("unconfirmed", "Previous native save is unconfirmed; reload the session before writing", viewOf(ctx));
    if (state.occupied) return fail("occupied", "Maintenance has not finished native commit; draft was not saved", viewOf(ctx));
    const current = viewOf(ctx);
    if (!revisionApplies(revision, ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), ctx.sessionManager.buildContextEntries(), ctx.sessionManager.getBranch())) {
      return fail("conflict", "Session path or memory revision changed; re-read before saving", current);
    }
    try { validateMemory(next); } catch (error) {
      return fail("invalid", error instanceof Error ? error.message : "Invalid memory", current);
    }
    const budget = measureBudget(ctx, options, next.slots);
    const grew = budget.tokens > current.budget.tokens;
    if (grew && budget.unknown) return fail("unknown-budget", "Memory budget cannot be computed; growing edit was not saved", current);
    if (grew && budget.limit !== null && budget.tokens > budget.limit) {
      return fail("overbudget", `Growing edit estimate ${budget.tokens} exceeds M budget ${budget.limit}`, { ...current, budget });
    }
    if (isDeepStrictEqual(next, current.memory)) return { ok: true, revision: current.revision, memory: current.memory };
    const leaf = ctx.sessionManager.getLeafId();
    try {
      options.pi.appendEntry(MANUAL_MEMORY_TYPE, { nunc: next });
    } catch (error) {
      if (ctx.sessionManager.getLeafId() !== leaf) state.unconfirmed = true;
      return fail("unconfirmed", `Save unconfirmed: ${error instanceof Error ? error.message : "native append failed"}`, viewOf(ctx));
    }
    options.onCommitted();
    const saved = viewOf(ctx);
    return { ok: true, revision: saved.revision, memory: saved.memory };
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
    clearUnconfirmed() { state.unconfirmed = false; },
    read: viewOf,
    replace(ctx, revision, slotId, text) {
      return commit(ctx, revision, prepareEdit(ctx, revision, state, viewOf, memory => {
        if (!nonempty(text)) throw new EngineError("INPUT", "Empty text is not a valid slot");
        if (!memory.slots.some(slot => slot.id === slotId)) throw new EngineError("INPUT", `Unknown slot ${slotId}`);
        return { version: 1, nextId: memory.nextId, slots: memory.slots.map(slot => slot.id === slotId ? { id: slot.id, text } : slot) };
      }));
    },
    delete(ctx, revision, slotId) {
      return commit(ctx, revision, prepareEdit(ctx, revision, state, viewOf, memory => {
        if (!memory.slots.some(slot => slot.id === slotId)) throw new EngineError("INPUT", `Unknown slot ${slotId}`);
        return { version: 1, nextId: memory.nextId, slots: memory.slots.filter(slot => slot.id !== slotId) };
      }));
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

function fail(code: ManualSaveCode, message: string, view: MemoryView): ManualSaveResult {
  return { ok: false, code, message, view };
}

function prepareEdit(ctx: ExtensionContext, revision: string, state: { occupied: boolean; unconfirmed: boolean }, viewOf: (ctx: ExtensionContext) => MemoryView, edit: (memory: Memory) => Memory): Memory | ManualSaveResult {
  if (state.unconfirmed) return fail("unconfirmed", "Previous native save is unconfirmed; reload the session before writing", viewOf(ctx));
  if (state.occupied) return fail("occupied", "Maintenance has not finished native commit; draft was not saved", viewOf(ctx));
  const current = viewOf(ctx);
  if (!revisionApplies(revision, ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), ctx.sessionManager.buildContextEntries(), ctx.sessionManager.getBranch())) {
    return fail("conflict", "Session path or memory revision changed; re-read before saving", current);
  }
  try { return edit(current.memory); }
  catch (error) { return fail("invalid", error instanceof Error ? error.message : "Invalid memory", current); }
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
