import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { memorySurface } from "../../src/pi/index.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { answer, assistant, tool, user } from "../engine/fixtures.js";
import { parseNuncSettings, resolveMemoryTools, resolveToolResultCleanup } from "../../src/pi/config.js";
import { compactionCleanupScope, eligibleCleanupScope, project, originalResults, effectiveActive } from "../../src/pi/projection.js";
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
  assert.deepEqual(compactionCleanupScope(active, []), [{ entryId: "r1", messageIndex: 0 }]);
  assert.deepEqual(compactionCleanupScope(active, [{ entryId: "r1", messageIndex: 0 } as any]), []);
  assert.deepEqual(eligibleCleanupScope(active, ["unknown"], []), []);
  assert.deepEqual(eligibleCleanupScope(active, ["old"], [{ entryId: "r1", messageIndex: 0 } as any]), []);
});

for (const reopen of [false, true]) test(`compaction cleanup without a sent-M anchor: ${reopen ? "SessionManager.open before another main" : "first compact with empty M"}`, async t => {
  let ctx: ExtensionContext | undefined;
  const f = await fixture({ diskSettings: true, globalSettings: { nunc: { memoryTools: true } },
    extras: [{ name: "capture-anchorless-compaction", factory(pi) {
      pi.on("session_start", (_event, current) => { ctx = current; });
    } }] });
  t.after(() => f.close());
  f.seed();
  if (reopen) {
    f.respond(memoryPatch);
    await f.runtime.session.compact();
    assert.equal(f.events.at(-1)?.result.ok, true);
  }
  const original = "Older completed diagnostic with recoverable detail. ".repeat(25);
  const newest = "Newest completed diagnostic must remain full. ".repeat(25);
  const managerBefore = f.runtime.session.sessionManager;
  const refs = [original, newest].map((body, index) => {
    const id = `anchorless-${index}`;
    managerBefore.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }] });
    return managerBefore.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: body }], timestamp: 2 });
  });
  f.runtime.session.agent.state.messages = managerBefore.buildSessionContext().messages;
  const callsBefore = f.calls.length;
  if (reopen) {
    const file = f.runtime.session.sessionFile!;
    const reopened = SessionManager.open(file, f.sessionDir);
    await f.runtime.switchSession(file);
    assert.notEqual(f.runtime.session.sessionManager, managerBefore);
    assert.equal(f.runtime.session.sessionManager.getSessionId(), reopened.getSessionId());
  }
  assert(ctx);
  const manager = f.runtime.session.sessionManager;
  const before = project(manager.buildContextEntries());
  assert.equal(before.memory.slots.length > 0, reopen);
  const read = (f.runtime.session as any).getToolDefinition("nunc_memory_read");
  const manualView = JSON.parse((await read.execute("no-anchor", {}, undefined, undefined, ctx)).content[0].text);
  assert.equal(manualView.cleanupCandidates, undefined, "live read/patch still require a sent-M prefix");
  assert.equal(f.calls.length, callsBefore, "no main request may establish an anchor before this compact");
  f.respond(context => {
    const records = context.messages.flatMap(message => typeof message.content === "string" ? [] : message.content.flatMap(block => {
      if (block.type !== "text") return [];
      try { return [JSON.parse(block.text) as { cleanupCandidates?: { entryId: string; messageIndex: number }[] }]; } catch { return []; }
    }));
    assert.deepEqual(records.find(row => row.cleanupCandidates)?.cleanupCandidates?.map(ref => ref.entryId), [refs[0]],
      "actual maintenance supplies only the older retained completed result");
    const patch = memoryPatch(context).content.find(block => block.type === "text");
    assert(patch?.type === "text");
    return fauxAssistantMessage(JSON.stringify({ ...JSON.parse(patch.text),
      ...(reopen ? { update: [{ id: before.memory.slots[0]!.id, text: "Task continues after consuming the earlier completed diagnostic." }] } : {}), toolResultEdits: [
      { entryId: refs[0], messageIndex: 0, action: "replace", text: "Earlier diagnostic consumed; original remains recoverable." },
    ] }));
  });
  await f.runtime.session.compact();
  assert.equal(f.events.at(-1)?.result.ok, true, JSON.stringify(f.events.at(-1)));
  const after = project(manager.buildContextEntries());
  assert.deepEqual(after.cleanup.map(ref => ref.entryId), [refs[0]]);
  assert(after.active.some(entry => entry.entryId === refs[0]), "edited result must be retained K, not retired B");
  assert.equal(originalResults(after, [{ entryId: refs[0]!, messageIndex: 0 }])[0]?.text, original);
  assert(!JSON.stringify(effectiveActive(after, true)).includes(original));
  assert(JSON.stringify(effectiveActive(after, true)).includes(newest));
  assert.deepEqual(project(SessionManager.open(f.runtime.session.sessionFile!, f.sessionDir).buildContextEntries()).cleanup, after.cleanup);
  f.respond(() => fauxAssistantMessage("Continue after compaction cleanup."));
  await f.runtime.session.prompt("Continue the established task");
  const sent = JSON.stringify(f.calls.at(-1)!.messages);
  assert(!sent.includes(original)); assert(sent.includes(newest));
  const sentResult = f.calls.at(-1)!.messages.find(message => message.role === "toolResult" && message.toolCallId === "anchorless-0");
  assert(sentResult?.role === "toolResult");
  assert.deepEqual(sentResult.content, [{ type: "text", text: after.cleanup[0]!.text }]);
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

