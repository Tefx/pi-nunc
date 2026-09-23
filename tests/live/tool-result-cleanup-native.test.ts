import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RunInput } from "../../src/live/contract.js";
import { runSegment } from "../../src/live/worker.js";
import { repository } from "./fixtures.js";

test("m5 stock host proves an initial no-eligible save and later lawful cleanup, with off-arm original projection", { timeout: 180000 }, async t => {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const scenario = JSON.parse(await readFile(join(repository, "tests/scenarios/tool-result-cleanup-inputs.json"), "utf8")).cases[0];
  for (const variant of ["cleanup-on", "cleanup-off"] as const) {
    const f = await new StockFixture().setup({ timeoutMs: 85000 });
    const model: Model<Api> = { id: "nunc-m5-controlled", name: "Controlled m5", provider: "openrouter", api: "openai-completions", baseUrl: f.endpoint,
      reasoning: false, input: ["text"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const stateRoot = join(f.state, "worker"); await mkdir(stateRoot);
    const selection: RunInput["scenarios"][number] = { id: "m5", variant, config: { compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 1200 } } } };
    const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
      effective: { source: "invoking-runtime", provider: model.provider, model: model.id, thinking: "off", transport: "sse", compaction: selection.config.compaction, settings: { nunc: { memoryTools: true } } },
      limits: { maxCalls: 48, maxTotalTokens: 2400000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 85000 }, scenarios: [selection] };
    const steps: Record<string, Array<{ name: string; input: unknown } | string>> = {
      a: [{ name: "read", input: { path: "requirements.zh.txt" } }, { name: "read", input: { path: "repair.log" } }, { name: "read", input: { path: "progress.json" } }, { name: "nunc_memory_read", input: {} }, "patch-initial", "Initial obligations recorded."],
      b: [{ name: "read", input: { path: "verbose-report.txt" } }, { name: "read", input: { path: "diagnostics.txt" } }, { name: "write", input: { path: "interim.json", content: JSON.stringify({ verification: "failed", nextAction: "repair restart state" }) } }, "Interim recorded."],
      c: [{ name: "read", input: { path: "supplement.txt" } }, { name: "read", input: { path: "verbose-report.txt" } }, { name: "read", input: { path: "diagnostics.txt" } }, { name: "read", input: { path: "progress.json" } }, { name: "nunc_memory_read", input: {} }, "patch-later", "Updated notes."],
      d: [{ name: "write", input: { path: "final.json", content: JSON.stringify({ cancellationState: "pending repair", restartState: "still running", completedJobs: "preserve", verification: "failed", nextAction: "fix restart state and rerun tests" }) } }, "Controlled turn complete."],
    };
    let turn = "", index = 0;
    f.response = (row: any, source: any) => {
      assert.equal(source, undefined, "No synthetic maintenance output in this observation");
      const messages = row.payload.messages;
      const latestUser = [...messages].reverse().find((m: any) => m.role === "user" && scenario.turns.some((s: any) => text(m) === s.text));
      const id = scenario.turns.find((s: any) => s.text === text(latestUser))?.id;
      assert(id, "Delivered task turn must be visible");
      if (id !== turn) { turn = id; index = 0; }
      const step = steps[id]![index++]; assert(step, `Unexpected continuation ${id}/${index}`);
      if (typeof step === "string" && step.startsWith("patch-")) {
        const read = JSON.parse(text(messages.findLast((m: any) => m.role === "tool")));
        assert.equal(typeof read.revision, "string");
        return { tool: { name: "nunc_memory_patch", input: { expectedRevision: read.revision, add: [{ key: step === "patch-initial" ? "repair" : "restart", text: step === "patch-initial" ? "Cancellation repair is open; restart test failed; preserve completed jobs." : "Supplement confirms restart reloads a cancelled job as running; verification remains failed." }] } } };
      }
      return typeof step === "string" ? step : { tool: step };
    };
    try {
      const report = await runSegment({ input, scenarioIndex: 0, deadline: Date.now() + 85000, resume: false, group: "candidate" }, { models: [model], controlledModels: { providers: { openrouter: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [model] } } } });
      await writeFile(join(f.dir, `m5-${variant}-report.json`), JSON.stringify(report));
      t.diagnostic(`${variant} stock report: ${f.dir}`);
      const check = report.prerequisites.find(c => c.check.startsWith(variant));
      assert.equal(check?.status, "PROVEN", JSON.stringify({ status: report.status, reason: report.reason, diagnostic: report.diagnostic, fixtureError: f.error?.message, check, steps: index, actions: report.actions.filter((a: any) => a.event?.type === "tool_result").map((a: any) => [a.turn, a.event.toolName]) }));
      assert.equal(report.nextTurn, 4);
      assert.equal(report.status, "OBSERVED", JSON.stringify({ reason: report.reason, prerequisites: report.prerequisites }));
      assert.equal(report.score?.checks.some(c => c.status === "UNPROVEN"), true, "A scripted model cannot establish semantic quality");
    } finally { await f.close(); }
  }
});
