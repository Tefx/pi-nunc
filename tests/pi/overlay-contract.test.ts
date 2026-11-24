import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth, KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, getKeybindings, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { buildContextNodes } from "../../src/ui/context-tree.js";
import { NuncOverlay } from "../../src/ui/overlay.js";
import { NuncUi } from "../../src/ui/index.js";
import type { Accounting } from "../../src/engine/index.js";
import type { ContextView } from "../../src/pi/context.js";
import type { MemoryView } from "../../src/pi/manual.js";
import type { DiagnosticNote } from "../../src/ui/status.js";

function clean(lines: string[]): string {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:[^\x07]*\x07/g, "");
}

function fixture(options: { rows?: number; text?: string; failure?: string; unconfirmed?: boolean; keybindings?: KeybindingsManager } = {}) {
  const text = options.text ?? "original saved text";
  let view: MemoryView = {
    revision: "s\n\n\nl",
    memory: { version: 1, nextId: 3, slots: [{ id: "s1", text }, { id: "s2", text: "second slot" }] },
    status: { occupied: false, unconfirmed: options.unconfirmed === true },
    budget: { tokens: 20, limit: 2000, unknown: false, overLimit: false },
    contextLayout: { slotCount: 2, activeEntries: 0 },
  };
  let renders = 0;
  const saves: { rev: string; id: string; text: string }[] = [];
  const statuses: { key: string; value: string | undefined }[] = [];
  const memory = {
    read: () => structuredClone(view),
    replace(_ctx: unknown, rev: string, id: string, next: string) {
      saves.push({ rev, id, text: next });
      if (options.failure) return { ok: false as const, code: options.failure as "overbudget", message: `REJECTED ${options.failure}`, view: structuredClone(view) };
      view = { ...view, revision: `${rev}+`, memory: { ...view.memory, slots: view.memory.slots.map(slot => slot.id === id ? { ...slot, text: next } : slot) } };
      return { ok: true as const, revision: view.revision, memory: view.memory };
    },
    delete() { throw new Error("unexpected delete"); },
  };
  const contextView = (): ContextView => ({
    current: {
      scope: "current", sessionId: "s", leafId: "l", model: null, revision: view.revision,
      occupied: view.status.occupied, unconfirmed: view.status.unconfirmed, contextLayout: view.contextLayout,
      layout: {
        system: { text: "SYSTEM_BODY", tokens: 3 },
        tools: { count: 1, names: ["tool"], tokens: 4, unknown: false, definitions: [{ name: "tool", description: "Readable tool", parameters: { type: "object" }, tokens: 4, unknown: false }] },
        memory: { slots: view.memory.slots, tokens: 20, ...(view.slotProvenance ? { slotProvenance: view.slotProvenance } : {}) },
        messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0,
        heuristic: { tokens: 27, unknown: false }, associations: [],
      },
      budget: {
        modelWindow: 10000, triggerTokens: 8000, plannedInputLimit: 8500, mainAdmissionLimit: 9999,
        extractionInputLimit: 7000, memoryLimit: 2000, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: 1000,
        outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: 1000, extractionOutputCapTokens: null, extractionOutputCapKnown: true, safetyTokens: 500,
      },
    },
    lastMain: {
      scope: "last-main", observedAt: 1, sessionId: "s", leafId: "l",
      model: { id: "m", provider: "p", api: "openai-completions" }, outcome: "delegate",
      initialMetadataTokens: 7,
      layout: {
        system: { text: "REQ_SYS", tokens: 2 },
        tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] },
        messages: [{ order: 0, role: "user", tokens: 4, unknown: false, preview: "hello", blocks: [{ type: "text", tokens: 4, unknown: false, preview: "hello", text: "hello observed" }] }],
        messageCount: 1, blockCount: 1, packagingTokens: 0, extraInputTokens: 0,
        heuristic: { tokens: 6, unknown: false }, associations: [],
      },
      payload: { mode: "replacement", categories: ["input"], transform: "last-user-text-append", addedTokens: 3, addedText: "APPENDED_TEXT", chargedGrowthTokens: 5 },
    },
    lastMaintenance: {
      scope: "last-maintenance", observedAt: 2, sessionId: "s", leafId: "l",
      model: { id: "m", provider: "p", api: "openai-completions" }, reason: "threshold", engine: "ok", native: "saved",
      before: {
        memory: view.memory, entries: [{ entryId: "e1", sourceRole: "user", messages: [] }],
        messages: [{ order: 0, role: "user", tokens: 2, unknown: false, preview: "old", blocks: [{ type: "text", tokens: 2, unknown: false, preview: "old", text: "frozen body" }] }],
        system: { text: "FROZEN_SYS", tokens: 1 },
        tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] },
      },
      cut: { firstKeptEntryId: "keep1", retiredEntryIds: ["b1"], keptEntryIds: ["keep1"] },
      candidate: { memory: view.memory, firstKeptEntryId: "keep1" },
      after: { memory: view.memory, keptEntryIds: ["keep1"] },
    },
  });
  const ctx = {
    hasUI: true, mode: "tui",
    sessionManager: { getSessionId: () => view.revision.split("\n")[0], getLeafId: () => "l", buildContextEntries: () => [], getBranch: () => [] },
    ui: { theme: { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s }, setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }) },
  };
  const overlay = new NuncOverlay({
    ctx: ctx as never, memory: memory as never, context: { read: () => structuredClone(contextView()) } as never,
    tui: { requestRender() { renders++; }, terminal: { rows: options.rows ?? 40, columns: 120 } } as TUI,
    theme: ctx.ui.theme as never,
    keybindings: options.keybindings ?? new KeybindingsManager(TUI_KEYBINDINGS),
    done() { overlay.dispose(); },
  });
  return { overlay, memory, ctx, contextView, saves, statuses, get renders() { return renders; }, get view() { return view; }, set view(next: MemoryView) { view = next; } };
}

