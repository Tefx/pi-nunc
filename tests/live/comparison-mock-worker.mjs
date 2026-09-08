#!/usr/bin/env node
// purpose: Comparison worker fixture for controlled offline tests.
// usage: spawned by launchWorker during comparison tests.
// effects: writes observation.json under caseRoot without model calls or credentials.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const job = JSON.parse(Buffer.concat(chunks).toString());
const { input, scenarioIndex, resume, group, mode, caseRoot: explicitCaseRoot } = job;
const selection = input.scenarios[scenarioIndex];
const caseRoot = explicitCaseRoot ?? join(input.target.stateRoot, `${mode ?? "defaults"}-${group ?? "candidate"}-${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
await mkdir(caseRoot, { recursive: true });
const base = {
  pid: process.pid,
  scenario: selection.id,
  group: group ?? "candidate",
  mode: mode ?? "defaults",
  prerequisites: [{ check: "controlled test mock prerequisite", status: "PROVEN" }],
  nextTurn: 0,
  contexts: [],
  maintenance: [],
  actions: [{ type: "mock-action" }],
  commands: [],
  calibrations: [],
  score: {
    artifacts: {},
    checks: [{ check: "mock artifact check", status: "PROVEN" }],
    actionReview: [],
  },
  comparisonFacts: {
    h: 183616,
    summarySize: 100,
    kTokens: 50,
    mTokens: 50,
    outputCap: 4096,
    outputReserve: 10000,
  },
};
await writeFile(join(caseRoot, resume ? "resumed-observation.json" : "observation.json"), JSON.stringify(base), { mode: 0o600 });
process.exitCode = 0;
