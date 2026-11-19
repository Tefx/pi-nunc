import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { visibleWidth, KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
initTheme();
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { NuncOverlay } from "../../src/ui/overlay.js";
import { NuncUi } from "../../src/ui/index.js";
import type { MemoryFreeze } from "../../src/pi/manual.js";
import { UNLOAD_LIMIT } from "../../src/ui/status.js";
import { fixture, memoryPatch, surfacePort as port } from "./fixtures.js";


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
  assert.match(visible(overlay.render(90)), /No matching slots/);
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
  const initial = memory().read(ctx());
  assert(memory().patch(ctx(), { expectedRevision: initial.revision, add: [{ key: "neighbor", text: "Adjacent note." }] }).ok);
  overlay.sync();
  const before = memory().read(ctx()).memory.slots.map(slot => slot.id);
  assert(before.length >= 2);
  overlay.handleInput("\x04");
  assert.equal(overlay.layerName, "confirm-delete");
  overlay.handleInput("\x1b");
  assert.equal(overlay.layerName, "browse");
  assert.deepEqual(memory().read(ctx()).memory.slots.map(slot => slot.id), before);
  overlay.handleInput("\x04");
  overlay.handleInput("\r");
  assert.equal(overlay.layerName, "browse");
  assert.equal(memory().read(ctx()).memory.slots.length, before.length - 1);
  assert.equal(overlay.selectedSlotId(), before[1]);
  overlay.handleInput("\t");
  overlay.handleInput("\r");
  assert.match(visible(overlay.render(90)), /F · Fixed/);
  overlay.handleInput("\x1b");
  assert.match(visible(overlay.render(90)), /Current projection/);
  overlay.handleInput("\t");
  assert.equal(overlay.tabName, "slots", "nested Esc popped the Context path without closing");
  overlay.handleInput("\x1b");
  overlay.handleInput("\t");
  assert.equal(overlay.tabName, "slots", "root Esc closed and disposed the overlay");
});

test("context tab shows F/R/M and jumps M to slots without writing", async t => {
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
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  overlay.handleInput("\r");
  assert.equal(overlay.tabName, "slots");
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
  assert(memory().read(ctx()).memory.slots.length >= 1);
});

test("asynchronous cleanup save preserves the edit on cancellation and commits once on retry", async t => {
  const { memory, context, ctx, f } = await prepared(t);
  const original = memory().read(ctx()).memory.slots[0]!;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  let cancelled = false;
  const overlay = new NuncOverlay({
    ctx: ctx(), memory: memory(), context: context(), tui: mockTui(), theme: ctx().ui.theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS), done() { overlay.dispose(); },
    prepareSave: async (_context, _proposal, signal) => {
      attempts++;
      if (attempts === 1) {
        started.resolve();
        await release.promise;
        cancelled = signal.aborted;
        return { stale: true };
      }
      return {};
    },
  });
  overlay.handleInput("\r");
  overlay.handleInput(" NATIVE_UI_EDIT");
  assert.match(overlay.draftText() ?? "", /NATIVE_UI_EDIT/, "draft before save");
  overlay.handleInput("\r");
  await started.promise;
  assert.match(visible(overlay.render(90)), /Saving/);
  overlay.handleInput("\x1b");
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(overlay.layerName, "edit");
  assert.match(overlay.draftText() ?? "", /NATIVE_UI_EDIT/);
  assert.equal(memory().read(ctx()).memory.slots[0]?.text, original.text);
  overlay.handleInput("\r");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(overlay.layerName, "browse");
  assert.match(memory().read(ctx()).memory.slots[0]?.text ?? "", /NATIVE_UI_EDIT/);
  assert.match(await readFile(f.runtime.session.sessionFile!, "utf8"), /NATIVE_UI_EDIT/);
});

test("native compact during edit conflicts on original revision and keeps draft", async t => {
  const { overlay, memory, ctx, f } = await prepared(t);
  const before = memory().read(ctx());
  overlay.handleInput("\r");
  overlay.handleInput(" Local draft.");
  const started = overlay.editRevision();
  f.seed("new-turn");
  f.respond(() => fauxAssistantMessage(JSON.stringify({ add: [{ key: "new", text: "New fact added by background maintenance." }], remove: [], priority: [...before.memory.slots.map(s => s.id), "new"], required: [] })));
  await f.runtime.session.compact();
  const expected = memory().replace(ctx(), before.revision, before.memory.slots[0]!.id, overlay.draftText() ?? "");
  assert.equal(expected.ok, false);
  if (!expected.ok) assert.equal(expected.code, "conflict");
  overlay.sync();
  assert.equal(overlay.editRevision(), started);
  overlay.handleInput("\r");
  assert.equal(overlay.layerName, "edit");
  assert.match(overlay.draftText() ?? "", /Local draft/);
  assert.equal(overlay.editRevision(), started);
});

