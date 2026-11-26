import { semanticEvidence } from "../../bench/live/scenarios.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager, sessionEntryToContextMessages, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sourceRecords } from "../engine/fixtures.js";
import { fixture, memoryPatch } from "./fixtures.js";
import { isSystemMessage } from "../../src/engine/accounting.js";
import { project, eligibleUsageEntryIds, compactionCleanupScope, eligibleStarts, originalResults, searchBranchHistory, withEffectiveMemory, peekMemoryAnchor, sealDecisions, MANUAL_MEMORY_TYPE, carrierIndexIn } from "../../src/pi/projection.js";

test("native edits share active, history, originals and anchor projection semantics", async t => {
  const f = await fixture(); t.after(() => f.close());
  const manager = f.runtime.session.sessionManager;
  const user = manager.appendMessage({ role: "user", content: "Original user", timestamp: 1 });
  const assistant = manager.appendMessage(fauxAssistantMessage("Original assistant"));
  const tool = manager.appendMessage({ role: "toolResult", toolCallId: "c", toolName: "read", isError: false,
    content: [{ type: "text", text: "old caption" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 2 });
  const custom = manager.appendCustomMessageEntry("visible", "Old custom", false);
  manager.appendMessage({ role: "bashExecution", command: "private", output: "Excluded bash", excludeFromContext: true,
    exitCode: 0, cancelled: false, truncated: false, timestamp: 3 });
  manager.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: { version: 1, nextId: 2, slots: [{ id: "s1", text: "Saved M" }] } });
  for (const id of [user, assistant, tool, custom]) manager.appendContextEdit(id, { content: "Edited visible body" });
  const entries = manager.buildContextEntries(), projected = project(entries);
  assert.equal(projected.active.length, 4);
  assert(projected.active.every(entry => JSON.stringify(entry.messages).includes("Edited visible body")));
  assert(projected.active.find(entry => entry.entryId === assistant)?.outputUsageUnavailable);
  assert.equal(originalResults(projected, [{ entryId: tool, messageIndex: 0 }], manager.getBranch())[0]?.text, "Edited visible body");
  const messages = manager.buildSessionContext().messages;
  withEffectiveMemory(messages, projected.memory, { sessionId: manager.getSessionId(), entries });
  assert.deepEqual(peekMemoryAnchor(manager.getSessionId())?.prefixEntryIds, projected.active.map(entry => entry.entryId));
  manager.appendCompaction("Retired", custom, 1000);
  const retired = project(manager.buildContextEntries());
  assert.equal(originalResults(retired, [{ entryId: tool, messageIndex: 0 }], manager.getBranch())[0]?.text, "Edited visible body");
  manager.appendContextEdit(tool, null);
  const omitted = project(manager.buildContextEntries());
  assert.equal(searchBranchHistory(manager.getBranch(), omitted.active, { entryIds: [tool] }).entries[0]?.messages.length, 0);
  assert(originalResults(omitted, [{ entryId: tool, messageIndex: 0 }], manager.getBranch())[0]?.error);
});

for (const replacement of [null, { content: "Edited user" }]) test(`usage receipts after a checkpoint expire on native ${replacement === null ? "omission" : "replacement"}`, () => {
  const manager = SessionManager.inMemory();
  const old = manager.appendMessage({ role: "user", content: "Kept from earlier window", timestamp: 0 });
  manager.appendCompaction("", old, 1000);
  const target = manager.appendMessage({ role: "user", content: "Post-checkpoint source", timestamp: 1 });
  const receipt = manager.appendMessage(fauxAssistantMessage("Older usage receipt"));
  let entries = manager.buildContextEntries();
  assert(eligibleUsageEntryIds(entries, project(entries).active).includes(receipt));
  manager.appendContextEdit(old, { content: "Edit outside the post-checkpoint window" });
  entries = manager.buildContextEntries();
  assert(eligibleUsageEntryIds(entries, project(entries).active).includes(receipt));
  manager.appendContextEdit(target, replacement);
  entries = manager.buildContextEntries();
  assert.deepEqual(eligibleUsageEntryIds(entries, project(entries).active), []);
  const fresh = manager.appendMessage(fauxAssistantMessage("Fresh usage receipt"));
  entries = manager.buildContextEntries();
  assert.deepEqual(eligibleUsageEntryIds(entries, project(entries).active), [fresh]);
});

