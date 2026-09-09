import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, getKeybindings, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { NuncOverlay } from "../../src/ui/overlay.js";
import { NuncUi } from "../../src/ui/index.js";
import type { ContextView } from "../../src/pi/context.js";
import type { MemoryView } from "../../src/pi/manual.js";

function clean(lines: string[]): string {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:c\x07/g, "");
}

function fixture(options: { rows?: number; text?: string; failure?: string; unconfirmed?: boolean; keybindings?: KeybindingsManager } = {}) {
  const text = options.text ?? "original saved text";
  let view: MemoryView = {
    revision: "old",
    memory: { version: 1, nextId: 3, slots: [{ id: "s1", text }, { id: "s2", text: "second slot" }] },
    status: { occupied: false, unconfirmed: options.unconfirmed === true },
    budget: { tokens: 20, limit: 2000, unknown: false, overLimit: false },
    contextLayout: { slotCount: 2, activeEntries: 0 },
  };
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
        memory: { slots: view.memory.slots, tokens: 20, envelopeTokens: 1 },
        messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0,
        heuristic: { tokens: 27, unknown: false }, associations: [],
      },
      budget: {
        modelWindow: 10000, triggerTokens: 8000, plannedInputLimit: 8500, mainAdmissionLimit: 9999,
        memoryLimit: 2000, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: 1000,
        outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: 1000, extractionOutputCapTokens: null, safetyTokens: 500,
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
    ui: { theme: { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s }, setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }) },
  };
  const overlay = new NuncOverlay({
    ctx: ctx as never, memory: memory as never, context: { read: () => structuredClone(contextView()) } as never,
    tui: { requestRender() {}, terminal: { rows: options.rows ?? 40, columns: 120 } } as TUI,
    theme: ctx.ui.theme as never,
    keybindings: options.keybindings ?? new KeybindingsManager(TUI_KEYBINDINGS),
    done() { overlay.dispose(); },
  });
  return { overlay, memory, ctx, saves, statuses, get view() { return view; }, set view(next: MemoryView) { view = next; } };
}

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

test("edit keeps original revision when live saved view changes", () => {
  const f = fixture();
  f.overlay.handleInput("\r");
  f.overlay.handleInput(" local edit");
  const started = f.overlay.editRevision();
  f.view.revision = "new-checkpoint";
  f.view.memory.slots[0] = { id: "s1", text: "maintenance replacement" };
  f.overlay.sync();
  assert.equal(f.overlay.editRevision(), started);
  f.overlay.handleInput("\r");
  assert.equal(f.saves[0]?.rev, started);
  assert.match(f.saves[0]?.text ?? "", /local edit/);
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
    context: { read: () => ({ current: { scope: "current", sessionId: "s", leafId: "l", model: null, revision: "old", occupied: false, unconfirmed: false, contextLayout: { slotCount: 2, activeEntries: 0 }, layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: false }, associations: [] }, budget: { modelWindow: null, triggerTokens: null, plannedInputLimit: null, mainAdmissionLimit: null, memoryLimit: null, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: null, outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: null, extractionOutputCapTokens: null, safetyTokens: null } } }) } as never,
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
  const ui = new NuncUi({ memory: f.memory as never, context: { read: () => ({ current: { revision: "old", occupied: false, unconfirmed: true, layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: false }, associations: [] }, budget: { modelWindow: null, triggerTokens: null, plannedInputLimit: null, mainAdmissionLimit: null, memoryLimit: 2000, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: null, outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: null, extractionOutputCapTokens: null, safetyTokens: null }, contextLayout: { slotCount: 2, activeEntries: 0 }, scope: "current", sessionId: "s", leafId: "l", model: null } }) } as never, supported() {} });
  ui.attach(f.ctx as never);
  assert.equal(f.statuses.at(-1)?.key, "nunc");
  assert.match(f.statuses.at(-1)?.value ?? "", /nunc !/);
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

test("native backslash-enter submit still saves when enter is newline", () => {
  const old = getKeybindings();
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
  setKeybindings(kb);
  try {
    const f = fixture();
    f.overlay.handleInput("\r");
    f.overlay.handleInput(" \\");
    const before = f.overlay.draftText();
    assert.match(before ?? "", /\\/);
    f.overlay.handleInput("\r");
    assert.equal(f.saves.length, 1);
    assert.match(f.saves[0]?.text ?? "", /original saved text/);
    assert.equal(f.overlay.layerName, "browse");
    assert.notEqual(before, "");
  } finally {
    setKeybindings(old);
  }
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
      return { current: { scope: "current", sessionId: "s", leafId: "l", model: null, revision: "old", occupied: false, unconfirmed: false, contextLayout: { slotCount: 2, activeEntries: 0 }, layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: false }, associations: [] }, budget: { modelWindow: null, triggerTokens: null, plannedInputLimit: null, mainAdmissionLimit: null, memoryLimit: 2000, memoryOccupied: 20, memoryUnknown: false, outputReserveTokens: null, outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: null, extractionOutputCapTokens: null, safetyTokens: null } } };
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

test("rejected paste retains full draft in editor without clearing", () => {
  const f = fixture({ failure: "overbudget" });
  f.overlay.handleInput("\r");
  const pasted = Array.from({ length: 20 }, (_, i) => `中文粘贴行 ${i}`).join("\n");
  f.overlay.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  const before = f.overlay.draftText();
  assert(before && before.includes("中文粘贴行 19"));
  f.overlay.handleInput("\r");
  assert.equal(f.overlay.layerName, "edit");
  assert.equal(f.overlay.draftText(), before);
  assert.equal(f.saves[0]?.text.endsWith(pasted), true);
});

