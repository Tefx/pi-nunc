import { test } from "node:test";
import assert from "node:assert/strict";
import { maintain } from "../../src/engine/engine.js";
import { memoryPlan } from "../../src/engine/accounting.js";
import { engineConfig, parseConfig } from "../../src/pi/config.js";
import { input, responder, user } from "./fixtures.js";

test("low-water maintenance rolls actual history rather than the unused large-model window", async () => {
  const s = await input();
  s.model.contextWindow = 1048576;
  s.config = engineConfig({}, s.model, { reserveTokens: 16384, keepRecentTokens: 20000 });
  s.active = Array.from({ length: 40 }, (_, i) => user(`u${i}`, "evidence ".repeat(1000)));
  const before = structuredClone(s.active);
  const result = await maintain(s, responder());
  assert(result.ok, result.ok ? "" : result.message);
  assert(result.candidate.kept.length >= 18 && result.candidate.kept.length <= 22);
  assert.deepEqual(result.candidate.kept, before.slice(result.candidate.retiredEntryIds.length));
  assert.deepEqual(s.active, before);
  assert.equal(result.observations.requests, 1);
  assert.equal(result.observations.accounting!.effectiveTrigger, 1048576 - 16384);
});

test("default large-window K target is bounded while explicit fractional and target settings remain effective", async () => {
  const s = await input(); s.model.contextWindow = 1048576;
  const host = { reserveTokens: 16384, keepRecentTokens: 20000 };
  const defaults = memoryPlan(s.fixed, s.model, engineConfig({}, s.model, host), [], 800000);
  assert.equal(defaults.keepTarget, 100000);
  const explicit = engineConfig(parseConfig({ rolling: { keepRecentFraction: 0.5 } }), s.model, host);
  assert.equal(memoryPlan(s.fixed, s.model, explicit, [], 800000).keepTarget, 400000);
  const custom = engineConfig(parseConfig({ rolling: { targetTokens: 64000 } }), s.model, host);
  assert.equal(memoryPlan(s.fixed, s.model, custom, [], 800000).keepTarget, 64000);
  assert.throws(() => parseConfig({ rolling: { targetTokens: 0 } }), /Invalid/);
  assert.throws(() => parseConfig({ rolling: { targetTokens: 1.5 } }), /Invalid/);
});

test("retention target cannot consume required growth space and remains soft at legal message boundaries", async () => {
  const s = await input();
  s.config.keepRecentFraction = 0.99;
  s.config.growthTokens = 15000;
  const plan = memoryPlan(s.fixed, s.model, s.config, [], 100000);
  assert(plan.fixedTokens + plan.memoryReserveTokens + plan.keepTarget + s.config.growthTokens <= plan.effectiveTrigger);
  s.active = [user("old", "old"), user("large-unit", "x".repeat(20000))];
  s.config.keepRecentTargetTokens = 10;
  const result = await maintain(s, responder());
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.kept, s.active.slice(1));
  assert(result.observations.accounting!.keptTokens > 10);
});
