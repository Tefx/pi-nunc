import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import type { RunInput } from "../../src/live/contract.js";
import { runSegment } from "../../src/live/worker.js";
import { boundedProvider, BudgetLedger, readLedger, ledgerSummary } from "../../src/live/budget.js";
import { taskFileChecks } from "../../src/live/task-retention.js";
import { loadScenario } from "../../src/live/scenarios.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { repository } from "./fixtures.js";
import { metricsSolution, metricsTests } from "./metrics-fixture.js";

test("real native serializer refuses missing/off/wrong thinking and wrong model before transport", { timeout: 30000 }, async () => {
  const { StockFixture } = await import(join(repository, "scripts/stock-driver.mjs"));
  const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
  const f = await new StockFixture().setup({ timeoutMs: 25000 });
  const model: Model<"openai-completions"> = { id: "openai/gpt-5.6-luna", name: "Controlled serializer", provider: "openrouter", api: "openai-completions", baseUrl: f.endpoint, reasoning: true, input: ["text"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ledger = new BudgetLedger(join(f.dir, "ledger.jsonl"), { maxCalls: 20, maxTotalTokens: 1600000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 25000 }, Date.now() + 25000, new AbortController().signal);
  try {
    const rawLedger = new BudgetLedger(ledger.path, ledger.limits, ledger.deadline, ledger.signal, "raw-maintenance-default");
    const raw = await boundedProvider(openrouterProvider(), [model], rawLedger, { requireThinkingLevel: "low" }).stream(model, normalizeContext({ messages: [] }), { apiKey: "isolated-nunc-fixture", maxTokens: 1000 }).result();
    assert.equal(raw.stopReason, "error"); assert.match(raw.errorMessage!, /THINKING_UNAPPLIED/); assert.equal(f.requests.length, 0);
    for (const kind of ["main", "maintenance"] as const) for (const effort of [undefined, "off", "high"]) {
      const caseLedger = new BudgetLedger(ledger.path, ledger.limits, ledger.deadline, ledger.signal, `${kind}-${effort ?? "missing"}`);
      const provider = boundedProvider(openrouterProvider(), [model], caseLedger, { requireThinkingLevel: "low", maintenanceThinking: "low", classify: () => kind });
      const options = { apiKey: "isolated-nunc-fixture", maxTokens: 1000, reasoning: "low" as const,
        onPayload: (payload: any) => { delete payload.reasoning_effort; if (effort === undefined) delete payload.reasoning; else payload.reasoning = { effort }; return payload; } };
      const stream = kind === "main" ? provider.streamSimple(model, normalizeContext({ messages: [] }), options) : provider.stream(model, normalizeContext({ messages: [] }), options);
      const result = await stream.result();
      assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /THINKING_UNAPPLIED/);
      assert.equal(f.requests.length, 0, "negative payload never reaches HTTP");
    }
    const provider = boundedProvider(openrouterProvider(), [model], ledger, { requireThinkingLevel: "low" });
    for (const wrong of [{ ...model, id: "other" }, { ...model, reasoning: false }]) {
      const result = await provider.streamSimple(wrong, normalizeContext({ messages: [] }), { apiKey: "isolated-nunc-fixture", reasoning: "low" }).result();
      assert.equal(result.stopReason, "error"); assert.equal(f.requests.length, 0);
    }
    assert.deepEqual(ledgerSummary(readLedger(join(f.dir, "ledger.jsonl"))).unreconciledCallIds, []);
  } finally { await f.close(); }
});

// No model calls: stock serialization, HTTP, tool effects, reload, compaction and JSONL all execute.
// Controlled usage intentionally supplies the positive threshold premise; the low-usage case falsifies it.
async function taskFileHost(group: "native" | "current" | "candidate", tools = true, lowUsage: boolean | "infeasible" | "reachable" | "defer-then-progress" = false, ordinaryExtra = false) {
  const { StockFixture } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 160000 });
  const model: Model<Api> = { id: "openai/gpt-5.6-luna", name: "Controlled Luna protocol fixture", provider: "openrouter", api: "openai-completions", baseUrl: f.endpoint,
    reasoning: true, input: ["text"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stateRoot = join(f.state, "worker"); await mkdir(stateRoot);
  const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
    effective: { source: "invoking-runtime", provider: model.provider, model: model.id, thinking: "low", transport: "sse", compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, settings: { nunc: { memoryTools: true } } },
    comparison: { modes: ["defaults"], targets: { native: { repository }, candidate: { repository }, current: { repository: join(repository, ".scratch/prechange"), ref: "refs/nunc/task-retention-pre-change" } } },
    overrides: [{ requirement: "maintenance-thinking", maintenanceThinking: "low", reason: "Controlled low-effort native serializer proof" }, ...(tools ? [] : [{ requirement: "memory-tools-off", memoryTools: false, reason: "Actual tools-off comparison" }])],
    limits: { maxCalls: 40, maxTotalTokens: 3200000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 150000 },
    scenarios: [{ id: "g4", variant: "task-file", config: { compaction: { enabled: ordinaryExtra, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 1200 }, extraction: { outputTokens: 2048 } } } }] };
  const tool = (name: string, input: any, stepIndex: number) => {
    let inp = 18000;
    if (lowUsage === true || lowUsage === "infeasible") inp = 100;
    else if (lowUsage === "reachable") inp = 5000;
    else if (lowUsage === "defer-then-progress") inp = stepIndex === 0 ? 2929 : 18000;
    return { tool: { name, input }, input: inp };
  };
  const sequence = [tool("read", { path: "TASK.md" }, 0), tool("bash", { command: "python3 build.py" }, 1),
    tool("edit", { path: "solution.py", oldText: "def evaluate(record)", newText: "def evaluate(record):" }, 2),
    tool("bash", { command: "python3 build.py" }, 3), tool("write", { path: "solution.py", content: metricsSolution }, 4),
    tool("write", { path: "test_solution.py", content: metricsTests }, 5), tool("bash", { command: "python3 build.py" }, 6),
    tool("bash", { command: "python3 -m unittest test_solution.py" }, 7), tool("write", { path: "handoff.json", content: JSON.stringify({ implemented: true, verified: true, complete: true, remaining: [], commands: ["python3 build.py", "python3 -m unittest test_solution.py"] }) }, 8), { text: "Controlled task completed.", input: 18000 }];
  if (ordinaryExtra) sequence[6]!.input = 30000; // An ordinary later tool batch crosses the restored threshold.
  let step = 0, maintenance = 0;
  f.response = (row: any, source: any) => {
    assert.equal(row.payload.model, model.id);
    assert.equal(row.payload.reasoning?.effort ?? row.payload.reasoning_effort, "low", "actual native serialized effort");
    if (!source && row.payload.messages.some((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes("<conversation>"))) return "## Goal\nContinue the local task.\n## Progress\nControlled native compaction.\n## Next Steps\nConsult ordinary task sources if needed.";
    if (source) {
      maintenance++;
      return JSON.stringify({ add: [{ key: "generated", text: `Controlled generated note ${maintenance}` }], remove: source.M.map((s: any) => s.id), priority: ["generated"], required: ["generated"] });
    }
    assert(step < sequence.length, "no repeated main effects"); return sequence[step++];
  };
  try {
    const report = await runSegment({ input, scenarioIndex: 0, deadline: Date.now() + 150000, resume: false, group }, {
      models: [model], controlledModels: { providers: { openrouter: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [model] } } },
    });
    await writeFile(join(f.dir, "task-retention-report.json"), JSON.stringify(report));
    if (lowUsage === true || lowUsage === "infeasible") {
      assert.equal(report.status, "UNPROVEN"); assert.equal(report.reason, "PREPARATION");
      assert.equal(maintenance, 0); assert.equal(report.rollovers!.length, 0); return;
    }
    if (lowUsage === "defer-then-progress") {
      assert(report.preparations!.some((p: any) => p.deferred === true), "first read was genuinely deferred when insufficient");
    }
    assert.equal(report.status, "OBSERVED", JSON.stringify({ status: report.status, reason: report.reason, diagnostic: report.diagnostic, prerequisites: report.prerequisites }));
    assert.equal(report.nextTurn, 1);
    assert.equal(report.observedFacts!.guardApplicability, group === "native" ? "NOT_APPLICABLE" : "APPLICABLE", "actual prechange retains the required-item protocol");
    assert.equal(step, sequence.length); assert.equal(maintenance, group === "native" ? 0 : ordinaryExtra ? 4 : 3);
    for (const request of report.requests!.filter(r => r.kind === "main")) {
      const names = request.context.tools?.map(t => t.name) ?? [];
      assert.equal(names.includes("nunc_memory_patch"), tools && group !== "native");
      assert.equal(names.includes("nunc_memory_read"), tools && group !== "native");
    }
    assert.equal(new Set(report.rollovers!.map(r => r.snapshot!.id)).size, ordinaryExtra ? 4 : 3);
    assert.equal(report.configurationChanges!.length, 6);
    for (let i = 0; i < 6; i += 2) assert.deepEqual(report.configurationChanges![i + 1]!.to, report.configurationChanges![i]!.from);
    assert.equal(report.setupChecks![1]!.status, group === "native" ? "UNPROVEN" : "PROVEN", JSON.stringify(report.setupChecks!.slice(0, 3)));
    assert.equal(report.score!.actionReview.find(c => c.check === "metrics-artifact")!.status, "PROVEN");
    assert(report.score!.actionReview.filter(c => c.check.startsWith("semantic:")).every(c => c.status === "UNPROVEN"));
    const branch = SessionManager.open(report.sessionFile!).getBranch();
    const scenario = (await loadScenario(repository, input.scenarios[0]!)).input;
    for (const corrupt of ["no-commit", "duplicate", "wrong-cut", "missing-M", "no-continuation"]) {
      const rows = structuredClone(report.rollovers!); const requests = structuredClone(report.requests!);
      if (corrupt === "no-commit") delete rows[0]!.snapshot;
      if (corrupt === "duplicate") rows[1]!.snapshot = rows[0]!.snapshot!;
      if (corrupt === "wrong-cut") rows[0]!.snapshot!.firstKeptEntryId = rows[1]!.snapshot!.firstKeptEntryId;
      if (corrupt === "missing-M") requests.find(r => r.callId === rows[2]!.callIds[0])!.context.messages = [];
      if (corrupt === "no-continuation") delete rows[2]!.continuationCallId;
      assert.equal(taskFileChecks(scenario, {}, branch, [], rows, report.actions as any, join(stateRoot, "g4-task-file/task"), requests)[1]!.status, "UNPROVEN", corrupt);
    }
    assert.deepEqual(ledgerSummary(readLedger(join(stateRoot, "calls.jsonl"))).unreconciledCallIds, []);
  } finally { await f.close(); }
}
for (const group of ["candidate", "current", "native"] as const) {
  for (const tools of group === "native" ? [false] : [true, false]) test(`task-file ${group} tools=${tools}: real three-cut loop, restored configuration and final artifact`, { timeout: 180000 }, () => taskFileHost(group, tools));
}
test("task-file low native usage stops before infeasible maintenance or subsequent effects", { timeout: 30000 }, () => taskFileHost("candidate", true, true));
test("task-file reachable low-usage preparation succeeds when genuine task context fits threshold", { timeout: 45000 }, () => taskFileHost("candidate", true, "reachable"));
test("task-file genuinely insufficient first read defers and then succeeds when causal tool progress fits threshold", { timeout: 45000 }, () => taskFileHost("candidate", true, "defer-then-progress"));
test("task-file actual blocked command receives truthful diagnostic, recovers with permitted task command, and completes self-verification", { timeout: 45000 }, async () => {
  const { StockFixture } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 40000 });
  const model: Model<Api> = { id: "openai/gpt-5.6-luna", name: "Controlled Luna protocol fixture", provider: "openrouter", api: "openai-completions", baseUrl: f.endpoint,
    reasoning: true, input: ["text"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stateRoot = join(f.state, "worker"); await mkdir(stateRoot);
  const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
    effective: { source: "invoking-runtime", provider: model.provider, model: model.id, thinking: "low", transport: "sse", compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, settings: { nunc: { memoryTools: true } } },
    overrides: [{ requirement: "maintenance-thinking", maintenanceThinking: "low", reason: "Controlled low-effort native serializer proof" }],
    limits: { maxCalls: 40, maxTotalTokens: 3200000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 40000 },
    scenarios: [{ id: "g4", variant: "task-file", config: { compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 1200 }, extraction: { outputTokens: 2048 } } } }] };
  const tool = (name: string, input: any) => ({ tool: { name, input }, input: 18000 });
  const sequence = [
    tool("read", { path: "TASK.md" }),
    tool("bash", { command: "find . -maxdepth 2 -type f -print" }),
    tool("bash", { command: "python3 build.py" }),
    tool("edit", { path: "solution.py", oldText: "def evaluate(record)", newText: "def evaluate(record):" }),
    tool("bash", { command: "python3 build.py" }),
    tool("write", { path: "solution.py", content: metricsSolution }),
    tool("write", { path: "test_solution.py", content: metricsTests }),
    tool("bash", { command: "python3 build.py" }),
    tool("bash", { command: "python3 -m unittest test_solution.py" }),
    tool("write", { path: "handoff.json", content: JSON.stringify({ implemented: true, verified: true, complete: true, remaining: [], commands: ["python3 build.py", "python3 -m unittest test_solution.py"] }) }),
    { text: "Controlled task completed.", input: 18000 }
  ];
  let step = 0, maintenance = 0;
  f.response = (row: any, source: any) => {
    if (!source && row.payload.messages.some((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes("<conversation>"))) return "## Goal\nContinue the local task.\n## Progress\nControlled native compaction.\n## Next Steps\nConsult ordinary task sources if needed.";
    if (source) {
      maintenance++;
      return JSON.stringify({ add: [{ key: "generated", text: `Controlled generated note ${maintenance}` }], remove: source.M.map((s: any) => s.id), priority: ["generated"], required: ["generated"] });
    }
    assert(step < sequence.length); return sequence[step++];
  };
  try {
    const report = await runSegment({ input, scenarioIndex: 0, deadline: Date.now() + 40000, resume: false, group: "candidate" }, {
      models: [model], controlledModels: { providers: { openrouter: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [model] } } },
    });
    assert.equal(report.status, "OBSERVED");
    const blocked = (report.actions as any[]).find(a => a.event?.type === "tool_blocked" && a.event.toolName === "bash");
    assert(blocked, "Blocked bash command must be recorded in actions");
    assert.equal(blocked.event.input.command, "find . -maxdepth 2 -type f -print");
    assert.match(blocked.event.reason, /^Tool kind or command is outside authorization: only scenario-local read\/write\/edit and task commands/);
    assert.equal(blocked.event.reason.includes("verify.py"), false, "Diagnostic must not misdirect model with verify.py");
    assert.equal(report.score!.actionReview.find(c => c.check === "metrics-artifact")!.status, "PROVEN");
  } finally { await f.close(); }
});
test("task-file continues ordinary native compaction after its three observed opportunities", { timeout: 30000 }, () => taskFileHost("candidate", true, false, true));
