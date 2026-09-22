import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeMetricsOracle, HELD_OUT_RECORDS } from "../../src/live/metrics-oracle.js";
import { parseInput, type Selection } from "../../src/live/contract.js";
import { scoreGuidance, TOOLS_CHECK } from "../../src/live/guidance.js";
import { repository } from "./fixtures.js";
import { boundedProvider, BudgetLedger } from "../../src/live/budget.js";
import { createAssistantMessageEventStream, type Model, type Context, type Api, type Provider } from "@earendil-works/pi-ai";
import { resolveInput } from "../../src/live/defaults.js";

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

const VALID_TEST_SOLUTION_PY = `
import unittest, json, sys
from solution import calc_single

class SolutionTest(unittest.TestCase):
    def test_regions_and_edges(self):
        # north, south, west regions
        for region in ['north', 'south', 'west']:
            self.assertTrue(len(region) > 0)
        self.assertEqual(calc_single({'gross': 10, 'refunds': 3, 'cost': 5}), {'net': 7, 'margin': 2})
        self.assertEqual(calc_single({'gross': None, 'refunds': 3, 'cost': 5}), {'net': None, 'margin': None})
        self.assertEqual(calc_single({'gross': 0, 'refunds': 0, 'cost': 0}), {'net': 0, 'margin': 0})
        self.assertEqual(calc_single({'gross': -4, 'refunds': 2, 'cost': 3}), {'net': -6, 'margin': -9})

if __name__ == '__main__':
    unittest.main()
`;

async function setupWorkspace(dir: string, files: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
}

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
    const report = executeMetricsOracle(dir);
    assert.equal(report.status, "PROVEN", JSON.stringify(report));
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
  assert.throws(() => parseInput({ ...baseInput, scenarios: [{ id: "g3", variant: "invalid", config }] }), /g3 may select scoped-tasks/);
  assert.throws(() => parseInput({ ...baseInput, scenarios: [{ id: "g4", variant: "invalid", config }] }), /g4 may select task-file or active-edit/);
});

test("model validation admits gpt-5.6-luna and blocks Astra for guidance scenarios", () => {
  const baseInput = {
    version: 1,
    mode: "controlled",
    target: { repository, stateRoot: join(repository, ".scratch/nunc-live-test"), cleanup: "retain" },
    limits: { maxCalls: 10, maxTotalTokens: 100000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 20000 },
    models: [{ provider: "openrouter", id: "openai/gpt-5.6-luna", contextWindow: 60000, maxTokens: 20000, baseUrl: "http://127.0.0.1:8080" }],
    scenarios: [{ id: "g4", variant: "task-file", config }],
  };
  // Valid Luna model
  const parsed = parseInput(baseInput);
  assert.equal(parsed.models[0]!.id, "openai/gpt-5.6-luna");

  // Forbidden Astra model
  const astraInput = {
    ...baseInput,
    models: [{ provider: "openrouter", id: "gpt-6-astra", contextWindow: 60000, maxTokens: 20000, baseUrl: "http://127.0.0.1:8080" }],
  };
  assert.throws(() => parseInput(astraInput), /Astra is forbidden/);
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

    const boundedApplied = boundedProvider(mockBaseApplied, [mockModel], ledger, {
      classify: () => "maintenance",
      requireThinkingLevel: "low",
      maintenanceThinking: "low",
      fetch: async () => new Response(""),
      controlled: true,
    });

    const streamApplied = boundedApplied.stream(mockModel, { messages: [] } as any, { maxTokens: 1000 });
    let appliedEvents = 0;
    for await (const _ of streamApplied) { appliedEvents++; }
    assert(appliedEvents > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
