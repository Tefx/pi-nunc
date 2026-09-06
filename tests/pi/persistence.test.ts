import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { buildContextEntries, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { project } from "../../src/pi/projection.js";
import { renderMemory } from "../../src/engine/index.js";
import type { MaintenanceEvent } from "../../src/pi/index.js";
import { sourceRecords } from "../engine/fixtures.js";
import { fixture, memoryPatch } from "./fixtures.js";

test("public package export -> actual loader -> manual hook -> single JSONL snapshot -> rebuild -> normal main request", async t => {
  const f = await fixture({ publicFactory: true }); t.after(() => f.close());
  f.seed(); f.respond(context => sourceRecords(context).length ? memoryPatch(context) : fauxAssistantMessage("Continued work."));
  const before = f.runtime.session.sessionManager.getEntries().length;
  const result = await f.runtime.session.compact();
  const entries = f.runtime.session.sessionManager.getEntries();
  assert.equal(entries.length, before + 1);
  const snapshot = entries.at(-1); assert.equal(snapshot?.type, "compaction");
  const loaded = SessionManager.open(f.runtime.session.sessionFile!, f.sessionDir);
  const projected = project(loaded.buildContextEntries());
  assert.equal(projected.memory.slots[0]?.text, "Preserved test constraint.");
  assert.equal(result.summary, renderMemory(projected.memory.slots));
  assert.equal(loaded.getEntries().filter(e => e.type === "compaction").length, 1);
  assert((await stat(f.runtime.session.sessionFile!)).size > 0);
  const raw = await readFile(f.runtime.session.sessionFile!, "utf8");
  assert(raw.includes("a".repeat(12000)), "retired original remains in Pi JSONL");
  const kept = projected.active.flatMap(e => e.messages);
  await f.runtime.session.prompt("Continue without restating the old constraint.");
  assert.equal(f.events.length, 1, "ordinary turn performs no maintenance");
  const main = f.calls.at(-1)!;
  assert.deepEqual(main.messages.slice(1, 1 + kept.length), kept);
  const summary = main.messages[0]; assert(summary && typeof summary.content !== "string");
  assert(summary.content.some(b => b.type === "text" && b.text.includes(result.summary)));
  assert.equal(f.faux.state.callCount, 2);
});

test("three consecutive real compactions rebuild ONLY latest M and original current suffix", async t => {
  const f = await fixture(); t.after(() => f.close());
  f.respond(memoryPatch);
  let oldSnapshot: string | undefined;
  for (let i = 0; i < 3; i++) {
    f.seed(`roll-${i}`);
    const oldActive = project(f.runtime.session.sessionManager.buildContextEntries()).active;
    const result = await f.runtime.session.compact();
    const manager = f.runtime.session.sessionManager;
    const rebuilt = buildContextEntries(manager.getEntries(), manager.getLeafId());
    const snapshots = rebuilt.filter(e => e.type === "compaction");
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.id, manager.getLeafId());
    assert.notEqual(snapshots[0]?.id, oldSnapshot);
    const start = oldActive.findIndex(e => e.entryId === result.firstKeptEntryId);
    assert(start > 0);
    assert.deepEqual(project(rebuilt).active, oldActive.slice(start));
    const sources = sourceRecords(f.calls.at(-1)!);
    assert(sources.every(s => s.sourceRole !== "compactionSummary"));
    assert.equal(convertToLlm(manager.buildSessionContext().messages).length, project(rebuilt).active.length + 1);
    oldSnapshot = snapshots[0]?.id;
  }
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 3);
});

test("resume/new/tree/fork/clone follow selected persisted path and never import unrelated M", async t => {
  const f = await fixture(); t.after(() => f.close());
  const { last: beforeMemory } = f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const snapshotId = f.runtime.session.sessionManager.getLeafId()!;
  const originalId = f.runtime.session.sessionId;
  const originalFile = f.runtime.session.sessionFile!;
  const memory = project(f.runtime.session.sessionManager.buildContextEntries()).memory;
  await f.runtime.switchSession(originalFile);
  assert.equal(f.runtime.session.sessionId, originalId);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory, memory);
  assert.equal(f.faux.state.callCount, 1, "resume performs no extraction or historical replay");
  await f.runtime.session.navigateTree(beforeMemory, { summarize: false });
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots.length, 0);
  await f.runtime.session.navigateTree(snapshotId, { summarize: false });
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory, memory);
  // Pi /clone uses fork at the current leaf. A historical fork uses the same public runtime.
  await f.runtime.fork(snapshotId, { position: "at" });
  assert.notEqual(f.runtime.session.sessionId, originalId);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory, memory);
  await f.runtime.fork(beforeMemory, { position: "at" });
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots.length, 0);
  await f.runtime.newSession();
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots.length, 0);
  assert.equal(f.runtime.session.sessionManager.buildSessionContext().messages.length, 0);
  assert.equal(f.faux.state.callCount, 1);
});

test("observer mutation cannot change the validated persistence candidate", async t => {
  const f = await fixture({ extras: [pi => { pi.events.on("nunc:maintenance", data => {
    const event = data as MaintenanceEvent;
    if (event.result.ok) event.result.candidate.memory.slots[0]!.text = "accidental observer mutation";
  }); }] });
  t.after(() => f.close()); f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots[0]?.text, "Preserved test constraint.");
});

test("legacy external summary becomes one slot; malformed Nunc details cancel without another model", async t => {
  const f = await fixture(); t.after(() => f.close());
  const { kept } = f.seed();
  f.runtime.session.sessionManager.appendCompaction("Legacy constraints.", kept, 5000);
  f.seed("after-legacy"); f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots, [{ id: "legacy", text: "Legacy constraints." }]);
  f.seed("invalid");
  f.runtime.session.sessionManager.appendCompaction("bad", f.runtime.session.sessionManager.getLeafId()!, 10, { nunc: { version: 9 } });
  f.seed("more");
  const before = f.runtime.session.sessionManager.getEntries().length;
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.runtime.session.sessionManager.getEntries().length, before);
  assert.equal(f.faux.state.callCount, 1);
});
