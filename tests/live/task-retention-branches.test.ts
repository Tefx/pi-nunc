import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RunInput, Selection } from "../../src/live/contract.js";
import { runSegment } from "../../src/live/worker.js";
import { loadScenario } from "../../src/live/scenarios.js";
import { confirmedEdits } from "../../src/live/task-retention.js";
import { ledgerSummary, readLedger } from "../../src/live/budget.js";
import { metricsSolution, metricsTests } from "./metrics-fixture.js";
import { repository } from "./fixtures.js";

async function branch(variant: Selection["variant"], controlledOpportunity = false) {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 120000 });
  const model: Model<Api> = { id: "openai/gpt-5.6-luna", name: "Controlled branch", provider: "openrouter", api: "openai-completions", baseUrl: f.endpoint,
    reasoning: true, input: ["text"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const sourceLoss = variant === "source-loss" || variant === "source-unavailable";
  const scoped = variant === "scoped-tasks";
  const stateRoot = join(f.state, "worker"); await mkdir(stateRoot);
  const selection: Selection = { id: scoped ? "g3" : "g4", variant: variant!, config: { compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 },
    nunc: { memory: { maxTokens: 600 }, extraction: { outputTokens: 2048, headTailChars: 40 }, ...(sourceLoss ? { budget: { inputLimit: 7800 } } : {}) },
    retentionCalibration: { minFraction: 0.000001, maxFraction: 0.999999 } } };
  const scenario = (await loadScenario(repository, selection)).input;
  const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
    effective: { source: "invoking-runtime", provider: model.provider, model: model.id, thinking: "low", transport: "sse", compaction: selection.config.compaction, settings: {} },
    overrides: [{ requirement: "maintenance-thinking", maintenanceThinking: "low", reason: "Controlled native low effort" }, ...(controlledOpportunity ? [{ requirement: "mixed-note-opportunity", reason: "Reorganize only generated notes" }] : [])],
    limits: { maxCalls: 70, maxTotalTokens: 5600000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 110000 }, scenarios: [selection] };
  const tool = (name: string, input: any) => ({ tool: { name, input } });
  const write = (path: string, content: string) => tool("write", { path, content });
  const stop = { text: "Controlled turn ended; semantic quality untested." };
  const finish = [write("solution.py", metricsSolution), write("test_solution.py", metricsTests), tool("bash", { command: "python3 build.py" }), tool("bash", { command: "python3 -m unittest test_solution.py" }), write("handoff.json", '{"complete":true,"verified":true,"remaining":[]}'), stop];
  let turn = "", step = 0;
  f.limits.maxCalls = 100; f.limits.maxTotalTokens = 8000000;
  f.response = (row: any, source: any) => {
    assert.equal(row.payload.reasoning?.effort ?? row.payload.reasoning_effort, "low");
    if (source) return JSON.stringify({ add: [{ key: "a", text: "The build has compiled; the explorer task is still open." }, { key: "b", text: "Continue the task from its saved work and original task document." }, { key: "dup", text: "The build has compiled; the explorer task is still open." }], remove: source.M.map((s: any) => s.id), priority: ["a", "b", "dup"], required: ["a", "b"] });
    const last = row.payload.messages.filter((m: any) => !text(m).startsWith("Nunc working memory (session-local")).at(-1), body = text(last);
    const request = last?.role === "user" && scenario.turns.find(t => t.text === body);
    if (request && request.id !== turn) { turn = request.id; step = 0; }
    const n = step++;
    if (scoped) {
      if (turn === "a") return [tool("read", { path: "TASK.md" }), tool("read", { path: "archive.json" }), write("closeout.json", '{"netUnits":13}'), stop][n];
      if (turn === "d") return n === 0 ? write("east.json", '{"port":9090,"timeoutMs":650,"database":"sqlite","crossTenantSharing":false}') : stop;
      return stop;
    }
    if (turn === "a") return [tool("read", { path: "TASK.md" }), tool("bash", { command: "python3 build.py" }), tool("edit", { path: "solution.py", oldText: "def evaluate(record)", newText: "def evaluate(record):" }), tool("bash", { command: "python3 build.py" }), stop][n];
    if (sourceLoss) {
      if (turn === "b") return n === 0 ? tool("read", { path: "records.json" }) : stop;
      if (turn === "c") return n === 0 ? tool("read", { path: variant === "source-loss" ? "source/TASK.md" : "TASK.md" }) : finish[n - 1];
    }
    if (turn === "b") {
      if (n === 0) return tool("nunc_memory_read", {});
      if (n === 1) return tool("nunc_memory_patch", { expectedRevision: JSON.parse(body).revision, add: [{ key: "mixed", text: "Build repaired and compiled. Remaining explorer work is still pending; original task is in TASK.md." }] });
      return stop;
    }
    if (turn === "c") return stop;
    if (turn === "e") return n === 0 ? tool("nunc_memory_read", {}) : stop;
    if (turn === "d") {
      if (variant === "commit-conflict") {
        if (n === 0 || n === 2) return tool("nunc_memory_read", {});
        if (n === 1 || n === 3) { const view = JSON.parse(body); return tool("nunc_memory_patch", { expectedRevision: view.revision, update: [{ id: view.slots[0].id, text: view.slots[0].text + " Continue from the current state." }] }); }
        return finish[n - 4];
      }
      if (variant === "commit-unconfirmed") {
        if (n === 0) return tool("nunc_memory_read", {});
        if (n === 1) { const view = JSON.parse(body); return tool("nunc_memory_patch", { expectedRevision: view.revision, update: [{ id: view.slots[0].id, text: view.slots[0].text + " Continue from the current state." }] }); }
        return finish[n - 2];
      }
      if ([0, 2, 4].includes(n)) return tool("nunc_memory_read", {});
      const view = [1, 3, 5].includes(n) ? JSON.parse(body) : undefined;
      if (n === 1) return tool("nunc_memory_patch", { expectedRevision: view.revision, update: [{ id: view.slots[0].id, text: view.slots[0].text + " Work remains pending." }] });
      if (n === 3) return tool("nunc_memory_patch", { expectedRevision: view.revision, remove: view.slots.slice(0, 2).map((s: any) => s.id), add: [{ key: "combined", text: view.slots.slice(0, 2).map((s: any) => s.text).join("\n") }, { key: "duplicate", text: view.slots[0].text }] });
      if (n === 5) return tool("nunc_memory_patch", { expectedRevision: view.revision, remove: [view.slots.at(-1).id] });
      return finish[n - 6];
    }
    throw new Error(`Unexpected controlled turn ${turn}/${n}`);
  };
  try {
    const report = await runSegment({ input, scenarioIndex: 0, deadline: Date.now() + 110000, resume: false }, { models: [model], controlledModels: { providers: { openrouter: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [model] } } } });
    await writeFile(join(f.dir, "branch-report.json"), JSON.stringify(report));
    assert.equal(report.status, "OBSERVED", JSON.stringify({ variant, reason: report.reason, diagnostic: report.diagnostic, prerequisites: report.prerequisites }));
    assert.equal(report.nextTurn, scenario.turns.length);
    assert.equal(report.score!.actionReview.find(c => c.check === (scoped ? "scoped-artifacts" : "metrics-artifact"))!.status, "PROVEN");
    if (scoped) {
      assert.equal(report.rollovers!.length, 2);
      assert.equal(report.setupChecks![1]!.status, "PROVEN", JSON.stringify(report.setupChecks));
    } else if (sourceLoss) {
      const omission = report.rollovers!.flatMap(r => r.result!.observations.omissions);
      assert(omission.length > 0, "configured capacity actually omits source detail");
      assert.equal(report.setupChecks![0]!.status, "PROVEN", JSON.stringify(report.setupChecks));
      const task = join(stateRoot, `g4-${variant}`, "task");
      await assert.rejects(stat(join(task, "TASK.md")));
      if (variant === "source-loss") assert.equal(await readFile(join(task, "source/TASK.md"), "utf8"), scenario.files["TASK.md"]);
      else await assert.rejects(stat(join(task, "source/TASK.md")));
    } else if (variant === "active-edit") {
      const edits = confirmedEdits(report.actions as any).filter(e => e.turn === "d");
      assert.equal(edits.length, 3); assert(edits.every(e => e.confirmed));
      assert(edits[0]!.updated.length); assert(edits[1]!.removed.length >= 2 && edits[1]!.added.length); assert(edits[2]!.removed.length);
      assert(report.setupChecks!.filter(c => c.check.startsWith("Mixed-note")).every(c => c.status === "UNPROVEN"));
      if (controlledOpportunity) assert(report.actions.some((a: any) => a.event.type === "note_opportunity" && a.event.established === true));
    } else {
      const name = variant === "commit-conflict" ? "conflict-order" : "unconfirmed-no-replay";
      assert.equal(report.score!.actionReview.find(c => c.check === name)!.status, "PROVEN");
      assert.equal((await stat(report.sessionFile!)).mode & 0o200, 0o200);
    }
    assert.deepEqual(ledgerSummary(readLedger(join(stateRoot, "calls.jsonl"))).unreconciledCallIds, []);
  } finally { await f.close(); }
}
for (const variant of ["active-edit", "source-loss", "source-unavailable", "commit-conflict", "commit-unconfirmed", "scoped-tasks"] as const) test(`controlled long-task ${variant} executes real tool/state/failure branch`, { timeout: 130000 }, () => branch(variant));
test("controlled mixed-note opportunity uses only generated note text", { timeout: 130000 }, () => branch("active-edit", true));
