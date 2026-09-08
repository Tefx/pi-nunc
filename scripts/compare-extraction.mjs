#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), "..");
const flags = process.argv.slice(2);
let controller;
try {
  if (flags.length > 1 || (flags.length === 1 && !["--preflight", "--worker"].includes(flags[0]))) throw new Error("ARGUMENTS");
  const { readBoundedJson, parseInput, preflight } = await import("../dist/src/live/contract.js");
  const timer = setTimeout(() => process.stdin.destroy(new Error("STDIN_TIMEOUT")), 10000);
  let value;
  try { value = await readBoundedJson(process.stdin); } finally { clearTimeout(timer); }
  if (flags[0] !== "--worker") {
    const { resolveInput } = await import("../dist/src/live/defaults.js");
    value = await resolveInput(value);
    const { parseComparisonInput } = await import("../dist/src/live/contract.js");
    parseComparisonInput(value);
  }
  if (flags[0] === "--preflight") {
    const { parseComparisonInput } = await import("../dist/src/live/contract.js");
    const input = parseComparisonInput(value);
    const receipt = await preflight(input, repository);
    const limitations = [
      "No task state created, credentials resolved, or model calls made. Internal binding protects candidate/target identity; no receipt must be returned by the caller."
    ];
    if (input.scenarios.some(s => s.id === "e3")) {
      limitations.push("e3 exact mid-turn tool-boundary split control requires boundary pause before continuation; manual ctx.compact() aborts without continuing, while automatic threshold compaction occurs on token threshold crossing. Reported as UNPROVEN before execution.");
    }
    process.stdout.write(`${JSON.stringify({
      status: "PREFLIGHT",
      receipt,
      target: input.target,
      models: input.models,
      comparison: input.comparison,
      effective: input.effective,
      overrides: input.overrides,
      limits: input.limits,
      scenarios: input.scenarios,
      limitations,
      unsupportedPublicSeams: input.scenarios.some(s => s.id === "e3") ? ["rollover_at_tool_boundary"] : []
    })}\n`);
  } else if (flags[0] === "--worker") {
    const { workerMain } = await import("../dist/src/live/worker.js");
    const result = await workerMain(value, repository);
    process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
    process.exitCode = result.status === "STOPPED" ? 2 : 0;
  } else {
    controller = new AbortController();
    const cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      const { executeComparison } = await import("../dist/src/live/comparison.js");
      const report = await executeComparison(value, repository, script, controller.signal);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.status === "OBSERVED" ? 0 : 2;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : error?.message === "ARGUMENTS" ? "ARGUMENTS" : "INPUT_OR_ENVIRONMENT";
  if (flags[0] === "--worker" && process.send) {
    const messages = {
      TARGET: "Worker target failed canonical path or allowed-root validation.",
      TARGET_EXISTS: "Worker target already exists outside the permitted owned-worker path.",
      RECEIPT: "Worker target, candidate or supervisor execution binding does not match.",
      TIME_LIMIT: "Worker deadline is invalid or exceeds the task bound.",
      CANDIDATE: "Worker candidate must have committed clean product and check inputs.",
      DEPENDENCY: "Worker local dependencies do not match the selected lock.",
      BUILD: "Worker could not verify the compiled runtime against tracked source.",
      ENVIRONMENT: "Worker runtime does not match the selected check environment.",
      INPUT: "Worker job input is invalid.",
      COMPARISON: "Worker comparison configuration is invalid.",
    };
    process.send({ type: "nunc-worker-rejection", code: code.slice(0, 64), message: messages[code] ?? "Worker boundary rejected the job; inspect the terminal report before any new run." }, () => { if (process.connected) process.disconnect(); });
  }
  process.stderr.write(`${JSON.stringify({ status: "REJECTED", code, message: "Runner refused the request. Check the new task target, limits, native effective defaults, named overrides and local compiled dependencies. No implicit setup or retry is performed." })}\n`);
  process.exitCode = 1;
}
