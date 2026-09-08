import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fixture, memoryPatch } from "./fixtures.js";
import { answer, sourceRecords } from "../engine/fixtures.js";
import { project } from "../../src/pi/projection.js";

test("native image survives actual host projection and raw Pi model bridge when capacity is explicitly bounded", async t => {
  const f = await fixture({ config: { budget: { imageTokens: 512 } } }); t.after(() => f.close()); f.seed(); f.respond(memoryPatch);
  const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
  f.runtime.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect native image" }, image], timestamp: 8 });
  f.runtime.session.sessionManager.appendMessage(answer({}, f.faux.getModel()));
  await f.runtime.session.compact();
  const content = f.calls[0]?.messages[0]?.content; assert(Array.isArray(content));
  assert.deepEqual(content.find(b => b.type === "image"), image);
  assert(f.events[0]?.result.ok);
});

for (const mode of ["auto", "full"] as const) test(`giant source through real hook in ${mode} mode preserves original K or cancels before dispatch`, async t => {
  const f = await fixture({ config: { extraction: { toolResults: mode }, rolling: { keepRecentFraction: 0.25 } } }); t.after(() => f.close()); f.seed(); f.respond(memoryPatch);
  const manager = f.runtime.session.sessionManager;
  manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse", content: [{ type: "toolCall", id: "giant", name: "probe", arguments: { pattern: "full arguments stay intact" } }] });
  manager.appendMessage({ role: "toolResult", toolCallId: "giant", toolName: "probe", content: [{ type: "text", text: "head" + "e".repeat(300000) + "tail" }], isError: false, timestamp: 10 });
  manager.appendMessage({ role: "user", content: "Keep latest exact correction", timestamp: 11 });
  manager.appendMessage(answer({}, f.faux.getModel()));
  const before = project(manager.buildContextEntries()).active;
  if (mode === "full") {
    const entries = manager.getEntries();
    await assert.rejects(f.runtime.session.compact(), /cancel/i);
    assert.equal(f.faux.state.callCount, 0); assert.deepEqual(manager.getEntries(), entries);
    assert.equal(f.events[0]?.result.ok, false);
  } else {
    const result = await f.runtime.session.compact();
    const event = f.events[0]; assert(event?.result.ok);
    assert.equal(event.result.observations.omissions.length, 1);
    const accounting = event.result.observations.accounting!;
    assert(accounting.fullExtractionTokens > accounting.extractionInputLimit);
    assert(accounting.extractionTokens <= accounting.extractionInputLimit);
    assert(accounting.mainAfterTokens! + accounting.growthTokens! <= accounting.effectiveTrigger);
    assert.deepEqual(project(manager.buildContextEntries()).active, before.slice(before.findIndex(e => e.entryId === result.firstKeptEntryId)));
    assert.equal(sourceRecords(f.calls[0]!).filter(s => s.region === "K").at(-2)?.messages[0]?.content, "Keep latest exact correction");
  }
});

test("a changed main model recomputes H, extraction and final memory allowance on the next actual hook", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const large = f.events[0]; assert(large?.result.ok);
  await f.runtime.session.setModel(f.faux.getModel("small")!);
  f.seed("small-input");
  // Seed helper uses large model history; maintenance must use the currently selected small model.
  await f.runtime.session.compact();
  const small = f.events[1]; assert(small?.result.ok);
  assert(small.result.observations.accounting!.effectiveTrigger < large.result.observations.accounting!.effectiveTrigger);
  assert(small.result.observations.accounting!.memoryLimit < large.result.observations.accounting!.memoryLimit);
  assert.equal(f.runtime.session.model?.id, "small");
});

function fauxMsg(text: string, outputTokens = 50, inputTokens = 1000) {
  const m = fauxAssistantMessage(text);
  m.usage = { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + outputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return m;
}

test("required-capacity failure on manual compact: cancels, no default compaction, leaves M/K unchanged, subsequent turn succeeds without repeating extraction", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  const oversizedPatch = JSON.stringify({
    add: [{ key: "oversizedReq", text: "Mandatory shipment constraint ".repeat(400) }],
    remove: [],
    priority: ["oversizedReq"],
    required: ["oversizedReq"],
  });
  let maintCalls = 0;
  f.respond(context => {
    if (sourceRecords(context).length) {
      maintCalls++;
      return fauxMsg(oversizedPatch, 3500);
    }
    return fauxMsg("Task continued normally.");
  });
  const beforeEntries = f.runtime.session.sessionManager.getEntries();
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(maintCalls, 1, "exactly one maintenance call; no repair loops");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0]?.reason, "manual");
  assert.equal(f.events[0]?.result.ok, false);
  assert.equal(f.events[0]?.result.code, "CAPACITY");
  assert.equal(f.events[0]?.result.observations.required?.failed, true);
  assert.deepEqual(f.events[0]?.result.observations.required?.declared, ["oversizedReq"]);
  // No compaction entry persisted (proves no fallback to default compaction)
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), beforeEntries);

  // Subsequent user prompt continues against preserved history without repeating maintenance or duplicating input
  await f.runtime.session.prompt("Next instruction after failed manual compact");
  assert.equal(maintCalls, 1, "no extra maintenance call during subsequent prompt");
  const callsWithPrompt = f.calls.filter(c => JSON.stringify(c.messages).includes("Next instruction after failed manual compact"));
  assert.equal(callsWithPrompt.length, 1, "prompt delivered exactly once");
});

