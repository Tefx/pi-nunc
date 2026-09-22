import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeMetricsOracle, HELD_OUT_RECORDS } from "../../src/live/metrics-oracle.js";
import { parseInput, type Selection } from "../../src/live/contract.js";
import { scoreGuidance, TOOLS_CHECK } from "../../src/live/guidance.js";
import { repository } from "./fixtures.js";
import { boundedProvider, BudgetLedger } from "../../src/live/budget.js";
import { createAssistantMessageEventStream, type Model, type Context, type Api, type Provider } from "@earendil-works/pi-ai";
import { resolveInput } from "../../src/live/defaults.js";
import { taskFileChecks } from "../../src/live/task-retention.js";

import { metricsSolution, metricsTests } from "./metrics-fixture.js";
const config = { nunc: {}, compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 4000 } };

const VALID_SOLUTION_PY = `
import json, sys

def calc_single(r):
    g = r.get('gross')
    ref = r.get('refunds')
    c = r.get('cost')
    net = None if (g is None or ref is None) else g - ref
    margin = None if (net is None or c is None) else net - c
    return {'net': net, 'margin': margin}

def get_graph():
    return {
        'nodes': ['gross', 'refunds', 'cost', 'net', 'margin'],
        'edges': [['gross', 'net'], ['refunds', 'net'], ['net', 'margin'], ['cost', 'margin']]
    }

def get_trace(metric, r):
    res = calc_single(r)
    g = r.get('gross')
    ref = r.get('refunds')
    c = r.get('cost')
    if metric == 'margin':
        return {
            'nodes': ['gross', 'refunds', 'cost', 'net', 'margin'],
            'edges': [['gross', 'net'], ['refunds', 'net'], ['net', 'margin'], ['cost', 'margin']],
            'values': {'gross': g, 'refunds': ref, 'cost': c, 'net': res['net'], 'margin': res['margin']}
        }
    elif metric == 'net':
        return {
            'nodes': ['gross', 'refunds', 'net'],
            'edges': [['gross', 'net'], ['refunds', 'net']],
            'values': {'gross': g, 'refunds': ref, 'net': res['net']}
        }
    return {'nodes': [], 'edges': [], 'values': {}}

try:
    req = json.load(sys.stdin)
    op = req.get('op')
    if op == 'single':
        out = calc_single(req.get('record', {}))
    elif op == 'batch':
        out = [calc_single(x) for x in req.get('records', [])]
    elif op == 'history':
        series = req.get('series', {})
        out = {k: [calc_single(x) for x in v] for k, v in series.items()}
    elif op == 'graph':
        out = get_graph()
    elif op == 'trace':
        out = get_trace(req.get('metric'), req.get('record', {}))
    else:
        out = {'error': 'unknown op'}
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

const VALID_BUILD_PY = `
import py_compile
py_compile.compile('solution.py', doraise=True)
print('Compilation succeeded; behavior has not been checked by this command.')
`;

const VALID_TEST_SOLUTION_PY = `import unittest
from solution import calc_single
class Regression(unittest.TestCase):
    def test_values(self):
        self.assertEqual(calc_single({'gross': 0, 'refunds': 0, 'cost': 0}), {'net': 0, 'margin': 0})
