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

test("loaded /nunc command completes details by argument prefix without side effects", async t => {
  const f = await fixture(); t.after(() => f.close());
  const command = f.runtime.services.resourceLoader.getExtensions().extensions
    .flatMap(extension => [...extension.commands.values()]).find(command => command.name === "nunc");
  assert(command?.getArgumentCompletions);
  const entries = f.runtime.session.sessionManager.getEntries();
  const details = { value: "details", label: "details", description: "查看预算与最近维护详情" };
  const status = { value: "status", label: "status", description: "文字概览，不打开面板" };
  assert.deepEqual(await command.getArgumentCompletions(""), [details, status]);
  assert.deepEqual(await command.getArgumentCompletions(" d"), [details]);
  for (const prefix of ["d", "det", "details"]) {
    assert.deepEqual(await command.getArgumentCompletions(prefix), [details]);
  }
  for (const prefix of ["s", "st", "status"]) {
    assert.deepEqual(await command.getArgumentCompletions(prefix), [status]);
  }
  for (const prefix of ["unknown", "details ", "details x", "status "]) {
    assert.equal(await command.getArgumentCompletions(prefix), null);
  }
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
});

test("registered /nunc renders a compact summary and opt-in budget details without model calls or transcript changes", async t => {
  const messages: string[] = [];
  const f = await fixture({ extras: [{ name: "capture-nunc-status", factory(pi) {
    pi.events.on("nunc:diagnostic", value => {
      if (value && typeof value === "object" && "message" in value && typeof value.message === "string") messages.push(value.message);
    });
  } }] });
  t.after(() => f.close());
  const entries = f.runtime.session.sessionManager.getEntries();
  await f.runtime.session.prompt("/nunc");
  assert.equal(messages.at(-1), "记忆：0 条\n压缩触发：24,000 tokens\n预算详情：/nunc details");
  await f.runtime.session.prompt("/nunc details");
  assert.equal(messages.at(-1), [
    "记忆：0 条", "压缩触发：24,000 tokens", "", "输入预算（tokens）",
    "  主请求准入：59,999", "  记忆规划：50,784", "  维护：50,784", "", "输出预留（tokens）",
    "  主请求：8,192", "  维护：8,192", "  维护输出 cap：8,192", "安全余量：1,024 tokens",
    "", "本上下文暂无维护记录。", "", "Pi 0.85.1 · 预算为估算值",
  ].join("\n"));
  await f.runtime.session.prompt("/nunc status");
  assert.equal(messages.at(-1), "记忆：0 条\n压缩触发：24,000 tokens\n预算详情：/nunc details");
  await f.runtime.session.prompt("/nunc unknown");
  assert.equal(messages.at(-1), "用法：/nunc [status|details]");
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const saved = f.runtime.session.sessionManager.getEntries();
  const calls = f.faux.state.callCount;
  await f.runtime.session.prompt("/nunc");
  assert.equal(messages.at(-1), "记忆：1 条\n压缩触发：24,000 tokens\n预算详情：/nunc details");
  await f.runtime.session.prompt("/nunc details");
  const accounting = f.events.at(-1)!.result.observations.accounting!;
  assert(messages.at(-1)!.includes(`最近维护（本上下文）\n  输入估算：完整 ${accounting.fullExtractionTokens.toLocaleString("en-US")} → 选用 ${accounting.extractionTokens.toLocaleString("en-US")}`));
  assert.equal(f.faux.state.callCount, calls);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), saved);
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
