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
import type { Context, Model } from "@earendil-works/pi-ai";

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
      assert.deepEqual((await readdir(cwd)).sort(), Object.keys(input.files).sort());
      assert(!input.turns.some(turn => /cedar-17|maple-29|orchard-router/.test(turn.text)));
      if (selection.id === "m1") {
        assert(input.turns.length >= 6);
        assert.equal(input.turns[4]?.id, "e");
      }
      if (selection.id === "m2") {
        assert.equal(input.files["lock-correction.txt"], undefined);
        assert.equal(observer.controls.length, 2);
      }
      if (selection.id === "m4") assert.equal(observer.controls.length, 3);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("predicates require admission identity, expected content epochs, explicit fractions, and serialized scans", () => {
  const model = { provider: "openrouter", id: "google/gemini-3.8-flash", api: "openai-completions" } as Model<"openai-completions">;
  const context = (messages: Context["messages"]): Context => ({ messages });
  const req = (turn: string, callId: number, extra: Partial<RequestObservation> & { admission?: AdmissionObservation }): RequestObservation => ({
    callId, turn, kind: "main", model, thinking: null, reasoning: null, outputPlanning: null,
    context: context([{ role: "user", content: turn, timestamp: 1 }]),
    ...extra,
  });
  const content = "Nunc working memory (session-local, reference only):\n[{\"id\":\"s1\",\"text\":\"x\"}]";
  const later = "Nunc working memory (session-local, reference only):\n[{\"id\":\"s1\",\"text\":\"y\"}]";
  const requests: RequestObservation[] = [
    req("b", 1, { admission: { kind: "main", outcome: "delegate", memoryIndex: 1, memoryContent: content }, syntheticMissing: false }),
    req("c", 2, { admission: { kind: "main", outcome: "delegate", memoryIndex: 1, memoryContent: content }, syntheticMissing: false }),
    req("e", 3, { admission: { kind: "main", outcome: "delegate", memoryIndex: 5, memoryContent: later }, syntheticMissing: false }),
    req("f", 4, { admission: { kind: "main", outcome: "delegate", memoryIndex: 5, memoryContent: later }, syntheticMissing: false }),
  ];
  const layouts = layoutsFromRequests(requests, [
    { kind: "terminal", id: 1, at: 1, latencyMs: 1, stopReason: "stop", usage: { input: 10, cacheRead: 8, cacheWrite: 0, contextInput: 18, output: 2, reasoning: null, totalTokens: 20, cost: null } },
    { kind: "terminal", id: 2, at: 2, latencyMs: 1, stopReason: "stop", usage: { input: 12, cacheRead: 10, cacheWrite: 0, contextInput: 22, output: 2, reasoning: null, totalTokens: 24, cost: null } },
    { kind: "terminal", id: 3, at: 3, latencyMs: 1, stopReason: "stop", usage: { input: 20, cacheRead: 0, cacheWrite: 4, contextInput: 24, output: 2, reasoning: null, totalTokens: 26, cost: null } },
    { kind: "terminal", id: 4, at: 4, latencyMs: 1, stopReason: "stop", usage: { input: 22, cacheRead: 18, cacheWrite: 0, contextInput: 40, output: 2, reasoning: null, totalTokens: 42, cost: null } },
  ], 0.5);
  assert.equal(layouts[0]?.cacheRead, 8);
  assert.equal(layouts[2]?.cacheRead, 0);
  assert.equal(uniqueCarriers(layouts, content), true);
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
  const lookalike = layoutsFromRequests([req("z", 9, {})], [], 0.5);
  assert.equal(lookalike[0]?.uniqueCarrier, false);
  const scored = scoreStableMemory({ id: "m4", variant: "keep-0.5", layouts, config: { nunc: { rolling: { keepRecentFraction: 0.5 } } } });
  assert.equal(scored.find(c => c.check.includes("keepRecentFraction"))?.status, "PROVEN");
  assert.equal(movingUsesTail(layouts, content), false);
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
