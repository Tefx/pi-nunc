#!/usr/bin/env node
// purpose: Comparison worker that records one reconciled ledger call for optional-quota tests.
// usage: spawned by launchWorker during tests/live/optional-quotas.test.ts.
// effects: appends one reserve+terminal to the shared calls.jsonl and writes observation.json.
// requires: Isolated comparison stateRoot; no model calls or credentials.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const job = JSON.parse(Buffer.concat(chunks).toString());
const { input, scenarioIndex, resume, group, mode, caseRoot: explicitCaseRoot } = job;
const selection = input.scenarios[scenarioIndex];
const caseRoot = explicitCaseRoot ?? join(input.target.stateRoot, `${mode ?? "defaults"}-${group ?? "candidate"}-${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
mkdirSync(caseRoot, { recursive: true });
const path = join(input.target.stateRoot, "calls.jsonl");
const text = existsSync(path) ? readFileSync(path, "utf8") : "";
const records = text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
const id = records.filter(r => r.kind === "reserve").length + 1;
const reserve = { kind: "reserve", id, at: Date.now(), model: "fixture", inputEstimate: 1, outputCeiling: 20, reservedTokens: 100, reservedCostUsd: null, caseKey: `${mode ?? "defaults"}:${group ?? "candidate"}:${selection.id}` };
const terminal = { kind: "terminal", id, at: Date.now(), latencyMs: 1, stopReason: "stop", usage: { input: 1, cacheRead: 0, cacheWrite: 0, contextInput: 1, output: 1, reasoning: null, totalTokens: 2, cost: null }, caseKey: reserve.caseKey };
appendFileSync(path, `${JSON.stringify(reserve)}\n${JSON.stringify(terminal)}\n`, { mode: 0o600 });
writeFileSync(join(caseRoot, resume ? "resumed-observation.json" : "observation.json"), JSON.stringify({
  status: "OBSERVED",
  pid: process.pid,
  scenario: selection.id,
  group: group ?? "candidate",
  mode: mode ?? "defaults",
  prerequisites: [{ check: "controlled quota ledger worker", status: "PROVEN" }],
  nextTurn: 0,
  contexts: [],
  maintenance: [],
  actions: [],
  commands: [],
  calibrations: [],
  score: { artifacts: {}, checks: [{ check: "mock artifact check", status: "PROVEN" }], actionReview: [] },
}), { mode: 0o600 });
process.exitCode = 0;
