import { test } from "node:test";
import assert from "node:assert/strict";
import { maintain } from "../../src/engine/engine.js";
import { decideToolResultCleanup, messageTextContent } from "../../src/engine/cleanup.js";
import { activeUsageObservation } from "../../src/engine/calibration.js";
import { mainPlanningEstimate } from "../../src/engine/accounting.js";
import { piComplete, retryMaintenanceComplete } from "../../src/engine/pi-model.js";
import { reduceToolBodies } from "../../src/engine/request.js";
import { answer, assistant, input, sourceRecords, tool, user } from "./fixtures.js";

for (const field of ["samplingParams", "samplingParamsByThinkingLevel"] as const) test(`both maintenance seams reject raw ${field}`, async () => {
  const value = await input();
  Object.assign(value.model, { [field]: field === "samplingParams" ? { max_tokens: 1 } : { high: { max_tokens: 1 } } });
  const result = await maintain(value, async () => assert.fail("unsafe override cannot dispatch"));
  assert(!result.ok); assert.equal(result.code, "CONFIG");
  await assert.rejects(async () => piComplete({ complete: async () => assert.fail("unsafe override cannot reach registry") })({
    model: value.model, context: { messages: [] }, outputTokens: 100, signal: value.signal,
  }), /sampling overrides/);
});

for (const message of ["Connection error after 400 ms", "Connection error after 401 tokens", "Connection error (429)"]) test(`retry recognizes status context without treating units as HTTP: ${message}`, async () => {
  const value = await input(); let attempts = 0;
  await retryMaintenanceComplete(async () => ++attempts === 1 ? { ...answer(), stopReason: "error", errorMessage: message } : answer(), 0)({
    model: value.model, context: { messages: [] }, outputTokens: 100, signal: value.signal,
  });
  assert.equal(attempts, 2);
});

test("mechanical cleanup preserves block boundaries and canonicalizes argument order", async () => {
  const value = await input();
  const calls = [assistant("a", [{ type: "toolCall", id: "a", name: "read", arguments: { a: 1, b: 2 } }]),
    assistant("b", [{ type: "toolCall", id: "b", name: "read", arguments: { b: 2, a: 1 } }])];
  const first = tool("first", "a", "item ".repeat(100));
  const second = tool("second", "b", "item ".repeat(100));
  const active = [calls[0]!, first, calls[1]!, second];
  const options = { active, retainedEntries: active, candidateScope: [{ entryId: "second", messageIndex: 0 }],
    initialMemory: value.memory, finalMemory: value.memory, mechanicalWhenMemoryUnchanged: true };
  assert.equal(decideToolResultCleanup(options).applied[0]?.action, "deduplicate");
  const message = second.messages[0]!; assert(message.role === "toolResult");
  message.content = [{ type: "text", text: "item ".repeat(50) }, { type: "text", text: "item ".repeat(50) }];
  assert.equal(messageTextContent(message), "item ".repeat(50) + "\n" + "item ".repeat(50));
  assert.equal(decideToolResultCleanup(options).applied.length, 0);
  message.content = [{ type: "text", text: '{ "v": "a' }, { type: "text", text: 'b" }' }];
  assert.equal(decideToolResultCleanup(options).applied.length, 0, "split JSON strings cannot be mechanically concatenated");
});

test("UTF-16 savings admit non-BMP reduction while preserving short ASCII", () => {
  const active = [tool("emoji", "e", "🙂".repeat(150)), tool("ascii", "a", "x".repeat(150))];
  const reduced = reduceToolBodies(active, 10);
  assert.deepEqual(reduced.omissions.map(item => item.entryId), ["emoji"]);
  const before = messageTextContent(active[0]!.messages[0]!)!;
  const after = messageTextContent(reduced.source[0]!.messages[0]!)!;
  assert(after.length < before.length); assert.equal(messageTextContent(reduced.source[1]!.messages[0]!), "x".repeat(150));
});

