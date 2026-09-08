import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Input,
  Key,
  KeybindingsManager,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type Keybinding,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ContextSurface, ContextView } from "../pi/context.js";
import type { MemorySurface, MemoryView } from "../pi/manual.js";
import { buildContextNodes, type CtxNode } from "./context-tree.js";
import { UNLOAD_LIMIT, thousands } from "./status.js";

export type OverlayTab = "slots" | "context";
type Layer = "browse" | "edit" | "confirm-delete" | "confirm-discard";

export interface OverlayHost {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  ctx: ExtensionContext;
  memory: MemorySurface;
  context: ContextSurface;
  done: () => void;
  onFailure?: (message: string) => void;
  onSuccess?: () => void;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_RESET_RE = /\x1b\[(?:0)?m/g;

function interceptSubmit(editor: Editor, attempt: (text: string) => void): void {
  Object.defineProperty(editor, "submitValue", {
    configurable: true,
    value() {
      if (editor.disableSubmit) return;
      attempt(editor.getExpandedText());
    },
  });
}

export class NuncOverlay implements Focusable {
  private readonly host: OverlayHost;
  private readonly search: Input;
  private readonly editorTui: TUI;
  private memoryView: MemoryView;
  private contextView: ContextView;
  private tab: OverlayTab = "slots";
  private layer: Layer = "browse";
  private list: SelectList;
  private editor: Editor | undefined;
  private editBasis: { revision: string; slotId: string; original: string } | undefined;
  private editorRows = 6;
  private preferredSlot: string | undefined;
  private contextPath: string[] = [];
  private previewOffset = 0;
  private previewViewport = 1;
  private error: string | undefined;
  private closed = false;
  private _focused = true;
  private listHeight = 4;
  private nodes = new Map<string, CtxNode>();

  constructor(host: OverlayHost) {
    this.host = host;
    this.search = new Input({ prompt: "", placeholder: "Search…", placeholderStyle: text => this.host.theme.fg("muted", text) });
    this.search.focused = true;
    this.memoryView = host.memory.read(host.ctx);
    try {
      this.contextView = host.context.read(host.ctx);
    } catch (error) {
      this.contextView = { current: { scope: "current", sessionId: this.memoryView.revision, leafId: null, model: null, revision: this.memoryView.revision, occupied: this.memoryView.status.occupied, unconfirmed: this.memoryView.status.unconfirmed, contextLayout: this.memoryView.contextLayout, layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: true }, associations: [] }, budget: { modelWindow: null, triggerTokens: null, plannedInputLimit: null, mainAdmissionLimit: null, memoryLimit: this.memoryView.budget.limit, memoryOccupied: this.memoryView.budget.tokens, memoryUnknown: this.memoryView.budget.unknown, outputReserveTokens: null, outputCapTokens: null, outputCapKnown: false, extractionOutputTokens: null, extractionOutputCapTokens: null, safetyTokens: null } } };
      this.error = error instanceof Error ? error.message : "Inspector read failed";
    }
    const overlay = this;
    this.editorTui = {
      requestRender: () => overlay.host.tui.requestRender(),
      get terminal() {
        const terminal = overlay.host.tui.terminal;
        return new Proxy(terminal, { get(target, prop, receiver) {
          if (prop === "rows") return overlay.editorRows;
          return Reflect.get(target, prop, receiver);
        } });
      },
    } as TUI;
    this.list = this.makeList([]);
    this.rebuildList();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    const editing = this.layer === "edit" && this.editor !== undefined;
    this.search.focused = value && !editing;
    if (this.editor) this.editor.focused = value && editing;
  }

  get tabName(): OverlayTab { return this.tab; }
  get layerName(): Layer { return this.layer; }
  selectedSlotId(): string | undefined { return this.tab === "slots" ? this.list.getSelectedItem()?.value : undefined; }
  draftText(): string | undefined { return this.editor?.getText(); }
  editRevision(): string | undefined { return this.editBasis?.revision; }

