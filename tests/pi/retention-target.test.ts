import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, memoryPatch } from "./fixtures.js";
import { answer } from "../engine/fixtures.js";
import { project } from "../../src/pi/projection.js";

test("native manual compaction at low water saves one checkpoint and retires a substantial prefix", async t => {
  const f = await fixture({ config: { rolling: { keepRecentFraction: 0.5 } } });
  t.after(() => f.close());
  await f.runtime.session.setModel({ ...f.faux.getModel(), contextWindow: 1048576 });
  const manager = f.runtime.session.sessionManager;
  for (let i = 0; i < 20; i++) {
    manager.appendMessage({ role: "user", content: `work ${i}: ` + "a".repeat(2000), timestamp: i });
    manager.appendMessage({ ...answer({}, f.faux.getModel()), timestamp: i });
  }
  const before = project(manager.buildContextEntries()).active;
  f.respond(memoryPatch);
  const saved = await f.runtime.session.compact();
  const after = project(manager.buildContextEntries()).active;
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.length, 1);
  assert(f.events[0]!.result.ok);
  assert(after.length < before.length * 0.7 && after.length > before.length * 0.3);
  assert.deepEqual(after, before.slice(before.findIndex(e => e.entryId === saved.firstKeptEntryId)));
  assert.equal(manager.getEntries().filter(e => e.type === "compaction").length, 1);
  assert.equal(f.settings.getCompactionSettings().enabled, false);
});

test("model selection diagnoses oversized projection without transport, compaction or reversal", async t => {
  const notes: { message: string }[] = [];
  const f = await fixture({ bus: bus => bus.on("nunc:diagnostic", value => notes.push(value as { message: string })) });
  t.after(() => f.close());
  const manager = f.runtime.session.sessionManager;
  manager.appendMessage({ role: "user", content: "x".repeat(180000), timestamp: 0 });
  const original = manager.getEntries();
  await f.runtime.session.setModel(f.faux.getModel("small")!);
  assert(notes.some(n => n.message.includes("exceeds input limit")));
  assert.equal(f.runtime.session.model?.id, "small");
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 0);
  assert.deepEqual(manager.getEntries().slice(0, original.length), original);
  assert.equal(manager.getEntries().filter(e => e.type === "compaction").length, 0);
  assert.equal(f.settings.getCompactionSettings().enabled, false);
});
