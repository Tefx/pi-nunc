import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { repository } from "./fixtures.js";
import { loadScenario, type ScenarioInput } from "../../src/live/scenarios.js";
import { sameTaskHistoryChecks, sameTaskHistoryEffects, deriveExpectedRecords, taskRead } from "../../src/live/task-retention.js";
import { diagnosePreparationFeasibility } from "../../src/live/preparation.js";
import { parseInput, type RunInput } from "../../src/live/contract.js";
import { runSegment } from "../../src/live/worker.js";
import { metricsSolution } from "./metrics-fixture.js";
import { readLedger, ledgerSummary } from "../../src/live/budget.js";

const config = { compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 1200 }, extraction: { outputTokens: 2048 } } };

// Candidate regression tests that directly consume and verify records.json dataset
const candidateTests = `import unittest, json
from solution import run

class Regression(unittest.TestCase):
    def test_modes(self):
        series = {'north': [{'gross': 0, 'refunds': 0, 'cost': 0}],
                  'south': [{'gross': None, 'refunds': 1, 'cost': 2}],
                  'west': [{'gross': -2, 'refunds': 3, 'cost': 4}]}
        history = run({'op': 'history', 'series': series})
        self.assertEqual(set(history), set(series))
        expected = {'north': [{'net': 0, 'margin': 0}], 'south': [{'net': None, 'margin': None}], 'west': [{'net': -5, 'margin': -9}]}
        self.assertEqual(history, expected)
        for name, records in series.items():
            batch = run({'op': 'batch', 'records': records})
            self.assertEqual(batch, history[name])
            self.assertEqual(batch, [run({'op': 'single', 'record': r}) for r in records])

    def test_dataset(self):
        with open('records.json') as f:
            records = json.load(f)
        history = run({'op': 'history', 'series': records})
        for region in ['north', 'south', 'west']:
            self.assertEqual(len(history[region]), len(records[region]))
            for rec, res in zip(records[region], history[region]):
                self.assertEqual(res, run({'op': 'single', 'record': rec}))
`;

function makeValidActions(scenario: ScenarioInput) {
  const actions: any[] = [];
  const expectedRecords = deriveExpectedRecords(scenario);
  const recordsJson = JSON.stringify(expectedRecords, null, 2);

  const effect = (turn: string, id: string, name: string, input: any, isError: boolean, resultText: string) => {
    actions.push(
      { turn, event: { type: "tool_call", toolCallId: id, toolName: name, input } },
      { turn, event: { type: "tool_result", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: resultText }] } }
    );
  };

  // Turn setup: read schema and all 3 regional inputs, then write records.json
  effect("setup", "c1", "read", { path: "schema/records.schema.json" }, false, scenario.files["schema/records.schema.json"]!);
  effect("setup", "c2", "read", { path: "inputs/north.json" }, false, scenario.files["inputs/north.json"]!);
  effect("setup", "c3", "read", { path: "inputs/south.json" }, false, scenario.files["inputs/south.json"]!);
  effect("setup", "c4", "read", { path: "inputs/west.json" }, false, scenario.files["inputs/west.json"]!);
  effect("setup", "c5", "write", { path: "records.json", content: recordsJson }, false, "Wrote records.json");
  actions.push({ turn: "setup", event: { type: "turn_complete", stopReason: "stop" } });

  // Turn preflight: validate records.json via script execution
  effect("preflight", "c6", "bash", { command: "python3 scripts/validate_records.py" }, false, "Validation succeeded: 46 total cleared records from regional inputs verified in records.json.");
  actions.push({ turn: "preflight", event: { type: "turn_complete", stopReason: "stop" } });

  // Turn task: read TASK.md, build failure, edit solution, build success, write solution, write test, tests, handoff
  effect("task", "c7", "read", { path: "TASK.md" }, false, scenario.files["TASK.md"]!);
  effect("task", "c8", "bash", { command: "python3 build.py" }, true, "SyntaxError: invalid syntax");
  effect("task", "c9", "edit", { path: "solution.py", oldText: "def evaluate(record)", newText: "def evaluate(record):" }, false, "Edited solution.py");
  effect("task", "c10", "bash", { command: "python3 build.py" }, false, "Compilation succeeded");
  effect("task", "c11", "write", { path: "solution.py", content: metricsSolution }, false, "Wrote solution.py");
  effect("task", "c12", "write", { path: "test_solution.py", content: candidateTests }, false, "Wrote test_solution.py");
  effect("task", "c13", "bash", { command: "python3 build.py" }, false, "Compilation succeeded");
  effect("task", "c14", "bash", { command: "python3 -m unittest test_solution.py" }, false, "OK");
  effect("task", "c15", "write", { path: "handoff.json", content: JSON.stringify({ implemented: true, verified: true, complete: true, remaining: [], commands: ["python3 build.py", "python3 -m unittest test_solution.py"] }) }, false, "Wrote handoff.json");
  actions.push({ turn: "task", event: { type: "turn_complete", stopReason: "stop" } });

  return actions;
}