  sync(): void {
    if (this.closed) return;
    try {
      this.memoryView = this.host.memory.read(this.host.ctx);
      this.contextView = this.host.context.read(this.host.ctx);
      if (this.layer === "browse") this.rebuildList();
      else if (this.editBasis && this.memoryView.revision !== this.editBasis.revision) {
        this.error = "Saved memory changed while editing; review before saving. Draft keeps the original revision.";
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Inspector read failed";
    }
    try { this.host.tui.requestRender(); } catch { /* Paint only. */ }
  }

  dispose(): void {
    this.closed = true;
    this.search.focused = false;
    if (this.editor) this.editor.focused = false;
    this.editor = undefined;
    this.editBasis = undefined;
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
    this.editor?.invalidate();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.layer === "confirm-delete") return this.handleConfirm(data, () => this.deleteSelected());
    if (this.layer === "confirm-discard") return this.handleConfirm(data, () => this.leaveEdit(true));
    if (this.layer === "edit") return this.handleEdit(data);
    this.handleBrowse(data);
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    if (renderWidth < 8) return [truncateToWidth("Nunc", renderWidth)];
    const rows = Number.isFinite(this.host.tui.terminal?.rows) ? this.host.tui.terminal.rows : 24;
    const withShadow = renderWidth >= 10 && rows >= 10;
    const boxWidth = withShadow ? renderWidth - 1 : renderWidth;
    const contentWidth = Math.max(1, boxWidth - 4);
    const maxBox = Math.max(8, Math.min(Math.floor(rows * 0.9), rows - (rows >= 12 ? 1 : 0)));
    const innerBudget = Math.max(5, maxBox - 2 - (withShadow ? 1 : 0));
    this.listHeight = Math.max(1, Math.min(8, Math.floor(innerBudget / 3)));
    const title = this.host.theme.fg("accent", this.host.theme.bold("Nunc"));
    const topTitle = truncateToWidth(`─ ${title} `, boxWidth - 2);
    const topMiddle = `${topTitle}${"─".repeat(Math.max(0, boxWidth - 2 - visibleWidth(topTitle)))}`;
    const inner = this.layer === "edit" ? this.renderEditor(contentWidth, innerBudget)
      : this.layer === "confirm-delete" || this.layer === "confirm-discard" ? this.fit(this.renderConfirm(contentWidth), innerBudget)
      : this.renderBrowse(contentWidth, innerBudget);
    const lines = [
      this.borderRow("╭", topMiddle, "╮", boxWidth, withShadow),
      ...inner.map(line => this.boxRow(line, contentWidth, withShadow)),
      this.borderRow("╰", "─".repeat(Math.max(0, boxWidth - 2)), "╯", boxWidth, withShadow),
    ];
    return withShadow ? [...lines, this.shadowLine(boxWidth)] : lines;
  }

