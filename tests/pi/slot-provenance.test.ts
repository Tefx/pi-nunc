import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { renderMemory, type Memory, type Slot } from "../../src/engine/index.js";
import { deriveSlotProvenance, MANUAL_MEMORY_TYPE, project, withEffectiveMemory } from "../../src/pi/projection.js";
import { formatSlotProvenance } from "../../src/ui/context-tree.js";
import { user } from "../engine/fixtures.js";
import { memoryPatch, preparedSurface } from "./fixtures.js";

const memory = (slots: Slot[]): Memory => ({ version: 1, slots, nextId: 100 });
const a = { id: "s1", text: "A" };
const b = { id: "s2", text: "B" };
const expected = (unmodifiedTurns: number, unmodifiedCompactions: number, originInActiveWindow: boolean) =>
  ({ unmodifiedTurns, unmodifiedCompactions, originInActiveWindow });
const manager = () => SessionManager.inMemory("/isolated-provenance-fixture");

test("first commit origins, persisted turns and compactions, and active-window boundaries", () => {
  const m = manager();
  const first = m.appendMessage({ role: "user", content: "Before origin", timestamp: 0 });
  const manual = m.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: memory([a]) });
  const derive = (start: string) => deriveSlotProvenance(m.getBranch(), [user(start, "Active")], memory([a]));
  assert.deepEqual(derive(first).s1, expected(0, 0, true), "origin is the first memory-bearing commit");
  m.appendMessage({ role: "user", content: "One", timestamp: 1 });
  m.appendCustomEntry("unrelated", {});
  m.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: memory([a, b]) });
  m.appendCompaction(renderMemory([a, b]), first, 100, { nunc: memory([a, b]) });
  m.appendMessage(fauxAssistantMessage("No user turn here"));
  const second = m.appendMessage({ role: "user", content: "Two", timestamp: 2 });
  m.appendCompaction(renderMemory([a, b]), second, 100, { nunc: memory([a, b]) });
  assert.deepEqual(derive(first).s1, expected(2, 2, true));
  assert.deepEqual(derive(second).s1, expected(2, 2, false), "manual origin before R is outside-window");
  assert.deepEqual(derive(manual).s1, expected(2, 2, true), "inclusive active-window boundary");
  const c = manager();
  c.appendCompaction(renderMemory([a]), null, 100, { nunc: memory([a]) });
  assert.deepEqual(deriveSlotProvenance(c.getBranch(), [], memory([a])).s1, expected(0, 0, false), "compaction origins always outside-window");
});

test("body returns, removal/re-addition and other-slot edits determine exact continuity", () => {
  const m = manager();
  const first = m.appendMessage({ role: "user", content: "Start", timestamp: 0 });
  const save = (slots: Slot[]) => m.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: memory(slots) });
  const derive = () => deriveSlotProvenance(m.getBranch(), [user(first, "Start")], memory([a, b]));
  save([a, b]);
  m.appendMessage({ role: "user", content: "Turn 1", timestamp: 1 });
  save([{ ...a, text: "changed" }, b]);
  m.appendMessage({ role: "user", content: "Turn 2", timestamp: 2 });
  save([a, b]);
  assert.deepEqual(derive().s1, expected(0, 0, true), "A -> changed -> A starts a new origin");
  assert.deepEqual(derive().s2, expected(2, 0, true), "edits to a different slot preserve origin");
  save([b]);
  m.appendMessage({ role: "user", content: "Turn 3", timestamp: 3 });
  save([a, b]);
  assert.deepEqual(derive().s1, expected(0, 0, true), "remove/re-add resets origin");
  assert.deepEqual(derive().s2, expected(3, 0, true));
  assert.equal(deriveSlotProvenance(m.getBranch(), [], memory([{ ...a, text: "uncommitted" }])).s1, undefined);
});

test("corrupt retired commits omit unknown continuity but retain newer origins and prototype-safe IDs", () => {
  const m = manager();
  const first = m.appendMessage({ role: "user", content: "Old", timestamp: 0 });
  m.appendCompaction("corrupt", first, 100, { nunc: { version: 9 } });
  m.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: memory([a]) });
  const proto = { id: "__proto__", text: "Ordinary slot" };
  m.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: memory([a, b, proto]) });
  const result = deriveSlotProvenance(m.getBranch(), [user(first, "Active")], memory([a, b, proto]));
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.hasOwn(result, "s1"), false);
  assert.deepEqual(result.s2, expected(0, 0, true));
  assert.deepEqual(result.__proto__, expected(0, 0, true));
  assert.equal(formatSlotProvenance("s1", result, true), "age unknown");
  assert.equal(formatSlotProvenance("s1", result), undefined);
  assert.equal(formatSlotProvenance("s1", undefined, true), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).__proto__, expected(0, 0, true));
  m.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: null });
  assert.equal(Object.keys(deriveSlotProvenance(m.getBranch(), [], memory([a]))).length, 0);
  assert.equal(Object.keys(deriveSlotProvenance([], [], memory([a]))).length, 0);
  assert.equal(Object.keys(deriveSlotProvenance(m.getBranch(), [], memory([]))).length, 0);
  const noCommits = manager();
  noCommits.appendMessage({ role: "user", content: "No memory commits", timestamp: 0 });
  assert.equal(Object.keys(deriveSlotProvenance(noCommits.getBranch(), [], memory([a]))).length, 0);
});

