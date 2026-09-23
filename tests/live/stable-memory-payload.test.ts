import { test } from "node:test";
import assert from "node:assert/strict";
import { serializedEvidence, layoutsFromRequests, noSyntheticMissing, scoreStableMemory } from "../../src/live/stable-memory-observation.js";
import type { RequestObservation } from "../../src/live/comparison-observation.js";

function request(): RequestObservation {
  return { callId: 41, kind: "main", turn: "a", model: { api: "openai-completions", provider: "fixture", id: "native" } as any, thinking: null, reasoning: null, outputPlanning: null,
    context: { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] } as any,
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "No result provided" }], isError: false, timestamp: 2 }] },
    finalPayload: { messages: [{ role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call-1", content: "No result provided" }] } };
}
test("final-payload evidence uses bound structural tool results, never a literal missing-result substring", () => {
  const r = request();
  assert.equal(serializedEvidence(r).synthetic, false, "genuine result text is preserved");
  r.context.messages.pop();
  assert.equal(serializedEvidence(r).synthetic, true, "an additional native result contradicts exact source preservation");
  const changed = request();
  (changed.finalPayload as any).messages[1].tool_call_id = "wrong-call";
  assert.equal(serializedEvidence(changed).synthetic, true);
  const absent = request(); delete absent.finalPayload;
  assert.equal(serializedEvidence(absent).synthetic, undefined);
  assert.equal(noSyntheticMissing(layoutsFromRequests([request(), absent], [])), undefined);
  const unknownApi = request(); unknownApi.model.api = "anthropic-messages";
  assert.equal(serializedEvidence(unknownApi).synthetic, undefined);
});
test("native Codex Responses binds M and every function call/result to the actual Context", () => {
  const base: RequestObservation = { callId: 8, turn: "b", kind: "main", model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" } as any,
    thinking: "low", reasoning: "low", outputPlanning: 128000,
    admission: { memoryPresent: true, memoryCarrierCount: 1, memoryIndex: 3, memoryContent: "Saved M" } as any,
    context: { messages: [
      { role: "user", content: [{ type: "text", text: "Task" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1|fc-1", name: "read", arguments: { path: "source.txt" } }] },
      { role: "toolResult", toolCallId: "call-1|fc-1", toolName: "read", isError: false, content: [{ type: "text", text: "No result provided" }] },
      { role: "user", content: [{ type: "text", text: "Saved M" }] },
    ] } as any,
    finalPayload: { input: [
      { role: "user", content: [{ type: "input_text", text: "Task" }] },
      { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"source.txt"}' },
      { type: "function_call_output", call_id: "call-1", output: "No result provided" },
      { role: "user", content: [{ type: "input_text", text: "Saved M" }] },
    ] } };
  assert.deepEqual(serializedEvidence(base), { synthetic: false, memory: true });
  const change = (mutate: (input: any[]) => void) => {
    const row = structuredClone(base), input = (row.finalPayload as any).input;
    mutate(input);
    return serializedEvidence(row);
  };
  assert.equal(change(input => { input[2].output = "fabricated"; }).synthetic, true);
  assert.equal(change(input => { input.push({ type: "function_call_output", call_id: "extra", output: "No result provided" }); }).synthetic, true);
  assert.equal(change(input => { input[1].arguments = '{"path":"other.txt"}'; }).synthetic, true);
  assert.equal(change(input => { input[3].content[0].text = "stale M"; }).memory, false);
  assert.equal(change(input => { input[1].type = "custom_tool_call"; }).synthetic, undefined);
  const absent = structuredClone(base); delete absent.finalPayload;
  assert.equal(serializedEvidence(absent).synthetic, undefined);
});
test("an unbound main row cannot positively prove either unique M or the final payload", () => {
  const checks = scoreStableMemory({ id: "m2", layouts: [{ turn: "a", kind: "main", model: "fixture", messageCount: 1, uniqueCarrier: false }], config: {} });
  assert(checks.every(c => c.status === "UNPROVEN"));
});
