import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { maintain } from "../../src/engine/index.js";
import { answer, input, responder } from "./fixtures.js";

for (const stopReason of ["length", "pending", "error", "aborted", "toolUse", "deferred", "truncated"]) test(`parseable JSON with ${stopReason} status never becomes a candidate`, async () => {
  const source = await input();
  const result = await maintain(source, async request => ({ ...answer(undefined, request.model), stopReason }));
  assert(!result.ok); assert.equal(result.code, "RESPONSE"); assert.equal(result.observations.requests, 1); assert(!("candidate" in result));
});

test("tool calls, false endTurn, deferred handles, malformed JSON and different response model fail without tool execution/repair", async () => {
  const responses = [
    { ...answer(), content: [{ type: "toolCall", id: "x", name: "delete", arguments: {} }] },
    { ...answer(), endTurn: false }, { ...answer(), deferred: { id: "pending" } },
    { ...answer(), model: "different" }, { ...answer(), content: [{ type: "text", text: "```json\n{}\n```" }] },
  ];
  for (const response of responses) {
    const result = await maintain(await input(), async () => response);
    assert(!result.ok); assert.equal(result.code, "RESPONSE"); assert.equal(result.observations.requests, 1);
  }
});

test("abort before dispatch, during service wait, and immediately before handoff yield explicit cancellation", async () => {
  const source = await input(); const control = new AbortController(); source.signal = control.signal;
  control.abort();
  const before = await maintain(source, async () => { assert.fail("pre-aborted"); });
  assert(!before.ok); assert.equal(before.code, "CANCELLED"); assert.equal(before.observations.requests, 0);

  const duringSource = await input(); const duringControl = new AbortController(); duringSource.signal = duringControl.signal;
  let reached!: () => void;
  const reachedProvider = new Promise<void>(resolve => { reached = resolve; });
  let receivedSignal: AbortSignal | undefined;
  const pending = maintain(duringSource, request => {
    receivedSignal = request.signal; reached();
    // Deliberately non-cooperating wait: the engine must still release its caller and listener.
    return new Promise(() => {});
  });
  await reachedProvider; duringControl.abort();
  const during = await pending;
  assert(!during.ok); assert.equal(during.code, "CANCELLED"); assert(receivedSignal?.aborted);
  assert.equal(getEventListeners(duringControl.signal, "abort").length, 0);
  assert.equal(during.observations.usage.cost, null);

  const lastSource = await input(); const lastControl = new AbortController(); lastSource.signal = lastControl.signal;
  const last = await maintain(lastSource, async request => { lastControl.abort(); return answer(undefined, request.model); });
  assert(!last.ok); assert.equal(last.code, "CANCELLED");
});

test("freeze entire transaction before await; mutable host data cannot rewrite model/policy/source/boundary", async () => {
  const source = await input();
  let reached!: () => void, finish!: (value: unknown) => void;
  const reachedProvider = new Promise<void>(resolve => { reached = resolve; });
  const original = structuredClone({ active: source.active, binding: source.binding, model: source.model });
  const pending = maintain(source, async request => {
    assert(Object.isFrozen(request.model)); assert(Object.isFrozen(request.context));
    reached(); return new Promise(resolve => { finish = resolve; });
  });
  await reachedProvider;
  source.model.id = "changed"; source.model.contextWindow = 100; source.config.triggerTokens = 1;
  source.policy = { builtin: "modified while running", user: "later preferences" };
  source.active[2]!.messages[0]!.content = "mutated later";
  source.binding.generation = "next";
  finish(answer(undefined, original.model));
  const result = await pending; assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.binding, original.binding); // adapter MUST compare this before Pi handoff
  assert.deepEqual(result.candidate.kept.at(-1)!.messages, original.active[2]!.messages);
  assert.equal(getEventListeners(source.signal, "abort").length, 0);
});

test("model rejection preserves cause and original memory; listener removed on success and failure", async () => {
  const source = await input(); const sentinel = new Error("controlled provider failed");
  const result = await maintain(source, async () => { throw sentinel; });
  assert(!result.ok); assert.equal(result.code, "MODEL"); assert.equal(result.cause, sentinel);
  assert.equal(getEventListeners(source.signal, "abort").length, 0);
  const success = await maintain(source, responder()); assert(success.ok);
  assert.equal(getEventListeners(source.signal, "abort").length, 0);
});
