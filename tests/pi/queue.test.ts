import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fixture, publicSelection, repository } from "../live/fixtures.js";
import { childEnvironment } from "../../src/live/host.js";
import { rm, writeFile } from "node:fs/promises";

for (const mode of ["rpc", "tui"] as const) test(`bounded downstream stdin -> actual stock ${mode}: freeze, threshold, queues/editor and cancellation`, { timeout: 115000 }, async () => {
  const input = await fixture(); input.observations = [mode === "rpc" ? "stock_rpc" : "stock_tui"]; input.target.cleanup = "remove";
  const options = { cwd: repository, encoding: "utf8" as const, timeout: 105000, maxBuffer: 64_000_000, env: childEnvironment(repository + "/.scratch") };
  try {
    const preflight = spawnSync(process.execPath, ["scripts/verify-live.mjs", "--preflight"], { ...options, input: JSON.stringify(publicSelection(input)) });
    assert.equal(preflight.status, 0, preflight.stderr); input.receipt = JSON.parse(preflight.stdout).receipt;
    const result = spawnSync(process.execPath, ["scripts/verify-live.mjs", "--observe-stock"], { ...options, input: JSON.stringify(publicSelection(input)) });
    assert.equal(result.status, 0, result.stdout.slice(0, 3000) + result.stderr + String(result.error ?? ""));
    const report = JSON.parse(result.stdout); assert.equal(report.stock.length, 1); assert.equal(report.cleanup, "removed");
    assert(report.stock[0].evidence["wire.json"].length > 0); assert(report.stock[0].evidence["result.json"].cleanup.childrenExited);
    const evidence = `${repository}/.scratch/stock-${mode}-report.json`;
    await writeFile(evidence, result.stdout);
    console.log(JSON.stringify({ mode, observed: report.stock[0].status, requests: report.stock[0].requests, cleanup: report.cleanup, evidence, memoryQuality: "UNPROVEN (controlled service)" }));
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
});
