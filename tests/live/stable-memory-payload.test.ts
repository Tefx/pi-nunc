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
test("an unbound main row cannot positively prove either unique M or the final payload", () => {
  const checks = scoreStableMemory({ id: "m2", layouts: [{ turn: "a", kind: "main", model: "fixture", messageCount: 1, uniqueCarrier: false }], config: {} });
  assert(checks.every(c => c.status === "UNPROVEN"));
});