test("search cursor keys repaint without changing the filtered query", () => {
  const f = fixture();
  f.overlay.handleInput("original");
  for (const key of ["\x1b[D", "\x1b[C", "\x1b[H", "\x1b[F", "\x01", "\x05", "\x1bb", "\x1bf", "\x02", "\x06"]) {
    const before = f.renders;
    f.overlay.handleInput(key);
    assert.equal(f.renders, before + 1);
    assert.match(clean(f.overlay.render(90)), /Search original/);
    assert.equal(f.overlay.selectedSlotId(), "s1");
  }
});

test("remapped search navigation repaints and moves the native Input cursor", () => {
  const old = getKeybindings();
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.editor.cursorLeft": "f1", "tui.editor.cursorRight": "f2",
    "tui.editor.cursorLineStart": "f3", "tui.editor.cursorLineEnd": "f4",
    "tui.editor.cursorWordLeft": "f5", "tui.editor.cursorWordRight": "f6",
  });
  setKeybindings(kb);
  try {
    const f = fixture({ keybindings: kb });
    f.overlay.handleInput("original saved");
    const cursor = () => f.overlay.render(90).find(line => line.includes(CURSOR_MARKER))!;
    for (const key of ["\x1bOP", "\x1bOQ", "\x1bOR", "\x1bOS", "\x1b[15~", "\x1b[17~"]) {
      const previous = cursor();
      const renders = f.renders;
      f.overlay.handleInput(key);
      assert.equal(f.renders, renders + 1);
      assert.notEqual(cursor(), previous, "the public Input binding actually moves the cursor");
      assert.match(clean(f.overlay.render(90)), /Search original saved/);
      assert.equal(f.overlay.selectedSlotId(), "s1");
    }
    f.overlay.dispose();
  } finally { setKeybindings(old); }
});

test("nested Escape clears the local filter before returning to the parent", () => {
  const f = fixture();
  f.overlay.handleInput("\t"); f.overlay.handleInput("\r");
  f.overlay.handleInput("Fixed");
  assert.match(clean(f.overlay.render(90)), /Search Fixed/);
  f.overlay.handleInput("\x1b");
  const parent = clean(f.overlay.render(90));
  assert.doesNotMatch(parent, /Search Fixed/);
  assert.match(parent, /Current projection/);
  assert.match(parent, /Diagnostics/);
});

test("tall editors show every wrapped unload notice and error line", () => {
  const f = fixture({ rows: 50, failure: "DETAIL ".repeat(12) + "ERROR_TAIL" });
  f.overlay.handleInput("\r");
  f.overlay.handleInput(" changed"); f.overlay.handleInput("\r");
  const shown = clean(f.overlay.render(60));
  assert.match(shown, /last native summary\./);
  assert.match(shown, /ERROR_TAIL/);
  assert(shown.includes("save"));
});

test("rejected and occupied submits keep the full editor draft", () => {
  for (const failure of ["overbudget", "conflict", "unconfirmed"] as const) {
    const f = fixture({ failure });
    f.overlay.handleInput("\r");
    f.overlay.handleInput(" more draft");
    const before = f.overlay.draftText();
    f.overlay.handleInput("\r");
    assert.equal(f.overlay.layerName, "edit");
    assert.equal(f.overlay.draftText(), before);
    assert.match(clean(f.overlay.render(90)), /REJECTED/);
  }
  const occupied = fixture();
  occupied.overlay.handleInput("\r");
  occupied.overlay.handleInput(" more draft");
  occupied.view.status.occupied = true;
  occupied.overlay.sync();
  const before = occupied.overlay.draftText();
  occupied.overlay.handleInput("\r");
  assert.equal(occupied.saves.length, 0);
  assert.equal(occupied.overlay.draftText(), before);
  assert.equal(occupied.overlay.layerName, "edit");
});

