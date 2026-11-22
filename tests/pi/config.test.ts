import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { parseConfig, parseNuncSettings, engineConfig, readConfig } from "../../src/pi/config.js";
import { model, user, assistant, tool } from "../engine/fixtures.js";
import { chooseCut, inputLimit, memoryPlan } from "../../src/engine/accounting.js";
import { legalCuts, validateConfig } from "../../src/engine/validation.js";
import { fixture, memoryPatch, preparedSurface } from "./fixtures.js";

for (const config of [null, [], { unknown: 1 }, { policyFile: "" }, { memory: { fraction: 1 } }, { memory: { fraction: -1 } }, { memory: { maxTokens: 0 } }, { memory: { targetTokens: 0 } }, { memory: { targetTokens: -1 } }, { memory: { targetTokens: 1.5 } }, { rolling: { keepRecentFraction: 0 } }, { rolling: { keepRecentFraction: 1 } }, { rolling: { keepRecentFraction: -0.1 } }, { rolling: { keepRecentFraction: 1.5 } }, { rolling: { keepRecentFraction: "0.5" } }, { extraction: { toolResults: "never" } }, { extraction: { outputTokens: 1.5 } }, { budget: { inputLimit: -1 } }, { budget: { extraMainInputTokens: -1 } }]) {
  test(`invalid configuration rejected: ${JSON.stringify(config)}`, () => assert.throws(() => parseConfig(config)));
}
test("actual host settings drive H, memory/keep configuration and stock output/thinking upper bounds", () => {
  const config = parseConfig({ memory: { fraction: 0.2, maxTokens: 400 }, rolling: { keepRecentFraction: 0.5 }, extraction: { toolResults: "full", outputTokens: 1024 } });
  const first = engineConfig(config, model, { reserveTokens: 36000, keepRecentTokens: 100 });
  assert.equal(first.triggerTokens, 24000); assert.deepEqual(first.memory, { fraction: 0.2, maxTokens: 400, targetTokens: 8192 });
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

test("default rolling.keepRecentFraction resolves to 0.5; explicit overrides preserve 0.67 without altering non-target budgets", () => {
  const hostSettings = { reserveTokens: 36000, keepRecentTokens: 100 };
  const defaultEmpty = engineConfig({}, model, hostSettings);
  assert.equal(defaultEmpty.keepRecentFraction, 0.5);

  const defaultRollingEmpty = engineConfig({ rolling: {} }, model, hostSettings);
  assert.equal(defaultRollingEmpty.keepRecentFraction, 0.5);

  const explicit67 = engineConfig({ rolling: { keepRecentFraction: 0.67 } }, model, hostSettings);
  assert.equal(explicit67.keepRecentFraction, 0.67);

  const explicit25 = engineConfig({ rolling: { keepRecentFraction: 0.25 } }, model, hostSettings);
  assert.equal(explicit25.keepRecentFraction, 0.25);

  // Non-target budgets are strictly preserved between default 0.5 and explicit 0.67
  assert.equal(defaultEmpty.triggerTokens, explicit67.triggerTokens);
  assert.deepEqual(defaultEmpty.memory, explicit67.memory);
  assert.equal(defaultEmpty.growthTokens, explicit67.growthTokens);
  assert.deepEqual(defaultEmpty.main, explicit67.main);
  assert.deepEqual(defaultEmpty.extraction, explicit67.extraction);
  assert.equal(defaultEmpty.imageTokens, explicit67.imageTokens);
});

test("retention budget formula computes keepTarget = floor(q * (available - memoryLimit)) for default 0.5 vs explicit 0.67", () => {
  const fixed = { systemPrompt: "Task prompt.", tools: [] };
  const hostSettings = { reserveTokens: 36000, keepRecentTokens: 100 };
  const cfgDefault = engineConfig({}, model, hostSettings);
  const cfgExplicit = engineConfig({ rolling: { keepRecentFraction: 0.67 } }, model, hostSettings);

  const planDefault = memoryPlan(fixed, model, cfgDefault);
  const planExplicit = memoryPlan(fixed, model, cfgExplicit);

  // Trigger, fixedTokens, available, and memoryLimit remain identical
  assert.equal(planDefault.effectiveTrigger, planExplicit.effectiveTrigger);
  assert.equal(planDefault.fixedTokens, planExplicit.fixedTokens);
  assert.equal(planDefault.available, planExplicit.available);
  assert.equal(planDefault.memoryLimit, planExplicit.memoryLimit);

  // Formula check
  assert.equal(planDefault.keepTarget, hostSettings.keepRecentTokens);
  assert.equal(planExplicit.keepTarget, Math.floor(0.67 * (planExplicit.available - planExplicit.memoryLimit)));
  assert(planDefault.keepTarget < planExplicit.keepTarget);
});

test("proportional default target follows H, honors host minimum, and caps large windows", () => {
  for (const [window, reserve, recent, expected] of [[272000, 16384, 20000, 20000], [1000000, 16384, 20000, 20000], [60000, 36000, 7000, 7000], [400000, 16384, 8000, 8000], [272000, 16384, 1, 32768], [60000, 36000, 1, 3600]]) {
    const m = { ...model, contextWindow: window! };
    const settings = { reserveTokens: reserve!, keepRecentTokens: recent! };
    assert.equal(engineConfig({}, m, settings).keepRecentTargetTokens, expected);
    assert.equal(engineConfig({ rolling: { targetTokens: 1234 } }, m, settings).keepRecentTargetTokens, 1234);
    assert.equal(engineConfig({ rolling: { keepRecentFraction: 0.67 } }, m, settings).keepRecentTargetTokens, undefined);
    assert.equal(engineConfig({ rolling: { targetTokens: 1234, keepRecentFraction: 0.67 } }, m, settings).keepRecentTargetTokens, 1234);
  }
});

test("default retention honors host recent tokens within feasible space; explicit fraction opts out", () => {
  const fixed = { systemPrompt: "Task prompt.", tools: [] };
  const settings = { reserveTokens: 27000, keepRecentTokens: 20000 };
  const cfg = engineConfig({}, model, settings);
  const plan = memoryPlan(fixed, model, cfg);
  assert.equal(cfg.keepRecentTokens, settings.keepRecentTokens);
  assert(plan.keepTarget > Math.floor(cfg.keepRecentFraction * (plan.available - plan.memoryReserveTokens)));
  assert.equal(plan.keepTarget, settings.keepRecentTokens);
  const largeMemory = [{ id: "s1", text: "Current necessary state. ".repeat(2000) }];
  const constrained = memoryPlan(fixed, model, cfg, largeMemory);
  const feasible = Math.max(0, constrained.available - constrained.memoryReserveTokens - cfg.growthTokens);
  assert(feasible < settings.keepRecentTokens);
  assert.equal(constrained.keepTarget, Math.max(
    Math.floor(cfg.keepRecentFraction * Math.max(0, constrained.available - constrained.memoryReserveTokens)), feasible));
  for (const fraction of [0.5, 0.67]) {
    const explicit = engineConfig({ rolling: { keepRecentFraction: fraction } }, model, settings);
    assert.equal(explicit.keepRecentTokens, undefined);
    const planned = memoryPlan(fixed, model, explicit);
    assert.equal(planned.keepTarget, Math.floor(fraction * (planned.available - planned.memoryReserveTokens)));
  }
  for (const invalid of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => validateConfig({ ...cfg, keepRecentTokens: invalid }), /keepRecentTokens/);
  }
  validateConfig({ ...cfg, keepRecentTokens: 0 });
});

test("organizing target is independent of fractional reserve and constrained by growth and explicit ceiling", () => {
  const fixed = { systemPrompt: "Task prompt.", tools: [] };
  const settings = { reserveTokens: 27000, keepRecentTokens: 20000 };
  const cfg = engineConfig({}, model, settings);
  const plan = memoryPlan(fixed, model, cfg);
  assert.equal(plan.organizingTarget, 8192);
  assert.equal(plan.memoryLimit, Math.floor(cfg.memory.fraction * plan.available));
  assert(plan.memoryLimit < plan.organizingTarget);
  assert.equal(memoryPlan(fixed, model, { ...cfg, memory: { ...cfg.memory, maxTokens: 400 } }).organizingTarget, 400);
  const narrow = memoryPlan(fixed, model, { ...cfg, triggerTokens: 5000, growthTokens: 2000 });
  assert.equal(narrow.organizingTarget, Math.max(0, narrow.available - 2000));
  const fullGrowth = memoryPlan(fixed, model, { ...cfg, growthTokens: cfg.triggerTokens });
  assert.equal(fullGrowth.organizingTarget, 0);
});

test("chooseCut with legal cuts preserves full tool/message units and chooses minimal viable over-target suffix when needed", () => {
  const hostSettings = { reserveTokens: 36000, keepRecentTokens: 100 };
  const cfgDefault = engineConfig({}, model, hostSettings);
  const cfgExplicit = engineConfig({ rolling: { keepRecentFraction: 0.67 } }, model, hostSettings);

  // Construct active history containing indivisible tool call + result pair
  const active = [
    user("u1", "First instruction."),
    assistant("a1", [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "a.txt" } }]),
    tool("t1", "call1", "Content of file a.txt " + "z".repeat(4000)),
    user("u2", "Second question " + "w".repeat(3000)),
    assistant("a2", [{ type: "text", text: "Answer to second question." }]),
    user("u3", "Third task " + "v".repeat(2000)),
  ];

  // legalCuts must not allow cutting between assistant tool call and its toolResult
  const cuts = legalCuts(active);
  assert.deepEqual(cuts, [1, 3, 4, 5]); // cut 2 (between a1 and t1) is excluded

  const fixedTokens = 500;
  const memoryLimit = 2000;
  const trigger = 24000;

  // Case 1: Standard cut selection under different keepTargets
  // chooseCut selects largest feasible suffix <= keepTarget
  const targetDefault = 6000;
  const targetExplicit = 10000;
  const cutDefault = chooseCut(active, cuts, fixedTokens, memoryLimit, targetDefault, trigger, cfgDefault);
  const cutExplicit = chooseCut(active, cuts, fixedTokens, memoryLimit, targetExplicit, trigger, cfgExplicit);
  assert(cutDefault.keptTokens <= targetDefault);
  assert(cutExplicit.keptTokens <= targetExplicit);
  assert(cutDefault.keptTokens <= cutExplicit.keptTokens);
  assert(cutDefault.cut >= cutExplicit.cut);

  // Case 2: Discrete boundary where both 0.5 and 0.67 targets select the SAME cut
  // ("相同边界可能使两个比例选择相同K，不强求每次严格更小")
  const targetMidLow = 7500;
  const targetMidHigh = 8500;
  const cutMidLow = chooseCut(active, cuts, fixedTokens, memoryLimit, targetMidLow, trigger, cfgDefault);
  const cutMidHigh = chooseCut(active, cuts, fixedTokens, memoryLimit, targetMidHigh, trigger, cfgExplicit);
  assert.equal(cutMidLow.cut, cutMidHigh.cut);
  assert.equal(cutMidLow.keptTokens, cutMidHigh.keptTokens);

  // Case 3: An oversized unfinished turn releases turn alignment so the closest
  // legal suffix can retire the preceding completed response.
  const tinyTarget = 100;
  const cutOver = chooseCut(active, cuts, fixedTokens, memoryLimit, tinyTarget, trigger, cfgDefault);
  assert.equal(cutOver.cut, 5); // current user is the smallest indivisible suffix
  assert(cutOver.keptTokens > tinyTarget);
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
  const details = { value: "details", label: "details", description: "Complete memory, budget, maintenance, and diagnostic report" };
  assert.deepEqual((await command.getArgumentCompletions(""))?.map(c => c.value), ["details", "compact-for"]);
  assert.deepEqual(await command.getArgumentCompletions(" d"), [details]);
  for (const prefix of ["d", "det", "details"]) {
    assert.deepEqual(await command.getArgumentCompletions(prefix), [details]);
  }
  for (const prefix of ["s", "st", "status"]) {
    assert.equal(await command.getArgumentCompletions(prefix), null);
  }
  for (const prefix of ["unknown", "details ", "details x", "status "]) {
    assert.equal(await command.getArgumentCompletions(prefix), null);
  }
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
});

