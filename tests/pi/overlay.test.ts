import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { initTheme, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
initTheme();
import { contextSurface, memorySurface, type ContextSurface, type MemorySurface } from "pi-nunc/pi";
import { NuncOverlay } from "../../src/ui/overlay.js";
import { UNLOAD_LIMIT } from "../../src/ui/status.js";
import { fixture, memoryPatch } from "./fixtures.js";

function port(): {
  extras: InlineExtension[];
  memory: () => MemorySurface;
  context: () => ContextSurface;
  ctx: () => ExtensionContext;
} {
  let api: ExtensionAPI | undefined;
  let ctx: ExtensionContext | undefined;
  return {
    extras: [{ name: "nunc-ui-port", factory(pi) {
      api = pi;
      pi.on("session_start", (_event, next) => { ctx = next; });
    } }],
    memory() { const value = memorySurface(api!); assert(value); return value; },
    context() { const value = contextSurface(api!); assert(value); return value; },
    ctx() { assert(ctx); return ctx; },
  };
}

function visible(lines: string[]): string {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:c\x07/g, "");
}

function mockTui(): TUI {
  return { requestRender() {}, terminal: { rows: 40, columns: 120 } } as TUI;
}

async function prepared(t: { after: (fn: () => Promise<void>) => void }) {
  const captured = port();
  const f = await fixture({ extras: captured.extras });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const view = captured.memory().read(captured.ctx());
  assert(view.memory.slots.length >= 1);
  const overlay = new NuncOverlay({
    tui: mockTui(),
    theme: captured.ctx().ui.theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    ctx: captured.ctx(),
    memory: captured.memory(),
    context: captured.context(),
    done: () => { overlay.dispose(); },
  });
  return { f, overlay, ...captured };
}

test("overlay browse lists slots, searches id/text, and keeps empty-match distinct", async t => {
  const { overlay } = await prepared(t);
  const start = visible(overlay.render(90));
  assert.match(start, /\[Slots\]/);
  assert.match(start, /s\d+/);
  overlay.handleInput("zzzz-no-match");
  assert.match(visible(overlay.render(90)), /无匹配 slots/);
});

test("overlay enter edits, empty save stays in draft, successful save writes unique M", async t => {
  const { overlay, memory, ctx, f } = await prepared(t);
  const slot = memory().read(ctx()).memory.slots[0]!;
  overlay.handleInput("\r");
  assert.equal(overlay.layerName, "edit");
  assert.match(visible(overlay.render(90)), new RegExp(UNLOAD_LIMIT.slice(0, 12)));
  assert.equal(overlay.draftText(), slot.text);
  overlay.handleInput("\x15");
  overlay.handleInput("\r");
  assert.equal(overlay.layerName, "edit");
  assert.match(visible(overlay.render(90)), /Empty text|empty|not a valid/i);
  assert.equal(memory().read(ctx()).memory.slots[0]?.text, slot.text);
  overlay.handleInput("Edited from overlay.");
  overlay.handleInput("\r");
  assert.equal(overlay.layerName, "browse");
  assert.equal(memory().read(ctx()).memory.slots[0]?.text, "Edited from overlay.");
  const raw = await readFile(f.runtime.session.sessionFile!, "utf8");
  assert.match(raw, /nunc\.memory/);
  assert.match(raw, /Edited from overlay/);
});

test("changed editor requires discard intent and keeps draft on cancel", async t => {
  const { overlay, memory, ctx } = await prepared(t);
  const original = memory().read(ctx()).memory.slots[0]!.text;
  overlay.handleInput("\r");
  overlay.handleInput(" extra");
  overlay.handleInput("\x1b");
  assert.equal(overlay.layerName, "confirm-discard");
  overlay.handleInput("\x1b");
  assert.equal(overlay.layerName, "edit");
  assert.match(overlay.draftText() ?? "", / extra/);
  overlay.handleInput("\x1b");
  overlay.handleInput("\r");
  assert.equal(overlay.layerName, "browse");
  assert.equal(memory().read(ctx()).memory.slots[0]?.text, original);
});

test("list Ctrl+D confirms once, neighbor stays selected, Esc closes nested first", async t => {
  const { overlay, memory, ctx } = await prepared(t);
  const before = memory().read(ctx()).memory.slots.map(slot => slot.id);
  overlay.handleInput("\x04");
  assert.equal(overlay.layerName, "confirm-delete");
  overlay.handleInput("\x1b");
  assert.equal(overlay.layerName, "browse");
  assert.deepEqual(memory().read(ctx()).memory.slots.map(slot => slot.id), before);
  overlay.handleInput("\x04");
  overlay.handleInput("\r");
  assert.equal(overlay.layerName, "browse");
  assert.equal(memory().read(ctx()).memory.slots.length, before.length - 1);
});

test("context tab shows F/M/R and jumps M to slots without writing", async t => {
  const { overlay, memory, ctx, f } = await prepared(t);
  const entries = f.runtime.session.sessionManager.getEntries();
  overlay.handleInput("\t");
  assert.equal(overlay.tabName, "context");
  const text = visible(overlay.render(90));
  assert.match(text, /\[Context\]/);
  assert.match(text, /Current projection/);
  overlay.handleInput("\r");
  const drilled = visible(overlay.render(90));
  assert.match(drilled, /\bF\b/);
  assert.match(drilled, /\bM\b/);
  assert.match(drilled, /\bR\b/);
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  overlay.handleInput("\r");
  assert.equal(overlay.tabName, "slots");
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
  assert(memory().read(ctx()).memory.slots.length >= 1);
});