test("edit rejects changed revision before attempting a save and keeps the original draft", () => {
  const f = fixture();
  f.overlay.handleInput("\r");
  f.overlay.handleInput(" local edit");
  const started = f.overlay.editRevision();
  f.view.revision = "new-checkpoint";
  f.view.memory.slots[0] = { id: "s1", text: "maintenance replacement" };
  f.overlay.sync();
  assert.equal(f.overlay.editRevision(), started);
  f.overlay.handleInput("\r");
  assert.equal(f.saves.length, 0);
  assert.match(f.overlay.draftText() ?? "", /local edit/);
  assert.equal(f.overlay.layerName, "edit");
  assert.match(clean(f.overlay.render(120)), /changed while editing/);
});

test("context arrows move the list; page keys scroll preview; recent scopes drill down", () => {
  const f = fixture();
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\r");
  f.overlay.handleInput("\r");
  const onSystem = clean(f.overlay.render(90));
  assert.match(onSystem, /system/);
  f.overlay.handleInput("\x1b[B");
  const onTools = clean(f.overlay.render(90));
  assert.notEqual(onSystem, onTools);
  assert.match(onTools, /tools/);
  f.overlay.handleInput("\x1b");
  f.overlay.handleInput("\x1b");
  f.overlay.handleInput("\x1b[B");
  const lastMain = clean(f.overlay.render(90));
  assert.match(lastMain, /Last main request/);
  f.overlay.handleInput("\x1b[B");
  const lastMaint = clean(f.overlay.render(90));
  assert.match(lastMaint, /Last maintenance/);
  f.overlay.handleInput("\r");
  const drilled = clean(f.overlay.render(90));
  assert.match(drilled, /B\/K|Before|Candidate|After/);
  f.overlay.handleInput("\x1b");
  f.overlay.handleInput("\x1b[A");
  f.overlay.handleInput("\r");
  assert.match(clean(f.overlay.render(90)), /Observation|initialMetadataTokens|Payload|hello observed|REQ_SYS/);
});

test("jumping from a scrolled Context slot starts its Slots preview at the top", () => {
  const f = fixture({ rows: 24, text: Array.from({ length: 100 }, (_, i) => `LINE_${String(i).padStart(3, "0")}`).join("\n") });
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\r"); // Current
  f.overlay.handleInput("\x1b[B");
  f.overlay.handleInput("\x1b[B"); // M
  f.overlay.handleInput("\r");
  assert.match(clean(f.overlay.render(90)), /LINE_000/);
  for (let i = 0; i < 20; i++) f.overlay.handleInput("\x1b[6~");
  assert.match(clean(f.overlay.render(90)), /LINE_099/);
  f.overlay.handleInput("\r"); // Jump to Slots
  assert.equal(f.overlay.tabName, "slots");
  assert.equal(f.overlay.selectedSlotId(), "s1");
  assert.match(clean(f.overlay.render(90)), /LINE_000/);
  assert.doesNotMatch(clean(f.overlay.render(90)), /LINE_099/);
  f.overlay.dispose();
});

test("short and multiline edit keep cursor plus save/exit hints", () => {
  const short = fixture({ rows: 12 });
  const browse = clean(short.overlay.render(36));
  assert.match(browse, /close|esc/i);
  short.overlay.handleInput("\r");
  const editLines = short.overlay.render(36);
  assert.equal(editLines.some(line => line.includes(CURSOR_MARKER)), true);
  assert.match(clean(editLines), /save/);
  const long = fixture({ rows: 24, text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") });
  long.overlay.handleInput("\r");
  const longLines = long.overlay.render(90);
  assert.equal(longLines.some(line => line.includes(CURSOR_MARKER)), true);
  assert.match(clean(longLines), /save/);
});

test("injected cancel binding closes browse", () => {
  const f = fixture();
  let closed = false;
  const overlay = new NuncOverlay({
    ctx: f.ctx as never, memory: f.memory as never,
    context: { read: () => ({ current: { scope: "current", sessionId: "s", leafId: "l", model: null, revision: "old", occupied: false, unconfirmed: false, contextLayout: { slotCount: 2, activeEntries: 0 }, layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: false }, associations: [] }, budget: { modelWindow: null, triggerTokens: null, plannedInputLimit: null, mainAdmissionLimit: null, extractionInputLimit: null, memoryLimit: null, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: null, outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: null, extractionOutputCapTokens: null, extractionOutputCapKnown: false, safetyTokens: null } } }) } as never,
    tui: { requestRender() {}, terminal: { rows: 40, columns: 120 } } as TUI,
    theme: f.ctx.ui.theme as never,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "q" }),
    done() { closed = true; overlay.dispose(); },
  });
  overlay.handleInput("q");
  assert.equal(closed, true);
});

test("sync rereads last-main without replacing an edit revision", () => {
  const f = fixture();
  f.overlay.handleInput("\r");
  f.overlay.handleInput(" keep");
  const started = f.overlay.editRevision();
  f.overlay.sync();
  assert.equal(f.overlay.editRevision(), started);
  assert.match(f.overlay.draftText() ?? "", /keep/);
});

