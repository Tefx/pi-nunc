import { test } from "node:test";
import { semanticEvidence } from "../../src/live/scenarios.js";
import assert from "node:assert/strict";
import { legalCuts, mainContext, maintain } from "../../src/engine/index.js";
import type { ActiveEntry } from "../../src/engine/index.js";
import { answer, assistant, input, noChange, responder, sourceRecords, tool, user } from "./fixtures.js";

test("complete effective source includes pending latest user, custom messages, full tool body/arguments/status", async () => {
  const source = await input();
  const body = "head" + "中间关键证据".repeat(600) + "tail";
  source.active = [user("old", "old"), assistant("calls", [
    { type: "thinking", thinking: "hypothesis" },
    { type: "toolCall", id: "call1", name: "read", arguments: { path: "/fixture/entire.txt", nested: { exact: "arg".repeat(800) } } },
  ]), tool("result", "call1", body), { entryId: "custom", sourceRole: "custom", messages: [{ role: "user", content: "An injected effective observation", timestamp: 0 }] }, user("pending", "Latest user correction, not yet sent")];
  const resultMessage = source.active[2]!.messages[0]!;
  assert(resultMessage.role === "toolResult"); resultMessage.isError = true;
  const before = structuredClone(source.active);
  const main = mainContext(source.fixed, source.memory.slots, source.active);
  assert.deepEqual(main.messages.slice(1), source.active.flatMap(e => e.messages));
  const result = await maintain(source, async request => {
    const records = sourceRecords(request.context);
    assert.deepEqual(records.map(({ entryId, sourceRole, messages }) => ({ entryId, sourceRole, messages })), before.map(e => ({ ...e, messages: e.messages.map(semanticEvidence) })));
    assert.deepEqual(request.context.tools, []);
    return answer(noChange, request.model);
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.observations.omissions, []);
  assert.deepEqual(result.candidate.kept, before.slice(before.findIndex(e => e.entryId === result.candidate.firstKeptEntryId)));
  assert.deepEqual(source.active, before);
});

test("parallel tool results cannot be separated from their calls, including interleaved custom records", () => {
  const entries = [user("u", "start"), assistant("a", [{ type: "toolCall", id: "x", name: "read", arguments: {} }, { type: "toolCall", id: "y", name: "read", arguments: {} }]), tool("y", "y", "out"), user("injected", "correction"), tool("x", "x", "out"), assistant("next", [{ type: "text", text: "finish" }])];
  assert.deepEqual(legalCuts(entries), [1, 5]);
});

test("host-path retained-boundary restrictions cannot resurrect earlier compactions or override tool legality", async () => {
  const source = await input(); source.eligibleKeptEntryIds = ["latest"];
  const result = await maintain(source, responder()); assert(result.ok); assert.equal(result.candidate.firstKeptEntryId, "latest");
  source.eligibleKeptEntryIds = [];
  const none = await maintain(source, responder()); assert(!none.ok); assert.equal(none.code, "CAPACITY");
  source.eligibleKeptEntryIds = ["unseen"];
  const invalid = await maintain(source, responder()); assert(!invalid.ok); assert.equal(invalid.code, "INPUT");
  source.active = [user("u", "u"), assistant("c", [{ type: "toolCall", id: "x", name: "read", arguments: {} }]), tool("r", "x", "out")];
  source.eligibleKeptEntryIds = ["r"];
  const orphan = await maintain(source, responder()); assert(!orphan.ok); assert.equal(orphan.code, "CAPACITY");
});

test("engine rounds the retained target to a whole tool unit and permits long-task split at an assistant", async () => {
  const source = await input(); source.config.keepRecentFraction = 0.08;
  source.active = [user("start", "long task".repeat(1000)), assistant("call", [{ type: "toolCall", id: "x", name: "read", arguments: {} }]), tool("result", "x", "recent".repeat(200))];
  const result = await maintain(source, responder());
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(result.candidate.firstKeptEntryId, "call");
  assert.deepEqual(result.candidate.retiredEntryIds, ["start"]);
  assert.deepEqual(result.candidate.kept, source.active.slice(1));
});

const invalidSources: ActiveEntry[][] = [
  [user("u", "u"), tool("r", "missing", "orphan")],
  [assistant("a", [{ type: "toolCall", id: "x", name: "read", arguments: {} }]), tool("r", "x", "out", "write")],
  [assistant("a", [{ type: "toolCall", id: "x", name: "read", arguments: {} }]), tool("r", "x", "out"), tool("r2", "x", "duplicate")],
  [user("u", "u"), assistant("a", [{ type: "toolCall", id: "x", name: "read", arguments: {} }])],
  [user("dup", "u"), user("dup", "u")],
  [{ entryId: "empty", sourceRole: "custom", messages: [] }, user("u", "u")],
];
for (const [i, active] of invalidSources.entries()) test(`unusable association/projection ${i} is rejected before service call`, async () => {
  const source = await input(); source.active = active;
  const result = await maintain(source, async () => { assert.fail("must not call provider"); });
  assert(!result.ok); assert.equal(result.code, "INPUT"); assert.equal(result.observations.requests, 0);
});

test("actual oversized extraction can reduce tool text once with exact omission locations; K return stays full", async () => {
  const source = await input();
  const giant = "FIRST" + "x".repeat(320000) + "LAST";
  source.active = [user("u", "original requirement"), assistant("call", [{ type: "toolCall", id: "x", name: "read", arguments: { required: "intact" } }]), tool("giant", "x", giant), user("latest", "newest correction, preserve me")];
  const original = structuredClone(source.active);
  const result = await maintain(source, async request => {
    const records = sourceRecords(request.context);
    const record = records.find(r => r.entryId === "giant")!;
    const message = record.messages[0]!;
    assert(message.role === "toolResult"); assert.equal(message.toolCallId, "x");
    const text = message.content[0]!; assert(text.type === "text");
    assert(text.text.startsWith("FIRST")); assert(text.text.endsWith("LAST")); assert(text.text.length < giant.length);
    assert.deepEqual(records.find(r => r.entryId === "call")!.messages, original[1]!.messages.map(semanticEvidence));
    assert.deepEqual(records.find(r => r.entryId === "latest")!.messages, original[3]!.messages.map(semanticEvidence));
    return answer(noChange, request.model);
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.observations.omissions, [{ entryId: "giant", messageIndex: 0, blockIndex: 0, toolCallId: "x", headChars: 200, tailChars: 200, omittedCodePoints: giant.length - 400 }]);
  const accounting = result.observations.accounting!;
  assert(accounting.fullExtractionTokens > accounting.extractionInputLimit);
  assert(accounting.extractionTokens < accounting.extractionInputLimit);
  assert.deepEqual(source.active, original);
  assert.deepEqual(result.candidate.kept, original.slice(3));
});

test("full mode refuses oversized tool source; auto cannot truncate user instructions or tool arguments", async () => {
  for (const mode of ["full", "auto"] as const) {
    const source = await input(); source.config.extraction.toolResults = mode;
    source.active = [user("u", mode === "auto" ? "u".repeat(320000) : "u"), assistant("call", [{ type: "toolCall", id: "x", name: "read", arguments: {} }]), tool("r", "x", "x".repeat(mode === "full" ? 320000 : 10)), user("last", "recent")];
    const result = await maintain(source, async () => { assert.fail("capacity failure must precede dispatch"); });
    assert(!result.ok); assert.equal(result.code, "CAPACITY"); assert.equal(result.observations.requests, 0); assert.deepEqual(result.observations.omissions, []);
  }
  const source = await input();
  source.active = [user("u", "u"), assistant("call", [{ type: "toolCall", id: "x", name: "read", arguments: { exact: "a".repeat(320000) } }]), tool("r", "x", "small"), user("last", "recent")];
  const result = await maintain(source, responder()); assert(!result.ok); assert.equal(result.code, "CAPACITY");
});

test("supported native images remain real blocks associated with their source; no media placeholders", async () => {
  const source = await input(); source.config.imageTokens = 1200;
  const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
  source.active[2]!.messages = [{ role: "user", content: [{ type: "text", text: "What changed here?" }, image], timestamp: 0 }];
  const result = await maintain(source, async request => {
    assert(request.context.messages[0]);
    const content = request.context.messages[0].content; assert(Array.isArray(content));
    assert.deepEqual(content.filter(b => b.type === "image"), [image]);
    return answer(noChange, request.model);
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.kept.at(-1)!.messages, source.active[2]!.messages);
  delete source.config.imageTokens;
  const noBudget = await maintain(source, responder()); assert(!noBudget.ok); assert.equal(noBudget.code, "UNSUPPORTED_INPUT");
  source.config.imageTokens = 1200; source.model.input = ["text"];
  const noModel = await maintain(source, responder()); assert(!noModel.ok); assert.equal(noModel.code, "UNSUPPORTED_INPUT");
});

test("reduction of extraction K never rewrites the original retained tool body", async () => {
  const source = await input();
  source.active = [user("old", "old"), assistant("bc", [{ type: "toolCall", id: "b", name: "read", arguments: {} }]), tool("br", "b", "b".repeat(320000)),
    user("recent", "latest requirements"), assistant("kc", [{ type: "toolCall", id: "k", name: "read", arguments: {} }]), tool("kr", "k", "🦉".repeat(900)), user("latest", "correction")];
  const result = await maintain(source, async request => {
    const records = sourceRecords(request.context); const kr = records.find(r => r.entryId === "kr")!;
    assert.equal(kr.region, "K");
    assert.notDeepEqual(kr.messages, source.active[5]!.messages);
    return answer(noChange, request.model);
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert(result.observations.omissions.some(o => o.entryId === "kr" && o.omittedCodePoints === 500));
  assert.deepEqual(result.candidate.kept.find(e => e.entryId === "kr")!.messages, source.active[5]!.messages);
});

test("unrepresentable tool arguments and malformed F cannot be silently lost during transcript serialization", async () => {
  for (const value of [undefined, NaN, () => {}]) {
    const source = await input();
    source.active = [user("u", "u"), assistant("c", [{ type: "toolCall", id: "x", name: "read", arguments: { invalid: value } }]), tool("r", "x", "out"), user("last", "last")];
    const result = await maintain(source, responder()); assert(!result.ok); assert.equal(result.code, "INPUT");
    assert.equal(result.observations.requests, 0);
  }
  const source = await input(); Object.assign(source.fixed.tools[0]!, { parameters: null });
  const invalid = await maintain(source, responder()); assert(!invalid.ok); assert.equal(invalid.code, "INPUT");
});

test("unsupported block and old compaction in R fail explicitly", async () => {
  const source = await input();
  // Simulate untrusted JS/custom-extension data at the public typed boundary.
  Object.assign(source.active[2]!.messages[0]!, { content: [{ type: "audio", data: "audio bytes" }] });
  const result = await maintain(source, responder()); assert(!result.ok); assert.equal(result.code, "UNSUPPORTED_INPUT");
  Object.assign(source.active[2]!, { sourceRole: "compaction" });
  const old = await maintain(source, responder()); assert(!old.ok); assert.equal(old.code, "INPUT");
});