test("required-capacity failure on pre-prompt threshold: cancels compaction, no default fallback, prompt delivered once without duplicate input", async t => {
  const f = await fixture({ enabled: true }); t.after(() => f.close()); f.seed();
  // Simulate previous response with usage near threshold to trigger pre-prompt threshold maintenance
  const previous = answer({}, f.faux.getModel()); previous.stopReason = "aborted"; previous.timestamp = Date.now();
  previous.usage = { ...previous.usage, input: 24500, cacheRead: 0, cacheWrite: 0, totalTokens: 24540 };
  f.runtime.session.sessionManager.appendMessage(previous);
  f.runtime.session.agent.state.messages = f.runtime.session.sessionManager.buildSessionContext().messages;

  const oversizedPatch = JSON.stringify({
    add: [{ key: "oversizedReq", text: "Mandatory shipment constraint ".repeat(400) }],
    remove: [],
    priority: ["oversizedReq"],
    required: ["oversizedReq"],
  });
  let maintCalls = 0;
  let mainCalls = 0;
  f.respond(context => {
    if (sourceRecords(context).length) {
      maintCalls++;
      return fauxMsg(oversizedPatch, 3500);
    }
    mainCalls++;
    return fauxMsg("Main response after threshold cancellation.", 50, 20000);
  });

  await f.runtime.session.prompt("Prompt requiring execution after threshold failure");
  // In this fixture, prompt() invokes _checkCompaction(lastAssistant, false) before appending
  // the new prompt; post-run completion also invokes _checkCompaction(assistantMessage) when
  // the completed turn leaves context above threshold. (_compactBeforeNextAssistantResponse is
  // subsequent agent-loop-turn preparation, not this initial check).
  assert.equal(maintCalls, 2, "exactly two native threshold opportunities in this fixture: pre-prompt _checkCompaction on prior prefix, then post-run _checkCompaction on updated context with newly delivered turn");
  assert.equal(mainCalls, 1, "prompt dispatched to main model once");
  assert.equal(f.events.length, 2, "both native threshold opportunities recorded");
  assert.equal(f.events[0]?.reason, "threshold");
  assert.equal(f.events[0]?.result.ok, false);
  assert.equal(f.events[0]?.result.code, "CAPACITY");
  assert.equal(f.events[0]?.result.observations.required?.failed, true);
  assert.equal(f.events[1]?.reason, "threshold");
  assert.equal(f.events[1]?.result.ok, false);
  assert.equal(f.events[1]?.result.code, "CAPACITY");
  assert.equal(f.events[1]?.result.observations.required?.failed, true);

  // Verify causal inputs differ: first maintenance does not include the new prompt; second maintenance does
  const firstMaintContext = f.calls[0]!;
  assert(!JSON.stringify(sourceRecords(firstMaintContext)).includes("Prompt requiring execution after threshold failure"));
  const secondMaintContext = f.calls[2]!;
  assert(JSON.stringify(sourceRecords(secondMaintContext)).includes("Prompt requiring execution after threshold failure"));

  // No compaction entry persisted (proves no fallback to default compaction)
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
  // Verify prompt was sent once
  const mainCallsWithPrompt = f.calls.filter(c => !sourceRecords(c).length && JSON.stringify(c.messages).includes("Prompt requiring execution after threshold failure"));
  assert.equal(mainCallsWithPrompt.length, 1, "prompt was delivered once without duplicate inputs");
});