test("registered /nunc emits one complete report and treats status as unknown without model calls or transcript changes", async t => {
  const messages: string[] = [];
  const f = await fixture({ extras: [{ name: "capture-nunc-status", factory(pi) {
    pi.events.on("nunc:diagnostic", value => {
      if (value && typeof value === "object" && "message" in value && typeof value.message === "string") messages.push(value.message);
    });
  } }] });
  t.after(() => f.close());
  const entries = f.runtime.session.sessionManager.getEntries();
  await f.runtime.session.prompt("/nunc");
  const bare = messages.at(-1)!;
  await f.runtime.session.prompt("/nunc details");
  const details = messages.at(-1)!;
  assert.equal(bare, details);
  assert.match(bare, /Memory: 0 slots/);
  assert.match(bare, /Maintenance input plan:/);
  assert.match(bare, /No maintenance record in this context/);
  await f.runtime.session.prompt("/nunc status");
  assert.equal(messages.at(-1), "Usage: /nunc [details | compact-for <provider/model-id>]");
  await f.runtime.session.prompt("/nunc unknown");
  assert.equal(messages.at(-1), "Usage: /nunc [details | compact-for <provider/model-id>]");
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const saved = f.runtime.session.sessionManager.getEntries();
  const calls = f.faux.state.callCount;
  await f.runtime.session.prompt("/nunc");
  await f.runtime.session.prompt("/nunc details");
  const accounting = f.events.at(-1)!.result.observations.accounting!;
  assert.equal(messages.at(-1), messages.at(-2));
  assert(messages.at(-1)!.includes(`Input estimate: full ${accounting.fullExtractionTokens.toLocaleString("en-US")} → selected ${accounting.extractionTokens.toLocaleString("en-US")}`));
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
    observed.push(context.systemPrompt ?? getCurrentSystemPrompt(context.messages));
    await writeFile(policyFile, "Preference version B");
    return memoryPatch(context);
  });
  await f.runtime.session.compact();
  assert(observed[0]?.includes("Preference version A")); assert(!observed[0]?.includes("Preference version B"));
  f.seed("next"); await f.runtime.session.compact();
  assert(observed[1]?.includes("Preference version B"));
  assert.equal(f.events.filter(e => e.result.ok).length, 2);
});

