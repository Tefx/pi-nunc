import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, engineConfig, readConfig } from "../../src/pi/config.js";
import { model } from "../engine/fixtures.js";
import { inputLimit } from "../../src/engine/accounting.js";
import { fixture, memoryPatch } from "./fixtures.js";

for (const config of [null, [], { unknown: 1 }, { policyFile: "" }, { memory: { fraction: 1 } }, { memory: { fraction: -1 } }, { memory: { maxTokens: 0 } }, { rolling: { keepRecentFraction: 0 } }, { rolling: { keepRecentFraction: 1 } }, { extraction: { toolResults: "never" } }, { extraction: { outputTokens: 1.5 } }, { budget: { inputLimit: -1 } }, { budget: { extraMainInputTokens: -1 } }]) {
  test(`invalid configuration rejected: ${JSON.stringify(config)}`, () => assert.throws(() => parseConfig(config)));
}
test("actual host settings drive H, memory/keep configuration and stock output/thinking upper bounds", () => {
  const config = parseConfig({ memory: { fraction: 0.2, maxTokens: 400 }, rolling: { keepRecentFraction: 0.5 }, extraction: { toolResults: "full", outputTokens: 1024 } });
  const first = engineConfig(config, model, { reserveTokens: 36000, keepRecentTokens: 100 });
  assert.equal(first.triggerTokens, 24000); assert.deepEqual(first.memory, { fraction: 0.2, maxTokens: 400 });
  assert.equal(first.keepRecentFraction, 0.5); assert.equal(first.extraction.outputTokens, 1024);
  assert.equal(first.main.outputTokens, model.maxTokens);
  const second = engineConfig(config, { ...model, contextWindow: 45000 }, { reserveTokens: 36000, keepRecentTokens: 100 });
  assert.equal(second.triggerTokens, 9000); assert(second.triggerTokens < first.triggerTokens);
  const belowMax = engineConfig({}, model, { reserveTokens: 1000, keepRecentTokens: 1 });
  assert.equal(belowMax.triggerTokens, 59000); assert.equal(belowMax.main.outputTokens, model.maxTokens);
  assert(belowMax.triggerTokens > model.contextWindow - model.maxTokens);
  assert.throws(() => engineConfig({}, model, { reserveTokens: 60000, keepRecentTokens: 1 }));
  assert.throws(() => engineConfig({}, model, { reserveTokens: 59900, keepRecentTokens: 100 }));
  assert.deepEqual(readConfig(undefined, "/unused"), { config: {} });
});

test("equal 500k context/output capabilities leave main input room without changing fixed extraction", () => {
  const grok = { ...model, api: "openai-responses", contextWindow: 500000, maxTokens: 500000 };
  const config = engineConfig({}, grok, { reserveTokens: 16384, keepRecentTokens: 20000 });
  assert.equal(config.main.outputTokens, 500000);
  assert.equal(config.main.nativeOutputReserve, 16384);
  assert.equal(inputLimit(grok, config.main), 500000 - 16384 - 1024);
  assert.equal(config.extraction.outputTokens, 8192);
  assert.equal(inputLimit(grok, config.extraction), 500000 - 8192 - 1024);
  const bounded = engineConfig({ budget: { inputLimit: 300000 } }, grok, { reserveTokens: 16384, keepRecentTokens: 20000 });
  assert.equal(inputLimit(grok, bounded.main), 300000 - 1024);
  const tinyReserve = engineConfig({}, grok, { reserveTokens: 1, keepRecentTokens: 1 });
  assert.equal(tinyReserve.main.nativeOutputReserve, 16);
  assert.equal(inputLimit(grok, tinyReserve.main), 500000 - 16 - 1024);
  for (const uncapped of [{ ...grok, api: "openai-codex-responses" }, { ...grok, compat: { supportsMaxOutputTokens: false } }]) {
    const reserved = engineConfig({}, uncapped, { reserveTokens: 16384, keepRecentTokens: 20000 });
    assert.equal(reserved.main.nativeOutputReserve, 16384);
    assert.equal(inputLimit(uncapped, reserved.main), 482592);
  }
});

test("registered /nunc command handles the public prompt path without a model or transcript mutation", async t => {
  const f = await fixture(); t.after(() => f.close());
  const entries = f.runtime.session.sessionManager.getEntries();
  await f.runtime.session.prompt("/nunc");
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
});

test("stock CLI-style public settings files work without an SDK callback and remain read-only", async t => {
  const f = await fixture({ diskSettings: true }); t.after(() => f.close()); f.seed(); f.respond(memoryPatch);
  const file = join(f.agentDir, "settings.json");
  const before = await readFile(file, "utf8");
  await f.runtime.session.compact();
  assert.equal(await readFile(file, "utf8"), before);
  assert(f.events[0]?.result.ok);
  assert.equal(f.events[0].result.observations.accounting!.effectiveTrigger, 24000);
});

test("stock settings respect declined project trust instead of applying a project override", async t => {
  const f = await fixture({ diskSettings: true }); t.after(() => f.close()); f.seed(); f.respond(memoryPatch);
  // This project settings directory belongs only to the new, isolated fixture cwd.
  const dir = join(f.cwd, ".pi"); await mkdir(dir);
  const file = join(dir, "settings.json");
  const text = JSON.stringify({ compaction: { reserveTokens: 38000 } }); await writeFile(file, text);
  f.settings.setProjectTrusted(false);
  await f.runtime.session.compact();
  assert(f.events[0]?.result.ok);
  assert.equal(f.events[0].result.observations.accounting!.effectiveTrigger, 24000);
  assert.equal(await readFile(file, "utf8"), text);
});

test("relative config/policy loading, one frozen policy per extraction, later edits load next time", async t => {
  const f = await fixture({ config: { policyFile: "preferences.md" } }); t.after(() => f.close()); f.seed();
  const policyFile = join(f.dir, "preferences.md"); await writeFile(policyFile, "Preference version A");
  assert.equal(readConfig("../nunc.json", f.cwd).configFile, f.configFile);
  const observed: string[] = [];
  f.respond(async context => {
    observed.push(context.systemPrompt!);
    await writeFile(policyFile, "Preference version B");
    return memoryPatch(context);
  });
  await f.runtime.session.compact();
  assert(observed[0]?.includes("Preference version A")); assert(!observed[0]?.includes("Preference version B"));
  f.seed("next"); await f.runtime.session.compact();
  assert(observed[1]?.includes("Preference version B"));
  assert.equal(f.events.filter(e => e.result.ok).length, 2);
});

test("unreadable policy / invalid UTF-8 or configuration cannot fall through to Pi default generation", async t => {
  const f = await fixture({ config: { policyFile: "missing.md" } }); t.after(() => f.close()); f.seed();
  await assert.rejects(f.runtime.session.compact(), /cancel/i); assert.equal(f.faux.state.callCount, 0);
  await writeFile(join(f.dir, "missing.md"), Buffer.from([0xff]));
  await assert.rejects(f.runtime.session.compact(), /cancel/i); assert.equal(f.faux.state.callCount, 0);
  await writeFile(f.configFile, '{"memory":{"fraction":1}}');
  await assert.rejects(f.runtime.session.compact(), /cancel/i); assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
});