test("hosted patch tool skips malformed optional cleanup while committing legal M, and accepts a valid edit", async t => {
  let ctx: ExtensionContext | undefined, api: ExtensionAPI | undefined;
  const f = await fixture({ diskSettings: true, globalSettings: { nunc: { memoryTools: true } },
    extras: [{ name: "capture-public-cleanup-patch", factory(pi) {
      api = pi;
      pi.on("session_start", (_event, current) => { ctx = current; });
    } }] });
  t.after(() => f.close());
  assert(ctx && api);
  const manager = f.runtime.session.sessionManager;
  const definition = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");
  assert.match(definition.parameters.properties.toolResultEdits.description, /Optional array of eligible result edits/);
  const sendPatch = async (id: string, args: Record<string, unknown>) => {
    let sent = 0;
    f.respond(() => sent++ === 0
      ? fauxAssistantMessage(fauxToolCall("nunc_memory_patch", args as Parameters<typeof fauxToolCall>[1], { id }), { stopReason: "toolUse" })
      : fauxAssistantMessage("Controlled continuation after public tool result."));
    await f.runtime.session.prompt(`Apply ${id} through the hosted agent`);
    const result = manager.getBranch().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === id);
    assert(result?.type === "message" && result.message.role === "toolResult", `Host must dispatch ${id}`);
    assert.equal(result.message.isError, false, JSON.stringify(result.message));
    const block = result.message.content.find(b => b.type === "text");
    assert(block?.type === "text");
    return JSON.parse(block.text);
  };
  const bad: unknown[] = [
    [{ entryId: "missing", messageIndex: 0, action: "invalid" }],
    [{ entryId: "missing", messageIndex: -1, action: "omit" }],
    [{ entryId: 42, messageIndex: 0, action: "omit" }],
    { entryId: "missing", messageIndex: 0, action: "omit" },
  ];
  for (const [index, edits] of bad.entries()) {
    const revision = memorySurface(api)!.read(ctx).revision;
    const result = await sendPatch(`invalid-cleanup-${index}`, { expectedRevision: revision,
      add: [{ key: `note-${index}`, text: `Keep independently useful task note ${index}.` }], toolResultEdits: edits });
    assert.equal(result.ok, true);
    assert.equal(result.toolResultCleanup.applied.length, 0);
    assert.equal(result.toolResultCleanup.skipped[0]?.reason, "invalid_shape");
    assert.equal(memorySurface(api)!.read(ctx).memory.slots.length, index + 1);
  }

  f.respond(() => fauxAssistantMessage("Existing memory sent before cleanup."));
  await f.runtime.session.prompt("Establish the later cleanup anchor");
  const sourceBody = "Verified local diagnostic with relevant context. ".repeat(40);
  for (const id of ["eligible-source", "newest-source"]) {
    manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: sourceBody }], timestamp: 2 });
  }
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const read = (f.runtime.session as any).getToolDefinition("nunc_memory_read");
  const scope = JSON.parse((await read.execute("read-candidates", {}, undefined, undefined, ctx)).content[0].text);
  assert.equal(scope.cleanupCandidates.length, 1);
  const valid = await sendPatch("valid-cleanup", { expectedRevision: scope.revision,
    add: [{ key: "verified", text: "Diagnostic consumed; original remains recoverable." }],
    toolResultEdits: [{ entryId: scope.cleanupCandidates[0].entryId, messageIndex: 0,
      action: "replace", text: "Diagnostic consumed; see retained original." }] });
  assert.equal(valid.ok, true);
  assert.equal(valid.toolResultCleanup.applied.length, 1);
  assert.equal(memorySurface(api)!.read(ctx).memory.slots.length, bad.length + 1);
  assert.equal(project(manager.buildContextEntries()).cleanup.length, 1);

  const savedView = memorySurface(api)!.read(ctx);
  const savedMemory = structuredClone(savedView.memory);
  let dispatched = false;
  f.respond(() => {
    if (dispatched) return fauxAssistantMessage("Invalid M parameters were rejected by the host.");
    dispatched = true;
    return fauxAssistantMessage(fauxToolCall("nunc_memory_patch", {
      expectedRevision: savedView.revision,
      add: [{ text: "Missing required addition key" }],
    }, { id: "invalid-memory-shape" }), { stopReason: "toolUse" });
  });
  await f.runtime.session.prompt("Required M-field host validation probe");
  const rejected = manager.getBranch().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "invalid-memory-shape");
  assert(rejected?.type === "message" && rejected.message.role === "toolResult");
  assert.equal(rejected.message.isError, true, `required M item remains host-validated: ${JSON.stringify(rejected.message)}`);
  assert.deepEqual(memorySurface(api)!.read(ctx).memory, savedMemory);
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

