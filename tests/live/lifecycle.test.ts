import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { finalizeRun, launchWorker, type RunReport } from "../../src/live/runner.js";
import { ledgerSummary } from "../../src/live/budget.js";
import { preflight, type Receipt } from "../../src/live/contract.js";
import { fixture, repository } from "./fixtures.js";

test("worker deadline terminates an actual uncooperative process group and waits for exit", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot); await mkdir(join(input.target.stateRoot, "tmp"));
  const script = join(input.target.stateRoot, "slow.mjs");
  await writeFile(script, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  try {
    const result = await launchWorker(script, { input, scenarioIndex: 0, deadline: Date.now() + 200, resume: false }, new AbortController().signal);
    assert.equal(result.timedOut, true); assert.equal(result.signal, "SIGKILL");
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("actual worker target/binding rejection returns bounded diagnostics and reconciles terminal ownership", async () => {
  const input = await fixture(); input.mode = "native";
  const receipt = await preflight(input, repository); input.receipt = receipt;
  await mkdir(input.target.stateRoot);
  const deadline = Date.now() + 20000;
  await writeFile(join(input.target.stateRoot, "owner.json"), JSON.stringify({ receipt, deadline, status: "running" }));
  try {
    for (const code of ["TARGET", "RECEIPT"]) {
      const changed = structuredClone(input);
      if (code === "TARGET") changed.target.repository = "/";
      else changed.receipt!.binding = "mismatched-execution";
      const child = await launchWorker(join(repository, "scripts/verify-live.mjs"), { input: changed, scenarioIndex: 0, deadline, resume: false }, new AbortController().signal);
      assert.equal(child.exitCode, 1); assert.equal(child.signal, null); assert.equal(child.timedOut, false);
      assert.equal(child.diagnostic?.code, code); assert(child.diagnostic!.message.length <= 256);
      assert(!JSON.stringify(child).includes(input.target.stateRoot));
      await assert.rejects(lstat(join(input.target.stateRoot, "calls.jsonl")), { code: "ENOENT" });
      await assert.rejects(lstat(join(input.target.stateRoot, "c2")), { code: "ENOENT" });
      const report: RunReport = { version: 1, status: "UNPROVEN", reason: code, selection: input, children: [child], segments: [], usage: ledgerSummary([]), elapsedMs: 1, cleanup: "retained", limitations: [] };
      await finalizeRun(input, receipt, report);
      const owner = JSON.parse(await readFile(join(input.target.stateRoot, "owner.json"), "utf8"));
      assert.equal(owner.status, "terminal"); assert.equal(owner.result, "UNPROVEN"); assert.equal(owner.reason, code);
      assert.deepEqual(owner.receipt, receipt);
      const saved = JSON.parse(await readFile(join(input.target.stateRoot, "report.json"), "utf8"));
      assert.equal(saved.children[0].diagnostic.code, code); assert.equal(saved.usage.calls, 0);
    }
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("an already-created target is never implicitly resumed or overwritten", async () => {
  const input = await fixture();
  input.receipt = await preflight(input, repository);
  await mkdir(input.target.stateRoot);
  try {
    await assert.rejects(preflight(input, repository), /already exists/);
    await assert.rejects(lstat(join(input.target.stateRoot, "calls.jsonl")), { code: "ENOENT" });
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("cleanup embeds actual session evidence, removes owned successful state, and retains unresolved calls", async () => {
  for (const unresolved of [false, true]) {
    const input = await fixture(); input.target.cleanup = "remove"; await mkdir(input.target.stateRoot);
    const receipt: Receipt = { version: 1, binding: "fixture-owned-target", candidate: "fixture", node: process.versions.node, pi: "0.85.1", callsMade: 0 };
    await writeFile(join(input.target.stateRoot, "owner.json"), JSON.stringify({ receipt }));
    const file = join(input.target.stateRoot, "session.jsonl"); await writeFile(file, '{"type":"session","id":"isolated"}\n');
    const report: RunReport = { version: 1, status: "OBSERVED", selection: input, segments: [{ pid: 1, scenario: "c2", status: "OBSERVED", prerequisites: [], sessionFile: file, nextTurn: 1, contexts: [], maintenance: [], actions: [], calibrations: [] }], children: [], usage: { ...ledgerSummary([]), unreconciledCallIds: unresolved ? [1] : [] }, elapsedMs: 1, cleanup: "retained", limitations: [] };
    try {
      await finalizeRun(input, receipt, report);
      if (unresolved) { assert.equal(report.cleanup, "retained-for-reconciliation"); assert((await lstat(file)).isFile()); }
      else { assert.equal(report.cleanup, "removed"); assert.deepEqual(report.sessions?.[file], [{ type: "session", id: "isolated" }]); await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" }); }
    } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
  }
});
