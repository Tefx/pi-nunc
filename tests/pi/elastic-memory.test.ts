import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contextSurface, memorySurface, type ContextSurface, type MemorySurface } from "../../src/pi/index.js";
import { engineConfig, parseConfig } from "../../src/pi/config.js";
import { memoryTokens } from "../../src/engine/accounting.js";
import { readSourceRecords } from "../../src/engine/request.js";
import { budgetLines, maintenanceLines } from "../../src/ui/status.js";
import { model } from "../engine/fixtures.js";
import { fixture } from "./fixtures.js";

test("default/explicit target and explicit hard cap are independently parsed and resolved", () => {
  const settings = { reserveTokens: 36000, keepRecentTokens: 1 };
  const defaults = engineConfig({}, model, settings);
  assert.equal(defaults.memory.targetTokens, 8192);
  assert.equal(defaults.memory.hardMaxTokens, undefined);
  const explicit = engineConfig(parseConfig({ memory: { targetTokens: 200, hardMaxTokens: 900 } }), model, settings);
  assert.equal(explicit.memory.targetTokens, 200); assert.equal(explicit.memory.hardMaxTokens, 900);
});

test("active patches reject target growth while automatic required saves exceed it and later edits shrink", async t => {
  let ctx!: ExtensionContext, memory!: MemorySurface, context!: ContextSurface;
  const f = await fixture({ config: { memory: { targetTokens: 192 } }, extras: [{ name: "elastic-memory-view", factory(pi) {
    pi.on("session_start", (_e, c) => { ctx = c; });
    memory = memorySurface(pi)!; context = contextSurface(pi)!;
  } }] }); t.after(() => f.close());
  let view = memory.read(ctx);
  assert.equal(view.budget.limit, 192); assert.equal(view.budget.target, 192); assert.equal(view.budget.hardLimit, null);
  const first = memory.patch(ctx, { expectedRevision: view.revision, add: [{ key: "active", text: "Necessary original continuation" }] });
  assert(first.ok);
  const original = memory.read(ctx);
  const denied = memory.patch(ctx, { expectedRevision: original.revision, update: [{ id: original.memory.slots[0]!.id, text: "x".repeat(2000) }] });
  assert(!denied.ok); assert.equal(denied.code, "overbudget");
  assert.deepEqual(memory.read(ctx).memory, original.memory);
  f.seed();
  const extra = "Current necessary constraint " + "z".repeat(1600);
  f.respond(request => {
    const fm = request.messages.flatMap(m => typeof m.content === "string" ? readSourceRecords(m.content) : m.content.flatMap(b => b.type === "text" ? readSourceRecords(b.text) : [])).find(r => r.source === "F/M")!;
    const old = fm.M as { id: string; text: string }[];
    return fauxAssistantMessage(JSON.stringify({ add: [{ key: "extra", text: extra }], remove: [], priority: [...old.map(s => s.id), "extra"], required: [...old.map(s => s.id), "extra"] }));
  });
  await f.runtime.session.compact();
  view = memory.read(ctx);
  assert.equal(view.memory.slots[0]!.text, original.memory.slots[0]!.text);
  assert.equal(view.memory.slots[1]!.text, extra);
  assert(memoryTokens(view.memory.slots) > 192);
  const current = context.read(ctx);
  assert.equal(current.current.budget.memoryHardLimit, null);
  assert.equal(current.current.budget.memoryTarget, 192);
  assert.equal(current.current.budget.memoryReserveTokens, view.budget.tokens);
  assert(current.lastMaintenance?.after, "native save observation exists");
  assert.match(budgetLines(current.current).join("\n"), /over target.*elastic maintenance/);
  assert.match(maintenanceLines(current.lastMaintenance).join("\n"), /over target; required retained/);
  const grew = memory.patch(ctx, { expectedRevision: view.revision, add: [{ key: "unneeded", text: "Further growth" }] });
  assert(!grew.ok); assert.equal(grew.code, "overbudget");
  const reduced = memory.patch(ctx, { expectedRevision: view.revision, remove: [view.memory.slots[1]!.id] });
  assert(reduced.ok);
  assert(memory.read(ctx).budget.tokens < 192);
});
