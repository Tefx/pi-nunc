#!/usr/bin/env node
// purpose: Test-only native-host child for RPC/output/drain failure classification.
// usage: node tests/live/host-child.mjs malformed|overflow|rpc
// effects: Writes stdout/stderr only; does not call models or retain secrets.
// requires: HostOptions.testCommand.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
if (mode === "malformed") {
  process.stdout.write("{not-json\n");
  setInterval(() => {}, 1000);
} else if (mode === "overflow") {
  process.stdout.write(`${"x".repeat(33_000_000)}\n`);
  setInterval(() => {}, 1000);
} else if (mode === "rpc" || mode === "compact-error") {
  const binding = process.env.NUNC_LIVE_OBSERVER ? JSON.parse(readFileSync(process.env.NUNC_LIVE_OBSERVER, "utf8")) : { models: [{ provider: "groq", id: "nunc-native" }] };
  const model = binding.models[0];
  const sessionFile = join(process.cwd(), "../sessions/s.jsonl");
  process.stdin.on("data", buffer => {
    for (const line of buffer.toString().split("\n")) {
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.message === "/nunc-observer-quit") { process.exit(0); return; }
      if (typeof message.id === "string") {
        if (message.type === "compact" && mode === "compact-error") {
          process.stdout.write(`${JSON.stringify({ type: "response", id: message.id, command: "compact", success: false, error: process.argv[3] })}\n`);
          continue;
        }
        const data = message.type === "get_state" ? { sessionId: "fixture-session", sessionFile, model: { provider: model.provider, id: model.id } } : {};
        process.stdout.write(`${JSON.stringify({ type: "response", id: message.id, success: true, data })}\n`);
      }
    }
  });
} else {
  process.stderr.write("unknown host-child mode\n");
  process.exit(1);
}
