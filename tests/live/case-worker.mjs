#!/usr/bin/env node
// purpose: Substitute worker for independent-scenario supervisor tests.
// usage: spawned as `node tests/live/case-worker.mjs --worker` with a WorkerJob on stdin.
// effects: Writes observation JSON and optional calls.jsonl reservations under the job target.
// requires: Compiled dist/src/live/budget.js and job.input.resolvedModels.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BudgetLedger } from "../../dist/src/live/budget.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const job = JSON.parse(Buffer.concat(chunks).toString());
const { input, scenarioIndex, deadline, resume } = job;
const selection = input.scenarios[scenarioIndex];
const caseRoot = join(input.target.stateRoot, `${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
await mkdir(caseRoot, { recursive: true });
let mode = "default";
try { mode = JSON.parse(await readFile(join(input.target.stateRoot, "case-worker.json"), "utf8")).mode ?? "default"; } catch { /* default */ }
const report = { pid: process.pid, scenario: selection.id, status: "UNPROVEN", prerequisites: [], nextTurn: 0, contexts: [], maintenance: [], actions: [], commands: [], calibrations: [] };
if (mode === "hang") { await new Promise(() => {}); }
const model = input.resolvedModels[0];
const context = { messages: [{ role: "user", content: "case-worker", timestamp: 1 }] };
const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), input.limits, deadline, new AbortController().signal, `${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
try {
  const reservation = ledger.reserve(model, context, 16);
  if (mode === "unresolved" && scenarioIndex === 0) {
    report.reason = "MAIN_RESPONSE";
  } else if (scenarioIndex === 0 && mode === "default") {
    const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "nunc live stopped: PROVIDER_HTTP; stage=http; transport=started; status=429" });
    message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    ledger.finish(reservation, message, { code: "PROVIDER_HTTP", stage: "http", transport: "started", httpStatus: 429 });
    report.reason = "MAIN_RESPONSE";
    report.diagnostic = message.errorMessage;
  } else {
    ledger.finish(reservation, fauxAssistantMessage("ok"));
    report.status = "OBSERVED";
  }
} catch (error) {
  report.reason = typeof error?.code === "string" ? error.code : "WORKER";
  report.diagnostic = error instanceof Error ? error.message : "case worker stopped";
}
await writeFile(join(caseRoot, resume ? "resumed-observation.json" : "observation.json"), JSON.stringify(report), { mode: 0o600 });
process.exitCode = 0;