test("identical native replacement invalidates saved cleanup targets and candidate eligibility", () => {
  const manager = SessionManager.inMemory();
  const body = "Full original source ".repeat(50);
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "first" }), { stopReason: "toolUse" }));
  const target = manager.appendMessage({ role: "toolResult", toolCallId: "first", toolName: "read", isError: false,
    content: [{ type: "text", text: body }], timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "newest" }), { stopReason: "toolUse" }));
  manager.appendMessage({ role: "toolResult", toolCallId: "newest", toolName: "read", isError: false,
    content: [{ type: "text", text: "Newest full source" }], timestamp: 2 });
  const raw = project(manager.buildContextEntries());
  manager.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: raw.memory, toolResultCleanup: sealDecisions(raw.active, [{
    entryId: target, messageIndex: 0, toolCallId: "first", toolName: "read", kind: "semantic", action: "replace", text: "Summary",
    originalLength: body.length, cleanedLength: 7, netSavings: body.length - 7,
  }]) });
  assert.equal(project(manager.buildContextEntries()).cleanup.length, 1);
  manager.appendContextEdit(target, { content: body });
  const projected = project(manager.buildContextEntries());
  assert.equal(projected.cleanup.length, 0);
  assert.deepEqual(projected.unavailable, [`${target}:0`]);
  assert.deepEqual(compactionCleanupScope(projected.active, []), []);
});

test("a mismatched tool name cannot establish a completed memory boundary", () => {
  const messages = [
    { role: "user", content: "Begin", timestamp: 1 },
    fauxAssistantMessage(fauxToolCall("read", {}, { id: "c" }), { stopReason: "toolUse" }),
    { role: "toolResult", toolCallId: "c", toolName: "write", content: [{ type: "text", text: "Wrong tool" }], timestamp: 2 },
    { role: "user", content: "Continue", timestamp: 3 },
  ];
  const result = withEffectiveMemory(messages, { version: 1, nextId: 2, slots: [{ id: "s1", text: "Saved M" }] });
  assert.equal(carrierIndexIn(result), 1);
});

test("saved cleanup digests distinguish block partitions and malformed cleanup containers", async t => {
  const f = await fixture(); t.after(() => f.close());
  const manager = f.runtime.session.sessionManager;
  const id = manager.appendMessage({ role: "toolResult", toolCallId: "c", toolName: "read", isError: false,
    content: [{ type: "text", text: "a".repeat(300) }, { type: "text", text: "b".repeat(300) }], timestamp: 1 });
  const before = project(manager.buildContextEntries());
  const decision = { entryId: id, messageIndex: 0, toolCallId: "c", toolName: "read", kind: "semantic" as const, action: "replace" as const,
    text: "Summary", originalLength: 601, cleanedLength: 7, netSavings: 594 };
  const data = { nunc: before.memory, toolResultCleanup: sealDecisions(before.active, [decision]) };
  manager.appendCustomEntry(MANUAL_MEMORY_TYPE, data);
  assert.equal(project(manager.buildContextEntries()).cleanup.length, 1);
  const changed = structuredClone(manager.buildContextEntries());
  const source = changed.find(entry => entry.id === id); assert(source?.type === "message" && source.message.role === "toolResult");
  source.message.content = [{ type: "text", text: "a".repeat(300) + "\n" + "b".repeat(300) }];
  assert.equal(project(changed).cleanup.length, 0);
  manager.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: before.memory, toolResultCleanup: {} });
  assert.equal(project(manager.buildContextEntries()).unavailable.length, 1);
});