test("prior cleanup reaches extraction and usage accounting while original K stays bound", async () => {
  const value = await input();
  const raw = "Full old evidence. ".repeat(100);
  value.active = [user("old", "Retire earlier work"), assistant("call", [{ type: "toolCall", id: "c", name: "read", arguments: {} }]),
    tool("body", "c", raw), { entryId: "usage", sourceRole: "assistant", messages: [{ ...answer(), usage: { ...answer().usage, input: 12000 } }] }, user("latest", "Continue")];
  value.eligibleKeptEntryIds = ["call"]; value.eligibleUsageEntryIds = ["usage"];
  value.priorCleanup = [{ entryId: "body", messageIndex: 0, toolName: "read", toolCallId: "c", kind: "semantic", action: "replace",
    text: "Saved summary", originalLength: raw.length, cleanedLength: 13, netSavings: raw.length - 13 }];
  const observation = activeUsageObservation(value)!;
  const effectivePrefix = structuredClone(value.active.slice(0, 4));
  const body = effectivePrefix[2]!.messages[0]!; assert(body.role === "toolResult"); body.content = [{ type: "text", text: "Saved summary" }];
  const expected = 12115 - mainPlanningEstimate(value.fixed, value.memory.slots, effectivePrefix, value.model).visibleTokens;
  assert.equal(observation.rawUndercountTokens, expected);
  const result = await maintain(value, async request => {
    const message = sourceRecords(request.context).find(record => record.entryId === "body")!.messages[0]!;
    assert.equal(messageTextContent(message), "Saved summary");
    return answer(undefined, request.model);
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(messageTextContent(result.candidate.kept.find(entry => entry.entryId === "body")!.messages[0]!), raw);
});

for (const fallback of [false, true]) test(`saved cleaned bodies cannot become new dependency keepers (${fallback ? "fallback" : "success"})`, async () => {
  const value = await input();
  const compacted = "Repeated summarized evidence ".repeat(30), raw = compacted + "Original details ".repeat(50);
  value.active = [user("old", "Earlier work"), assistant("a", [{ type: "toolCall", id: "a", name: "read", arguments: {} }]),
    tool("first", "a", raw), assistant("b", [{ type: "toolCall", id: "b", name: "read", arguments: {} }]), tool("second", "b", compacted)];
  value.eligibleKeptEntryIds = ["a"]; value.cleanupCandidateScope = [{ entryId: "second", messageIndex: 0 }];
  value.priorCleanup = [{ entryId: "first", messageIndex: 0, toolName: "read", toolCallId: "a", kind: "semantic", action: "replace",
    text: compacted, originalLength: raw.length, cleanedLength: compacted.length, netSavings: raw.length - compacted.length }];
  const result = await maintain(value, async () => fallback ? { ...answer(), content: [{ type: "text", text: "invalid JSON" }] } : answer());
  const cleanup = result.ok ? result.candidate.toolResultCleanup : result.fallbackCandidate?.toolResultCleanup;
  assert(cleanup); assert.deepEqual(cleanup.applied.map(item => item.entryId), ["first"]);
  assert(cleanup.skipped.some(item => item.entryId === "second" && item.reason === "missing_source_dependency"));
});

test("incomplete responses retain exceeded-plan observations and redact JSON parser causes", async () => {
  const value = await input();
  const incomplete = await maintain(value, async () => ({ ...answer(), stopReason: "length", usage: { ...answer().usage, input: 999999, output: 999999 } }));
  assert(!incomplete.ok); assert.equal(incomplete.observations.accounting!.inputExceededPlan, true);
  assert.equal(incomplete.observations.accounting!.outputExceededPlan, true);
  const malformed = await maintain(value, async () => ({ ...answer(), content: [{ type: "text", text: 'secret-value invalid JSON' }] }));
  assert(!malformed.ok); assert.equal((malformed.cause as Error).cause, undefined);
  assert(!String(malformed.cause).includes("secret-value"));
});