test("inspector setStatus failure does not cancel native compact or save", async t => {
  const { memory, ctx, f } = await prepared(t);
  const ui = ctx().ui;
  const original = ui.setStatus.bind(ui);
  Object.defineProperty(ctx(), "hasUI", { configurable: true, get: () => true });
  let throws = 0;
  ui.setStatus = () => { throws += 1; throw new Error("inspector-status-failure"); };
  try {
    const before = f.runtime.session.sessionManager.getEntries().length;
    f.seed("ui-fail");
    f.respond(memoryPatch);
    await f.runtime.session.compact();
    assert(f.runtime.session.sessionManager.getEntries().length > before);
    const view = memory().read(ctx());
    const slot = view.memory.slots[0]!;
    const saved = memory().replace(ctx(), view.revision, slot.id, `${slot.text} despite UI`);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert(throws > 0);
  } finally {
    ui.setStatus = original;
  }
});

for (const action of ["save", "delete"] as const)
for (const mode of ["sync", "prepared", "cleanup-warning"] as const)
for (const inspector of ["context", "memory", "both"] as const)
test(`NuncUi ${action}/${mode} persists post-commit ${inspector} warning after close`, async t => {
  const { memory, context, ctx, overlay: unused, f } = await prepared(t);
  unused.dispose();
  // The event port exposes MemorySurface; the bound implementation also owns freeze.
  const realMem = memory() as MemoryFreeze, realCtx = context();
  for (const key of ["beginFreeze", "endFreeze", "noteForeignFailure"] as const) assert.equal(typeof realMem[key], "function");
  const initial = realMem.read(ctx());
  const slotId = initial.memory.slots[0]!.id;
  let committed = false;
  const ui = new NuncUi({
    memory: {
      ...realMem,
      read(...args) {
        if (committed && inspector !== "context") throw new Error("memory-inspector-fault-after-commit");
        return realMem.read(...args);
      },
      replace(...args) { const result = realMem.replace(...args); committed = result.ok; return result; },
      delete(...args) { const result = realMem.delete(...args); committed = result.ok; return result; },
      patch(...args) { const result = realMem.patch(...args); committed = result.ok; return result; },
    },
    context: { read(c) {
      if (committed && inspector !== "memory") throw new Error("context-inspector-fault-after-commit");
      return realCtx.read(c);
    } },
    supported() {},
    ...(mode === "sync" ? {} : { prepareSave: async () => mode === "cleanup-warning" ? { warning: "Cleanup failed after proposed mutation" } : {} }),
  });
  let overlay: NuncOverlay | undefined;
  const closed = Promise.withResolvers<null>();
  // Implement only the headless host's public custom-component lifecycle.
  const host: ReturnType<typeof ctx> = { ...ctx(), mode: "tui", hasUI: true, ui: { ...ctx().ui, custom: async factory => {
    // The overlay consumes TUI bindings only, without host keybinding-file persistence.
    const bindings = new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<typeof factory>[2];
    const component = await factory(mockTui(), ctx().ui.theme, bindings, () => closed.resolve(null));
    assert(component instanceof NuncOverlay);
    overlay = component;
    return await closed.promise as never;
  } } };
  const opening = ui.openOverlay(host);
  await new Promise(resolve => setImmediate(resolve));
  assert(overlay);
  try {
    if (action === "save") { overlay.handleInput("\r"); overlay.handleInput(" SAVED_POST_COMMIT"); }
    else overlay.handleInput("\x04");
    overlay.handleInput("\r");
    await new Promise(resolve => setImmediate(resolve));
    assert(committed);
    assert.equal(overlay.layerName, "browse");
    const persisted = realMem.read(ctx()).memory;
    if (action === "save") assert.match(persisted.slots.find(s => s.id === slotId)!.text, /SAVED_POST_COMMIT/);
    else assert(!persisted.slots.some(s => s.id === slotId));
    assert.equal(overlay.selectedSlotId(), persisted.slots[0]?.id, "acknowledged view remains usable if refresh fails");
    const warning = ui.currentWarning();
    assert(warning);
    if (inspector !== "memory") assert.match(warning, /context-inspector-fault-after-commit/);
    if (inspector !== "context") assert.match(warning, /memory-inspector-fault-after-commit/);
    if (mode === "cleanup-warning") {
      assert.match(warning, /Cleanup failed after proposed mutation/);
      assert.equal([...visible(overlay.render(180)).matchAll(/Cleanup failed after proposed mutation/g)].length, 2,
        "reentrant UI refresh retains cleanup in both the status line and local error");
    }
    assert(ui.recentDiagnostics().some(note => note.level === "warning" && note.message === warning));
    assert.match(await readFile(f.runtime.session.sessionFile!, "utf8"), /nunc\.memory/);
    overlay.handleInput("\x1b");
    await opening;
    assert.equal(ui.currentWarning(), warning);
    assert(ui.recentDiagnostics().some(note => note.message === warning));
  } finally { closed.resolve(null); await opening; }
});