test("deriveExpectedRecords extracts all cleared records and filters void transactions from raw feeds", async () => {
  const { input: scenario } = await loadScenario(repository, { id: "g4", variant: "same-task-history", config });
  const derived = deriveExpectedRecords(scenario);

  assert.equal(derived.north.length, 16, "North must have 16 cleared records");
  assert.equal(derived.south.length, 14, "South must have 14 cleared records");
  assert.equal(derived.west.length, 16, "West must have 16 cleared records");

  // First 2 records of each region match the exact edge-case conditions
  assert.deepEqual(derived.north[0], { gross: 10, refunds: 3, cost: 9 });
  assert.deepEqual(derived.north[1], { gross: 0, refunds: 0, cost: 0 });
  assert.deepEqual(derived.south[0], { gross: null, refunds: 2, cost: 1 });
  assert.deepEqual(derived.west[0], { gross: -2, refunds: 1, cost: 4 });
  assert.deepEqual(derived.west[1], { gross: 8, refunds: null, cost: 0 });

  // Void records are strictly excluded
  assert(!derived.north.some(r => r.gross === 100 && r.cost === 50));
  assert(!derived.south.some(r => r.gross === 999));
  assert(!derived.west.some(r => r.gross === 500));
});

test("CLI admission accepts new variant g4/same-task-history and rejects invalid variants", () => {
  const baseInput = {
    version: 1,
    mode: "controlled",
    target: { repository, stateRoot: join(repository, ".scratch/nunc-live-test"), cleanup: "retain" },
    limits: { maxCalls: 10, maxTotalTokens: 100000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 20000 },
    models: [{ provider: "openrouter", id: "openai/gpt-5.6-luna", contextWindow: 60000, maxTokens: 20000, baseUrl: "http://127.0.0.1:8080" }],
    effective: { thinking: "low" },
    scenarios: [
      { id: "g4", variant: "same-task-history", config },
    ],
  };
  const parsed = parseInput(baseInput);
  assert.equal(parsed.scenarios.length, 1);
  assert.equal(parsed.scenarios[0]!.variant, "same-task-history");

  assert.throws(() => parseInput({ ...baseInput, scenarios: [...baseInput.scenarios, { id: "g4", variant: "unknown-history", config }] }), /g4 variant must be one of/);
});