test("required-capacity failure on provider overflow: cancels compaction, terminates without infinite compaction loops or duplicate effects", async t => {
  const f = await fixture({ enabled: true }); t.after(() => f.close()); f.seed();
  const oversizedPatch = JSON.stringify({
    add: [{ key: "oversizedReq", text: "Mandatory shipment constraint ".repeat(400) }],
    remove: [],
    priority: ["oversizedReq"],
    required: ["oversizedReq"],
  });
  let maintCalls = 0;
  let mainCalls = 0;
  f.respond(context => {
    if (sourceRecords(context).length) {
      maintCalls++;
      return fauxMsg(oversizedPatch, 3500);
    }
    mainCalls++;
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" });
  });

  await f.runtime.session.prompt("Prompt that triggers overflow");
  assert.equal(maintCalls, 1, "overflow maintenance attempted exactly once, no infinite compaction loop");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0]?.reason, "overflow");
  assert.equal(f.events[0]?.result.ok, false);
  assert.equal(f.events[0]?.result.code, "CAPACITY");
  assert.equal(f.events[0]?.result.observations.required?.failed, true);
  // No compaction entry persisted
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
});

test("host tool execution across required-capacity cancellations: tools execute once without duplicate effects", async t => {
  for (const mode of ["manual", "threshold", "overflow"] as const) {
    let executions = 0;
    let main = 0;
    let maintenance = 0;
    let recovery = false;
    const tool = {
      name: "probe",
      label: "Probe",
      description: "Count one synthetic effect",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        executions++;
        return { content: [{ type: "text" as const, text: "effect observed" }], details: {} };
      },
    };
    const f = await fixture({ enabled: mode !== "manual", config: { memory: { maxTokens: 100 } }, tools: [tool] });
    try {
      f.seed();
      if (mode === "threshold") {
        const previous = answer({}, f.faux.getModel());
        previous.stopReason = "aborted";
        previous.timestamp = Date.now();
        previous.usage = { ...previous.usage, input: 24500, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 24540 };
        f.runtime.session.sessionManager.appendMessage(previous);
        f.runtime.session.agent.state.messages = f.runtime.session.sessionManager.buildSessionContext().messages;
      }
      f.respond(c => {
        if (sourceRecords(c).length) {
          maintenance++;
          const m = fauxAssistantMessage(JSON.stringify({
            add: [{ key: "req", text: "Necessary constraint ".repeat(400) }],
            remove: [],
            priority: ["req"],
            required: ["req"],
          }));
          m.api = f.faux.getModel().api;
          m.provider = f.faux.getModel().provider;
          m.model = f.faux.getModel().id;
          m.usage = { input: 1000, output: 3500, cacheRead: 0, cacheWrite: 0, totalTokens: 4500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          return m;
        }
        main++;
        if (main === 1) {
          const m = fauxAssistantMessage("");
          m.stopReason = "toolUse";
          m.content = [{ type: "toolCall", id: "once", name: "probe", arguments: {} }];
          if (mode === "threshold") m.usage = { ...m.usage, input: 24500, output: 50, totalTokens: 24550 };
          return m;
        }
        if (mode === "overflow" && !recovery) {
          return fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" });
        }
        return fauxAssistantMessage("Continued.");
      });
      if (mode === "manual") {
        try { await f.runtime.session.compact(); }
        catch (e) { if (!/cancel/i.test(String(e))) throw e; }
      }
      await f.runtime.session.prompt("Execute once " + mode);
      assert.equal(executions, 1, `${mode}: tool executed exactly once`);
      recovery = true;
      await f.runtime.session.prompt("Continue " + mode);
      assert.equal(executions, 1, `${mode}: tool not duplicated during recovery`);

      const expectedMaintEvents = mode === "overflow" ? 2 : 1;
      assert.equal(f.events.length, expectedMaintEvents, `${mode}: expected exactly ${expectedMaintEvents} maintenance events`);
      assert.equal(f.events[0]?.reason, mode, `${mode}: first maintenance reason must be ${mode}`);
      assert.equal(f.events[0]?.result.ok, false, `${mode}: maintenance must fail`);
      assert.equal(f.events[0]?.result.code, "CAPACITY", `${mode}: failure code must be CAPACITY`);
      assert.equal(f.events[0]?.result.observations.required?.failed, true, `${mode}: required items must fail`);
      assert.deepEqual(f.events[0]?.result.observations.required?.declared, ["req"], `${mode}: declared required items must match`);

      if (mode === "overflow") {
        assert.equal(f.events[1]?.reason, "threshold", `${mode}: recovery prompt pre-check triggers threshold`);
        assert.equal(f.events[1]?.result.ok, false);
        assert.equal(f.events[1]?.result.code, "CAPACITY");
        assert.equal(f.events[1]?.result.observations.required?.failed, true);
      }

      assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0, `${mode}: no compaction saved`);
      assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "message" && e.message.role === "toolResult").length, 1, `${mode}: exactly one toolResult recorded`);
    } finally {
      await f.close();
    }
  }
});