for (const change of ["update", "delete", "unrelated", "legacy-update", "maintenance-update", "maintenance-delete", "maintenance-evict"] as const) test(`committed cleanup survives later ${change} without automatic source restoration`, async t => {
  let ctx: ExtensionContext | undefined, api: ExtensionAPI | undefined;
  const f = await fixture({ config: change === "maintenance-evict" ? { memory: { fraction: 0 } } : {},
    diskSettings: true, globalSettings: { nunc: { memoryTools: change !== "maintenance-evict" } },
    extras: [{ name: "capture-inherited-cleanup", factory(pi) {
      api = pi; pi.on("session_start", (_event, current) => { ctx = current; });
    } }] });
  t.after(() => f.close());
  assert(ctx && api);
  const surface = memorySurface(api)!;
  if (change.startsWith("maintenance")) f.seed("inherited-checkpoint");
  const initial = surface.patch(ctx, { expectedRevision: surface.read(ctx).revision,
    add: [{ key: "evidence", text: "Retain the source's decisive exception." }, { key: "other", text: "Unrelated pending work." }] });
  assert(initial.ok, JSON.stringify(initial));
  const evidenceId = initial.memory.slots[0]!.id, otherId = initial.memory.slots[1]!.id;
  f.respond(() => fauxAssistantMessage("Anchor established."));
  await f.runtime.session.prompt("Send the initial memory");
  const manager = f.runtime.session.sessionManager;
  const original = "The source's decisive exception must remain recoverable. ".repeat(40);
  for (const [id, body] of [["dependency", original], ["newest", "Newest unrelated output. ".repeat(35)]] as const) {
    manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: body }], timestamp: 2 });
  }
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const view = surface.read(ctx);
  const source = project(manager.buildContextEntries()).active.find(entry => entry.messages[0]?.role === "toolResult")!;
  const cleaned = surface.patch(ctx, { expectedRevision: view.revision,
    update: [{ id: otherId, text: "Unrelated pending work progressed." }],
    toolResultEdits: [{ entryId: source.entryId, messageIndex: 0, action: "omit", memoryRefs: [evidenceId] }] });
  assert(cleaned.ok, JSON.stringify(cleaned));
  assert.equal(cleaned.cleanup?.applied.length, 1);
  if (change === "legacy-update") {
    const saved = manager.getEntry(manager.getLeafId()!)!;
    assert(saved.type === "custom");
    const data = structuredClone(saved.data) as { toolResultCleanup: { text: string; originalLength: number; cleanedLength: number; netSavings: number }[] };
    const decision = data.toolResultCleanup[0]!;
    decision.text = `[Nunc: tool result omitted; original recoverable from entry ${source.entryId} message 0]`;
    decision.cleanedLength = decision.text.length;
    decision.netSavings = decision.originalLength - decision.cleanedLength;
    api.appendEntry(saved.customType, data);
  }
  const committed = project(manager.buildContextEntries()).cleanup[0]!;
  assert(committed, "the initial approval and legacy fixture must form a valid saved decision");
  f.respond(() => fauxAssistantMessage("Cleaned projection sent."));
  await f.runtime.session.prompt("Use the cleaned result");
  assert(!JSON.stringify(f.calls.at(-1)!.messages).includes(original));
  const before = surface.read(ctx);
  const previousRequest = f.calls.at(-1)!;
  if (change.startsWith("maintenance")) {
    const remove = change === "maintenance-delete" ? [evidenceId] : [];
    f.respond(() => fauxAssistantMessage(JSON.stringify({ add: [], remove,
      update: remove.length || change === "maintenance-evict" ? [] : [{ id: evidenceId, text: "Revised task note." }],
      priority: before.memory.slots.map(slot => slot.id).filter(id => !remove.includes(id)),
      required: change === "maintenance-evict" ? [] : [otherId] })));
    await f.runtime.session.compact();
    assert.equal(f.events.at(-1)?.result.ok, true, JSON.stringify(f.events.at(-1)));
  } else {
    const changed = change === "delete" ? surface.delete(ctx, before.revision, evidenceId)
      : surface.replace(ctx, before.revision, change === "unrelated" ? otherId : evidenceId, "Revised task note.");
    assert(changed.ok, JSON.stringify(changed));
  }
  if (change === "maintenance-evict") {
    assert.deepEqual(surface.read(ctx).memory.slots, [], "required-free final M is actually budget-evicted");
    assert.equal((f.runtime.session as any).getToolDefinition("nunc_memory_read"), undefined,
      "cleanup cannot implicitly enable an original-read tool");
  }
  const projected = project(manager.buildContextEntries());
  assert(projected.active.some(entry => entry.entryId === source.entryId), "counterexample must retain the source in K, not recover retired B");
  assert.deepEqual(projected.cleanup, [committed], "later memory edits cannot turn approval-time support into a permanent foreign key");
  assert.equal(JSON.stringify(effectiveActive(projected, true)).includes(original), false);
  assert.equal(originalResults(projected, [{ entryId: source.entryId, messageIndex: 0 }])[0]?.text, original);
  const reopened = SessionManager.open(f.runtime.session.sessionFile!, f.sessionDir);
  assert.deepEqual(project(reopened.buildContextEntries()).cleanup, [committed]);
  f.respond(() => fauxAssistantMessage("Continuation after memory edit."));
  await f.runtime.session.prompt("Continue after the memory change");
  const nextRequest = f.calls.at(-1)!;
  assert.equal(JSON.stringify(nextRequest.messages).includes(original), false,
    "actual native payload keeps the approved reduction even when supporting M changes later");
  const sourceMessage = nextRequest.messages.find(message => message.role === "toolResult" && message.toolCallId === "dependency");
  assert(sourceMessage?.role === "toolResult");
  assert.deepEqual(sourceMessage.content, [{ type: "text", text: committed.text }]);
  if (!change.startsWith("maintenance")) {
    const previousMemoryIndex = previousRequest.messages.findIndex(message => JSON.stringify(message).includes("Nunc working memory (session-local, reference only):"));
    assert(previousMemoryIndex >= 0);
    assert.deepEqual(nextRequest.messages.slice(0, previousMemoryIndex), previousRequest.messages.slice(0, previousMemoryIndex),
      "later M changes cannot move prefix changes earlier than the prior M");
  }
  if (change === "update") {
    let sentRead = false;
    f.respond(() => {
      if (sentRead) return fauxAssistantMessage("Active original read at new tail.");
      sentRead = true;
      return fauxAssistantMessage(fauxToolCall("nunc_memory_read", { originals: [{ entryId: source.entryId, messageIndex: 0 }] },
        { id: "read-active-original" }), { stopReason: "toolUse" });
    });
    await f.runtime.session.prompt("Explicitly read the available active original.");
    const delivered = f.calls.at(-1)!;
    const oldPosition = delivered.messages.find(message => message.role === "toolResult" && message.toolCallId === "dependency");
    assert(oldPosition?.role === "toolResult");
    assert.deepEqual(oldPosition.content, [{ type: "text", text: committed.text }], "read must not refill the old position");
    const tailIndex = delivered.messages.findIndex(message => message.role === "toolResult" && message.toolCallId === "read-active-original");
    assert(tailIndex > delivered.messages.indexOf(oldPosition));
    const tail = delivered.messages[tailIndex]!;
    assert(tail.role === "toolResult" && Array.isArray(tail.content));
    const block = tail.content.find(item => item.type === "text");
    assert(block?.type === "text");
    assert.equal(JSON.parse(block.text).originals[0].text, original);
    assert.deepEqual(project(manager.buildContextEntries()).cleanup, [committed]);
  }
});