test("sameTaskHistoryEffects verifies complete preliminary ingestion and rejects negative deviations", async () => {
  const { input: scenario } = await loadScenario(repository, { id: "g4", variant: "same-task-history", config });
  const validActions = makeValidActions(scenario);

  // 1. Valid actions pass
  const pass = sameTaskHistoryEffects(scenario, validActions, repository);
  assert.equal(pass.status, "PROVEN", JSON.stringify(pass));

  // 2. Negative: read-only validation (only read records.json, no script execution)
  const readOnlyVal = structuredClone(validActions);
  const scriptCall = readOnlyVal.find(a => a.event?.toolCallId === "c6");
  scriptCall.event = { type: "tool_call", toolCallId: "c6", toolName: "read", input: { path: "records.json" } };
  const scriptRes = readOnlyVal.find(a => a.event?.type === "tool_result" && a.event.toolCallId === "c6");
  scriptRes.event = { type: "tool_result", toolCallId: "c6", toolName: "read", isError: false, content: [{ type: "text", text: "{}" }] };
  assert.equal(sameTaskHistoryEffects(scenario, readOnlyVal, repository).status, "UNPROVEN", "File read alone cannot establish validation");

  // 3. Negative: failed validation script (isError: true)
  const failedVal = structuredClone(validActions);
  const valRes = failedVal.find(a => a.event?.type === "tool_result" && a.event.toolCallId === "c6");
  valRes.event.isError = true;
  assert.equal(sameTaskHistoryEffects(scenario, failedVal, repository).status, "UNPROVEN");

  // 4. Negative: post-validation mutation (records.json written after validation script ran)
  const postMutation = structuredClone(validActions);
  const preflightIdx = postMutation.findIndex(a => a.event?.toolCallId === "c6");
  postMutation.splice(preflightIdx + 2, 0,
    { turn: "preflight", event: { type: "tool_call", toolCallId: "late-write", toolName: "write", input: { path: "records.json", content: "{}" } } },
    { turn: "preflight", event: { type: "tool_result", toolCallId: "late-write", toolName: "write", isError: false, content: [{ type: "text", text: "ok" }] } }
  );
  assert.equal(sameTaskHistoryEffects(scenario, postMutation, repository).status, "UNPROVEN", "Post-validation mutation must fail");

  // 5. Negative: validation script was tampered with
  const tamperedScript = structuredClone(validActions);
  tamperedScript.splice(1, 0,
    { turn: "setup", event: { type: "tool_call", toolCallId: "edit-script", toolName: "edit", input: { path: "scripts/validate_records.py", oldText: "fail", newText: "pass" } } },
    { turn: "setup", event: { type: "tool_result", toolCallId: "edit-script", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] } }
  );
  assert.equal(sameTaskHistoryEffects(scenario, tamperedScript, repository).status, "UNPROVEN", "Tampered validation script must fail");

  // 6. Negative: missing read of inputs/west.json
  const missingWest = validActions.filter(a => a.event?.toolCallId !== "c4");
  assert.equal(sameTaskHistoryEffects(scenario, missingWest, repository).status, "UNPROVEN");

  // 7. Negative: incomplete read of north
  const incompleteRead = structuredClone(validActions);
  const c2Res = incompleteRead.find(a => a.event?.type === "tool_result" && a.event.toolCallId === "c2");
  c2Res.event.content[0].text = "truncated partial content";
  assert.equal(sameTaskHistoryEffects(scenario, incompleteRead, repository).status, "UNPROVEN");

  // 8. Negative: premature read of TASK.md during setup
  const prematureRead = structuredClone(validActions);
  const taskCall = prematureRead.find(a => a.event?.toolCallId === "c7");
  taskCall.turn = "setup";
  assert.equal(sameTaskHistoryEffects(scenario, prematureRead, repository).status, "UNPROVEN");

  // 9. Positive: editing records using edit event with readBack verifies correctly
  const editActions = structuredClone(validActions);
  const writeIdx = editActions.findIndex(a => a.event?.toolCallId === "c5");
  const expectedRecords = deriveExpectedRecords(scenario);
  editActions[writeIdx] = { turn: "setup", event: { type: "tool_call", toolCallId: "c5", toolName: "edit", input: { path: "records.json", oldText: "old", newText: "new" } } };
  editActions[writeIdx + 1] = { turn: "setup", event: { type: "tool_result", toolCallId: "c5", toolName: "edit", isError: false, content: [{ type: "text", text: "Edited records.json" }] } };
  editActions.splice(writeIdx + 2, 0,
    { turn: "setup", event: { type: "tool_call", toolCallId: "read-back", toolName: "read", input: { path: "records.json" } } },
    { turn: "setup", event: { type: "tool_result", toolCallId: "read-back", toolName: "read", isError: false, content: [{ type: "text", text: JSON.stringify(expectedRecords) }] } }
  );
  assert.equal(sameTaskHistoryEffects(scenario, editActions, repository).status, "PROVEN");
});

