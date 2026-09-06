#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), "..");
const flags = process.argv.slice(2);
let controller;
try {
  if (flags.length > 1 || (flags.length === 1 && !["--preflight", "--worker", "--observe-stock"].includes(flags[0]))) throw new Error("ARGUMENTS");
  const { readBoundedJson, parseInput, preflight, RunnerError } = await import("../dist/src/live/contract.js");
  const timer = setTimeout(() => process.stdin.destroy(new Error("STDIN_TIMEOUT")), 10000);
  let value;
  try { value = await readBoundedJson(process.stdin); } finally { clearTimeout(timer); }
  if (flags[0] !== "--worker") {
    const { resolveInput } = await import("../dist/src/live/defaults.js");
    value = await resolveInput(value);
  }
  if (flags[0] === "--preflight") {
    const input = parseInput(value);
    const receipt = await preflight(input, repository);
    process.stdout.write(`${JSON.stringify({ status: "PREFLIGHT", receipt, target: input.target, models: input.models, effective: input.effective, overrides: input.overrides, limits: input.limits, scenarios: input.scenarios, limitations: ["No task state created, credentials resolved, or model calls made. Internal binding protects candidate/target identity; no receipt must be returned by the caller."] })}\n`);

  } else if (flags[0] === "--worker") {
    const { workerMain } = await import("../dist/src/live/worker.js");
    const result = await workerMain(value, repository);
    // The supervisor reads the bounded job's observer file. Never print provider logs or credentials.
    process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
    process.exitCode = result.status === "STOPPED" ? 2 : 0;
  } else {
    controller = new AbortController();
    const cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      const { execute, observeStock } = await import("../dist/src/live/runner.js");
      const report = flags[0] === "--observe-stock" ? await observeStock(value, repository, controller.signal) : await execute(value, repository, script, controller.signal);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.status === "OBSERVED" ? 0 : 2;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : error?.message === "ARGUMENTS" ? "ARGUMENTS" : "INPUT_OR_ENVIRONMENT";
  process.stderr.write(`${JSON.stringify({ status: "REJECTED", code, message: "Runner refused the request. Check the new task target, limits, native effective defaults, named overrides and local compiled dependencies. No implicit setup or retry is performed." })}\n`);
  process.exitCode = 1;
}