  private handleBrowse(data: string): void {
    if (this.hit(data, "tui.select.cancel")) {
      if (this.tab === "context" && this.contextPath.length > 0) {
        this.contextPath.pop();
        this.previewOffset = 0;
        this.rebuildList();
        this.host.tui.requestRender();
        return;
      }
      this.close();
      return;
    }
    if (this.hit(data, "tui.input.tab")) {
      this.tab = this.tab === "slots" ? "context" : "slots";
      this.search.setValue("");
      this.contextPath = [];
      this.previewOffset = 0;
      this.error = undefined;
      this.rebuildList();
      this.host.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.tab === "slots" && this.list.getSelectedItem()) {
        this.layer = "confirm-delete";
        this.search.focused = false;
        this.host.tui.requestRender();
      }
      return;
    }
    if (this.hit(data, "tui.select.confirm")) {
      this.activate();
      return;
    }
    if (this.hit(data, "tui.select.pageUp") || this.hit(data, "tui.editor.pageUp")) {
      this.previewOffset = Math.max(0, this.previewOffset - this.previewViewport);
      this.host.tui.requestRender();
      return;
    }
    if (this.hit(data, "tui.select.pageDown") || this.hit(data, "tui.editor.pageDown")) {
      this.previewOffset += this.previewViewport;
      this.host.tui.requestRender();
      return;
    }
    if (this.hit(data, "tui.select.up") || this.hit(data, "tui.select.down")) {
      this.list.handleInput(data);
      this.previewOffset = 0;
      const selected = this.list.getSelectedItem()?.value;
      if (this.tab === "slots") this.preferredSlot = selected;
      this.host.tui.requestRender();
      return;
    }
    const before = this.search.getValue();
    this.search.handleInput(data);
    if (this.search.getValue() !== before) {
      this.previewOffset = 0;
      this.rebuildList();
      this.host.tui.requestRender();
    }
  }

  private handleEdit(data: string): void {
    const editor = this.editor;
    if (!editor) return;
    if (this.hit(data, "tui.select.cancel")) {
      if (editor.isShowingAutocomplete()) {
        editor.handleInput(data);
        this.host.tui.requestRender();
        return;
      }
      if (editor.getText() !== (this.editBasis?.original ?? "")) {
        this.layer = "confirm-discard";
        editor.focused = false;
        this.host.tui.requestRender();
        return;
      }
      this.leaveEdit(true);
      return;
    }
    editor.handleInput(data);
    this.host.tui.requestRender();
  }

  private handleConfirm(data: string, confirm: () => void): void {
    if (this.hit(data, "tui.select.cancel")) {
      if (this.layer === "confirm-discard") {
        this.layer = "edit";
        if (this.editor) this.editor.focused = this._focused;
      } else {
        this.layer = "browse";
        this.search.focused = this._focused;
      }
      this.host.tui.requestRender();
      return;
    }
    if (this.hit(data, "tui.select.confirm")) confirm();
  }

  private activate(): void {
    if (this.tab === "slots") {
      const id = this.list.getSelectedItem()?.value;
      if (!id) return;
      this.enterEdit(id);
      return;
    }
    const id = this.list.getSelectedItem()?.value;
    if (!id) return;
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.jumpSlot) {
      this.tab = "slots";
      this.preferredSlot = node.jumpSlot;
      this.search.setValue("");
      this.contextPath = [];
      this.rebuildList();
      this.host.tui.requestRender();
      return;
    }
    if (node.children.length > 0) {
      this.contextPath = [...this.contextPath, node.id];
      this.search.setValue("");
      this.previewOffset = 0;
      this.rebuildList();
      this.host.tui.requestRender();
    }
  }

  private enterEdit(slotId: string): void {
    const slot = this.memoryView.memory.slots.find(item => item.id === slotId);
    if (!slot) return;
    this.preferredSlot = slotId;
    this.editBasis = { revision: this.memoryView.revision, slotId, original: slot.text };
    this.layer = "edit";
    this.error = undefined;
    this.search.focused = false;
    const editor = new Editor(this.editorTui, {
      borderColor: text => this.host.theme.fg("border", text),
      selectList: this.selectTheme(),
    }, { paddingX: 0 });
    editor.setText(slot.text);
    editor.focused = this._focused;
    interceptSubmit(editor, text => this.save(slotId, text));
    this.editor = editor;
    this.host.tui.requestRender();
  }

  private leaveEdit(clearError: boolean): void {
    this.editor = undefined;
    this.editBasis = undefined;
    this.layer = "browse";
    this.search.focused = this._focused;
    if (clearError) this.error = undefined;
    this.rebuildList();
    this.host.tui.requestRender();
  }

  private save(slotId: string, text: string): void {
    const basis = this.editBasis;
    if (!basis || basis.slotId !== slotId) return;
    if (this.memoryView.status.occupied) {
      this.fail("维护尚未完成原生提交，草稿未保存。");
      return;
    }
    const result = this.host.memory.replace(this.host.ctx, basis.revision, slotId, text);
    if (!result.ok) {
      this.fail(result.message);
      return;
    }
    this.preferredSlot = slotId;
    this.memoryView = this.host.memory.read(this.host.ctx);
    this.contextView = this.host.context.read(this.host.ctx);
    this.host.onSuccess?.();
    this.leaveEdit(true);
  }

  private fail(message: string): void {
    this.error = message;
    this.host.onFailure?.(message);
    this.host.tui.requestRender();
  }

  private deleteSelected(): void {
    const id = this.list.getSelectedItem()?.value;
    if (!id) { this.layer = "browse"; return; }
    const slots = this.memoryView.memory.slots;
    const index = slots.findIndex(slot => slot.id === id);
    const neighbor = slots[index + 1]?.id ?? slots[index - 1]?.id;
    const result = this.host.memory.delete(this.host.ctx, this.memoryView.revision, id);
    if (!result.ok) {
      this.error = result.message;
      this.host.onFailure?.(result.message);
      this.layer = "browse";
      this.search.focused = this._focused;
      this.host.tui.requestRender();
      return;
    }
    this.preferredSlot = neighbor;
    this.error = undefined;
    this.layer = "browse";
    this.search.focused = this._focused;
    this.memoryView = this.host.memory.read(this.host.ctx);
    this.contextView = this.host.context.read(this.host.ctx);
    this.host.onSuccess?.();
    this.rebuildList();
    this.host.tui.requestRender();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.host.done();
  }

  private hit(data: string, id: Keybinding): boolean {
    return this.host.keybindings.matches(data, id);
  }

  private rebuildList(): void {
    const items = this.tab === "slots" ? this.slotItems() : this.contextItems();
    const previous = this.list.getSelectedItem()?.value;
    const selected = this.tab === "slots" ? (this.preferredSlot ?? previous) : previous;
    this.list = this.makeList(items);
    const index = items.findIndex(item => item.value === selected);
    if (index >= 0) this.list.setSelectedIndex(index);
    else if (this.tab === "slots") this.preferredSlot = items[0]?.value;
  }

  private slotItems(): SelectItem[] {
    const query = this.search.getValue().trim().toLowerCase();
    return this.memoryView.memory.slots
      .filter(slot => !query || slot.id.toLowerCase().includes(query) || slot.text.toLowerCase().includes(query))
      .map(slot => ({ value: slot.id, label: slot.id, description: slot.text.replace(/\s+/g, " ").trim() }));
  }

  private contextItems(): SelectItem[] {
    this.nodes = buildContextNodes(this.contextView);
    const parent = this.contextPath.at(-1);
    const ids = parent ? this.nodes.get(parent)?.children ?? [] : ["scope:current", "scope:last-main", "scope:last-maintenance"];
    const query = this.search.getValue().trim().toLowerCase();
    return ids.map(id => this.nodes.get(id)).filter((node): node is CtxNode => {
      if (!node) return false;
      if (!query) return true;
      return node.label.toLowerCase().includes(query) || node.id.toLowerCase().includes(query) || node.preview.toLowerCase().includes(query);
    }).map(node => ({ value: node.id, label: node.label, ...(node.description ? { description: node.description } : {}) }));
  }

  private currentNode(): CtxNode | undefined {
    const id = this.list.getSelectedItem()?.value;
    return id ? this.nodes.get(id) : undefined;
  }

  private makeList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.listHeight, this.selectTheme(), { minPrimaryColumnWidth: 6, maxPrimaryColumnWidth: 28 });
    list.onSelectionChange = item => {
      if (this.tab === "slots") this.preferredSlot = item.value;
      this.previewOffset = 0;
    };
    return list;
  }

  private selectTheme(): SelectListTheme {
    const theme = this.host.theme;
    const word = this.tab === "slots" ? "slots" : "items";
    return {
      selectedPrefix: text => theme.fg("accent", text),
      selectedText: text => theme.fg("accent", text),
      description: text => theme.fg("muted", text),
      scrollInfo: text => theme.fg("dim", text),
      noMatch: text => theme.fg("warning", text.replace("commands", word)),
    };
  }

  private renderBrowse(contentWidth: number, innerBudget: number): string[] {
    const theme = this.host.theme;
    const hint = theme.fg("dim", this.hintLine());
    const error = this.error ? wrapTextWithAnsi(theme.fg("error", this.error), contentWidth).slice(0, 2) : [];
    const empty = this.emptyLine();
    this.rebuildList();
    const listLines = empty ? [theme.fg("warning", empty)] : this.list.render(contentWidth);
    const filterPrefix = "Search ";
    const inputWidth = Math.max(1, contentWidth - visibleWidth(filterPrefix));
    const tabs = [this.tabLine()];
    const ready = innerBudget > 12 ? [this.readyLine()] : [];
    const search = [`${filterPrefix}${this.search.render(inputWidth)[0] ?? ""}`];
    const list = listLines.slice(0, this.listHeight);
    const divider = [theme.fg("border", "─".repeat(contentWidth))];
    const reserved = tabs.length + ready.length + search.length + list.length + divider.length + error.length + 1;
    this.previewViewport = Math.max(1, innerBudget - reserved);
    const preview = this.previewLines(contentWidth, this.previewViewport);
    return [...tabs, ...ready, ...search, ...list, ...divider, ...preview, ...error, hint].slice(0, innerBudget);
  }

  private renderEditor(contentWidth: number, innerBudget: number): string[] {
    const theme = this.host.theme;
    const notice = wrapTextWithAnsi(theme.fg("muted", UNLOAD_LIMIT), contentWidth).slice(0, 1);
    const error = this.error ? wrapTextWithAnsi(theme.fg("error", this.error), contentWidth).slice(0, 2) : [];
    const hint = theme.fg("dim", `${this.keyLabel("tui.input.submit")} save · ${this.keyLabel("tui.input.newLine")} newline · ${this.keyLabel("tui.select.cancel")} cancel`);
    const reserved = notice.length + error.length + 1;
    this.editorRows = Math.max(3, innerBudget - reserved);
    const editorLines = this.editor ? this.editor.render(contentWidth) : [];
    return [...notice, ...editorLines, ...error, hint];
  }

  private renderConfirm(contentWidth: number): string[] {
    const theme = this.host.theme;
    const id = this.preferredSlot ?? this.list.getSelectedItem()?.value ?? "";
    const slot = this.memoryView.memory.slots.find(item => item.id === id);
    const title = this.layer === "confirm-delete" ? `Delete ${id}?` : "Discard unsaved edits?";
    const summary = this.layer === "confirm-delete" ? (slot?.text.replace(/\s+/g, " ").trim() ?? "") : "Edited text is kept until you confirm discard.";
    const hint = theme.fg("dim", `${this.keyLabel("tui.select.confirm")} confirm · ${this.keyLabel("tui.select.cancel")} back`);
    return [
      this.tabLine(),
      theme.fg("warning", title),
      ...wrapTextWithAnsi(summary, contentWidth).slice(0, 4),
      hint,
    ];
  }

  private pack(sections: { id: string; lines: string[]; keep: number }[], budget: number): string[] {
    const out: string[] = [];
    const required = sections.reduce((n, section) => n + Math.min(section.keep, section.lines.length), 0);
    let extra = Math.max(0, budget - required);
    for (const section of sections) {
      const need = Math.min(section.keep, section.lines.length);
      const more = Math.min(Math.max(0, section.lines.length - need), extra);
      extra -= more;
      out.push(...section.lines.slice(0, need + more));
    }
    return out.slice(0, budget);
  }

  private fit(lines: string[], budget: number): string[] {
    if (lines.length <= budget) return lines;
    return [...lines.slice(0, Math.max(1, budget - 1)), lines[lines.length - 1]!];
  }

  private tabLine(): string {
    const theme = this.host.theme;
    const slots = this.tab === "slots" ? theme.fg("accent", theme.bold("[Slots]")) : theme.fg("muted", " Slots ");
    const context = this.tab === "context" ? theme.fg("accent", theme.bold("[Context]")) : theme.fg("muted", " Context ");
    return `${slots}   ${context}`;
  }

  private readyLine(): string {
    const theme = this.host.theme;
    const view = this.memoryView;
    const m = view.budget.unknown || view.budget.limit === null
      ? `M unknown (${thousands(view.budget.tokens)})`
      : view.budget.limit === 0
        ? `M ${thousands(view.budget.tokens)} / 0`
        : `M ≈${thousands(view.budget.tokens)} / ${thousands(view.budget.limit)}`;
    const flags = [
      view.status.occupied ? "维护中" : undefined,
      view.status.unconfirmed ? "保存未确认" : undefined,
      this.editBasis && view.revision !== this.editBasis.revision ? "revision changed" : undefined,
    ].filter(Boolean).join(" · ");
    const base = `Ready · ${view.memory.slots.length} slots · ${m}`;
    return theme.fg("dim", flags ? `${base} · ${flags}` : base);
  }

  private emptyLine(): string | undefined {
    if (this.tab === "slots") {
      if (this.memoryView.memory.slots.length === 0) return "空记忆";
      if (this.slotItems().length === 0) return "无匹配 slots";
      return undefined;
    }
    if (this.contextItems().length === 0) return this.search.getValue().trim() ? "无匹配" : "暂无记录";
    return undefined;
  }

  private previewLines(contentWidth: number, budget: number): string[] {
    const theme = this.host.theme;
    let text = "";
    if (this.tab === "slots") {
      const id = this.list.getSelectedItem()?.value;
      const slot = this.memoryView.memory.slots.find(item => item.id === id);
      text = slot ? `${slot.id}\n${slot.text}` : "";
    } else {
      const node = this.currentNode();
      text = node?.preview ?? "";
    }
    const wrapped = text ? text.split(/\r?\n/).flatMap(line => wrapTextWithAnsi(line, contentWidth)) : [theme.fg("muted", " ")];
    const view = Math.max(1, budget);
    const maxOffset = Math.max(0, wrapped.length - view);
    this.previewOffset = Math.min(Math.max(0, this.previewOffset), maxOffset);
    return wrapped.slice(this.previewOffset, this.previewOffset + view);
  }

  private hintLine(): string {
    const preview = `${this.keyLabel("tui.select.pageUp")}/${this.keyLabel("tui.select.pageDown")} preview`;
    const cancel = this.keyLabel("tui.select.cancel");
    if (this.tab === "slots") {
      return `${cancel} close · ${this.keyLabel("tui.select.up")}/${this.keyLabel("tui.select.down")} select · ${this.keyLabel("tui.select.confirm")} edit · Ctrl+D delete · ${preview}`;
    }
    return `${cancel} back/close · ${this.keyLabel("tui.select.up")}/${this.keyLabel("tui.select.down")} select · ${this.keyLabel("tui.select.confirm")} open · ${preview}`;
  }

  private keyLabel(id: Keybinding): string {
    return this.host.keybindings.getKeys(id)[0] ?? id;
  }

  private boxRow(line: string, contentWidth: number, withShadow: boolean): string {
    const row = `${this.border("│")} ${pad(line, contentWidth)} ${this.border("│")}`;
    return `${this.surface(row)}${withShadow ? this.shadow("█") : ""}`;
  }

  private borderRow(left: string, middle: string, right: string, boxWidth: number, withShadow: boolean): string {
    const row = this.border(`${left}${truncateToWidth(middle, Math.max(0, boxWidth - 2), "")}${right}`);
    return `${this.surface(row)}${withShadow ? this.shadow("█") : ""}`;
  }

  private shadowLine(boxWidth: number): string {
    return this.shadow(`${" ".repeat(boxWidth > 0 ? 1 : 0)}${"▀".repeat(Math.max(0, boxWidth))}`);
  }

  private border(text: string): string { return this.host.theme.fg("borderAccent", text); }
  private shadow(text: string): string { return this.host.theme.fg("dim", text); }
  private surface(line: string): string {
    const painted = this.host.theme.bg("customMessageBg", " ");
    const bg = painted.slice(0, Math.max(0, painted.length - visibleWidth(painted)));
    if (!bg.includes("\x1b[")) return line;
    return `${bg}${line.replace(ANSI_RESET_RE, `${ANSI_RESET}${bg}`)}${ANSI_RESET}`;
  }
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, width);
  const gap = width - visibleWidth(clipped);
  return gap > 0 ? `${clipped}${" ".repeat(gap)}` : clipped;
}