for (const mode of ["cancel", "stale", "warning"] as const) test(`async delete ${mode} restores browse selection and focus`, async t => {
  const { memory, context, ctx } = await prepared(t);
  const before = memory().read(ctx());
  const release = Promise.withResolvers<{ stale?: boolean; warning?: string }>();
  const started = Promise.withResolvers<void>();
  const warnings: string[] = [];
  let successes = 0;
  const overlay = new NuncOverlay({ ctx: ctx(), memory: memory(), context: context(), tui: mockTui(), theme: ctx().ui.theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS), done() {},
    onWarning: warning => warnings.push(warning), onSuccess: () => { successes++; warnings.length = 0; },
    prepareSave: async () => { started.resolve(); return release.promise; },
  });
  t.after(() => overlay.dispose());
  overlay.handleInput("\x04");
  assert.equal(overlay.layerName, "confirm-delete");
  assert(!overlay.render(90).join("\n").includes("\x1b_pi:c\x07"), "confirmation must not focus search");
  overlay.handleInput("\r"); await started.promise;
  assert.equal(overlay.layerName, "saving");
  assert(!overlay.render(90).join("\n").includes("\x1b_pi:c\x07"), "saving must not focus search");
  if (mode === "cancel") overlay.handleInput("\x1b");
  release.resolve(mode === "stale" ? { stale: true } : { warning: "Cleanup failed after proposed delete" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(overlay.layerName, "browse");
  if (mode === "warning") {
    assert.equal(memory().read(ctx()).memory.slots.length, before.memory.slots.length - 1);
    assert.deepEqual(warnings, ["Cleanup failed after proposed delete"]);
    assert.equal(successes, 0, "successful commit must not clear its cleanup warning");
  } else {
    assert.deepEqual(memory().read(ctx()).memory, before.memory);
    assert.equal(overlay.selectedSlotId(), before.memory.slots[0]!.id);
    overlay.handleInput("no-match");
    assert.match(visible(overlay.render(90)), /No matching slots/, "restored search accepts input");
  }
});

test("delete confirmation rejects concurrent revision changes before cleanup", async t => {
  const { memory, context, ctx, overlay } = await prepared(t);
  let preparedCalls = 0;
  const guarded = new NuncOverlay({ ctx: ctx(), memory: memory(), context: context(), tui: mockTui(), theme: ctx().ui.theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS), done() {}, prepareSave: async () => { preparedCalls++; return {}; } });
  t.after(() => guarded.dispose());
  const original = memory().read(ctx());
  guarded.handleInput("\x04");
  assert(memory().replace(ctx(), original.revision, original.memory.slots[0]!.id, "Changed during confirmation.").ok);
  guarded.sync();
  assert.match(visible(guarded.render(90)), /changed before delete confirmation/);
  guarded.handleInput("\r");
  assert.equal(preparedCalls, 0);
  assert.equal(memory().read(ctx()).memory.slots[0]!.text, "Changed during confirmation.");
  overlay.dispose();
});

test("real Theme surface keeps ANSI complete and every row within terminal width", async t => {
  const { memory, context, ctx } = await prepared(t);
  // The uniform native Theme exercises actual ANSI generation, including fallback tokens.
  const colors = Object.fromEntries("accent border borderAccent borderMuted success error warning muted dim text thinkingText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode".split(" ").map(key => [key, "#dddddd"])) as ConstructorParameters<typeof Theme>[0];
  const backgrounds: ConstructorParameters<typeof Theme>[1] = { selectedBg: "#333333", customMessageBg: "#222222", userMessageBg: "#222222", toolPendingBg: "#222222", toolSuccessBg: "#222222", toolErrorBg: "#222222" };
  const theme = new Theme(colors, backgrounds, "truecolor");
  assert(theme.getBgAnsi("customMessageBg").startsWith("\x1b["));
  const overlay = new NuncOverlay({ ctx: ctx(), memory: memory(), context: context(), tui: mockTui(), theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS), done() {} });
  t.after(() => overlay.dispose());
  const original = memory().read(ctx());
  assert(memory().replace(ctx(), original.revision, original.memory.slots[0]!.id, "ANSI reset \x1b[m and bg \x1b[49m with 中文 and **markdown**.").ok);
  overlay.sync();
  for (const key of ["", "\x04", "\x1b", "\r", " extra", "\x1b"]) {
    if (key) overlay.handleInput(key);
    for (const width of [8, 10, 24, 40, 90, 120]) for (const line of overlay.render(width)) {
      assert(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
      const noControls = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
      assert(!noControls.includes("\x1b["), `truncated CSI: ${JSON.stringify(line)}`);
    }
  }
});

