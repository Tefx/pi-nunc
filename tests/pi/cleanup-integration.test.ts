import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { memorySurface } from "../../src/pi/index.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { answer, assistant, tool, user } from "../engine/fixtures.js";
import { parseNuncSettings, resolveMemoryTools, resolveToolResultCleanup } from "../../src/pi/config.js";
import { eligibleCleanupScope, project, originalResults, effectiveActive } from "../../src/pi/projection.js";
import { fixture, memoryPatch } from "./fixtures.js";

test("trusted settings resolve cleanup independently of memory tools and reject invalid types", () => {
  assert.equal(resolveToolResultCleanup({}), true);
  assert.equal(resolveMemoryTools({}), false);
  assert.deepEqual(parseNuncSettings({ toolResultCleanup: false, memoryTools: true }), { toolResultCleanup: false, memoryTools: true });
  assert.equal(resolveToolResultCleanup({ globalNunc: { toolResultCleanup: true }, projectNunc: { toolResultCleanup: false }, projectTrusted: true }), false);
  assert.equal(resolveToolResultCleanup({ globalNunc: { toolResultCleanup: false }, projectNunc: { toolResultCleanup: true }, projectTrusted: false }), false);
  assert.throws(() => parseNuncSettings({ toolResultCleanup: "false" }), /CONFIG|expected boolean/);
});

test("eligibility requires a sent-M source prefix and excludes newest complete, pending, and already reduced groups", () => {
  const active = [user("old", "old"), assistant("a1", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }]),
    tool("r1", "c1", "a".repeat(500)), assistant("a2", [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } }]),
    tool("r2", "c2", "b".repeat(500)), assistant("a3", [{ type: "toolCall", id: "c3", name: "read", arguments: { path: "c" } }])];
  assert.deepEqual(eligibleCleanupScope(active, ["old"], []), [{ entryId: "r1", messageIndex: 0 }]);
  assert.deepEqual(eligibleCleanupScope(active, [], []), []);
  assert.deepEqual(eligibleCleanupScope(active, ["unknown"], []), []);
  assert.deepEqual(eligibleCleanupScope(active, ["old"], [{ entryId: "r1", messageIndex: 0 } as any]), []);
});

test("disabling cleanup restores raw capacity accounting and refuses an oversized native request", async t => {
  let ctx: ExtensionContext | undefined;
  const admission: unknown[] = [];
  const f = await fixture({ diskSettings: true, globalSettings: { nunc: { memoryTools: true } },
    extras: [{ name: "capture-cleanup-capacity", factory(pi) {
      pi.on("session_start", (_event, current) => { ctx = current; });
      pi.events.on("nunc:admission", event => { admission.push(event); });
    } }] });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert(ctx);
  f.respond(() => fauxAssistantMessage("Baseline M sent"));
  await f.runtime.session.prompt("Establish capacity anchor");
  const manager = f.runtime.session.sessionManager;
  const body = "FILLER_NATIVE_BODY ".repeat(13000);
  for (const id of ["capacity-1", "capacity-2"]) {
    manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: body }], timestamp: 2 });
  }
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const readTool = (f.runtime.session as any).getToolDefinition("nunc_memory_read");
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");
  const before = JSON.parse((await readTool.execute("capacity-read", {}, undefined, undefined, ctx)).content[0].text);
  assert.equal(before.cleanupCandidates.length, 1);
  const changed = await patchTool.execute("capacity-save", { expectedRevision: before.revision,
    update: [{ id: before.slots[0].id, text: "Keep capacity accounting anchored." }],
    toolResultEdits: [{ entryId: before.cleanupCandidates[0].entryId, messageIndex: 0, action: "replace", text: "Retained original is recoverable." }] }, undefined, undefined, ctx);
  assert.equal(changed.isError, undefined, JSON.stringify(changed));
  assert.equal(project(manager.buildContextEntries()).cleanup.length, 1);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ compaction: f.settings.getCompactionSettings(), nunc: { memoryTools: true, toolResultCleanup: false } }));
  const sentBefore = f.calls.length;
  f.respond(() => fauxAssistantMessage("Should never be sent"));
  await f.runtime.session.prompt("Restore originals; reject if too large");
  assert.equal(f.calls.length, sentBefore, "oversized restored body must not reach the provider");
  assert(admission.some(row => typeof row === "object" && row !== null && (row as { outcome?: string }).outcome === "reject"));
  assert.equal(project(manager.buildContextEntries()).cleanup.length, 1, "capacity rejection preserves persisted decision");
});

