// purpose: Tracked stock TUI observation for Nunc footer, Slots/Context overlay, save/delete, and host seams.
// usage: node scripts/observe-ui.mjs
// effects: Isolated PTY/CLI state and controlled loopback HTTP; writes evidence then removes fixture state.
// requires: Built tracked local Pi/Nunc, stock-driver.mjs, Python3 stdlib; no live model.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { renderMemory } from "../dist/src/engine/memory.js";
import { StockFixture } from "./stock-driver.mjs";

const strip = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const f = await new StockFixture().setup({ ...(process.argv[2] ? { artifactParent: process.argv[2] } : {}) });
let outcome = { status: "FAIL" };
try {
  const memory = {
    version: 1,
    nextId: 20,
    slots: [
      { id: "s12", text: "必须兼容 Node 18 UNIQUE_SLOT_TOKEN" },
      { id: "s15", text: "上传成功后不得自动重试" },
      { id: "s19", text: "尚未验证 Windows 路径处理" },
    ],
  };
  const sessions = f.env.PI_CODING_AGENT_DIR.replace(/agent$/, "sessions");
  const sm = SessionManager.create(f.env.HOME.replace(/home$/, "work"), sessions);
  const userId = sm.appendMessage({ role: "user", content: "Seeded UI session.", timestamp: Date.now() });
  sm.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Seeded." }], timestamp: Date.now(),
    model: f.modelId, provider: f.provider, api: f.api, stopReason: "stop",
    usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  sm.appendCompaction(renderMemory(memory.slots), userId, 1200, { nunc: memory }, true);
  const sessionFile = sm.getSessionFile();
  assert(sessionFile);
  const p = f.start("tui", sessionFile);
  await f.wait(() => f.log.some(e => e.type === "start" && e.data.mode === "tui"), "tui start");
  await delay(400);
  assert.match(strip(p.stdout), /nunc /);
  await p.send("/nunc");
  await f.wait(() => /\[Slots\]/.test(strip(p.stdout)), "overlay slots");
  p.keys("UNIQUE_SLOT_TOKEN");
  await delay(200);
  assert.match(strip(p.stdout), /UNIQUE_SLOT_TOKEN/);
  p.keys("\x15");
  await delay(100);
  p.keys("\r");
  await f.wait(() => strip(p.stdout).includes("尚未纳入下一次原生 compaction"), "edit unload notice");
  p.keys("\x15");
  p.keys("Edited via native TUI.");
  await delay(100);
  p.keys("\r");
  await f.wait(() => {
    const file = f.log.filter(e => e.type === "snapshot").at(-1)?.data?.file ?? sessionFile;
    if (!file || !existsSync(file)) return false;
    const raw = readFileSync(file, "utf8");
    return raw.includes("Edited via native TUI.") && raw.includes("nunc.memory");
  }, "native manual entry");
  const savedFile = f.log.filter(e => e.type === "snapshot").at(-1)?.data?.file ?? sessionFile;
  const saved = await readFile(savedFile, "utf8");
  assert.match(saved, /nunc\.memory/);
  assert.match(saved, /Edited via native TUI/);
  p.keys("\x04");
  await delay(150);
  assert.match(strip(p.stdout), /Delete /);
  p.keys("\x1b");
  await delay(100);
  p.keys("\x04");
  await delay(100);
  p.keys("\r");
  await delay(250);
  p.keys("\t");
  await f.wait(() => /\[Context\]/.test(strip(p.stdout)), "context tab");
  assert.match(strip(p.stdout), /Current projection|Last main|Last maintenance|F |M /);
  p.keys("\x1b");
  await delay(80);
  p.keys("\x1b");
  await delay(200);
  p.keys("KEEP_DRAFT");
  await delay(80);
  const n = f.log.filter(e => e.type === "snapshot").length;
  p.keys("\x1b[17~");
  await f.wait(() => f.log.filter(e => e.type === "snapshot").length > n, "editor snapshot");
  const snap = f.log.filter(e => e.type === "snapshot").at(-1).data;
  assert.match(snap.editor, /KEEP_DRAFT/);
  p.keys("\x03");
  f.hold("main");
  await p.send("In-flight while overlay opens");
  await f.wait(() => f.requests.some(r => r.kind === "main" && !r.closed), "inflight main");
  const open = f.requests.filter(r => r.kind === "main" && !r.closed).length;
  await p.send("/nunc");
  await f.wait(() => /\[Slots\]/.test(strip(p.stdout)), "overlay during inflight");
  p.keys("\x1b");
  await delay(200);
  assert.equal(f.requests.filter(r => r.kind === "main" && !r.closed).length, open, "closing overlay does not abort inflight");
  assert.equal(f.log.filter(e => e.type === "compact").length, 0);
  f.release("main");
  await f.wait(() => f.log.some(e => e.type === "settled"), "inflight settled");
  await p.send("/nunc status");
  await f.wait(() => f.log.some(e => e.type === "diagnostic" && String(e.data.message).includes("记忆：")), "status text");
  await p.send("/nunc details");
  await f.wait(() => f.log.some(e => e.type === "diagnostic" && String(e.data.message).includes("主请求准入")), "details text");
  await p.send("/nunc nope");
  await f.wait(() => f.log.some(e => e.type === "diagnostic" && String(e.data.message).includes("用法：/nunc [status|details]")), "unknown usage");
  p.keys("\x1b[200~中文粘贴\x1b[201~");
  await delay(150);
  await p.send("/nunc");
  await delay(250);
  p.keys("\x1b");
  await p.quit();
  const short = await new StockFixture().setup({ ...(process.argv[2] ? { artifactParent: process.argv[2] } : {}) });
  short.env.NUNC_PTY_ROWS = "12";
  short.env.NUNC_PTY_COLS = "40";
  try {
    const shortSessions = short.env.PI_CODING_AGENT_DIR.replace(/agent$/, "sessions");
    const shortSm = SessionManager.create(short.env.HOME.replace(/home$/, "work"), shortSessions);
    const shortUser = shortSm.appendMessage({ role: "user", content: "Short UI session.", timestamp: Date.now() });
    shortSm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Seeded." }], timestamp: Date.now(),
      model: short.modelId, provider: short.provider, api: short.api, stopReason: "stop",
      usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    shortSm.appendCompaction(renderMemory(memory.slots), shortUser, 1200, { nunc: memory }, true);
    const p2 = short.start("tui", shortSm.getSessionFile());
    await short.wait(() => short.log.some(e => e.type === "start" && e.data.mode === "tui"), "short tui start");
    await p2.send("/nunc");
    await short.wait(() => /Nunc/.test(strip(p2.stdout)), "short overlay");
    p2.keys("\x1b");
    await delay(150);
    await p2.quit();
  } finally {
    await short.close({ status: "short-screen" });
  }
  outcome = {
    status: "PASS",
    footer: Boolean(strip(p.stdout).match(/nunc /)),
    overlay: true,
    savedManual: true,
    editorKept: /KEEP_DRAFT/.test(snap.editor),
    inflightPreserved: true,
    shortScreen: true,
    commands: ["status", "details", "unknown"],
    unproven: ["IME candidate window position requires a real terminal/window"],
  };
} catch (error) {
  outcome = { status: "FAIL", error: error instanceof Error ? error.message : String(error) };
  throw error;
} finally {
  await f.close(outcome);
  console.log(JSON.stringify({ ...outcome, dir: f.dir, requests: f.requests.length }, null, 2));
}