test("remapped keys and backslash fallback restore draft on save failure", () => {
  const old = getKeybindings();
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
  setKeybindings(kb);
  try {
    const f = fixture({ failure: "conflict" });
    f.overlay.handleInput("\r");
    f.overlay.handleInput(" failed edit");
    const before = f.overlay.draftText();
    // Shift+Enter submit fails
    f.overlay.handleInput("\x1b[27;2;13~");
    assert.equal(f.overlay.layerName, "edit");
    assert.equal(f.overlay.draftText(), before);
    assert.match(clean(f.overlay.render(90)), /REJECTED conflict/);

    // Backslash+Enter submit fails
    f.overlay.handleInput(" \\");
    const beforeBs = f.overlay.draftText();
    f.overlay.handleInput("\r");
    assert.equal(f.overlay.layerName, "edit");
    assert.match(clean(f.overlay.render(90)), /REJECTED conflict/);
  } finally {
    setKeybindings(old);
  }
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

test("untrimmed draft preserved across remapped submit and backslash fallback with paste", () => {
  const old = getKeybindings();
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
  setKeybindings(kb);
  try {
    const f = fixture({ failure: "overbudget", keybindings: kb });
    f.overlay.handleInput("\r");
    f.overlay.handleInput("\x15");
    const multilineWithIndent = "  def hello():\n    print(1)\n";
    f.overlay.handleInput(multilineWithIndent);
    const beforeShift = f.overlay.draftText();
    f.overlay.handleInput("\x1b[27;2;13~");
    assert.equal(f.overlay.layerName, "edit");
    assert.equal(f.overlay.draftText(), beforeShift);
    assert.equal(f.saves[0]?.text, multilineWithIndent);

    f.overlay.handleInput("\\");
    f.overlay.handleInput("\r");
    assert.equal(f.overlay.layerName, "edit");
    assert.equal(f.overlay.draftText(), multilineWithIndent);
  } finally {
    setKeybindings(old);
  }
});

test("compressed paste with literal backslash and Ctrl+A backslash fallback preserves exact untrimmed text", () => {
  const old = getKeybindings();
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
  setKeybindings(kb);
  try {
    const lines20 = Array.from({ length: 20 }, (_, i) => i === 19 ? "line 19 \\" : `line ${i}`).join("\n");

    // 1. Success case: paste 20 lines ending in literal backslash, Ctrl+A to start, type backslash, then Enter
    const successFixture = fixture({ keybindings: kb });
    successFixture.overlay.handleInput("\r");
    successFixture.overlay.handleInput("\x15");
    successFixture.overlay.handleInput(`\x1b[200~${lines20}\x1b[201~`);
    successFixture.overlay.handleInput("\x01"); // Ctrl+A to start
    successFixture.overlay.handleInput("\\");
    successFixture.overlay.handleInput("\r");
    assert.equal(successFixture.overlay.layerName, "browse");
    assert.equal(successFixture.saves[0]?.text, lines20);
    assert.equal(successFixture.saves[0]?.text.endsWith("\\"), true);
    assert.equal(successFixture.saves[0]?.text.startsWith("\\"), false);
    assert.equal(successFixture.view.memory.slots[0]?.text, lines20);

    // 2. Rejection case: same sequence but with conflict failure; draft must retain lines20 exactly
    const failureFixture = fixture({ failure: "conflict", keybindings: kb });
    failureFixture.overlay.handleInput("\r");
    failureFixture.overlay.handleInput("\x15");
    failureFixture.overlay.handleInput(`\x1b[200~${lines20}\x1b[201~`);
    failureFixture.overlay.handleInput("\x01"); // Ctrl+A to start
    failureFixture.overlay.handleInput("\\");
    failureFixture.overlay.handleInput("\r");
    assert.equal(failureFixture.overlay.layerName, "edit");
    assert.equal(failureFixture.overlay.draftText(), lines20);
    assert.equal(failureFixture.saves[0]?.text, lines20);
    assert.equal(failureFixture.overlay.draftText()?.endsWith("\\"), true);
    assert.equal(failureFixture.overlay.draftText()?.startsWith("\\"), false);

    // 3. Compressed paste with literal backslash and submit
    const afterCursorFixture = fixture({ failure: "overbudget", keybindings: kb });
    afterCursorFixture.overlay.handleInput("\r");
    afterCursorFixture.overlay.handleInput("\x15");
    afterCursorFixture.overlay.handleInput("prefix \\\n");
    afterCursorFixture.overlay.handleInput(`\x1b[200~${lines20}\x1b[201~`);
    const beforeSubmit = afterCursorFixture.overlay.draftText();
    afterCursorFixture.overlay.handleInput("\x1b[27;2;13~");
    assert.equal(afterCursorFixture.overlay.layerName, "edit");
    assert.equal(afterCursorFixture.overlay.draftText(), beforeSubmit);
    assert.equal(afterCursorFixture.saves[0]?.text, beforeSubmit);
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
  // 3. Save raw text: session receives exact raw text
  f.overlay.handleInput("\r");
  assert.equal(f.overlay.layerName, "browse");
  assert.equal(f.saves[0]?.text, rawText);
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

  // Navigate down to item 3: Legend · abbreviations
  f.overlay.handleInput("\x1b[B"); // to last-main
  f.overlay.handleInput("\x1b[B"); // to last-maintenance
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



