import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { convertToLlm, sessionEntryToContextMessages, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sourceRecords } from "../engine/fixtures.js";
import { fixture, memoryPatch } from "./fixtures.js";
import { project, eligibleStarts } from "../../src/pi/projection.js";

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
  const expected = manager.buildContextEntries().filter(e => e.type !== "compaction").flatMap(e => convertToLlm(sessionEntryToContextMessages(e)));
  assert.deepEqual(before.active.flatMap(e => e.messages), expected);
  await f.runtime.session.compact();
  const extraction = f.calls.at(-1)!;
  // JSON has no undefined member: optional tool usage=undefined is absent on the wire.
  assert.deepEqual(sourceRecords(extraction).flatMap(s => s.messages), JSON.parse(JSON.stringify(expected)));
  assert.equal(executions, 1, "maintenance never dispatches business tools");
  assert.equal(extraction.tools?.length, 0);
  assert(!JSON.stringify(extraction).includes("INVISIBLE"));
  assert(JSON.stringify(extraction).includes("unopened-fixture-log"), "log path is source text, never retrieved");
  const firstBlock = extraction.messages[0]!.content; assert(Array.isArray(firstBlock));
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

test("native image missing capacity bound and orphan tool input cancel without lost-content workaround", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  const manager = f.runtime.session.sessionManager;
  manager.appendMessage({ role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 10 });
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.faux.state.callCount, 0);
  manager.appendMessage({ role: "toolResult", toolCallId: "unknown", toolName: "probe", content: [{ type: "text", text: "orphan" }], isError: true, timestamp: 11 });
  manager.appendMessage({ role: "user", content: "Continue after that orphan result", timestamp: 12 });
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.faux.state.callCount, 0);
});
