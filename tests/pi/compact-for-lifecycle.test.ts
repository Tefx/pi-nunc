import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, memoryPatch } from "./fixtures.js";
import { project } from "../../src/pi/projection.js";

test("user cancellation discards targeted extraction and releases the intent for ordinary compaction", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const before = project(f.runtime.session.sessionManager.buildContextEntries());
  f.respond(async context => { entered.resolve(); await release.promise; return memoryPatch(context); });
  const work = f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
  await entered.promise;
  f.runtime.session.abortCompaction(); release.resolve(); await work;
  assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory, before.memory);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).active, before.active);
  f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.equal(f.calls.length, 2);
  assert.equal(f.events.at(-1)!.result.observations.target, undefined);
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 1);
});

test("a changed session branch cannot receive a stale targeted checkpoint", async t => {
  const f = await fixture(); t.after(() => f.close());
  const { first } = f.seed();
  const manager = f.runtime.session.sessionManager;
  const before = manager.getEntries();
  f.respond(context => { manager.branch(first); return memoryPatch(context); });
  await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
  assert.equal(f.calls.length, 1);
  assert.equal(manager.getLeafId(), first);
  assert.equal(manager.getEntries().filter(e => e.type === "compaction").length, 0);
  assert.deepEqual(manager.getEntries(), before);
});

test("target per-model settings are used and changing them during extraction rejects the candidate", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  f.settings.applyOverrides({ compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1,
    modelOverrides: { "nunc-pi-fixture/small": { reserveTokens: 16000, keepRecentTokens: 1 } } } });
  f.respond(context => {
    f.settings.applyOverrides({ compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1,
      modelOverrides: { "nunc-pi-fixture/small": { reserveTokens: 18000, keepRecentTokens: 1 } } } });
    return memoryPatch(context);
  });
  await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
  assert.equal(f.calls.length, 1);
  assert.equal(f.events[0]!.result.observations.target!.plannedInputLimit, 29000);
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
  assert.equal(f.runtime.session.model?.id, "large");
});