test("real main tool loop and extraction retain complete bodies, arguments, associations, and visible custom/bash/branch projections", async t => {
  const body = "BEGIN\n" + "tool evidence ".repeat(1100) + "\nEND";
  let executions = 0;
  const tool: ToolDefinition = { name: "probe", label: "Probe", description: "Observe test evidence", parameters: Type.Object({ path: Type.String(), count: Type.Number() }), execute: async (_id, args) => {
    executions++; assert.deepEqual(args, { path: "report.txt", count: 17 });
    return { content: [{ type: "text", text: body }], details: {} };
  } };
  const f = await fixture({ tools: [tool] }); t.after(() => f.close()); f.seed();
  const manager = f.runtime.session.sessionManager;
  manager.appendCustomMessageEntry("visible", "CUSTOM complete text", false, {}); // display=false is still LLM-visible in Pi.
  manager.appendCustomEntry("private", { text: "INVISIBLE metadata" });
  manager.appendMessage({ role: "bashExecution", command: "fixture command", output: "BASH complete result", exitCode: 7, cancelled: false, truncated: true, fullOutputPath: "/unopened-fixture-log", timestamp: 3 });
  manager.appendMessage({ role: "bashExecution", command: "private", output: "INVISIBLE bash", excludeFromContext: true, exitCode: 0, cancelled: false, truncated: false, timestamp: 3 });
  manager.branchWithSummary(manager.getLeafId()!, "BRANCH visible evidence");
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  let main = 0;
  f.respond(context => sourceRecords(context).length ? memoryPatch(context) : ++main === 1
    ? fauxAssistantMessage(fauxToolCall("probe", { path: "report.txt", count: 17 }, { id: "probe-1" }), { stopReason: "toolUse" })
    : fauxAssistantMessage("Result incorporated."));
  await f.runtime.session.prompt("Probe then continue");
  assert.equal(executions, 1, JSON.stringify({ tools: f.calls[0]?.tools, last: f.runtime.session.agent.state.messages.at(-1), toolResults: f.runtime.session.agent.state.messages.filter(m => m.role === "toolResult") })); assert.equal(main, 2);
  const result = f.calls[1]!.messages.find(m => m.role === "toolResult");
  assert.deepEqual(result?.content, [{ type: "text", text: body }]);
  const before = project(manager.buildContextEntries());
  const expected = manager.buildContextEntries().filter(e => e.type !== "compaction").flatMap(e => convertToLlm(sessionEntryToContextMessages(e))).filter(m => !isSystemMessage(m));
  assert.deepEqual(before.active.flatMap(e => e.messages), expected);
  await f.runtime.session.compact();
  const extraction = f.calls.at(-1)!;
  // JSON has no undefined member: optional tool usage=undefined is absent on the wire.
  assert.deepEqual(sourceRecords(extraction).flatMap(s => s.messages), expected.map(semanticEvidence));
  assert.equal(executions, 1, "maintenance never dispatches business tools");
  assert.equal(extraction.tools?.length, 0);
  assert(!JSON.stringify(extraction).includes("INVISIBLE"));
  assert(JSON.stringify(extraction).includes("unopened-fixture-log"), "log path is source text, never retrieved");
  const extractMsg = extraction.messages.find(m => m.role === "user");
  const firstBlock = extractMsg!.content; assert(Array.isArray(firstBlock));
  const fm = firstBlock[0]; assert(fm?.type === "text");
  const fixed = JSON.parse(fm.text).F;
  assert.equal(fixed.tools[0].name, "probe"); assert.equal(fixed.systemPrompt, f.runtime.session.systemPrompt);
});

test("host-visible starts exclude metadata, excluded bash, and the old compaction entry", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const latest = f.runtime.session.sessionManager.getLeafId()!;
  f.seed("after");
  const branch = f.runtime.session.sessionManager.getBranch();
  const projected = project(f.runtime.session.sessionManager.buildContextEntries());
  const eligible = eligibleStarts(branch, projected.active, projected.latestId);
  assert(eligible.length > 0); assert(!eligible.includes(latest));
  assert(eligible.some(id => branch.findIndex(e => e.id === id) < branch.findIndex(e => e.id === latest)), "real K remains eligible across the older checkpoint");
  assert.deepEqual(eligible, projected.active.map(e => e.entryId));
});

test("native images on unsupported models and orphan tool input cancel without lost-content workaround", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  const manager = f.runtime.session.sessionManager;
  manager.appendMessage({ role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 10 });
  await f.runtime.session.setModel({ ...f.faux.getModel("small")!, input: ["text"] });
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.faux.state.callCount, 0);
  const rejected = f.events[0]?.result;
  assert(rejected && !rejected.ok);
  assert.equal(rejected.code, "UNSUPPORTED_INPUT");
  await f.runtime.session.setModel(f.faux.getModel());
  manager.appendMessage({ role: "toolResult", toolCallId: "unknown", toolName: "probe", content: [{ type: "text", text: "orphan" }], isError: true, timestamp: 11 });
  manager.appendMessage({ role: "user", content: "Continue after that orphan result", timestamp: 12 });
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.faux.state.callCount, 0);
});
