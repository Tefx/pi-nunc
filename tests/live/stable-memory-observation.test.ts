import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadScenario, seedScenario } from "../../src/live/scenarios.js";
import { parseInput } from "../../src/live/contract.js";
import {
  layoutsFromRequests,
  movingUsesTail,
  noSyntheticMissing,
  positionStable,
  scoreStableMemory,
  uniqueCarriers,
  explicitKeepFraction,
  unchangedContentEpochs,
} from "../../src/live/stable-memory-observation.js";
import type { RequestObservation } from "../../src/live/comparison-observation.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture, repository } from "./fixtures.js";
import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const config = { nunc: {}, compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 4000 } };

test("stable-memory assets seed public task files without observer criteria or future answers", async () => {
  const dir = join(repository, ".scratch", `stable-memory-assets-${Date.now()}`);
  try {
    for (const selection of [
      { id: "m1" as const, variant: "fixed" as const },
      { id: "m1" as const, variant: "moving" as const },
      { id: "m2" as const },
      { id: "m3" as const },
      { id: "m4" as const, variant: "keep-0.5" as const },
      { id: "m4" as const, variant: "keep-0.67" as const },
    ]) {
      const { input, observer } = await loadScenario(repository, { ...selection, config: selection.id === "m4"
        ? { ...config, nunc: { rolling: { keepRecentFraction: selection.variant === "keep-0.67" ? 0.67 : 0.5 } } }
        : config });
      const cwd = join(dir, `${selection.id}-${"variant" in selection && selection.variant ? selection.variant : "base"}`);
      await seedScenario(input, cwd);
      assert.deepEqual((await readdir(cwd)).sort(), [...Object.keys(input.files), ...(input.generatedFiles ?? []).map(f => f.path)].sort());
      assert(!input.turns.some(turn => /cedar-17|maple-29|orchard-router/.test(turn.text)));
      if (selection.id === "m1") {
        assert(input.turns.length >= 6);
        assert.equal(input.turns[4]?.id, "e");
      }
      if (selection.id === "m2") {
        assert.equal(input.files["lock-correction.txt"], undefined);
        assert.equal(observer.controls.length, 3);
      }
      if (selection.id === "m4") assert.equal(observer.controls.length, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("predicates require admission identity, expected content epochs, explicit fractions, and serialized scans", () => {
  const model = { provider: "openrouter", id: "google/gemini-3.8-flash", api: "openai-completions" } as Model<"openai-completions">;
  const context = (messages: Context["messages"]): Context => ({ messages });
  const req = (turn: string, callId: number, extra: Partial<RequestObservation> & { admission?: AdmissionObservation }): RequestObservation => ({
    callId, turn, kind: "main", model, thinking: null, reasoning: null, outputPlanning: null,
    context: context(Array.from({ length: (extra.admission?.memoryIndex ?? 0) + 2 }, (_, i) => ({ role: "user", content: i === extra.admission?.memoryIndex ? extra.admission.memoryContent! : turn, timestamp: i }))),
    ...extra,
  });
  const content = "Nunc working memory (session-local, reference only):\n[{\"id\":\"s1\",\"text\":\"x\"}]";
  const later = "Nunc working memory (session-local, reference only):\n[{\"id\":\"s1\",\"text\":\"y\"}]";
  const requests: RequestObservation[] = [
    req("b", 1, { admission: { kind: "main", outcome: "delegate", memoryPresent: true, memoryCarrierCount: 1, memoryIndex: 1, memoryContent: content } }),
    req("c", 2, { admission: { kind: "main", outcome: "delegate", memoryPresent: true, memoryCarrierCount: 1, memoryIndex: 1, memoryContent: content } }),
    req("e", 3, { admission: { kind: "main", outcome: "delegate", memoryPresent: true, memoryCarrierCount: 1, memoryIndex: 5, memoryContent: later } }),
    req("f", 4, { admission: { kind: "main", outcome: "delegate", memoryPresent: true, memoryCarrierCount: 1, memoryIndex: 5, memoryContent: later } }),
  ];
  for (const r of requests) r.finalPayload = { messages: r.context.messages.map(m => ({ role: m.role, content: m.content })) };
  const layouts = layoutsFromRequests(requests, [
    { kind: "terminal", id: 1, at: 1, latencyMs: 1, stopReason: "stop", usage: { input: 10, cacheRead: 8, cacheWrite: 0, contextInput: 18, output: 2, reasoning: null, totalTokens: 20, cost: null } },
    { kind: "terminal", id: 2, at: 2, latencyMs: 1, stopReason: "stop", usage: { input: 12, cacheRead: 10, cacheWrite: 0, contextInput: 22, output: 2, reasoning: null, totalTokens: 24, cost: null } },
    { kind: "terminal", id: 3, at: 3, latencyMs: 1, stopReason: "stop", usage: { input: 20, cacheRead: 0, cacheWrite: 4, contextInput: 24, output: 2, reasoning: null, totalTokens: 26, cost: null } },
    { kind: "terminal", id: 4, at: 4, latencyMs: 1, stopReason: "stop", usage: { input: 22, cacheRead: 18, cacheWrite: 0, contextInput: 40, output: 2, reasoning: null, totalTokens: 42, cost: null } },
  ], 0.5);
  assert.equal(layouts[0]?.cacheRead, 8);
  assert.equal(layouts[2]?.cacheRead, 0);
  assert.equal(uniqueCarriers(layouts, content), false, "a required content must hold on every row, never filter away mismatches");
  assert.equal(uniqueCarriers(layouts), true);
  assert.equal(positionStable(layouts, content), true);
  assert.equal(unchangedContentEpochs(layouts).length, 2);
  assert.equal(noSyntheticMissing(layouts), true);
  assert.equal(explicitKeepFraction({ nunc: {} }, 0.5), false);
  assert.equal(explicitKeepFraction({ nunc: { rolling: { keepRecentFraction: 0.5 } } }, 0.5), true);
  const empty = layoutsFromRequests([req("z", 9, { admission: { kind: "main", outcome: "delegate" } })], [], 0.5);
  assert.equal(uniqueCarriers(empty, content), false);
  assert.equal(positionStable(empty), false);
  assert.equal(noSyntheticMissing(empty), undefined);
  assert.equal(scoreStableMemory({ id: "m2", layouts: empty, config: {} })[0]?.status, "UNPROVEN");
  const explicitEmpty = layoutsFromRequests([req("z", 9, { admission: { kind: "main", outcome: "delegate", memoryPresent: false, memoryCarrierCount: 0, memoryContent: "" } })], []);
  assert.equal(uniqueCarriers(explicitEmpty), true);
  assert.equal(uniqueCarriers(explicitEmpty, content), false, "explicit empty M does not satisfy a required nonempty epoch");
  const missing = [...layouts, ...empty];
  assert.equal(uniqueCarriers(missing), false);
  assert.equal(positionStable(missing), false);
  assert.equal(noSyntheticMissing(missing), undefined);
  const duplicate = structuredClone(requests[0]!);
  duplicate.admission!.memoryCarrierCount = 2;
  assert.equal(uniqueCarriers(layoutsFromRequests([duplicate], [])), false);
  const edited = structuredClone(requests[0]!);
  (edited.finalPayload as any).messages[1].content = "changed after public hooks";
  assert.equal(layoutsFromRequests([edited], [])[0]?.deliveredMemoryMatches, false);
  const lookalike = layoutsFromRequests([req("z", 9, {})], [], 0.5);
  assert.equal(lookalike[0]?.uniqueCarrier, false);
  const scored = scoreStableMemory({ id: "m4", variant: "keep-0.5", layouts, config: { nunc: { rolling: { keepRecentFraction: 0.5 } } } });
  assert.equal(scored.find(c => c.check.includes("keepRecentFraction"))?.status, "PROVEN");
  assert.equal(movingUsesTail(layouts, content), false);
});

test("legal-tail evidence checks parallel pending/completed tool Contexts independently of native serialization", async () => {
  const provider = openaiProvider(), model = provider.getModels().find(m => m.id === "gpt-4.1");
  assert(model);
  const content = "Nunc working memory: current task";
  const user: Context["messages"][number] = { role: "user", content: "Execute both local tools", timestamp: 1 };
  const calls: Context["messages"][number] = { role: "assistant", content: [
    { type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
    { type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.txt" } },
  ], api: model.api, provider: model.provider, model: model.id, timestamp: 2, stopReason: "toolUse",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const result = (id: string): Context["messages"][number] => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `actual ${id}` }], isError: false, timestamp: 3 });
  const completed = [user, calls, result("call_a"), result("call_b")];
  const observe = async (history: Context["messages"], index: number, callId: number) => {
    const messages = [...history];
    messages.splice(index, 0, { role: "user", content, timestamp: 0 });
    const row: RequestObservation = { callId, turn: "a", kind: "main", model, thinking: null, reasoning: null, outputPlanning: null,
      context: { messages }, admission: { kind: "main", outcome: "delegate", memoryPresent: true, memoryCarrierCount: 1, memoryIndex: index, memoryContent: content } };
    let sends = 0;
    await provider.streamSimple(model, normalizeContext(row.context), { apiKey: "isolated-offline-key", maxRetries: 0, fetch: async (resource, init) => {
      sends++;
      row.finalPayload = await new Request(resource, init).json();
      return new Response('{"error":{"message":"controlled serializer-only stop"}}', { status: 400, headers: { "content-type": "application/json" } });
    } }).result();
    assert.equal(sends, 1, "actual provider serializer reached the controlled transport once");
    return layoutsFromRequests([row], [])[0]!;
  };
  const pending = await observe(completed.slice(0, 3), 1, 1);
  const complete = await observe(completed, 1, 2);
  for (const row of [pending, complete]) {
    assert.equal(row.legalTailIndex, 1, "parallel group cannot advance the legal tail past its calling assistant");
    assert.equal(row.memoryBoundaryLegal, true);
    assert.equal(row.deliveredMemoryMatches, true);
    assert.notEqual(row.memoryIndex, row.messageCount - 1, "legal tail is distinct from the physical end");
  }
  assert.equal(pending.payloadSyntheticMissing, true, "pending sibling remains independently visible in serializer evidence");
  assert.equal(complete.payloadSyntheticMissing, false, "both original results survive the actual serializer");
  assert.equal(movingUsesTail([pending, complete]), true);
  assert.equal(noSyntheticMissing([pending, complete]), false, "position evidence never overrides missing-result evidence");
  assert.equal(positionStable([pending, complete]), true);
  const between = await observe(completed, 3, 3);
  const afterResults = await observe(completed, 4, 4);
  for (const row of [between, afterResults]) {
    assert.equal(row.legalTailIndex, 1);
    assert.equal(row.memoryBoundaryLegal, false);
    assert.equal(movingUsesTail([row, row]), false);
    assert.equal(positionStable([row, row]), false, "a stable illegal index cannot pass the fixed-layout check");
  }
  const stopped = { ...calls, content: [{ type: "text" as const, text: "Both completed" }], stopReason: "stop" as const };
  const afterStop = await observe([...completed, stopped], 5, 5);
  assert.equal(afterStop.legalTailIndex, 5);
  assert.equal(afterStop.memoryBoundaryLegal, true);
  const system: Context["messages"][number] = { role: "system", content: "Use the authorized local tools.", timestamp: 0 };
  const withSystem = await observe([system, ...completed], 2, 7);
  assert.equal(withSystem.legalTailIndex, 2, "the real native leading system message participates in legal boundaries");
  assert.equal(withSystem.memoryBoundaryLegal, true);
  assert.equal(withSystem.deliveredMemoryMatches, true);
  assert.equal(withSystem.payloadSyntheticMissing, false);
  const singleCall = { ...calls, content: [calls.content[0]!] };
  const reusedHistory = [system, user, singleCall, result("call_a"), stopped, user, singleCall, result("call_a"), stopped];
  const reused = await observe(reusedHistory, 9, 8);
  assert.equal(reused.legalTailIndex, 9, "completed tool intervals retain evidence while the same ID may open a later interval");
  assert.equal(reused.memoryBoundaryLegal, true);
  assert.equal(reused.deliveredMemoryMatches, true);
  assert.equal(reused.payloadSyntheticMissing, false, "native serializer preserves both completed uses of the same ID");
  assert.equal(movingUsesTail([withSystem, reused]), true);
  assert.equal(noSyntheticMissing([withSystem, reused]), true);
  for (const history of [
    [system, user, singleCall, singleCall],
    [system, user, singleCall, result("call_a"), result("call_a")],
    [system, user, singleCall, { ...result("call_a"), toolName: "write" }],
  ]) {
    const messages: Context["messages"] = [...history];
    messages.splice(2, 0, { role: "user", content, timestamp: 0 });
    const invalid: RequestObservation = { callId: 9, turn: "a", kind: "main", model, thinking: null, reasoning: null, outputPlanning: null,
      context: { messages }, admission: { kind: "main", outcome: "delegate", memoryPresent: true, memoryCarrierCount: 1, memoryIndex: 2, memoryContent: content } };
    const row = layoutsFromRequests([invalid], [])[0]!;
    assert.equal(row.legalTailIndex, undefined, "duplicate pending calls, orphan results and mismatched names remain unknown");
    assert.equal(row.memoryBoundaryLegal, undefined);
    assert.equal(movingUsesTail([row, row]), false);
  }
  const unknown = await observe([user, result("unpaired")], 1, 6);
  assert.equal(unknown.legalTailIndex, undefined);
  assert.equal(unknown.memoryBoundaryLegal, undefined);
  assert.equal(movingUsesTail([unknown, unknown]), false);
  const changed = { ...complete, memoryContent: content + " updated", input: 17000, cacheRead: 0, cacheWrite: 0 };
  const first = { ...complete, input: 17000, cacheRead: 0, cacheWrite: 0 };
  const epochs = [first, first, first, changed, changed, changed];
  const warmup = (rows: typeof epochs) => scoreStableMemory({ id: "m1", variant: "fixed", layouts: rows, config: {} }).find(c => c.check.startsWith("large unchanged"))!.status;
  assert.equal(warmup(epochs), "PROVEN", "three 17000-input samples on both sides start at a legal tail");
  assert.equal(warmup(epochs.map(row => { const missing = { ...row }; delete missing.legalTailIndex; return missing; })), "UNPROVEN");
  assert.equal(warmup(epochs.map(row => ({ ...row, input: 16999 }))), "UNPROVEN", "17000 threshold remains binding");
  assert.equal(warmup([first, first, changed, changed]), "UNPROVEN", "two samples per epoch do not supply three warmup opportunities");
});

test("public parseInput admits m* with explicit fractions and refuses Astra or calibrated m4", async () => {
  const base = await fixture();
  const compaction = base.scenarios[0]!.config.compaction;
  const ok = structuredClone(base);
  ok.scenarios = [
    { id: "m1", variant: "fixed", config: { nunc: {}, compaction } },
    { id: "m4", variant: "keep-0.5", config: { nunc: { rolling: { keepRecentFraction: 0.5 } }, compaction } },
  ];
  assert.doesNotThrow(() => parseInput(ok));
  const astra = structuredClone(ok);
  astra.models[0]!.id = "gpt-6-astra";
  assert.throws(() => parseInput(astra));
  const calibrated = structuredClone(ok);
  calibrated.scenarios = [{ id: "m4", variant: "keep-0.5", config: { nunc: { rolling: { keepRecentFraction: 0.5 } }, compaction, retentionCalibration: { minFraction: 0.2, maxFraction: 0.8 } } }];
  assert.throws(() => parseInput(calibrated));
  const missingFraction = structuredClone(ok);
  missingFraction.scenarios = [{ id: "m4", variant: "keep-0.67", config: { nunc: {}, compaction } }];
  assert.throws(() => parseInput(missingFraction));
});
