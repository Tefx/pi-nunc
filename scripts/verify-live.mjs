#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readInput, runWorker, runCancellable, rejectRequest } from "./live-cli.mjs";

const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), "..");
const flags = process.argv.slice(2);
try {
  if (flags.length > 1 || (flags.length === 1 && !["--preflight", "--worker", "--observe-stock"].includes(flags[0]))) throw new Error("ARGUMENTS");
  const { parseInput, preflight } = await import("../dist/src/live/contract.js");
  let value = await readInput();
  if (flags[0] !== "--worker") {
    const { resolveInput } = await import("../dist/src/live/defaults.js");
    value = await resolveInput(value);
  }
  if (flags[0] === "--preflight") {
    const input = parseInput(value);
    const receipt = await preflight(input, repository);
    process.stdout.write(`${JSON.stringify({ status: "PREFLIGHT", receipt, target: input.target, models: input.models, effective: input.effective, overrides: input.overrides, limits: input.limits, scenarios: input.scenarios, limitations: ["No task state created, credentials resolved, or model calls made. Internal binding protects candidate/target identity; no receipt must be returned by the caller."] })}\n`);

  } else if (flags[0] === "--worker") {
    await runWorker(value, repository);
  } else {
    await runCancellable(async signal => {
      const { execute, observeStock } = await import("../dist/src/live/runner.js");
      const report = flags[0] === "--observe-stock" ? await observeStock(value, repository, signal) : await execute(value, repository, script, signal);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.status === "OBSERVED" ? 0 : 2;
    });
  }
} catch (error) {
  rejectRequest(error, flags[0] === "--worker");
}
