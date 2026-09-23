import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RunInput } from "../../src/live/contract.js";
import { runSegment } from "../../src/live/worker.js";
import { readLedger, ledgerSummary } from "../../src/live/budget.js";
import { repository } from "./fixtures.js";

test("m5 stock host proves an initial no-eligible save and later lawful cleanup, with off-arm original projection", { timeout: 180000 }, async t => {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const scenario = JSON.parse(await readFile(join(repository, "tests/scenarios/tool-result-cleanup-inputs.json"), "utf8")).cases[0];
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const native = runtime.getModel("openai-codex", "gpt-6-luna");
  assert(native && native.api === "openai-codex-responses" && native.maxTokens === 128000);
  assert.equal(clampThinkingLevel(native, "low"), "low");
  for (const api of ["openai-completions", "openai-codex-responses"] as const) for (const variant of ["cleanup-on", "cleanup-off"] as const) {
    const f = await new StockFixture().setup({ api, timeoutMs: 85000 });
    const codex = api === "openai-codex-responses";
    const model: Model<Api> = codex ? { ...native, baseUrl: f.endpoint } : { id: "nunc-m5-controlled", name: "Controlled m5", provider: "openrouter", api: "openai-completions", baseUrl: f.endpoint,
      reasoning: false, input: ["text"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    if (codex) f.modelId = model.id;
    const stateRoot = join(f.state, "worker"); await mkdir(stateRoot);
    if (codex) {
      await mkdir(join(stateRoot, "host"));
      await writeFile(join(stateRoot, "host/auth.json"), JSON.stringify({ "openai-codex": f.oauth }), { mode: 0o600 });
    }
    const selection: RunInput["scenarios"][number] = { id: "m5", variant, config: { compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 1200 } } } };
    const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
      effective: { source: "invoking-runtime", provider: model.provider, model: model.id, thinking: codex ? "low" : "off", transport: "sse", compaction: selection.config.compaction, settings: { nunc: { memoryTools: true } } },
      limits: { maxCalls: 48, maxTotalTokens: codex ? null : 2400000, maxOutputTokens: model.maxTokens, maxCostUsd: null, maxDurationMs: 85000 }, scenarios: [selection] };
    const steps: Record<string, Array<{ name: string; input: unknown } | string>> = {
      a: [{ name: "read", input: { path: "requirements.zh.txt" } }, { name: "read", input: { path: "repair.log" } }, { name: "read", input: { path: "progress.json" } }, { name: "nunc_memory_read", input: {} }, "patch-initial", "Initial obligations recorded."],
      b: [{ name: "read", input: { path: "verbose-report.txt" } }, { name: "read", input: { path: "diagnostics.txt" } }, { name: "write", input: { path: "interim.json", content: JSON.stringify({ verification: "failed", nextAction: "repair restart state" }) } }, "Interim recorded."],
      c: [{ name: "read", input: { path: "supplement.txt" } }, { name: "read", input: { path: "verbose-report.txt" } }, { name: "read", input: { path: "diagnostics.txt" } }, { name: "read", input: { path: "progress.json" } }, { name: "nunc_memory_read", input: {} }, "patch-later", "Updated notes."],
      d: [{ name: "write", input: { path: "final.json", content: JSON.stringify({ cancellationState: "pending repair", restartState: "still running", completedJobs: "preserve", verification: "failed", nextAction: "fix restart state and rerun tests" }) } }, "Controlled turn complete."],
    };
    let turn = "", index = 0;
    f.response = (row: any, source: any) => {
      assert.equal(source, undefined, "No synthetic maintenance output in this observation");
      const messages = row.payload.messages ?? row.payload.input;
      const latestUser = [...messages].reverse().find((m: any) => m.role === "user" && scenario.turns.some((s: any) => text(m) === s.text));
      const id = scenario.turns.find((s: any) => s.text === text(latestUser))?.id;
      assert(id, "Delivered task turn must be visible");
      if (id !== turn) { turn = id; index = 0; }
      const step = steps[id]![index++]; assert(step, `Unexpected continuation ${id}/${index}`);
      if (typeof step === "string" && step.startsWith("patch-")) {
        const result = messages.findLast((m: any) => m.role === "tool" || m.type === "function_call_output");
        const read = JSON.parse(typeof result?.output === "string" ? result.output : text(result));
        assert.equal(typeof read.revision, "string");
        return { tool: { name: "nunc_memory_patch", input: { expectedRevision: read.revision, add: [{ key: step === "patch-initial" ? "repair" : "restart", text: step === "patch-initial" ? "Cancellation repair is open; restart test failed; preserve completed jobs." : "Supplement confirms restart reloads a cancelled job as running; verification remains failed." }] } } };
      }
      return typeof step === "string" ? step : { tool: step };
    };
    try {
      const controlledModels = codex ? { providers: { "openai-codex": { baseUrl: f.endpoint } } } : { providers: { openrouter: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [model] } } };
      const report = await runSegment({ input, scenarioIndex: 0, deadline: Date.now() + 85000, resume: false, group: "candidate" }, { models: [model], controlledModels });
      await writeFile(join(f.dir, `m5-${api}-${variant}-report.json`), JSON.stringify(report));
      t.diagnostic(`${api}/${variant} stock report: ${f.dir}`);
      const check = report.prerequisites.find(c => c.check.startsWith(variant));
      assert.equal(check?.status, "PROVEN", JSON.stringify({ status: report.status, reason: report.reason, diagnostic: report.diagnostic, fixtureError: f.error?.message, check, steps: index, actions: report.actions.filter((a: any) => a.event?.type === "tool_result").map((a: any) => [a.turn, a.event.toolName]) }));
      assert.equal(report.nextTurn, 4);
      assert.equal(report.status, "OBSERVED", JSON.stringify({ reason: report.reason, prerequisites: report.prerequisites }));
      assert.equal(report.score?.checks.some(c => c.status === "UNPROVEN"), true, "A scripted model cannot establish semantic quality");
      if (codex) {
        const main = report.requests?.filter(r => r.kind === "main") ?? [];
        assert(main.length > 2);
        for (const request of main) {
          assert.equal(request.model.provider, "openai-codex");
          assert.equal(request.model.id, "gpt-6-luna");
          assert.equal(request.thinking, "low");
          const payload = request.finalPayload as Record<string, any> | undefined;
          assert(payload, "Each native request must have a captured serialized payload");
          assert.equal(payload.model, "gpt-6-luna");
          assert.equal(payload.reasoning?.effort, "low", "Native serializer applies the authorized thinking level");
          assert.equal(Object.hasOwn(payload, "max_output_tokens"), false, "Native Codex output allowance is uncapped on the wire");
        }
        const ledger = readLedger(join(stateRoot, "calls.jsonl"));
        assert(ledger.some(row => row.kind === "reserve" && row.model === "openai-codex/gpt-6-luna" && row.outputCeiling === native.maxTokens));
        assert.equal(ledgerSummary(ledger).costUsd, null, "Controlled usage never proves native account billing");
      }
    } finally { await f.close(); }
  }
});
