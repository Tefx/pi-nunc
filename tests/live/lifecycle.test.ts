import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { openHost } from "../../bench/live/host.js";
import { finalizeRun, settleRun, launchWorker, type RunReport } from "../../bench/live/runner.js";
import { ledgerSummary } from "../../bench/live/budget.js";
import { preflight, type Receipt } from "../../bench/live/contract.js";
import { fixture, repository } from "./fixtures.js";

const rpcChild = `
  const fs = require("node:fs");
  const binding = JSON.parse(fs.readFileSync(process.env.NUNC_LIVE_OBSERVER, "utf8"));
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.message === "/nunc-observer-quit") process.exit(0);
    const data = request.type === "get_state" ? { sessionId: "fixture", model: binding.models[0] } : {};
    const respond = () => process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true, data }) + "\\n");
    if (request.type === "compact") setTimeout(respond, 30); else respond();
  });
`;

test("compaction preserves early during rejection verbatim and ignores completion-triggered abort", async () => {
  const input = await fixture();
  const caseRoot = join(input.target.stateRoot, "c2");
  await mkdir(join(caseRoot, "task"), { recursive: true });
  const host = await openHost({ repository, input, selection: input.scenarios[0]!, caseRoot, modelTargets: input.resolvedModels!, deadline: Date.now() + 5000,
    signal: new AbortController().signal, testCommand: { command: process.execPath, args: ["-e", rpcChild] } });
  try {
    const failure = new Error("during failed before compact settled");
    await assert.rejects(host.compact(async () => { throw failure; }), error => error === failure);
    await host.compact(signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("completion abort")), { once: true });
    }));
  } finally { await host.close(); }
});

test("abnormal IPC worker exit settles its NativeHost instead of orphaning a detached host group", { timeout: 15000 }, async () => {
  const input = await fixture();
  const caseRoot = join(input.target.stateRoot, "c2");
  await mkdir(join(caseRoot, "task"), { recursive: true });
  const script = join(input.target.stateRoot, "worker.mjs");
  await writeFile(script, `
    import { openHost } from ${JSON.stringify(new URL("../../bench/live/host.js", import.meta.url).href)};
    import { writeFile } from "node:fs/promises";
    let source = ""; for await (const chunk of process.stdin) source += chunk;
    const { input } = JSON.parse(source);
    const host = await openHost({ repository: input.target.repository, input, selection: input.scenarios[0], caseRoot: ${JSON.stringify(caseRoot)},
      modelTargets: input.resolvedModels, deadline: Date.now() + 10000, signal: new AbortController().signal,
      testCommand: { command: process.execPath, args: ["-e", ${JSON.stringify(rpcChild)}] } });
    await writeFile(${JSON.stringify(join(caseRoot, "host.pid"))}, String(host.pid));
    process.exit(2);
  `);
  let pid: number | undefined;
  try {
    const result = await launchWorker(script, { input, scenarioIndex: 0, deadline: Date.now() + 10000, resume: false }, new AbortController().signal);
    assert.equal(result.exitCode, 2); assert.equal(result.timedOut, false);
    pid = Number(await readFile(join(caseRoot, "host.pid"), "utf8"));
    const deadline = Date.now() + 1000;
    while (true) {
      const state: SpawnSyncReturns<string> = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      assert.equal(state.error, undefined);
      if (state.status === 1 || /^Z/.test(state.stdout.trim())) break;
      assert.equal(state.status, 0); assert(Date.now() < deadline, "NativeHost must be dead after worker settlement");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});

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
test("settlement contains cleanup failures while direct finalization still rejects", async () => {
  for (const failure of ["ownership", "session", "persistence"] as const) {
    const input = await fixture(); input.target.cleanup = "remove"; await mkdir(input.target.stateRoot);
    const receipt: Receipt = { version: 1, binding: "owned", candidate: "fixture", node: process.versions.node, pi: VERSION, callsMade: 0 };
    const boundReceipt = failure === "ownership" ? { ...receipt, binding: "changed" } : receipt;
    await writeFile(join(input.target.stateRoot, "owner.json"), JSON.stringify({ receipt: boundReceipt }));
    const file = join(input.target.stateRoot, "session.jsonl"); await writeFile(file, '{"incomplete":true}');
    const report: RunReport = { version: 1, status: "OBSERVED", selection: input, segments: [], children: [], usage: ledgerSummary([]), elapsedMs: 0, cleanup: "retained", limitations: [] };
    if (failure === "session") report.segments.push({ pid: 1, scenario: "c2", status: "OBSERVED", prerequisites: [], sessionFile: file, nextTurn: 1, contexts: [], maintenance: [], actions: [], calibrations: [] });
    if (failure === "persistence") {
      report.status = "UNPROVEN"; report.reason = "WORKER";
      await mkdir(join(input.target.stateRoot, "report.json"));
    }
    try {
      await assert.rejects(finalizeRun(input, receipt, report));
      await settleRun(input, receipt, report, () => [], Date.now() - 10);
      assert.equal(report.status, "UNPROVEN"); assert.equal(report.cleanup, "retained-for-reconciliation");
      assert.equal(report.reason, failure === "session" ? "RECONCILIATION" : failure === "persistence" ? "WORKER" : "CLEANUP");
      assert(report.elapsedMs >= 10);
      const owner = JSON.parse(await readFile(join(input.target.stateRoot, "owner.json"), "utf8"));
      assert.deepEqual(owner.receipt, boundReceipt); assert.equal(owner.result, "UNPROVEN"); assert.equal(owner.cleanup, report.cleanup);
      if (failure !== "persistence") assert.equal(JSON.parse(await readFile(join(input.target.stateRoot, "report.json"), "utf8")).reason, report.reason);
      assert.equal(await readFile(file, "utf8"), '{"incomplete":true}');
    } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
  }
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
    const receipt: Receipt = { version: 1, binding: "fixture-owned-target", candidate: "fixture", node: process.versions.node, pi: VERSION, callsMade: 0 };
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
