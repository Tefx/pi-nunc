import { test } from "node:test";
import assert from "node:assert/strict";
import { decideToolResultCleanup, emptyMemory, maintain, type CleanupDecisionOptions } from "../../src/engine/index.js";
import { assistant, input, responder, tool, user } from "./fixtures.js";

const raw = '{\n  "value": [1, 2, 3],\n  "precise": 9007199254740993\n}';
function options(): CleanupDecisionOptions {
  const active = [tool("scoped", "a", raw), tool("outside", "b", raw), tool("retired", "c", raw)];
  return { active, retainedEntries: active.slice(0, 2), candidateScope: [{ entryId: "scoped", messageIndex: 0 }, { entryId: "retired", messageIndex: 0 }],
    initialMemory: emptyMemory(), finalMemory: emptyMemory(), mechanicalWhenMemoryUnchanged: true,
    semanticEdits: [{ entryId: "outside", messageIndex: 0, action: "omit" }, { entryId: "scoped", messageIndex: 0, action: "omit" }] };
}

test("unchanged-M opt-in applies only lossless rules in scope intersect retained history", () => {
  const o = options();
  const result = decideToolResultCleanup(o);
  assert.deepEqual(result.skipped.map(s => s.reason), ["m_unchanged", "m_unchanged"]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0]?.entryId, "scoped");
  assert.equal(result.applied[0]?.action, "compact_json");
  assert.equal(result.applied[0]?.text, '{"value":[1,2,3],"precise":9007199254740993}');
  assert.equal(decideToolResultCleanup({ ...o, mechanicalWhenMemoryUnchanged: false }).applied.length, 0);
  const empty = decideToolResultCleanup({ ...o, candidateScope: [] });
  assert.equal(empty.applied.length, 0);
  assert.deepEqual(empty.skipped.map(s => s.reason), ["m_unchanged", "m_unchanged"]);
  const disabled = decideToolResultCleanup({ ...o, disabled: true });
  assert.equal(disabled.applied.length, 0);
  assert.deepEqual(disabled.skipped.map(s => s.reason), ["not_in_candidate_scope", "not_in_candidate_scope"]);
});

test("native maintain opts into mechanical cleanup with unchanged M and accounts effective kept text", async () => {
  const source = await input();
  source.active = [user("old", "old context".repeat(1000)), user("current", "continue"),
    assistant("call", [{ type: "toolCall", id: "a", name: "read", arguments: {} }]), tool("scoped", "a", raw)];
  source.eligibleKeptEntryIds = ["current"];
  source.cleanupCandidateScope = [{ entryId: "scoped", messageIndex: 0 }];
  const result = await maintain(source, responder());
  assert(result.ok, JSON.stringify(result));
  assert.deepEqual(result.candidate.memory, source.memory);
  assert.equal(result.candidate.toolResultCleanup?.applied[0]?.action, "compact_json");
  const accounting = result.observations.accounting!;
  assert.equal(accounting.growthTokens, accounting.effectiveTrigger - accounting.mainAfterTokens!);
  const disabled = await maintain({ ...source, config: { ...source.config, toolResultCleanup: false } }, responder());
  assert(disabled.ok);
  assert.equal(disabled.candidate.toolResultCleanup?.applied.length, 0);
  assert(disabled.observations.accounting!.mainAfterTokens! > accounting.mainAfterTokens!);
});