test("malformed local config errors retain parser diagnostics", async t => {
  const f = await fixture(); t.after(() => f.close());
  await writeFile(f.configFile, '{"memory": invalid}');
  assert.throws(() => readConfig(f.configFile, f.cwd), error => {
    assert(error instanceof Error);
    assert(error.cause instanceof SyntaxError);
    assert.match(error.message, /Cannot load Nunc configuration/);
    return true;
  });
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

test("settings engine sections share config validation and require explicit project trust", () => {
  const globalNunc = { rolling: { targetTokens: 8000 }, memory: { targetTokens: 1000 }, extraction: { toolResults: "full" }, budget: { safetyTokens: 100 }, policyFile: "policy.md" };
  assert.deepEqual(parseNuncSettings(globalNunc), globalNunc);
  for (const value of [{ rolling: { targetTokens: 0 } }, { memory: { fraction: 1 } }, { extraction: { toolResults: "invalid" } }, { budget: { inputLimit: -1 } }, { policyFile: "" }]) assert.throws(() => parseNuncSettings(value));
  for (const projectTrusted of [undefined, false, true]) {
    const { config } = readConfig(undefined, "/workspace", { globalNunc, ...(projectTrusted === undefined ? {} : { projectTrusted }), projectNunc: { rolling: { targetTokens: 2000 } } });
    assert.equal(config.rolling!.targetTokens, projectTrusted === true ? 2000 : 8000);
    assert.equal(config.memory!.targetTokens, 1000);
    assert.equal(config.policyFile, "/workspace/policy.md");
    if (projectTrusted !== true) assert.doesNotThrow(() => readConfig(undefined, "/workspace", { projectNunc: { invalid: true }, ...(projectTrusted === undefined ? {} : { projectTrusted }) }));
  }
});

for (const projectTrusted of [false, true]) test(`native settings engine config reaches maintenance and memory growth budget: trusted=${projectTrusted}`, async t => {
  const { f, memory, ctx } = await preparedSurface(t, { configFlag: false, diskSettings: true, projectTrusted,
    globalSettings: { nunc: { memoryTools: true, memory: { targetTokens: 1000 }, rolling: { targetTokens: 700 }, extraction: { toolResults: "full" }, policyFile: "policy.md" } },
    projectSettings: { nunc: { memory: { targetTokens: 500 }, rolling: { targetTokens: 400 } } } });
  await writeFile(join(f.cwd, "policy.md"), "Keep exact source-based conclusions.");
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const result = f.events.at(-1)!.result;
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(result.observations.accounting!.keepTarget, projectTrusted ? 400 : 700);
  assert.equal(memory().read(ctx()).budget.target, projectTrusted ? 500 : 1000);
  assert(f.calls.at(-1)!.systemPrompt.includes("Keep exact source-based conclusions."));
});

test("explicit config file overrides settings engine options throughout native maintenance", async t => {
  const { f, memory, ctx } = await preparedSurface(t, { diskSettings: true, config: { memory: { targetTokens: 1200 }, rolling: { targetTokens: 900 } },
    globalSettings: { nunc: { memory: { targetTokens: 500 }, rolling: { targetTokens: 400 }, policyFile: "missing.md" } } });
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.equal(f.events.at(-1)!.result.observations.accounting!.keepTarget, 900);
  assert.equal(memory().read(ctx()).budget.target, 1200);
});
