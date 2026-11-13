import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { preparedSurface } from "./fixtures.js";
import { maintenanceLines } from "../../src/ui/status.js";

test("model diagnostics deduplicate startup and selection, survive thinking changes, and reset with session", async t => {
  const notes: string[] = [];
  const h = await preparedSurface(t, { config: { memory: { hardMaxTokens: 1000 } }, bus: bus => bus.on("nunc:diagnostic", value => notes.push((value as { message: string }).message)) });
  const warnings = () => notes.filter(n => n.includes("memory.hardMaxTokens"));
  assert.equal(warnings().length, 1, "startup runs shared diagnostics");
  const original = h.f.faux.getModel();
  const dense = { ...original, id: "dense-output", maxTokens: 54000 };
  const registry = new ModelRegistry(h.f.modelRuntime);
  registry.registerProvider({ ...h.f.faux.provider, getModels: () => [original, dense] });
  await h.f.runtime.session.setModel(dense);
  assert.equal(notes.filter(n => n.includes("Oversized catalog output caps")).length, 1);
  h.f.runtime.session.setThinkingLevel("low");
  await h.f.runtime.session.setModel(original);
  await h.f.runtime.session.setModel(dense);
  assert.equal(notes.filter(n => n.includes("Oversized catalog output caps")).length, 1);
  assert.equal(warnings().length, 2, "one per model, including startup model");
  await h.f.runtime.newSession();
  assert.equal(warnings().length, 3, "new session startup diagnoses its initial model again");
  await h.f.runtime.session.setModel(dense);
  assert.equal(notes.filter(n => n.includes("Oversized catalog output caps")).length, 2);
});

test("narrow candidate runway is separate from sufficient normal extraction headroom and warns once until invalidation", async t => {
  const notes: string[] = [];
  const h = await preparedSurface(t, { bus: bus => bus.on("nunc:diagnostic", value => notes.push((value as { message: string }).message)) });
  h.f.respond(() => fauxAssistantMessage(JSON.stringify({ add: [], remove: [], priority: [], required: [] })));
  let seeded = false;
  const prepare = () => {
    if (!seeded) { h.f.seed(); seeded = true; }
    const manager = h.f.runtime.session.sessionManager;
    manager.appendMessage({ role: "user", content: "Current indivisible work " + "x".repeat(60000), timestamp: 3 });
    h.f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  };
  prepare();
  await h.f.runtime.session.compact();
  const result = h.f.events.at(-1)!.result;
  assert(result.ok, JSON.stringify(result));
  const a = result.observations.accounting!;
  assert.equal(a.normalHeadroomSufficient, true);
  assert(a.growthTokens! < 0.35 * a.effectiveTrigger);
  assert.equal(a.growthTokens, a.effectiveTrigger - a.mainAfterTokens!);
  const report = maintenanceLines(h.context().read(h.ctx()).lastMaintenance).join("\n");
  assert.match(report, /Normal-trigger headroom: sufficient/);
  assert.match(report, /Candidate post-compaction runway:.*narrow.*forecast/);
  const runway = () => notes.filter(n => n.includes("Candidate post-compaction growth runway"));
  assert.equal(runway().length, 1);
  assert.doesNotMatch(runway()[0]!, /reserveTokens/);
  prepare();
  await h.f.runtime.session.compact();
  assert.equal(runway().length, 1);
  h.f.runtime.session.setThinkingLevel("low");
  prepare();
  await h.f.runtime.session.compact();
  assert.equal(runway().length, 2);
});
