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
const since = (proc, mark) => strip(proc.stdout.slice(mark));
const frame = (proc, mark, n = 8000) => {
  const text = since(proc, mark);
  return text.slice(Math.max(0, text.length - n));
};
const diagnostics = fixture => fixture.log.filter(e => e.type === "diagnostic");
const f = await new StockFixture().setup({ ...(process.argv[2] ? { artifactParent: process.argv[2] } : {}) });
let outcome = { status: "FAIL" };
try {
  const memory = {
    version: 1,
    nextId: 20,
    slots: [
      { id: "s12", text: "Must stay compatible with Node 18 UNIQUE_SLOT_TOKEN" },
      { id: "s15", text: "Do not auto-retry after a successful upload" },
      { id: "s19", text: "Windows path handling is not verified yet" },
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
  p.keys("PRE_OVERLAY_DRAFT");
  await delay(80);
  let snaps = f.log.filter(e => e.type === "snapshot").length;
  p.keys("\x1b[17~");
  await f.wait(() => f.log.filter(e => e.type === "snapshot").length > snaps, "pre-overlay editor");
  assert.match(f.log.filter(e => e.type === "snapshot").at(-1).data.editor, /PRE_OVERLAY_DRAFT/);
  p.keys("\x1b[18~");
  await f.wait(() => /\[Slots\]/.test(strip(p.stdout)), "overlay via F7");
  p.keys("\x1b");
  await delay(150);
  snaps = f.log.filter(e => e.type === "snapshot").length;
  p.keys("\x1b[17~");
  await f.wait(() => f.log.filter(e => e.type === "snapshot").length > snaps, "editor after F7 overlay");
  assert.match(f.log.filter(e => e.type === "snapshot").at(-1).data.editor, /PRE_OVERLAY_DRAFT/);
  p.keys("\x15");
  await delay(80);
  await p.send("/nunc");
  await f.wait(() => /\[Slots\]/.test(strip(p.stdout)), "overlay slots");
  p.keys("UNIQUE_SLOT_TOKEN");
  await delay(200);
  assert.match(strip(p.stdout), /UNIQUE_SLOT_TOKEN/);
  p.keys("\x15");
  await delay(100);
  p.keys("\r");
  await f.wait(() => strip(p.stdout).includes("Manual edits not yet absorbed"), "edit unload notice");
  p.keys("\x1b[200~中文粘贴\x1b[201~");
  await delay(150);
  assert.match(strip(p.stdout), /中文粘贴/);
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
  snaps = f.log.filter(e => e.type === "snapshot").length;
  p.keys("\x1b[17~");
  await f.wait(() => f.log.filter(e => e.type === "snapshot").length > snaps, "editor after overlay");
  const afterOverlay = f.log.filter(e => e.type === "snapshot").at(-1).data.editor;
  assert.doesNotMatch(afterOverlay, /UNIQUE_SLOT_TOKEN|Edited via native TUI|Must stay compatible/);
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
  const detailsAt = diagnostics(f).length;
  await p.send("/nunc details");
  await f.wait(() => diagnostics(f).length === detailsAt + 1, "details event");
  const detailsEvent = diagnostics(f)[detailsAt];
  assert.match(String(detailsEvent.data.message), /Maintenance input plan/);
  assert.equal(detailsEvent.data.level, "info");
  const statusAt = diagnostics(f).length;
  await p.send("/nunc status");
  await f.wait(() => diagnostics(f).length === statusAt + 1, "status event");
  const statusSlice = diagnostics(f).slice(statusAt);
  assert.equal(statusSlice.length, 1);
  assert.equal(statusSlice[0].data.message, "Usage: /nunc [details]");
  assert.equal(statusSlice[0].data.level, "warning");
  await p.send("/nunc");
  await f.wait(() => /\[Slots\]/.test(strip(p.stdout)), "overlay after status warning");
  const overlayMark = p.stdout.length;
  p.keys("\t");
  await f.wait(() => /\[Context\]/.test(frame(p, overlayMark)), "context tab for Diagnostics");
  p.keys("\x1b[B");
  await delay(80);
  p.keys("\x1b[B");
  await delay(80);
  const selectMark = p.stdout.length;
  p.keys("\x1b[B");
  await f.wait(() => /1 recent diagnostic/.test(frame(p, selectMark)) && /→ Diagnostics/.test(frame(p, selectMark)), "selected Diagnostics node");
  assert.match(frame(p, selectMark), /1 recent diagnostic/);
  assert.match(frame(p, selectMark), /→ Diagnostics/);
  const enterMark = p.stdout.length;
  p.keys("\r");
  await f.wait(() => /→ warning/.test(frame(p, enterMark)), "entered Diagnostics");
  const entered = frame(p, enterMark);
  assert.match(entered, /→ warning/);
  assert.match(entered, /Usage: \/nunc \[details\]/);
  assert.doesNotMatch(entered, /→ Diagnostics/);
  const returnMark = p.stdout.length;
  p.keys("\x1b");
  await f.wait(() => /1 recent diagnostic/.test(frame(p, returnMark)) && /→ Diagnostics/.test(frame(p, returnMark)), "return from Diagnostics");
  const closeMark = p.stdout.length;
  p.keys("\x1b");
  snaps = f.log.filter(e => e.type === "snapshot").length;
  p.keys("\x1b[17~");
  await f.wait(() => f.log.filter(e => e.type === "snapshot").length > snaps, "editor after Diagnostics overlay");
  assert.doesNotMatch(frame(p, closeMark), /1 recent diagnostic/);
  const nopeAt = diagnostics(f).length;
  await p.send("/nunc nope");
  await f.wait(() => diagnostics(f).length === nopeAt + 1, "unknown event");
  const nopeSlice = diagnostics(f).slice(nopeAt);
  assert.equal(nopeSlice.length, 1);
  assert.equal(nopeSlice[0].data.message, "Usage: /nunc [details]");
  assert.equal(nopeSlice[0].data.level, "warning");
  p.keys("\x1b[200~中文粘贴\x1b[201~");
  await delay(150);
  p.keys("\x15");
  await delay(80);
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
    const shortStatusAt = diagnostics(short).length;
    await p2.send("/nunc status");
    await short.wait(() => diagnostics(short).length === shortStatusAt + 1, "short status event");
    assert.equal(diagnostics(short).slice(shortStatusAt).at(-1).data.message, "Usage: /nunc [details]");
    await p2.send("/nunc");
    await short.wait(() => /Nunc/.test(strip(p2.stdout)) && /close|esc|select/i.test(strip(p2.stdout)), "short overlay controls");
    const shortOverlay = p2.stdout.length;
    p2.keys("\t");
    await short.wait(() => /\[Context\]/.test(frame(p2, shortOverlay)), "short context tab");
    p2.keys("\x1b[B");
    await delay(60);
    p2.keys("\x1b[B");
    await delay(60);
    const shortSelect = p2.stdout.length;
    p2.keys("\x1b[B");
    await short.wait(() => /1 recent diagnostic/.test(frame(p2, shortSelect)) && /→ Diagnostics/.test(frame(p2, shortSelect)), "short selected Diagnostics");
    const shortEnter = p2.stdout.length;
    p2.keys("\r");
    await short.wait(() => /→ warning/.test(frame(p2, shortEnter)), "short entered Diagnostics");
    const shortEntered = frame(p2, shortEnter);
    assert.match(shortEntered, /→ warning/);
    assert.match(shortEntered, /Usage: \/nunc \[details\]/);
    assert.doesNotMatch(shortEntered, /→ Diagnostics/);
    const shortReturn = p2.stdout.length;
    p2.keys("\x1b");
    await short.wait(() => /1 recent diagnostic/.test(frame(p2, shortReturn)) && /→ Diagnostics/.test(frame(p2, shortReturn)), "short return from Diagnostics");
    p2.keys("\t");
    await delay(80);
    p2.keys("\r");
    await delay(200);
    assert.match(strip(p2.stdout), /save/);
    p2.keys("\x1b");
    await delay(80);
    const shortClose = p2.stdout.length;
    p2.keys("\x1b");
    await delay(150);
    assert.doesNotMatch(frame(p2, shortClose), /1 recent diagnostic/);
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
    preExistingDraft: true,
    overlayDidNotWriteEditor: true,
    slotPaste: true,
    inflightPreserved: true,
    shortScreen: true,
    commands: ["details", "status-unknown", "unknown"],
    diagnosticsNav: true,
    unproven: ["IME candidate window position requires a real terminal/window"],
  };
} catch (error) {
  outcome = { status: "FAIL", error: error instanceof Error ? error.message : String(error) };
  throw error;
} finally {
  await f.close(outcome);
  console.log(JSON.stringify({ ...outcome, dir: f.dir, requests: f.requests.length }, null, 2));
}
