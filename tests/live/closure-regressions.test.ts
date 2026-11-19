import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ledgerSummary, readQualifiedLedgers, type CallRecord, type CallEnd } from "../../src/live/budget.js";
import { dispatchWorker } from "../../src/live/runner.js";
import { scoreGuidance, type GuidanceAction } from "../../src/live/guidance.js";
import observer from "../../src/live/observer.js";
import { fixture, repository } from "./fixtures.js";

const reserve: CallRecord = { kind: "reserve", id: 1, at: 1, model: "fixture", inputEstimate: 10, outputCeiling: 100, reservedTokens: 1000, reservedCostUsd: 1 };
const terminal: CallEnd = { kind: "terminal", id: 1, at: 2, latencyMs: 1, stopReason: "stop", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, contextInput: 10, reasoning: null, totalTokens: 30, cost: 0.1 } };

test("orphan terminals reject raw and qualified ledger reads; aggregate unresolved IDs retain ledger identity", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  const a = join(input.target.stateRoot, "a.jsonl"), b = join(input.target.stateRoot, "b.jsonl");
  try {
    const inA = { ...reserve, ledgerPath: a }, inB = { ...reserve, ledgerPath: b };
    assert.deepEqual(ledgerSummary([inA, inB]).unreconciledCallIds, [`${a}::1`, `${b}::1`]);
    assert.deepEqual(ledgerSummary([inA, inB, { ...terminal, ledgerPath: b }]).unreconciledCallIds, [`${a}::1`]);
    assert.throws(() => ledgerSummary([inA, { ...terminal, ledgerPath: b }]), /Orphan terminal/);
    await writeFile(a, JSON.stringify(reserve) + "\n");
    await writeFile(b, JSON.stringify(terminal) + "\n");
    assert.throws(() => readQualifiedLedgers([a, b]), /Orphan terminal/);
    await writeFile(b, JSON.stringify(reserve) + "\n");
    assert.deepEqual(ledgerSummary(readQualifiedLedgers([a, b])).unreconciledCallIds, [`${a}::1`, `${b}::1`]);
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
});

test("shared worker dispatch rejects fresh cumulative call/token/cost exhaustion before launching a child", async () => {
  for (const ceiling of ["calls", "tokens", "cost", "unresolved"] as const) {
    const input = await fixture();
    input.limits.maxCalls = ceiling === "calls" ? 1 : null;
    input.limits.maxTotalTokens = ceiling === "tokens" ? 1 : null;
    input.limits.maxCostUsd = ceiling === "cost" ? 0.1 : null;
    const usage = ledgerSummary([]), report = { children: [], usage };
    const records = [{ ledgerPath: "/fixture", record: reserve, terminals: ceiling === "unresolved" ? [] : [terminal] }];
    await assert.rejects(dispatchWorker("/must-never-launch.js", { input, scenarioIndex: 0, deadline: Date.now() + 10000, resume: false }, new AbortController().signal, report, () => records), (error: { code?: string }) => error.code === ({ calls: "CALL_LIMIT", tokens: "TOKEN_LIMIT", cost: "COST_LIMIT", unresolved: "RECONCILIATION" }[ceiling]));
    assert.equal(report.children.length, 0);
  }
});

test("guidance command evidence uses completed successes and detects post-test edits to solution and tests", () => {
  let id = 0;
  const effect = (toolName: string, input: unknown, isError = false) => {
    const toolCallId = String(id++);
    return [{ event: { type: "tool_call", toolName, toolCallId, input } }, { event: { type: "tool_result", toolName, toolCallId, isError } }];
  };
  const check = "semantic: actual commands show build and unittest success";
  const score = (actions: GuidanceAction[]) => scoreGuidance("g4", check, actions, [], "/task");
  const build = effect("bash", { command: "python3 build.py" });
  const tests = effect("bash", { command: "python3 -m unittest test_solution.py" });
  for (const actions of [[...build, tests[0]!], [...build, ...effect("bash", { command: "python3 -m unittest" }, true)], [{ event: { type: "tool_blocked", toolName: "bash", input: { command: "python3 build.py" } } }]]) {
    assert.match(score(actions).reason!, /No completed successful/);
  }
  for (const path of ["solution.py", "test_solution.py"]) {
    const edit = effect("edit", { path });
    assert.equal(score([...build, ...tests, ...edit]).status, "DISPROVEN");
    assert.equal(score([...build, edit[0]!, ...tests, edit[1]!]).status, "DISPROVEN", "An overlapping completed write is not covered by that test invocation");
    assert.equal(score([...build, ...tests, ...edit, ...effect("bash", { command: "python3 -m unittest" }, true)]).status, "DISPROVEN");
    assert.match(score([...build, ...tests, ...edit, ...effect("bash", { command: "python3 -m unittest" })]).reason!, /Independent observation/);
    assert.match(score([...build, ...tests, ...effect("edit", { path }, true)]).reason!, /Independent observation/);
  }
});

test("autonomous task compaction exemption starts only after every scheduled boundary is exhausted", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  const previous = process.env.NUNC_LIVE_OBSERVER;
  try {
    for (const index of [0, 1, 2]) {
      const source = join(input.target.stateRoot, `binding-${index}.json`);
      const events = join(input.target.stateRoot, `events-${index}.jsonl`);
      await writeFile(events, "");
      await writeFile(source, JSON.stringify({ input, selection: { id: "g4", variant: "task-file" }, models: input.resolvedModels, deadline: Date.now() + 10000, events, ledger: join(input.target.stateRoot, "calls.jsonl"), boundaries: [{}, {}] }));
      process.env.NUNC_LIVE_OBSERVER = source;
      const handlers = new Map<string, (...args: any[]) => any>();
      const commands = new Map<string, (...args: any[]) => any>();
      observer({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), events: { on() {} }, registerCommand: (name: string, value: { handler: (...args: any[]) => any }) => commands.set(name, value.handler) } as unknown as ExtensionAPI);
      for (let i = 0; i < index; i++) await commands.get("nunc-observer-release")!(JSON.stringify({ restored: true }));
      const result = handlers.get("session_before_compact")!({ branchEntries: [], preparation: { firstKeptEntryId: "unarmed", fileOps: {} } }, { sessionManager: { buildContextEntries: () => [] } });
      assert.deepEqual(result, index < 2 ? { cancel: true } : undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.NUNC_LIVE_OBSERVER; else process.env.NUNC_LIVE_OBSERVER = previous;
    await rm(input.target.stateRoot, { recursive: true, force: true });
  }
});