test("stock loader, native session append, public read/patch, active projection and restart keep originals", async t => {
  let ctx: ExtensionContext | undefined;
  let api: ExtensionAPI | undefined;
  const f = await fixture({ diskSettings: true, globalSettings: { nunc: { memoryTools: true } },
    extras: [{ name: "capture-cleanup", factory(pi) {
      api = pi;
      pi.on("session_start", (_event, current) => { ctx = current; });
    } }] });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert(ctx);
  const readTool = (f.runtime.session as any).getToolDefinition("nunc_memory_read");
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");
  assert(readTool && patchTool);
  const beforeSent = JSON.parse((await readTool.execute("initial", {}, undefined, undefined, ctx)).content[0].text);
  assert.equal(beforeSent.cleanupCandidates, undefined);
  f.respond(() => fauxAssistantMessage("Existing memory sent"));
  await f.runtime.session.prompt("Use the saved M");
  const manager = f.runtime.session.sessionManager;
  const body1 = "First completed result, exact original. ".repeat(50);
  const body2 = "Newest result must stay complete. ".repeat(50);
  for (const [id, body] of [["c1", body1], ["c2", body2]] as const) {
    manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: body }], timestamp: 2 });
  }
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const native = project(manager.buildContextEntries());
  const refs = native.active.filter(e => e.messages[0]?.role === "toolResult");
  assert.equal(refs.length, 2);
  const first = { entryId: refs[0]!.entryId, messageIndex: 0 };
  const second = { entryId: refs[1]!.entryId, messageIndex: 0 };
  const read = JSON.parse((await readTool.execute("eligible", {}, undefined, undefined, ctx)).content[0].text);
  assert.deepEqual(read.cleanupCandidates.map((c: { entryId: string }) => c.entryId), [first.entryId]);
  assert.equal(JSON.stringify(read).includes(body1), false);
  const original = JSON.parse((await readTool.execute("original", { originals: [first, { entryId: "missing", messageIndex: 0 }] }, undefined, undefined, ctx)).content[0].text);
  assert.equal(original.originals[0].text, body1);
  assert.match(original.originals[1].error, /unavailable/);
  const edited = await patchTool.execute("save", { expectedRevision: read.revision,
    update: [{ id: read.slots[0].id, text: "Updated continuation note." }],
    toolResultEdits: [{ ...first, action: "replace", text: "First result consumed, location remains recoverable." }] }, undefined, undefined, ctx);
  assert.equal(edited.isError, undefined, JSON.stringify(edited));
  const saved = JSON.parse(edited.content[0].text);
  assert.deepEqual(saved.toolResultCleanup.applied.map((d: { entryId: string }) => d.entryId), [first.entryId]);
  const projected = project(manager.buildContextEntries());
  assert.equal(projected.cleanup.length, 1);
  const savedLeaf = manager.getLeafId()!;
  const previousLeaf = manager.getEntry(savedLeaf)!.parentId!;
  await f.runtime.session.navigateTree(previousLeaf, { summarize: false });
  assert.equal(project(manager.buildContextEntries()).cleanup.length, 0, "earlier selected branch has no saved overlay");
  await f.runtime.session.navigateTree(savedLeaf, { summarize: false });
  assert.equal(project(manager.buildContextEntries()).cleanup.length, 1);
  assert.equal(originalResults(projected, [first])[0]?.text, body1);
  assert.match(JSON.stringify(effectiveActive(projected, true)), /Nunc summary/);
  const reopened = SessionManager.open(f.runtime.session.sessionFile!, f.sessionDir);
  assert.equal(project(reopened.buildContextEntries()).cleanup.length, 1);
  const altered = structuredClone(reopened.buildContextEntries());
  const alteredSource = altered.find(e => e.id === first.entryId);
  if (alteredSource?.type !== "message" || alteredSource.message.role !== "toolResult") throw new Error("missing native result");
  const originalBlock = alteredSource.message.content[0];
  if (originalBlock?.type !== "text") throw new Error("missing text result");
  originalBlock.text = `${originalBlock.text.slice(0, -1)}${originalBlock.text.endsWith("X") ? "Y" : "X"}`;
  const mismatched = project(altered);
  assert.equal(mismatched.cleanup.length, 0, "same-length changed source must not receive saved cleanup");
  assert(mismatched.unavailable.includes(`${first.entryId}:0`));
  f.respond(() => fauxAssistantMessage("After cleanup"));
  await f.runtime.session.prompt("Continue after save");
  const sent = JSON.stringify(f.calls.at(-1)!.messages);
  assert(sent.includes("Nunc summary"), "next native request carries the projected text");
  assert(!sent.includes(body1), "next native request must not resend the original body");
  assert(sent.includes(body2), "newest complete group remains full");
  assert.equal(originalResults(project(manager.buildContextEntries()), [second])[0]?.text, body2);

  async function settings(enabled: boolean) {
    assert(api);
    await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ compaction: f.settings.getCompactionSettings(),
      nunc: { memoryTools: true, toolResultCleanup: enabled } }));
    // Stock extension reads Pi's effective disk settings on its normal lifecycle.
  }
  await settings(false);
  const off = JSON.parse((await readTool.execute("disabled", {}, undefined, undefined, ctx)).content[0].text);
  assert.equal(off.cleanupCandidates, undefined);
  f.respond(() => fauxAssistantMessage("Disabled view"));
  await f.runtime.session.prompt("Continue with cleanup disabled");
  assert.equal(memorySurface(api!)?.read(ctx!).cleanup?.enabled, false);
  assert(JSON.stringify(f.calls.at(-1)!.messages).includes(body1), "disabled native request restores active raw body");
  assert.equal(project(manager.buildContextEntries()).cleanup.length, 1, "disabled view does not delete saved decisions");
  await settings(true);
  f.respond(() => fauxAssistantMessage("Reenabled view"));
  await f.runtime.session.prompt("Continue with cleanup enabled again");
  assert.equal(memorySurface(api!)?.read(ctx!).cleanup?.enabled, true);
  assert(JSON.stringify(f.calls.at(-1)!.messages).includes("Nunc summary"));
  assert(!JSON.stringify(f.calls.at(-1)!.messages).includes(body1));
});