`;
// This fixture exercises only single; the oracle must never claim candidate test adequacy from it.
const FIXTURES = { "TASK.md": "# Task\n", "records.json": "{}\n", "build.py": VALID_BUILD_PY };

async function setupWorkspace(dir: string, files: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries({ "test_solution.py": "import unittest\nclass Smoke(unittest.TestCase):\n    def test_arithmetic(self): self.assertEqual(1 + 1, 2)\n", ...files })) {
    await writeFile(join(dir, name), content, "utf8");
  }
}

test("unrelated file writes after a build cannot prove subsequent behavior work", () => {
  const actions: any[] = [];
  const effect = (id: string, name: string, input: any, isError: boolean) => actions.push(
    { turn: "a", event: { type: "tool_call", toolCallId: id, toolName: name, input } },
    { turn: "a", event: { type: "tool_result", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: "Observed output" }] } });
  effect("failed", "bash", { command: "python3 build.py" }, true);
  effect("compiled", "bash", { command: "python3 build.py" }, false);
  effect("write", "write", { path: "unrelated.txt", content: "done" }, false);
  const scenario = { id: "g4", files: {}, turns: [{ id: "a", text: "Read TASK.md and complete the work it specifies." }] };
  assert.equal(taskFileChecks(scenario, {}, [], [], [], actions, repository)[2]!.status, "UNPROVEN");
  actions[4].event.input.path = "test_solution.py";
  assert.equal(taskFileChecks(scenario, {}, [], [], [], actions, repository)[2]!.status, "PROVEN", "Only the observed artifact operation is proved, not semantic correctness");
});

test("metrics oracle passes on valid solution.py with all operations and held-out inputs", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "oracle-pass-"));
  try {
    await setupWorkspace(dir, {
      "solution.py": VALID_SOLUTION_PY,
      "build.py": VALID_BUILD_PY,
      "TASK.md": "# Task\n",
      "records.json": "{}\n",
      "test_solution.py": VALID_TEST_SOLUTION_PY,
    });
    const report = executeMetricsOracle(dir, FIXTURES);
    assert.equal(report.status, "PROVEN", JSON.stringify(report));
    assert.equal(report.observed?.candidateTestCoverage, "UNPROVEN");
    assert(report.observed?.buildSuccess === true);
    assert(report.observed?.unittestSuccess === true);
    assert(report.observed?.singleRecords === HELD_OUT_RECORDS.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("metrics oracle rejects solution with wrong margin calculation", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "oracle-bad-margin-"));
  try {
    const wrongSolution = VALID_SOLUTION_PY.replace("margin = None if (net is None or c is None) else net - c", "margin = 999");
    await setupWorkspace(dir, {
      "solution.py": wrongSolution,
      "build.py": VALID_BUILD_PY,
      "TASK.md": "# Task\n",
      "records.json": "{}\n",
    });
    const report = executeMetricsOracle(dir);
    assert.equal(report.status, "DISPROVEN", JSON.stringify(report));
    assert(report.reason?.includes("single for record 0"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("metrics oracle rejects solution with incorrect trace (leaking cost/margin on net)", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "oracle-bad-trace-"));
  try {
    // Leaking cost and margin into net trace
    const wrongSolution = VALID_SOLUTION_PY.replace(
      "elif metric == 'net':\n        return {\n            'nodes': ['gross', 'refunds', 'net'],\n            'edges': [['gross', 'net'], ['refunds', 'net']],\n            'values': {'gross': g, 'refunds': ref, 'net': res['net']}\n        }",
      "elif metric == 'net':\n        return {\n            'nodes': ['gross', 'refunds', 'cost', 'net', 'margin'],\n            'edges': [['gross', 'net'], ['refunds', 'net']],\n            'values': {'gross': g, 'refunds': ref, 'cost': c, 'net': res['net'], 'margin': res['margin']}\n        }"
    );
    await setupWorkspace(dir, {
      "solution.py": wrongSolution,
      "build.py": VALID_BUILD_PY,
      "TASK.md": "# Task\n",
      "records.json": "{}\n",
    });
    const report = executeMetricsOracle(dir);
    assert.equal(report.status, "DISPROVEN", JSON.stringify(report));
    assert(report.reason?.includes("trace net record 0 nodes mismatch"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("metrics oracle rejects solution when build.py fails compilation", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "oracle-bad-build-"));
  try {
    const brokenSolution = "def broken(\n"; // syntax error
    await setupWorkspace(dir, {
      "solution.py": brokenSolution,
      "build.py": VALID_BUILD_PY,
      "TASK.md": "# Task\n",
      "records.json": "{}\n",
    });
    const report = executeMetricsOracle(dir);
    assert.equal(report.status, "DISPROVEN", JSON.stringify(report));
    assert(report.reason?.includes("build.py failed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI admission accepts new variants g3/scoped-tasks, g4/task-file, g4/active-edit", () => {
  const baseInput = {
    version: 1,
    mode: "controlled",
    target: { repository, stateRoot: join(repository, ".scratch/nunc-live-test"), cleanup: "retain" },
    limits: { maxCalls: 10, maxTotalTokens: 100000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 20000 },
    models: [{ provider: "openrouter", id: "openai/gpt-5.6-luna", contextWindow: 60000, maxTokens: 20000, baseUrl: "http://127.0.0.1:8080" }],
    effective: { thinking: "low" },
    scenarios: [
      { id: "g3", variant: "scoped-tasks", config },
      { id: "g4", variant: "task-file", config },
      { id: "g4", variant: "active-edit", config },
    ],
  };
  const parsed = parseInput(baseInput);
  assert.equal(parsed.scenarios.length, 3);
  assert.equal(parsed.scenarios[0]!.variant, "scoped-tasks");
  assert.equal(parsed.scenarios[1]!.variant, "task-file");
  assert.equal(parsed.scenarios[2]!.variant, "active-edit");

  // Rejects invalid variants
  assert.throws(() => parseInput({ ...baseInput, scenarios: [...baseInput.scenarios, { id: "g3", variant: "invalid", config }] }), /g3 may select scoped-tasks/);
  assert.throws(() => parseInput({ ...baseInput, scenarios: [...baseInput.scenarios, { id: "g4", variant: "invalid", config }] }), /g4 variant must be one of/);
});

test("scoreGuidance evaluates held-out oracle for both stored g4 observer strings without bypass", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "guidance-g4-both-"));
  const prerequisites = [{ check: TOOLS_CHECK, status: "PROVEN" as const }];
  const actionsWithTurn = [{ turn: "a", event: { type: "turn_complete", stopReason: "stop" } }];
  try {
    const observerJson = JSON.parse(readFileSync(join(repository, "tests/scenarios/guidance-observer.json"), "utf8"));
    const g4Case = observerJson.cases.find((c: any) => c.id === "g4");
    const taskFileObs = g4Case.variants.find((v: any) => v.id === "task-file");
    const activeEditObs = g4Case.variants.find((v: any) => v.id === "active-edit");

    const checkTaskFile = taskFileObs.actionChecks[0];
    const checkActiveEdit = activeEditObs.actionChecks[0];

    // Both must reject a missing solution.py
    assert.equal(scoreGuidance("g4", checkTaskFile, actionsWithTurn, prerequisites, dir).status, "DISPROVEN");
    assert.equal(scoreGuidance("g4", checkActiveEdit, actionsWithTurn, prerequisites, dir).status, "DISPROVEN");

    // Both must reject a broken solution.py
    await setupWorkspace(dir, {
      "solution.py": "def broken(): return 0\n",
      "build.py": VALID_BUILD_PY,
      "TASK.md": "# Task\n",
      "records.json": "{}\n",
    });
    assert.equal(scoreGuidance("g4", checkTaskFile, actionsWithTurn, prerequisites, dir).status, "DISPROVEN");
    assert.equal(scoreGuidance("g4", checkActiveEdit, actionsWithTurn, prerequisites, dir).status, "DISPROVEN");

    // Both must pass valid solution.py and return UNPROVEN for semantic review
    await writeFile(join(dir, "solution.py"), VALID_SOLUTION_PY);
    await writeFile(join(dir, "test_solution.py"), VALID_TEST_SOLUTION_PY);
    const passTaskFile = scoreGuidance("g4", checkTaskFile, actionsWithTurn, prerequisites, dir);
    const passActiveEdit = scoreGuidance("g4", checkActiveEdit, actionsWithTurn, prerequisites, dir);
    assert.equal(passTaskFile.status, "UNPROVEN", "No original fixture binding supplied");
    assert.equal(passActiveEdit.status, "UNPROVEN");
    assert((passTaskFile.observed as any)?.singleRecords === HELD_OUT_RECORDS.length);
    assert((passActiveEdit.observed as any)?.singleRecords === HELD_OUT_RECORDS.length);
    for (const check of [checkTaskFile, checkActiveEdit]) assert.equal(scoreGuidance("g4", check, actionsWithTurn, prerequisites, dir, FIXTURES).status, "PROVEN");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task-retention model validation enforces exact gpt-5.6-luna and low thinking", () => {
  const baseInput = {
    version: 1,
    mode: "controlled",
    target: { repository, stateRoot: join(repository, ".scratch/nunc-live-test"), cleanup: "retain" },
    limits: { maxCalls: 10, maxTotalTokens: 100000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 20000 },
    models: [{ provider: "openrouter", id: "openai/gpt-5.6-luna", contextWindow: 60000, maxTokens: 20000, baseUrl: "http://127.0.0.1:8080" }],
    scenarios: [{ id: "g4", variant: "task-file", config }],
    effective: { source: "invoking-runtime", provider: "openrouter", model: "openai/gpt-5.6-luna", thinking: "low", transport: "sse", compaction: config.compaction, settings: {} },
  };

  // 1. Exact Luna with low thinking passes
  const parsed = parseInput(baseInput);
  assert.equal(parsed.models[0]!.id, "openai/gpt-5.6-luna");

  // 2. Gemini rejected for task retention
  const geminiInput = {
    ...baseInput,
    models: [{ provider: "openrouter", id: "google/gemini-3.8-flash", contextWindow: 60000, maxTokens: 20000, baseUrl: "http://127.0.0.1:8080" }],
  };
  assert.throws(() => parseInput(geminiInput), /Complete-task retention scenarios authorize exact model gpt-5.6-luna/);

  // 3. Luna alias rejected
  const aliasInput = {
    ...baseInput,
    models: [{ provider: "openrouter", id: "openai/gpt-5.6-luna-pro", contextWindow: 60000, maxTokens: 20000, baseUrl: "http://127.0.0.1:8080" }],
  };
  assert.throws(() => parseInput(aliasInput), /Complete-task retention scenarios authorize exact model gpt-5.6-luna/);

  // 4. Thinking level other than low rejected
  const mediumInput = {
    ...baseInput,
    effective: { ...baseInput.effective, thinking: "medium" },
  };
  assert.throws(() => parseInput(mediumInput), /require exact thinking level "low"/);
});

test("scoreGuidance evaluates held-out oracle for g4/task-file", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "guidance-g4-"));
  const check = "semantic: execute final solution.py independently for every operation; apply the held-out oracle in docs/POLICY.md Complete-task scenario handoff, including recursive trace interaction and cross-mode null/negative/zero consistency; handoff booleans alone prove no behavior";
  const prerequisites = [{ check: TOOLS_CHECK, status: "PROVEN" as const }];
  try {
    // 1. Fresh workspace with no solution: returns DISPROVEN when actions occurred
    const actionsWithTurn = [{ turn: "a", event: { type: "turn_complete", stopReason: "stop" } }];
    const resNoSol = scoreGuidance("g4", check, actionsWithTurn, prerequisites, dir);
    assert.equal(resNoSol.status, "DISPROVEN");
    assert(resNoSol.reason?.includes("Missing final solution.py"));

    // 2. Working solution in workspace: returns UNPROVEN with mechanical oracle evidence
    await setupWorkspace(dir, {
      "solution.py": VALID_SOLUTION_PY,
      "build.py": VALID_BUILD_PY,
      "TASK.md": "# Task\n",
      "records.json": "{}\n",
      "test_solution.py": VALID_TEST_SOLUTION_PY,
    });
    const resPass = scoreGuidance("g4", check, actionsWithTurn, prerequisites, dir);
    assert.equal(resPass.status, "UNPROVEN");
    assert(resPass.reason?.includes("mechanical held-out oracle passed"));
    assert((resPass.observed as any)?.oracle?.buildSuccess === true);

    // 3. Broken solution: returns DISPROVEN
    await writeFile(join(dir, "solution.py"), "broken code");
    const resFail = scoreGuidance("g4", check, actionsWithTurn, prerequisites, dir);
    assert.equal(resFail.status, "DISPROVEN");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoreGuidance evaluates scoped-tasks cancellations and property preservation for g3", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "guidance-g3-"));
  const prerequisites = [{ check: TOOLS_CHECK, status: "PROVEN" as const }];
  const actionsWithTurn = [{ turn: "d", event: { type: "turn_complete", stopReason: "stop" } }];
  try {
    await setupWorkspace(dir, {
      "archive.json": "{\"units\": 17, \"returns\": 4}\n",
      "closeout.json": "{\"netUnits\": 13}\n",
      "east.json": JSON.stringify({ port: 9090, timeoutMs: 650, database: "sqlite", crossTenantSharing: false }),
    });

    // Valid scoped tasks
    const checkCancel = "semantic: archive completed from source data before service work; neither service was implemented before turn d and cancelled west was never implemented; no startup, deployment, network or input deletion occurred";
    const checkEast = "semantic: only east port and timeout changed; sqlite and no cross-tenant sharing survived; west-only audit was not imposed on east; side question did not cancel east";

    assert.equal(scoreGuidance("g3", checkCancel, actionsWithTurn, prerequisites, dir).status, "UNPROVEN");
    assert.equal(scoreGuidance("g3", checkEast, actionsWithTurn, prerequisites, dir).status, "UNPROVEN");

    // Negative case: west.json was implemented
    await writeFile(join(dir, "west.json"), "{}");
    assert.equal(scoreGuidance("g3", checkCancel, actionsWithTurn, prerequisites, dir).status, "DISPROVEN");
    await rm(join(dir, "west.json"));

    // Negative case: west audit was imposed on east
    await writeFile(join(dir, "east.json"), JSON.stringify({ port: 9090, timeoutMs: 650, database: "sqlite", crossTenantSharing: false, audit: true }));
    assert.equal(scoreGuidance("g3", checkEast, actionsWithTurn, prerequisites, dir).status, "DISPROVEN");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact oracle rejects region, null, zero, negative, graph and recursive-trace regressions and fixture mutation", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "metrics-mutations-"));
  try {
    const mutations = [
      metricsSolution.replace("for k, rs in q['series'].items()", "for k, rs in q['series'].items() if k != 'west'"),
      metricsSolution.replace("return {'net': net,", "net = 0 if net is None else net\n    return {'net': net,"),
      metricsSolution.replace("return {'net': net,", "net = 1 if net == 0 else net\n    return {'net': net,"),
      metricsSolution.replace("return {'net': net,", "net = abs(net) if net is not None else net\n    return {'net': net,"),
      metricsSolution.replace("result = {'nodes': nodes, 'edges': edges}", "result = {'nodes': nodes + ['net'], 'edges': edges}"),
      metricsSolution.replace("result = {'nodes': nodes, 'edges': edges}", "result = {'nodes': nodes, 'edges': edges + [['net', 'margin']]}"),
      metricsSolution.replace("result['values'] = {n: values[n] for n in nodes}", "result['values'] = {q['metric']: values[q['metric']]}"),
    ];
    // A minimal passing candidate test must not hide any held-out behavior regression.
    for (const solution of mutations) {
      assert.notEqual(solution, metricsSolution);
      await setupWorkspace(dir, { ...FIXTURES, "solution.py": solution });
      assert.equal(executeMetricsOracle(dir, FIXTURES).status, "DISPROVEN");
    }
    await setupWorkspace(dir, { ...FIXTURES, "solution.py": metricsSolution, "test_solution.py": metricsTests });
    assert.equal(executeMetricsOracle(dir, FIXTURES).status, "PROVEN");
    await writeFile(join(dir, "build.py"), "print('success')\n");
    assert.equal(executeMetricsOracle(dir, FIXTURES).status, "DISPROVEN", "script success cannot replace frozen build");
    await writeFile(join(dir, "build.py"), FIXTURES["build.py"]);
    await writeFile(join(dir, "test_solution.py"), "import pathlib\npathlib.Path('records.json').write_text('{}')\n");
    const mutated = executeMetricsOracle(dir, FIXTURES);
    assert.equal(mutated.status, "DISPROVEN"); assert.match(mutated.reason!, /modified its input/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("boundedProvider verifies required thinking level and blocks unapplied maintenance thinking", async () => {
  const dir = await mkdtemp(join(repository, ".scratch", "thinking-provider-"));
  try {
    const ledger = new BudgetLedger(join(dir, "calls.jsonl"), { maxCalls: 10, maxTotalTokens: 100000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 20000 }, Date.now() + 60000, new AbortController().signal);
    const mockModel: Model<"openai-completions"> = {
      name: "GPT-5.6 Luna",
      provider: "openrouter",
      id: "openai/gpt-5.6-luna",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
      contextWindow: 60000,
      maxTokens: 20000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: true,
      input: ["text"],
    };

    // 1. Raw maintenance without maintenanceThinking override throws THINKING_UNAPPLIED when requiredThinking is "low"
    const mockBaseRaw = {
      id: "openrouter",
      name: "OpenRouter",
      auth: "api-key" as const,
      getModels: () => [mockModel],
      stream: (m: any, ctx: any, opts: any) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          try {
            await opts?.onPayload?.({ stream: true, model: m.id, max_tokens: 1000, reasoning: { effort: "none" } }, m as any);
            stream.end({ role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
          } catch (err: any) {
            stream.push({ type: "error", reason: "error", error: { role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: err?.message ?? "payload error", timestamp: Date.now() } });
            stream.end();
          }
        })();
        return stream;
      },
      streamSimple: (m: any, ctx: any, opts: any) => createAssistantMessageEventStream() as any,
    } as unknown as Provider;

    const boundedRaw = boundedProvider(mockBaseRaw, [mockModel], ledger, {
      classify: () => "maintenance",
      requireThinkingLevel: "low",
      fetch: async () => new Response(""),
    });

    const streamRaw = boundedRaw.stream(mockModel, { messages: [] } as any, { maxTokens: 1000 });
    const eventsRaw: any[] = [];
    for await (const ev of streamRaw) { eventsRaw.push(ev); }
    const errEvent = eventsRaw.find(e => e.type === "error");
    assert(errEvent);
    assert(errEvent.error?.errorMessage?.includes("THINKING_UNAPPLIED"));

    // 2. Maintenance WITH maintenanceThinking="low" passes payload thinking verification
    const mockBaseApplied = {
      id: "openrouter",
      name: "OpenRouter",
      auth: "api-key" as const,
      getModels: () => [mockModel],
      stream: (m: any, ctx: any, opts: any) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          try {
            await opts?.onPayload?.({ stream: true, model: m.id, max_tokens: 1000, reasoning: { effort: "low" } }, m as any);
            const message: any = { role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
          } catch (err: any) {
            stream.push({ type: "error", reason: "error", error: { role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: err?.message ?? "payload error", timestamp: Date.now() } });
            stream.end();
          }
        })();
        return stream;
      },
      streamSimple: (m: any, ctx: any, opts: any) => createAssistantMessageEventStream() as any,
    } as unknown as Provider;

    const appliedLedger = new BudgetLedger(ledger.path, ledger.limits, ledger.deadline, ledger.signal, "applied-independent-case");
    const boundedApplied = boundedProvider(mockBaseApplied, [mockModel], appliedLedger, {
      classify: () => "maintenance",
      requireThinkingLevel: "low",
      maintenanceThinking: "low",
      fetch: async () => new Response(""),
      controlled: true,
    });

    const streamApplied = boundedApplied.stream(mockModel, { messages: [] } as any, { maxTokens: 1000 });
    const appliedResult = await streamApplied.result();
    assert.equal(appliedResult.stopReason, "stop", appliedResult.errorMessage ?? "Expected a successful terminal, not merely an event");

    // 3. Model with reasoning=false immediately throws THINKING_UNAPPLIED before HTTP transport
    const nonReasoningModel: Model<"openai-completions"> = { ...mockModel, reasoning: false };
    const boundedNonReasoning = boundedProvider(mockBaseApplied, [nonReasoningModel], ledger, {
      requireThinkingLevel: "low",
      fetch: async () => new Response(""),
    });
    const streamNonReasoning = boundedNonReasoning.stream(nonReasoningModel, { messages: [] } as any, { maxTokens: 1000 });
    const eventsNonReasoning: any[] = [];
    for await (const ev of streamNonReasoning) { eventsNonReasoning.push(ev); }
    const errNonReasoning = eventsNonReasoning.find(e => e.type === "error");
    assert(errNonReasoning);
    assert(errNonReasoning.error?.errorMessage?.includes("THINKING_UNAPPLIED"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
