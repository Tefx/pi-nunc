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
