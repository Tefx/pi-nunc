#!/usr/bin/env node
// purpose: Supervisor-loop fixture only. Emits PAUSED/STOPPED/UNPROVEN segments without Pi/host.
// usage: spawned as `node tests/live/supervisor-loop-worker.mjs --worker` with a WorkerJob on stdin.
// effects: Writes observation JSON under the job case root. No model calls, no ledger writes.
// requires: Does not prove workerMain, NativeHost, observer caseKey, or runSegment.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const job = JSON.parse(Buffer.concat(chunks).toString());
const { input, scenarioIndex, resume } = job;
const selection = input.scenarios[scenarioIndex];
const caseRoot = join(input.target.stateRoot, `${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
await mkdir(caseRoot, { recursive: true });
const mode = String((input.overrides ?? []).find(o => typeof o.requirement === "string" && o.requirement.startsWith("supervisor-loop:"))?.requirement ?? "");
const base = { pid: process.pid, scenario: selection.id, prerequisites: [], nextTurn: 0, contexts: [], maintenance: [], actions: [], commands: [], calibrations: [] };
let report;
if (scenarioIndex === 0 && !resume) {
  if (mode === "supervisor-loop:paused-unproven") report = { ...base, status: "PAUSED", reason: "PREREQUISITE", prerequisites: [{ check: "required source placement", status: "UNPROVEN" }] };
  else if (mode === "supervisor-loop:stopped-cleanup") report = { ...base, status: "STOPPED", reason: "CLEANUP" };
  else report = { ...base, status: "UNPROVEN", reason: "MAIN_RESPONSE", diagnostic: "nunc live stopped: PROVIDER_HTTP; stage=http; transport=started; status=429" };
} else report = { ...base, status: "OBSERVED", prerequisites: [{ check: "independent case ran", status: "PROVEN" }] };
await writeFile(join(caseRoot, resume ? "resumed-observation.json" : "observation.json"), JSON.stringify(report), { mode: 0o600 });
process.exitCode = 0;