test("unconfirmed footer is not a normal percentage", () => {
  const f = fixture({ unconfirmed: true });
  const ui = new NuncUi({ memory: f.memory as never, context: { read: () => ({ current: { revision: "old", occupied: false, unconfirmed: true, layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: false }, associations: [] }, budget: { modelWindow: null, triggerTokens: null, plannedInputLimit: null, mainAdmissionLimit: null, extractionInputLimit: null, memoryLimit: 2000, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: null, outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: null, extractionOutputCapTokens: null, extractionOutputCapKnown: false, safetyTokens: null }, contextLayout: { slotCount: 2, activeEntries: 0 }, scope: "current", sessionId: "s", leafId: "l", model: null } }) } as never, supported() {} });
  ui.attach(f.ctx as never);
  assert.equal(f.statuses.at(-1)?.key, "nunc");
  assert.match(f.statuses.at(-1)?.value ?? "", /🧠 !/);
  assert.doesNotMatch(f.statuses.at(-1)?.value ?? "", /%/);
});

test("page keys reach the last slot preview line", () => {
  const f = fixture({ rows: 24, text: Array.from({ length: 100 }, (_, i) => `LINE_${String(i).padStart(3, "0")}`).join("\n") });
  let visible = "";
  for (let i = 0; i < 120; i++) {
    visible = clean(f.overlay.render(90));
    f.overlay.handleInput("\x1b[6~");
  }
  assert.match(visible, /LINE_099/);
});

test("page inputs clamp before rendering so one PageUp leaves the bottom immediately", () => {
  for (const [down, up] of [["\x1b[6~", "\x1b[5~"], ["\x1b[6;5~", "\x1b[5;5~"]]) {
    const f = fixture({ rows: 24, text: Array.from({ length: 100 }, (_, i) => `LINE_${String(i).padStart(3, "0")}`).join("\n") });
    const initial = clean(f.overlay.render(90));
    const position = / (\d+)–(\d+) \/ (\d+) /.exec(initial);
    assert(position);
    const viewport = Number(position[2]) - Number(position[1]) + 1;
    const total = Number(position[3]);
    for (let i = 0; i < 120; i++) f.overlay.handleInput(down!);
    f.overlay.handleInput(up!);
    const shown = clean(f.overlay.render(90));
    const after = / (\d+)–(\d+) \/ (\d+) /.exec(shown);
    assert(after);
    assert.equal(Number(after[1]), total - 2 * viewport + 1);
    assert.doesNotMatch(shown, /LINE_099/);
    f.overlay.dispose();
  }
});

test("short 12-line edit keeps cursor on the last line and rejected error", () => {
  const f = fixture({ rows: 12, text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"), failure: "overbudget" });
  f.overlay.handleInput("\r");
  const before = f.overlay.render(36);
  assert.equal(before.some(line => line.includes(CURSOR_MARKER)), true);
  f.overlay.handleInput(" draft");
  f.overlay.handleInput("\r");
  const failed = clean(f.overlay.render(36));
  assert.match(failed, /REJECTED/);
  assert.match(failed, /save/);
  assert.equal(f.overlay.render(36).some(line => line.includes(CURSOR_MARKER)), true);
  assert.equal(f.overlay.layerName, "edit");
});

test("refresh isolates inspector read failures", () => {
  const f = fixture();
  const ui = new NuncUi({
    memory: f.memory as never,
    context: { read() { throw new Error("inspector-read-failure"); } } as never,
    supported() {},
  });
  ui.attach(f.ctx as never);
  assert.doesNotThrow(() => ui.refresh(f.ctx as never));
  let boom = false;
  const overlay = new NuncOverlay({
    ctx: f.ctx as never, memory: f.memory as never,
    context: { read: () => {
      if (boom) throw new Error("inspector-read-failure");
      return { current: { scope: "current", sessionId: "s", leafId: "l", model: null, revision: "old", occupied: false, unconfirmed: false, contextLayout: { slotCount: 2, activeEntries: 0 }, layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: false }, associations: [] }, budget: { modelWindow: null, triggerTokens: null, plannedInputLimit: null, mainAdmissionLimit: null, extractionInputLimit: null, memoryLimit: 2000, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: null, outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: null, extractionOutputCapTokens: null, extractionOutputCapKnown: false, safetyTokens: null } } };
    } } as never,
    tui: { requestRender() {}, terminal: { rows: 40, columns: 120 } } as TUI,
    theme: f.ctx.ui.theme as never, keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    done() { overlay.dispose(); },
  });
  overlay.handleInput("\r");
  overlay.handleInput(" keep-draft");
  boom = true;
  assert.doesNotThrow(() => overlay.sync());
  assert.match(overlay.draftText() ?? "", /keep-draft/);
});

