#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readInput, runWorker, runCancellable, rejectRequest } from "./live-cli.mjs";

const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), "..");
const flags = process.argv.slice(2);
try {
  if (flags.length > 1 || (flags.length === 1 && !["--preflight", "--worker"].includes(flags[0]))) throw new Error("ARGUMENTS");
  const { parseInput, preflight } = await import("../dist/src/live/contract.js");
  let value = await readInput();
  if (flags[0] !== "--worker") {
    if (!value || typeof value !== "object" || !("comparison" in value)) {
      const { RunnerError } = await import("../dist/src/live/contract.js");
      throw new RunnerError("COMPARISON", "comparison configuration is required for compare-extraction");
    }
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
      limitations.push("e3 uses the public awaited turn_end and command reload path before native automatic compaction. Actual read success, whole sibling batch, threshold and group capacity remain runtime predicates; an infeasible batch stops before further transport.");
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
      limitations
    })}\n`);
  } else if (flags[0] === "--worker") {
    await runWorker(value, repository);
  } else {
    await runCancellable(async signal => {
      const { executeComparison } = await import("../dist/src/live/comparison.js");
      const report = await executeComparison(value, repository, script, signal);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.status === "OBSERVED" ? 0 : 2;
    });
  }
} catch (error) {
  rejectRequest(error, flags[0] === "--worker");
}
