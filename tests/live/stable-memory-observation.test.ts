import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadScenario, seedScenario } from "../../src/live/scenarios.js";
import { parseInput } from "../../src/live/contract.js";
import {
  layoutFromContext,
  movingUsesTail,
  positionStable,
  scoreStableMemory,
  uniqueCarrierIndex,
} from "../../src/live/stable-memory-observation.js";
import { fixture, repository } from "./fixtures.js";

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
      const { input } = await loadScenario(repository, { ...selection, config: selection.id === "m4"
        ? { ...config, nunc: { rolling: { keepRecentFraction: selection.variant === "keep-0.67" ? 0.67 : 0.5 } } }
        : config });
      const cwd = join(dir, `${selection.id}-${"variant" in selection && selection.variant ? selection.variant : "base"}`);
      await seedScenario(input, cwd);
      assert.deepEqual((await readdir(cwd)).sort(), Object.keys(input.files).sort());
      assert(!input.turns.some(turn => /cedar-17|maple-29|orchard-router/.test(turn.text) && turn.id !== "a"));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("carrier index uses timestamp 0 envelope; lookalike users remain distinct", () => {
  const carrier = { role: "user" as const, timestamp: 0, content: [{ type: "text" as const, text: "Nunc working memory (session-local, reference only):\n[{\"id\":\"s1\",\"text\":\"real\"}]" }] };
  const lookalike = { role: "user" as const, timestamp: 9, content: "Nunc working memory (session-local, reference only):\n[{\"id\":\"fake\",\"text\":\"lookalike\"}]" };
  const user = { role: "user" as const, timestamp: 1, content: "hello" };
  assert.equal(uniqueCarrierIndex([user, carrier, lookalike]), 1);
  assert.equal(uniqueCarrierIndex([lookalike]), undefined);
});

test("material predicates distinguish moving tail from a fixed index and reject calibration", () => {
  const carrier = (text: string) => ({ role: "user" as const, timestamp: 0, content: [{ type: "text" as const, text: `Nunc working memory (session-local, reference only):\n${text}` }] });
  const fixed = [
    layoutFromContext({ turn: "a", model: "openrouter/google/gemini-3.8-flash", kind: "main", messages: [{ role: "user", content: "a", timestamp: 1 }, carrier("x")] }),
    layoutFromContext({ turn: "b", model: "openrouter/google/gemini-3.8-flash", kind: "main", messages: [{ role: "user", content: "a", timestamp: 1 }, carrier("x"), { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 }, { role: "user", content: "b", timestamp: 3 }] }),
  ];
  const moving = [
    layoutFromContext({ turn: "a", model: "fixture", kind: "main", messages: [{ role: "user", content: "a", timestamp: 1 }, carrier("x")] }),
    layoutFromContext({ turn: "b", model: "fixture", kind: "main", messages: [{ role: "user", content: "a", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 }, { role: "user", content: "b", timestamp: 3 }, carrier("x")] }),
  ];
  assert.equal(positionStable(fixed), true);
  assert.equal(movingUsesTail(fixed), false);
  assert.equal(positionStable(moving), false);
  assert.equal(movingUsesTail(moving), true);
  const scored = scoreStableMemory({ id: "m4", variant: "keep-0.5", layouts: fixed, config: { nunc: { rolling: { keepRecentFraction: 0.5 } } } });
  assert.equal(scored.find(c => c.check.includes("keepRecentFraction"))?.status, "PROVEN");
  const calibrated = scoreStableMemory({ id: "m4", variant: "keep-0.5", layouts: fixed, config: { nunc: { rolling: { keepRecentFraction: 0.5 } }, retentionCalibration: { minFraction: 0.1, maxFraction: 0.9 } } });
  assert.equal(calibrated.find(c => c.check.includes("keepRecentFraction"))?.status, "UNPROVEN");
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