test("sameTaskHistoryChecks verifies 3-compaction series, first read in K, and rejects corruptions", async () => {
  const { input: scenario } = await loadScenario(repository, { id: "g4", variant: "same-task-history", config });
  const actions = makeValidActions(scenario);
  const expectedRecords = deriveExpectedRecords(scenario);

  const branch: any[] = [
    { id: "u-setup", parentId: null, type: "message", message: { role: "user", content: scenario.turns[0]!.text, timestamp: 1 }, timestamp: "1" },
    { id: "a-setup", parentId: "u-setup", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c5", name: "write", arguments: { path: "records.json", content: JSON.stringify(expectedRecords) } }], timestamp: 2, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "2" },
    { id: "r-setup", parentId: "a-setup", type: "message", message: { role: "toolResult", toolCallId: "c5", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 }, timestamp: "3" },
    { id: "u-pre", parentId: "r-setup", type: "message", message: { role: "user", content: scenario.turns[1]!.text, timestamp: 4 }, timestamp: "4" },
    { id: "a-pre", parentId: "u-pre", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c6", name: "bash", arguments: { command: "python3 scripts/validate_records.py" } }], timestamp: 5, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "5" },
    { id: "r-pre", parentId: "a-pre", type: "message", message: { role: "toolResult", toolCallId: "c6", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 6 }, timestamp: "6" },
    { id: "u-task", parentId: "r-pre", type: "message", message: { role: "user", content: scenario.turns[2]!.text, timestamp: 7 }, timestamp: "7" },
    { id: "a-task-read", parentId: "u-task", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c7", name: "read", arguments: { path: "TASK.md" } }], timestamp: 8, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "8" },
    { id: "r-task-read", parentId: "a-task-read", type: "message", message: { role: "toolResult", toolCallId: "c7", toolName: "read", content: [{ type: "text", text: scenario.files["TASK.md"]! }], isError: false, timestamp: 9 }, timestamp: "9" },
    { id: "a-sol", parentId: "r-task-read", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c11", name: "write", arguments: { path: "solution.py", content: metricsSolution } }], timestamp: 10, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "10" },
    { id: "r-sol", parentId: "a-sol", type: "message", message: { role: "toolResult", toolCallId: "c11", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 11 }, timestamp: "11" },
    { id: "a-test", parentId: "r-sol", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c12", name: "write", arguments: { path: "test_solution.py", content: candidateTests } }], timestamp: 12, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "12" },
    { id: "r-test", parentId: "a-test", type: "message", message: { role: "toolResult", toolCallId: "c12", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 13 }, timestamp: "13" },
  ];

  const snap1 = { id: "snap1", parentId: "r-task-read", type: "compaction" as const, firstKeptEntryId: "a-task-read", timestamp: "14", fromHook: true, summary: "snap1", tokensBefore: 1000 };
  const snap2 = { id: "snap2", parentId: "r-sol", type: "compaction" as const, firstKeptEntryId: "a-sol", timestamp: "15", fromHook: true, summary: "snap2", tokensBefore: 2000 };
  const snap3 = { id: "snap3", parentId: "r-test", type: "compaction" as const, firstKeptEntryId: "a-test", timestamp: "16", fromHook: true, summary: "snap3", tokensBefore: 3000 };

  const fullBranch: any[] = [...branch, snap1, snap2, snap3];

  const mem1 = [{ id: "m1", text: "Task requirements in memory" }];
  const rollovers: any[] = [
    {
      snapshot: snap1, active: branch.slice(0, 9), branch: branch.slice(0, 9), association: { status: "resolved" },
      rebuilt: [snap1, ...branch.slice(7, 9)], continuationCallId: "req1", callIds: ["m-call-1"]
    },
    {
      snapshot: snap2, active: [snap1, ...branch.slice(7, 11)], branch: [snap1, ...branch.slice(7, 11)], association: { status: "resolved" },
      rebuilt: [snap2, ...branch.slice(9, 11)], continuationCallId: "req2", callIds: ["m-call-2"]
    },
    {
      snapshot: snap3, active: [snap2, ...branch.slice(9, 13)], branch: [snap2, ...branch.slice(9, 13)], association: { status: "resolved" },
      rebuilt: [snap3, ...branch.slice(11, 13)], continuationCallId: "req3", callIds: ["m-call-3"]
    }
  ];

  const requests: any[] = [
    { callId: "req1", kind: "main", context: { messages: branch.slice(7, 9).map(e => e.message) } },
    { callId: "req2", kind: "main", context: { messages: [ { role: "system", content: "Nunc working memory: [m1]" }, ...branch.slice(9, 11).map(e => e.message) ] } },
    { callId: "m-call-3", kind: "maintenance", context: { messages: [ { role: "system", content: JSON.stringify({ F: "frozen", M: mem1, B: [], K: [] }) } ] } },
    { callId: "req3", kind: "main", context: { messages: [ { role: "system", content: "Nunc working memory: [m1]" }, ...branch.slice(11, 13).map(e => e.message) ] } },
  ];

  const turns = { setup: ["u-setup", "a-setup", "r-setup"], preflight: ["u-pre", "a-pre", "r-pre"], task: ["u-task", "a-task-read", "r-task-read", "a-sol", "r-sol", "a-test", "r-test"] };

  const checks = sameTaskHistoryChecks(scenario, turns, fullBranch, branch, rollovers, actions, repository, requests);
  assert.equal(checks[0]!.status, "PROVEN", "Requirements entered through designated request & read following setup");
  assert.equal(checks[1]!.status, "PROVEN", "Preliminary effects verified");
  assert.equal(checks[3]!.status, "PROVEN", "Observed build failure and repair");
  assert.equal(checks[4]!.status, "UNPROVEN", "Input/oracle separation is semantic");

  // Negative: first compaction retired read instead of keeping in K
  const badRollovers1 = structuredClone(rollovers);
  badRollovers1[0].snapshot.firstKeptEntryId = "a-sol";
  const checksBad1 = sameTaskHistoryChecks(scenario, turns, fullBranch, branch, badRollovers1, actions, repository, requests);
  assert.equal(checksBad1[2]!.status, "UNPROVEN");

  // Negative: premature read in setup violates check 0
  const badActions = structuredClone(actions);
  const taskReadAct = badActions.find(a => a.event?.toolCallId === "c7");
  taskReadAct.turn = "setup";
  const checksBadRead = sameTaskHistoryChecks(scenario, turns, fullBranch, branch, rollovers, badActions, repository, requests);
  assert.equal(checksBadRead[0]!.status, "UNPROVEN");
});

test("diagnosePreparationFeasibility delegates to actual prepareBoundary and correctly assesses feasibility", async () => {
  const { input: scenario } = await loadScenario(repository, { id: "g4", variant: "same-task-history", config });
  const model: Model<Api> = { id: "openai/gpt-5.6-luna", name: "Luna", provider: "openrouter", api: "openai-completions", baseUrl: "http://localhost:8080", reasoning: true, input: ["text"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const fixed = { systemPrompt: "Carry out the user's tasks using the available file tools.", tools: [] };

  // 1. Negative: Sole-user-request short history (B = 12 tokens, H = 1775, F = 1855, cannot pay suffix / fixed overhead)
  const shortBranch: SessionEntry[] = [
    { id: "e0", parentId: null, type: "message", message: { role: "user", content: "Read TASK.md and complete the work it specifies.", timestamp: 1 }, timestamp: "1" },
    { id: "e1", parentId: "e0", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call_task", name: "read", arguments: { path: "TASK.md" } }], timestamp: 2, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "2" },
    { id: "e2", parentId: "e1", type: "message", message: { role: "toolResult", toolCallId: "call_task", toolName: "read", content: [{ type: "text", text: scenario.files["TASK.md"]! }], isError: false, timestamp: 3 }, timestamp: "3" },
  ] as any;
  const shortControl = {
    duringTurn: "a",
    action: "rollover_at_tool_boundary" as const,
    trigger: { occurrence: 1, pathArgument: "TASK.md", toolName: "read", when: "after_result_before_continuation" as const },
    placement: { retireRequestOfTurn: "a", retainToolExchange: { occurrence: 1, pathArgument: "TASK.md", toolName: "read", turn: "a" } }
  };
  const shortDiag = await diagnosePreparationFeasibility({
    branch: shortBranch,
    control: shortControl,
    turns: { a: ["e0", "e1", "e2"] },
    turnOrder: ["a"],
    config,
    model,
    fixed,
    repository,
    trigger: { callId: "call_task", requestText: "Read TASK.md and complete the work it specifies.", path: "TASK.md", cwd: "/task", fixtureContent: scenario.files["TASK.md"]!, contextTokens: 1776 }
  });
  assert.equal(shortDiag.feasible, false);
  assert.equal(shortDiag.status, "INSUFFICIENT_PREFIX");
  assert.match(shortDiag.explanation, /cannot pay fixed\/memory\/growth costs/);

  // 2. Negative: Invalid turn mapping fails feasibility directly
  const badMappingDiag = await diagnosePreparationFeasibility({
    branch: shortBranch,
    control: shortControl,
    turns: {},
    turnOrder: ["a"],
    config,
    model,
    fixed,
    repository,
    trigger: { callId: "call_task", requestText: "Read TASK.md and complete the work it specifies.", path: "TASK.md", cwd: "/task", fixtureContent: scenario.files["TASK.md"]!, contextTokens: 1776 }
  });
  assert.equal(badMappingDiag.feasible, false);

  // 3. Negative: Incomplete sibling tool batch fails feasibility directly
  const incompleteSiblingBranch: any[] = [
    { id: "s0", parentId: null, type: "message", message: { role: "user", content: "Read TASK.md and complete the work it specifies.", timestamp: 1 }, timestamp: "1" },
    { id: "s1", parentId: "s0", type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "call_task", name: "read", arguments: { path: "TASK.md" } },
      { type: "toolCall", id: "call_other", name: "read", arguments: { path: "other.md" } }
    ], timestamp: 2, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "2" },
    { id: "s2", parentId: "s1", type: "message", message: { role: "toolResult", toolCallId: "call_task", toolName: "read", content: [{ type: "text", text: scenario.files["TASK.md"]! }], isError: false, timestamp: 3 }, timestamp: "3" },
  ];
  const siblingDiag = await diagnosePreparationFeasibility({
    branch: incompleteSiblingBranch,
    control: shortControl,
    turns: { a: ["s0", "s1", "s2"] },
    turnOrder: ["a"],
    config,
    model,
    fixed,
    repository,
    trigger: { callId: "call_task", requestText: "Read TASK.md and complete the work it specifies.", path: "TASK.md", cwd: "/task", fixtureContent: scenario.files["TASK.md"]!, contextTokens: 5000 }
  });
  assert.equal(siblingDiag.feasible, false);
  assert.match(siblingDiag.explanation, /Incomplete persisted sibling tool batch/);

  // 4. Positive: Multi-turn same-task-history with genuine prefix (B >= 2500 tokens)
  const prefixText = "x".repeat(12000); // 12000 chars ~ 3000 tokens of preliminary ingest reads
  const longBranch: SessionEntry[] = [
    { id: "e-u1", parentId: null, type: "message", message: { role: "user", content: scenario.turns[0]!.text, timestamp: 1 }, timestamp: "1" },
    { id: "e-a1", parentId: "e-u1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call_ingest", name: "read", arguments: { path: "inputs/north.json" } }], timestamp: 2, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "2" },
    { id: "e-r1", parentId: "e-a1", type: "message", message: { role: "toolResult", toolCallId: "call_ingest", toolName: "read", content: [{ type: "text", text: prefixText }], isError: false, timestamp: 3 }, timestamp: "3" },
    { id: "e-u2", parentId: "e-r1", type: "message", message: { role: "user", content: scenario.turns[1]!.text, timestamp: 4 }, timestamp: "4" },
    { id: "e-u3", parentId: "e-u2", type: "message", message: { role: "user", content: scenario.turns[2]!.text, timestamp: 5 }, timestamp: "5" },
    { id: "e-a3", parentId: "e-u3", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call_task3", name: "read", arguments: { path: "TASK.md" } }], timestamp: 6, api: "openai-completions", provider: "openrouter", model: "openai/gpt-5.6-luna", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "toolUse" }, timestamp: "6" },
    { id: "e-r3", parentId: "e-a3", type: "message", message: { role: "toolResult", toolCallId: "call_task3", toolName: "read", content: [{ type: "text", text: scenario.files["TASK.md"]! }], isError: false, timestamp: 7 }, timestamp: "7" },
  ] as any;
  const longControl = {
    duringTurn: "task",
    action: "rollover_at_tool_boundary" as const,
    trigger: { occurrence: 1, pathArgument: "TASK.md", toolName: "read", when: "after_result_before_continuation" as const },
    placement: { retireThroughTurn: "preflight", retireRequestOfTurn: "task", retainToolExchange: { occurrence: 1, pathArgument: "TASK.md", toolName: "read", turn: "task" } }
  };
  const longDiag = await diagnosePreparationFeasibility({
    branch: longBranch,
    control: longControl,
    turns: { setup: ["e-u1", "e-a1", "e-r1"], preflight: ["e-u2"], task: ["e-u3", "e-a3", "e-r3"] },
    turnOrder: ["setup", "preflight", "task"],
    config,
    model,
    fixed,
    repository,
    trigger: { callId: "call_task3", requestText: scenario.turns[2]!.text, path: "TASK.md", cwd: "/task", fixtureContent: scenario.files["TASK.md"]!, contextTokens: 6000 }
  });
  assert.equal(longDiag.feasible, true);
  assert.equal(longDiag.status, "FEASIBLE");
  assert.equal(longDiag.firstKeptEntryId, "e-a3");
  assert(longDiag.retiringPrefixTokens! > 2000, `Retiring prefix must be substantial, got ${longDiag.retiringPrefixTokens}`);
  assert.match(longDiag.explanation, /Compaction boundary is feasible/);
});

// Full native controlled multi-turn flow with real StockFixture
async function sameTaskHistoryHost(group: "native" | "candidate", tools = true, lowUsage = false) {
  const { StockFixture } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 160000 });
  const model: Model<Api> = { id: "openai/gpt-5.6-luna", name: "Controlled Luna protocol fixture", provider: "openrouter", api: "openai-completions", baseUrl: f.endpoint,
    reasoning: true, input: ["text"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stateRoot = join(f.state, "worker"); await mkdir(stateRoot);
  const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
    effective: { source: "invoking-runtime", provider: model.provider, model: model.id, thinking: "low", transport: "sse", compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, settings: { nunc: { memoryTools: true } } },
    comparison: { modes: ["defaults"], targets: { native: { repository }, candidate: { repository }, current: { repository: join(repository, ".scratch/prechange"), ref: "refs/nunc/task-retention-pre-change" } } },
    overrides: [{ requirement: "maintenance-thinking", maintenanceThinking: "low", reason: "Controlled low-effort native serializer proof" }, ...(tools ? [] : [{ requirement: "memory-tools-off", memoryTools: false, reason: "Actual tools-off comparison" }])],
    limits: { maxCalls: 50, maxTotalTokens: 4000000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 150000 },
    scenarios: [{ id: "g4", variant: "same-task-history", config: { compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 1200 }, extraction: { outputTokens: 2048 } } } }] };

  const { input: scenario } = await loadScenario(repository, input.scenarios[0]!);
  const expectedRecords = deriveExpectedRecords(scenario);
  const recordsJson = JSON.stringify(expectedRecords, null, 2);

  const tool = (name: string, inputArgs: any) => ({ tool: { name, input: inputArgs }, input: lowUsage ? 100 : 18000 });

  // Sequence of actions across turns:
  // Turn setup:
  const turnSetup = [
    tool("read", { path: "schema/records.schema.json" }),
    tool("read", { path: "inputs/north.json" }),
    tool("read", { path: "inputs/south.json" }),
    tool("read", { path: "inputs/west.json" }),
    tool("write", { path: "records.json", content: recordsJson }),
    { text: "Ingested regional feeds and wrote records.json.", input: lowUsage ? 100 : 18000 }
  ];

  // Turn preflight:
  const turnPreflight = [
    tool("bash", { command: "python3 scripts/validate_records.py" }),
    { text: "Validation completed successfully.", input: lowUsage ? 100 : 18000 }
  ];

  // Turn task:
  const turnTask = [
    tool("read", { path: "TASK.md" }),
    tool("bash", { command: "python3 build.py" }),
    tool("edit", { path: "solution.py", oldText: "def evaluate(record)", newText: "def evaluate(record):" }),
    tool("bash", { command: "python3 build.py" }),
    tool("write", { path: "solution.py", content: metricsSolution }),
    tool("write", { path: "test_solution.py", content: candidateTests }),
    tool("bash", { command: "python3 build.py" }),
    tool("bash", { command: "python3 -m unittest test_solution.py" }),
    tool("write", { path: "handoff.json", content: JSON.stringify({ implemented: true, verified: true, complete: true, remaining: [], commands: ["python3 build.py", "python3 -m unittest test_solution.py"] }) }),
    { text: "Controlled same-task completed.", input: lowUsage ? 100 : 18000 }
  ];

  const fullSequence = [...turnSetup, ...turnPreflight, ...turnTask];
  let step = 0, maintenance = 0;
  f.response = (row: any, source: any) => {
    assert.equal(row.payload.model, model.id);
    assert.equal(row.payload.reasoning?.effort ?? row.payload.reasoning_effort, "low");
    if (!source && row.payload.messages.some((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes("<conversation>"))) {
      return "## Goal\nContinue the local metrics task.\n## Progress\nControlled native compaction.\n## Next Steps\nConsult ordinary task sources if needed.";
    }
    if (source) {
      maintenance++;
      return JSON.stringify({ add: [{ key: "generated", text: `Controlled generated note ${maintenance}` }], remove: source.M.map((s: any) => s.id), priority: ["generated"], required: ["generated"] });
    }
    assert(step < fullSequence.length, `Step ${step} exceeds sequence length ${fullSequence.length}`);
    return fullSequence[step++];
  };

  try {
    const report = await runSegment({ input, scenarioIndex: 0, deadline: Date.now() + 150000, resume: false, group }, {
      models: [model], controlledModels: { providers: { openrouter: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [model] } } },
    });
    await writeFile(join(f.dir, "same-task-history-report.json"), JSON.stringify(report));

    if (lowUsage) {
      assert.equal(report.status, "UNPROVEN");
      assert.equal(report.reason, "PREPARATION");
      assert.equal(maintenance, 0);
      return;
    }

    assert.equal(report.status, "OBSERVED", JSON.stringify({ status: report.status, reason: report.reason, diagnostic: report.diagnostic }));
    assert.equal(report.nextTurn, 3, "All 3 turns executed");
    assert.equal(step, fullSequence.length);
    assert.equal(maintenance, group === "native" ? 0 : 3, "Exactly 3 compactions for candidate");

    if (group !== "native") {
      assert.equal(new Set(report.rollovers!.map(r => r.snapshot!.id)).size, 3, "3 unique snapshots");
      assert.equal(report.configurationChanges!.length, 6, "3 prepare/restore configuration pairs");
      // Setup checks:
      assert.equal(report.setupChecks![0]!.status, "PROVEN", "Requirements entered through designated request & read following setup");
      assert.equal(report.setupChecks![1]!.status, "PROVEN", "Preliminary regional schema and input records verified");
      assert.equal(report.setupChecks![2]!.status, "PROVEN", "Three committed compactions series");
      assert.equal(report.setupChecks![3]!.status, "PROVEN", "Build failure and repair in order");
      assert.equal(report.score!.actionReview.find(c => c.check === "metrics-artifact")!.status, "PROVEN", "Independent metrics oracle passes");
    }

    const branch = SessionManager.open(report.sessionFile!).getBranch();
    assert.equal(taskRead(scenario, branch, report.actions as any, join(stateRoot, "g4-same-task-history/task")).complete, true);
    assert.deepEqual(ledgerSummary(readLedger(join(stateRoot, "calls.jsonl"))).unreconciledCallIds, []);
  } finally {
    await f.close();
  }
}

test("same-task-history candidate tools=true: entire multi-turn flow with preliminary ingestion, 3 rollovers, restored configs and final oracle", { timeout: 180000 }, () => sameTaskHistoryHost("candidate", true));
test("same-task-history candidate tools=false: entire multi-turn flow without nunc memory tools", { timeout: 180000 }, () => sameTaskHistoryHost("candidate", false));
test("same-task-history native tools=false: entire multi-turn flow under native Pi", { timeout: 180000 }, () => sameTaskHistoryHost("native", false));
test("same-task-history low usage: stops honestly before infeasible maintenance without synthetic padding", { timeout: 45000 }, () => sameTaskHistoryHost("candidate", true, true));