test("registered read and committed/no-op patches return provenance without changing slot shape or carrier position", async t => {
  const { f, memory: surface, context, ctx } = await preparedSurface(t, { flagValues: [["nunc-memory-tools", "true"]] });
  f.seed();
  const m = f.runtime.session.sessionManager;
  const read = f.runtime.session.getAllTools().find(tool => tool.name === "nunc_memory_read")!;
  // getAllTools is metadata; the public session lookup exposes executable definitions.
  const readTool = f.runtime.session.getToolDefinition(read.name)!;
  const patchTool = f.runtime.session.getToolDefinition("nunc_memory_patch")!;
  const toolContext = () => ({ ...ctx(), tools: [], executeTool: async () => { throw new Error("Unexpected nested tool execution"); } });
  const initial = surface().read(ctx());
  const saved = await patchTool.execute("save", { expectedRevision: initial.revision, add: [{ key: "new", text: "Saved body" }] }, undefined, undefined, toolContext());
  const payload = JSON.parse((saved.content[0] as { text: string }).text);
  assert.equal(payload.ok, true);
  const id = payload.added.new as string;
  assert.deepEqual(payload.slotProvenance[id], expected(0, 0, true));
  m.appendMessage({ role: "user", content: "After save", timestamp: 3 });
  const result = await readTool.execute("read", {}, undefined, undefined, toolContext());
  const output = JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(output.slots, [{ id, text: "Saved body" }]);
  assert.deepEqual(output.slotProvenance[id], expected(1, 0, true));
  assert.deepEqual(context().read(ctx()).current.layout.memory?.slotProvenance?.[id], expected(1, 0, true));
  const before = project(m.buildContextEntries());
  const carrierBefore = withEffectiveMemory(m.buildSessionContext().messages, before.memory, { sessionId: m.getSessionId(), entries: m.buildContextEntries() });
  const leaf = m.getLeafId();
  const noop = await patchTool.execute("noop", { expectedRevision: output.revision, update: [{ id, text: "Saved body" }] }, undefined, undefined, toolContext());
  const noopPayload = JSON.parse((noop.content[0] as { text: string }).text);
  assert.equal(noopPayload.ok, true);
  assert.deepEqual(noopPayload.slotProvenance, output.slotProvenance);
  assert.equal(m.getLeafId(), leaf, "no-op must not append a memory carrier");
  const after = project(m.buildContextEntries());
  assert.deepEqual(after.memory, before.memory);
  assert.deepEqual(withEffectiveMemory(m.buildSessionContext().messages, after.memory, { sessionId: m.getSessionId(), entries: m.buildContextEntries() }), carrierBefore);
  const changed = await patchTool.execute("change", { expectedRevision: output.revision, update: [{ id, text: "New body" }] }, undefined, undefined, toolContext());
  assert.deepEqual(JSON.parse((changed.content[0] as { text: string }).text).slotProvenance[id], expected(0, 0, true));
});

test("maintenance freezes provenance before asynchronous policy load while later D stays live", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "nunc-provenance-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fifo = join(dir, "preferences.md");
  execFileSync("mkfifo", [fifo]);
  const { f, memory: surface, context, ctx } = await preparedSurface(t, { config: { policyFile: fifo } });
  f.seed();
  const initial = surface().read(ctx());
  const saved = surface().patch(ctx(), { expectedRevision: initial.revision, add: [{ key: "note", text: "Frozen observation" }] });
  assert(saved.ok);
  const id = saved.added.note!;
  const before = surface().read(ctx()).slotProvenance![id]!;
  f.respond(memoryPatch);
  const compacting = f.runtime.session.compact();
  // The writer opens only after loadPolicy reaches its real asynchronous read.
  const writer = await open(fifo, "w");
  try {
    f.runtime.session.sessionManager.appendMessage({ role: "user", content: "Later D during policy load", timestamp: 4 });
    await writer.writeFile("A scoped preference.");
  } finally { await writer.close(); }
  await compacting;
  const blocks = f.calls.at(-1)!.messages.find(message => message.role === "user")!.content;
  assert(Array.isArray(blocks));
  const tail = blocks.at(-1);
  assert(tail?.type === "text");
  assert(tail.text.includes(`Current M slot provenance: ${JSON.stringify({ [id]: before })}. Current M slot IDs:`));
  assert(!JSON.stringify(blocks).includes("Later D during policy load"));
  const frozen = context().read(ctx()).lastMaintenance!;
  assert.deepEqual(frozen.before.slotProvenance?.[id], before);
  assert.equal(frozen.native, "saved");
  assert.equal(surface().read(ctx()).slotProvenance![id]!.unmodifiedTurns, before.unmodifiedTurns + 1);
  assert.equal(surface().read(ctx()).slotProvenance![id]!.unmodifiedCompactions, before.unmodifiedCompactions + 1);
  frozen.before.slotProvenance![id]!.unmodifiedTurns = 999;
  assert.deepEqual(context().read(ctx()).lastMaintenance!.before.slotProvenance?.[id], before, "read snapshots cannot mutate frozen provenance");
});
