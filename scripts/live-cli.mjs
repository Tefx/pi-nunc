export async function readInput() {
  const { readBoundedJson } = await import("../dist/src/live/contract.js");
  const timer = setTimeout(() => process.stdin.destroy(new Error("STDIN_TIMEOUT")), 10000);
  try { return await readBoundedJson(process.stdin); } finally { clearTimeout(timer); }
}

export async function runWorker(value, repository) {
  const { workerMain } = await import("../dist/src/live/worker.js");
  const result = await workerMain(value, repository);
  process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
  process.exitCode = result.status === "STOPPED" ? 2 : 0;
}

export async function runCancellable(run) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try { return await run(controller.signal); }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}

export function rejectRequest(error, worker) {
  const code = typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : error?.message === "ARGUMENTS" ? "ARGUMENTS" : "INPUT_OR_ENVIRONMENT";
  if (worker && process.send) {
    // Fixed messages only: never forward exception bodies, paths, env or logs.
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
