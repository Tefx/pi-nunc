// purpose: Prepare an isolated offline Pi TUI with a seeded Nunc slot for manual IME observation.
// usage: node scripts/ime-fixture.mjs validate|print
// effects: Isolated agent/session/loopback only; validate cleans up; print writes a launch recipe then removes nothing until teardown line is run.
// requires: Built dist, locked Pi 0.85.1, Python3 PTY; no daily profile, live model, or paid calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { renderMemory } from "../dist/src/engine/memory.js";
import { StockFixture, root } from "./stock-driver.mjs";

const mode = process.argv[2] ?? "validate";
assert(["validate", "print"].includes(mode), "usage: node scripts/ime-fixture.mjs validate|print");
const memory = {
  version: 1, nextId: 20,
  slots: [{ id: "s12", text: "IME fixture slot. Type CJK here after F7 or /nunc Enter." }],
};
const f = await new StockFixture().setup({ artifactParent: join(root, ".scratch/ime-fixture") });
const sessions = f.env.PI_CODING_AGENT_DIR.replace(/agent$/, "sessions");
const sm = SessionManager.create(f.env.HOME.replace(/home$/, "work"), sessions);
const userId = sm.appendMessage({ role: "user", content: "IME fixture seed.", timestamp: Date.now() });
sm.appendMessage({
  role: "assistant", content: [{ type: "text", text: "Seeded." }], timestamp: Date.now(),
  model: f.modelId, provider: f.provider, api: f.api, stopReason: "stop",
  usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
sm.appendCompaction(renderMemory(memory.slots), userId, 200, { nunc: memory }, true);
const sessionFile = sm.getSessionFile();
assert(sessionFile);
const host = join(root, "node_modules/@earendil-works/pi-coding-agent");
const cli = join(host, JSON.parse(readFileSync(join(host, "package.json"), "utf8")).bin.pi);
const args = [cli, "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
  "-e", join(root, "dist/src/index.js"), "--nunc-config", f.configFile, "--provider", f.provider, "--model", f.modelId,
  "--thinking", "off", "--system-prompt", "Inspect Nunc overlay IME.", "--session-dir", join(f.state, "sessions"), "--session", sessionFile];
const envLines = Object.entries(f.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" \\\n");
const recipe = `# Isolated Nunc IME fixture (no daily profile, dummy loopback key, seeded s12).
# Real IME candidate-window placement is unproven until you type with a host IME.
cd ${JSON.stringify(join(f.state, "work"))}
env ${envLines} \\\n${process.execPath} ${args.map(a => JSON.stringify(a)).join(" ")}\n
# F7 opens overlay without consuming the main editor. Enter the s12 slot and type with CJK IME.
# Teardown: rm -rf ${JSON.stringify(f.dir)}
`;
await writeFile(join(f.dir, "LAUNCH.txt"), recipe);
if (mode === "print") {
  console.log(recipe);
  console.log(JSON.stringify({ status: "READY", recipe: join(f.dir, "LAUNCH.txt"), sessionFile, slot: "s12", teardown: `rm -rf ${f.dir}` }));
  process.exit(0);
}
const strip = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
let outcome = { status: "FAIL" };
try {
  const p = f.start("tui", sessionFile);
  await f.wait(() => f.log.some(e => e.type === "start" && e.data.mode === "tui"), "tui start");
  p.keys("\x1b[18~");
  await f.wait(() => /s12/.test(strip(p.stdout)), "seeded slot visible");
  p.keys("\x1b");
  await new Promise(resolve => setTimeout(resolve, 200));
  p.keys("\x1b");
  await new Promise(resolve => setTimeout(resolve, 200));
  await p.quit();
  outcome = { status: "PASS", slot: "s12", opened: true };
} catch (error) {
  outcome = { status: "FAIL", error: error instanceof Error ? error.message : String(error) };
  throw error;
} finally {
  await f.close(outcome);
  console.log(JSON.stringify({ ...outcome, dir: f.dir }, null, 2));
}