test("native composed 12x40 terminal sink keeps cursor, error, and save/cancel hints", () => {
  const f = fixture({ rows: 12, text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"), failure: "overbudget" });
  f.overlay.handleInput("\r");
  f.overlay.handleInput(" draft");
  f.overlay.handleInput("\r");

  let output = "";
  const terminal = new Proxy(
    { rows: 12, columns: 40, write(data: string) { output += data; } },
    { get(target, prop) { return prop in target ? (target as Record<string, unknown>)[prop as string] : () => {}; } }
  );
  const tui = new TuiMainScreen(terminal as never);
  tui.start();
  tui.showOverlay(f.overlay, { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 });
  tui.renderNow(true);

  const shown = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.equal(f.overlay.render(36).length <= 10, true);
  assert.equal(shown.includes("REJECTED"), true);
  assert.equal(shown.includes("save"), true);
  assert.equal(shown.includes("cancel"), true);
  assert.equal(f.overlay.render(36).some(line => line.includes(CURSOR_MARKER)), true);
  tui.stop();
});

test("untrimmed leading/trailing whitespace and newlines are preserved across save failure and success", () => {
  const failureFixture = fixture({ failure: "conflict" });
  failureFixture.overlay.handleInput("\r");
  failureFixture.overlay.handleInput("\x15");
  const indented = "    indented memory text\n";
  failureFixture.overlay.handleInput(indented);
  const before = failureFixture.overlay.draftText();
  assert.equal(before, indented);
  failureFixture.overlay.handleInput("\r");
  assert.equal(failureFixture.overlay.layerName, "edit");
  assert.equal(failureFixture.overlay.draftText(), indented);
  assert.equal(failureFixture.saves[0]?.text, indented);

  const successFixture = fixture();
  successFixture.overlay.handleInput("\r");
  successFixture.overlay.handleInput("\x15");
  successFixture.overlay.handleInput(indented);
  successFixture.overlay.handleInput("\r");
  assert.equal(successFixture.overlay.layerName, "browse");
  assert.equal(successFixture.saves[0]?.text, indented);
  assert.equal(successFixture.view.memory.slots[0]?.text, indented);
});

test("explicit whitespace-only text fails as invalid and retains draft in editor", () => {
  const f = fixture();
  f.overlay.handleInput("\r");
  f.overlay.handleInput("\x15");
  const spaces = "    \n    ";
  f.overlay.handleInput(spaces);
  const before = f.overlay.draftText();
  f.overlay.handleInput("\r");
  assert.equal(f.overlay.layerName, "edit");
  assert.equal(f.overlay.draftText(), before);
  assert.match(clean(f.overlay.render(90)), /Empty text|invalid|not a valid/i);
});

test("remapped submit and backslash fallback preserve compressed paste and literal backslashes", () => {
  const old = getKeybindings();
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
  setKeybindings(kb);
  try {
    const pasted = Array.from({ length: 20 }, (_, i) => i === 19 ? "line 19 \\" : `中文 line ${i}`).join("\n");
    for (const { submit, failure } of [
      { submit: "backslash", failure: undefined },
      { submit: "backslash", failure: "conflict" },
      { submit: "shift", failure: "overbudget" },
    ] as const) {
      const f = fixture({ keybindings: kb, ...(failure ? { failure } : {}) });
      f.overlay.handleInput("\r");
      f.overlay.handleInput("\x15");
      const prefix = submit === "shift" ? "  prefix \\\n" : "";
      if (prefix) f.overlay.handleInput(prefix);
      f.overlay.handleInput(`\x1b[200~${pasted}\x1b[201~`);
      const expected = prefix + pasted;
      assert.equal(f.overlay.draftText(), expected);
      if (submit === "backslash") {
        f.overlay.handleInput("\x01"); // Insert the submit marker before the compressed paste.
        f.overlay.handleInput("\\");
        f.overlay.handleInput("\r");
      } else {
        f.overlay.handleInput("\x1b[27;2;13~");
      }
      assert.deepEqual(f.saves.map(save => save.text), [expected]);
      assert.equal(f.overlay.layerName, failure ? "edit" : "browse");
      if (failure) {
        assert.equal(f.overlay.draftText(), expected);
        assert.match(clean(f.overlay.render(90)), new RegExp(`REJECTED ${failure}`));
      } else {
        assert.equal(f.view.memory.slots[0]?.text, expected);
      }
      f.overlay.dispose();
    }
  } finally {
    setKeybindings(old);
  }
});

test("slot preview formats Markdown while editor draft and session memory preserve raw text", () => {
  const rawText = "## Policy\n\n- **Must** retain `Node 18`\n- Example code:\n  ```js\n  const a = 1;\n  ```";
  const f = fixture({ text: rawText });
  // 1. Browse mode: slot preview renders with Markdown formatting
  const preview = clean(f.overlay.render(80));
  assert.match(preview, /Policy/);
  assert.match(preview, /Must retain/);
  assert.match(preview, /const a = 1;/);
  // 2. Enter edit mode: editor receives exact raw text, unformatted and unnormalized
  f.overlay.handleInput("\r");
  assert.equal(f.overlay.layerName, "edit");
  assert.equal(f.overlay.draftText(), rawText);
  assert.equal(f.view.memory.slots[0]?.text, rawText);
  // Unchanged submit exits without rewriting memory.
  f.overlay.handleInput("\r");
  assert.equal(f.overlay.layerName, "browse");
  assert.equal(f.saves.length, 0);
  assert.equal(f.view.memory.slots[0]?.text, rawText);
});

test("multiline wrapped markdown preview scrolls to the exact final line with page keys", () => {
  const mdItems = Array.from({ length: 50 }, (_, i) => `- Item **#${i}**: code \`val_${i}\` for testing`).join("\n");
  const f = fixture({ rows: 20, text: mdItems });
  let visible = "";
  for (let i = 0; i < 60; i++) {
    visible = clean(f.overlay.render(80));
    f.overlay.handleInput("\x1b[6~"); // PageDown
  }
  assert.match(visible, /Item #49/);
});

test("context abbreviations legend is reachable in panel and explains F, M, R, B, K, D", () => {
  const f = fixture();
  f.overlay.handleInput("\t"); // switch to Context tab
  assert.equal(f.overlay.tabName, "context");

  // Navigate down to Legend · abbreviations (after current, last-main, last-maintenance, Diagnostics)
  f.overlay.handleInput("\x1b[B"); // to last-main
  f.overlay.handleInput("\x1b[B"); // to last-maintenance
  f.overlay.handleInput("\x1b[B"); // to Diagnostics
  f.overlay.handleInput("\x1b[B"); // to Legend
  const legendPreview = clean(f.overlay.render(90));
  assert.match(legendPreview, /F \(Fixed\)/);
  assert.match(legendPreview, /M \(Memory\)/);
  assert.match(legendPreview, /R \(Raw history\)/);
  assert.match(legendPreview, /B \(Retiring\)/);
  assert.match(legendPreview, /K \(Kept\)/);
  assert.match(legendPreview, /D \(Queued\)/);

  // Enter to drill down into individual abbreviation nodes
  f.overlay.handleInput("\r");
  const legendDrill = clean(f.overlay.render(90));
  assert.match(legendDrill, /F · Fixed/);
  assert.match(legendDrill, /M · Memory/);
  assert.match(legendDrill, /R · Raw history/);
  assert.match(legendDrill, /B · Retiring/);
  assert.match(legendDrill, /K · Kept/);
  assert.match(legendDrill, /D · Queued input/);

  // Move down to M
  f.overlay.handleInput("\x1b[B");
  const mPreview = clean(f.overlay.render(90));
  assert.match(mPreview, /structured working memory/);
  assert.match(mPreview, /constraints and facts/);

  // Move down to B
  f.overlay.handleInput("\x1b[B");
  f.overlay.handleInput("\x1b[B");
  const bPreview = clean(f.overlay.render(90));
  assert.match(bPreview, /leave model-visible context/);
  assert.match(bPreview, /not predicted in advance/);

  // Move down to K
  f.overlay.handleInput("\x1b[B");
  const kPreview = clean(f.overlay.render(90));
  assert.match(kPreview, /verbatim history suffix/);
  assert.match(kPreview, /with new input/);

  // Move down to D
  f.overlay.handleInput("\x1b[B");
  const dPreview = clean(f.overlay.render(90));
  assert.match(dPreview, /Queued/);
  assert.match(dPreview, /scheduling rules/);

  // Esc returns to root level of Context tab
  f.overlay.handleInput("\x1b");
  assert.match(clean(f.overlay.render(90)), /Legend · abbreviations/);
});

function sampleAccounting(over: Partial<Accounting> = {}): Accounting {
  return {
    estimator: "pi-heuristic",
    outputReserveTokens: 8192,
    outputCapTokens: 8192,
    normalHeadroomSufficient: false,
    suggestedReserveTokens: 20000,
    inputExceededPlan: true,
    outputExceededPlan: false,
    fixedTokens: 100,
    mainBeforeTokens: 1000,
    mainInputLimit: 50000,
    extractionInputLimit: 40000,
    effectiveTrigger: 24000,
    memoryLimit: 2000,
    keepTarget: 1000,
    keptTokens: 800,
    fullExtractionTokens: 45000,
    extractionTokens: 30000,
    normalExtractionAtTrigger: 41000,
    mainAfterTokens: 900,
    memoryTokens: 20,
    growthTokens: 1024,
    ...over,
  };
}

test("context Budget, Last maintenance accounting, Diagnostics, and warning summary share one view", () => {
  const f = fixture();
  const notes: DiagnosticNote[] = [{ level: "warning", message: "Admission CAPACITY\nprivate body" }];
  let warning: string | undefined = "Admission CAPACITY\nprivate body";
  const overlay = new NuncOverlay({
    ctx: f.ctx as never, memory: f.memory as never,
    diagnostics: () => ({ notes, ...(warning ? { warning } : {}) }),
    context: { read: () => ({
      current: {
        scope: "current" as const, sessionId: "s", leafId: "l",
        model: { id: "m", provider: "p", api: "openai-completions" }, revision: "old",
        occupied: false, unconfirmed: false, contextLayout: { slotCount: 2, activeEntries: 0 },
        layout: {
          system: { text: "SYSTEM_BODY", tokens: 3 },
          tools: { count: 1, names: ["tool"], tokens: 4, unknown: false, definitions: [{ name: "tool", description: "Readable tool", parameters: { type: "object" }, tokens: 4, unknown: false }] },
          memory: { slots: f.view.memory.slots, tokens: 20 },
          messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0,
          heuristic: { tokens: 27, unknown: false }, associations: [],
        },
        budget: {
          modelWindow: 10000, triggerTokens: 8000, plannedInputLimit: 8500, mainAdmissionLimit: 9999,
          extractionInputLimit: 11111, memoryLimit: 0, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: 1000,
          outputCapTokens: null, outputCapKnown: true, extractionOutputTokens: 8192, extractionOutputCapTokens: null, extractionOutputCapKnown: true, safetyTokens: 0,
        },
      },
      lastMaintenance: {
        scope: "last-maintenance" as const, observedAt: 2, sessionId: "s", leafId: "l",
        model: { id: "m", provider: "p", api: "openai-completions" }, reason: "threshold", engine: "ok" as const, native: "saved" as const,
        before: {
          memory: f.view.memory, entries: [], messages: [],
          system: { text: "FROZEN_SYS", tokens: 1 },
          tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] },
        },
        cut: { firstKeptEntryId: "keep1", retiredEntryIds: ["b1"], keptEntryIds: ["keep1"] },
        candidate: { memory: f.view.memory, firstKeptEntryId: "keep1" },
        after: { memory: f.view.memory, keptEntryIds: ["keep1"] },
        accounting: sampleAccounting(),
      },
    }) } as never,
    tui: { requestRender() {}, terminal: { rows: 40, columns: 120 } } as TUI,
    theme: f.ctx.ui.theme as never, keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    done() { overlay.dispose(); },
  });
  overlay.handleInput("\t");
  const root = clean(overlay.render(90));
  assert.match(root, /warning Admission CAPACITY/);
  assert.match(root, /Diagnostics/);
  overlay.handleInput("\r");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  const budget = clean(overlay.render(90));
  assert.match(budget, /Maintenance input plan: 11,111/);
  assert.doesNotMatch(budget, /Last-maintenance input plan/);
  assert.match(budget, /M occupancy \/ organizing target: 20 \/ target 0 · over target/);
  assert.match(budget, /Main output cap: none/);
  assert.match(budget, /Maintenance output cap: none/);
  assert.match(budget, /Safety: 0/);
  assert.doesNotMatch(budget, /no model/);
  overlay.handleInput("\x1b");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  const maint = clean(overlay.render(90));
  assert.match(maint, /Input estimate: full 45,000 → selected 30,000/);
  assert.match(maint, /Last-maintenance input plan: 40,000/);
  assert.doesNotMatch(maint, /Last-maintenance input plan: 11,111/);
  assert.doesNotMatch(maint, /Maintenance input plan: 11,111/);
  assert.match(maint, /Normal-trigger headroom: insufficient; suggest reserveTokens ≥ 20,000/);
  assert.match(maint, /Over-plan records: input yes \/ output no/);
  assert.match(maint, /Native save: saved/);
  overlay.handleInput("\x1b[B");
  const diagRoot = clean(overlay.render(90));
  assert.match(diagRoot, /Diagnostics/);
  assert.doesNotMatch(diagRoot, /private body/);
  overlay.handleInput("\r");
  assert.match(clean(overlay.render(90)), /private body/);
  warning = undefined;
  overlay.sync();
  assert.doesNotMatch(clean(overlay.render(90)), /warning Admission CAPACITY/);
  assert.match(clean(overlay.render(90)), /Admission CAPACITY/);
});

test("overlay height and browse divider stay fixed across slots, filters, tabs and layers", () => {
  const f = fixture({ text: "short" });
  f.view.memory.slots[1]!.text = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}\n\n**Markdown body ${i}**`).join("\n\n");
  f.overlay.sync();
  const initial = f.overlay.render(90);
  const divider = (lines: string[]) => lines.findIndex(line => /^│ ─/.test(clean([line])));
  const height = initial.length, row = divider(initial);
  assert(row > 0);
  const browse = () => { const lines = f.overlay.render(90); assert.equal(lines.length, height); assert.equal(divider(lines), row); };
  browse();
  for (const key of ["\x1b[B", "\x1b[A", "\t", "\t", "short", "no-match", "\x15"]) { f.overlay.handleInput(key); browse(); }
  f.overlay.handleInput("\x04");
  assert.equal(f.overlay.layerName, "confirm-delete");
  assert.equal(f.overlay.render(90).length, height);
  f.overlay.handleInput("\x1b");
  f.overlay.handleInput("\r");
  assert.equal(f.overlay.layerName, "edit");
  assert.equal(f.overlay.render(90).length, height);
  f.overlay.handleInput("changed");
  f.overlay.handleInput("\x1b");
  assert.equal(f.overlay.layerName, "confirm-discard");
  assert.equal(f.overlay.render(90).length, height);
});

test("normalized, SGR and X10 wheels clamp preview without entering search", () => {
  const f = fixture({ rows: 30, text: Array.from({ length: 100 }, (_, i) => `LINE_${String(i).padStart(3, "0")}\n`).join("\n") });
  const render = () => clean(f.overlay.render(90));
  const mouse = (wheelDelta: number) => f.overlay.handleMouse({ type: "wheel", button: "none", x: 10, y: 10, screenX: 10, screenY: 10, width: 90, height: 30, shift: false, alt: false, ctrl: false, wheelDelta });
  assert.match(render(), /LINE_000/);
  const position = () => {
    const match = / (\d+)–(\d+) \/ (\d+) /.exec(render());
    assert(match);
    return { start: Number(match[1]), view: Number(match[2]) - Number(match[1]) + 1 };
  };
  mouse(5);
  assert.equal(position().start, 6, "normalized delta is measured in logical lines");
  mouse(-5);
  assert.equal(position().start, 1);
  for (let i = 0; i < 100; i++) { assert.deepEqual(mouse(5), { handled: true, render: true }); render(); }
  assert.match(render(), /LINE_099/);
  for (let i = 0; i < 100; i++) { mouse(-5); render(); }
  assert.match(render(), /LINE_000/);
  for (const down of ["\x1b[<65;20;15M", "\x1b[<73;20;15M", "\x1b[M" + String.fromCharCode(97, 52, 47)]) {
    const expectedStep = down.includes("<73;") ? position().view : 3;
    f.overlay.handleInput(down);
    assert.equal(position().start, 1 + expectedStep);
    for (let i = 0; i < 100; i++) { f.overlay.handleInput(down); render(); }
    assert.match(render(), /LINE_099/);
    assert.doesNotMatch(render(), /No matching slots/);
    for (let i = 0; i < 100; i++) { f.overlay.handleInput("\x1b[<64;20;15M"); render(); }
    assert.match(render(), /LINE_000/);
  }
  f.overlay.handleInput("\x1b[M" + String.fromCharCode(97, 52, 47));
  assert.equal(position().start, 4);
  f.overlay.handleInput("\x1b[M" + String.fromCharCode(96, 52, 47));
  assert.equal(position().start, 1);
  for (const data of ["\x1b[<0;20;15M", "\x1b[<0;20;15m", "\x1b[<32;20;15M", "\x1b[M" + String.fromCharCode(32, 52, 47)]) f.overlay.handleInput(data);
  assert.match(render(), /LINE_000/);
  assert.doesNotMatch(render(), /No matching slots/);
  assert.match(render(), /\d+–\d+ \/ \d+/);
});


test("slot provenance badges reach list and preview without changing raw drafts or narrow panel geometry", () => {
  const raw = "**Saved**  text\n\n- Keep punctuation and spaces.";
  const f = fixture({ text: raw });
  f.view.slotProvenance = { s1: { unmodifiedCompactions: 2, unmodifiedTurns: 5, originInActiveWindow: false } };
  f.overlay.sync();
  const wide = clean(f.overlay.render(120));
  assert(wide.includes("[2c · 5t · outside-window]"), "Slots list shows provenance before the collapsed body");
  assert(wide.includes("s1  2c · 5t · outside-window"), "Slots preview header has the same badge");
  const nodes = buildContextNodes(f.contextView(), []);
  assert.equal(nodes.get("current:M:s1")?.description, "[2c · 5t · outside-window] **Saved** text - Keep punctuation and spaces.");
  assert.equal(nodes.get("current:M:s1")?.preview, raw, "context preview remains the unmodified Markdown body");
  assert.match(nodes.get("current:M:s2")?.description ?? "", /^\[age unknown\]/);
  assert(!nodes.get("maint:candidate:s2")?.description?.includes("age unknown"));
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\r"); // Current
  f.overlay.handleInput("\x1b[B");
  f.overlay.handleInput("\x1b[B"); // M
  f.overlay.handleInput("\r");
  assert.match(clean(f.overlay.render(120)), /s1  2c · 5t · outside-window/);
  f.overlay.handleInput("\t"); // Slots
  f.overlay.handleInput("\r");
  assert.equal(f.overlay.draftText(), raw, "editor must never receive a badge");
  f.overlay.dispose();

  const unknown = fixture();
  unknown.view.slotProvenance = {};
  unknown.overlay.sync();
  assert.match(clean(unknown.overlay.render(120)), /\[age unknown\]/);
  assert.match(clean(unknown.overlay.render(120)), /s1  age unknown/);
  unknown.overlay.dispose();

  const plain = fixture({ rows: 12 });
  const baselineRows = plain.overlay.render(36).length;
  plain.view.slotProvenance = { s1: { unmodifiedCompactions: 2, unmodifiedTurns: 5, originInActiveWindow: false } };
  plain.overlay.sync();
  for (const provenance of [plain.view.slotProvenance, {}]) {
    plain.view.slotProvenance = provenance;
    plain.overlay.sync();
    const narrow = plain.overlay.render(36);
    assert.equal(narrow.length, baselineRows, "badge truncation cannot add rows at 36x12");
    assert(narrow.length <= 12);
    assert(narrow.every(line => visibleWidth(line) <= 36), "ANSI-safe truncation respects terminal width");
  }
  plain.overlay.dispose();
});
