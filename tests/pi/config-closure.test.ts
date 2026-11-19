import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseNuncSettings, readConfig } from "../../src/pi/config.js";
import { memoryPatch, preparedSurface } from "./fixtures.js";

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
