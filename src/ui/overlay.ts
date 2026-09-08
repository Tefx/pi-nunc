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
import type { ContextSurface, ContextView, CurrentContext, LastMainContext, LastMaintenanceContext } from "../pi/context.js";
import type { MemorySurface, MemoryView } from "../pi/manual.js";
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
}

interface CtxNode {
  id: string;
  label: string;
  description?: string;
  preview: string;
  jumpSlot?: string;
  children: string[];
}

const ANSI_RESET = "\x1b[0m";
const ANSI_RESET_RE = /\x1b\[(?:0)?m/g;

export class NuncOverlay implements Focusable {
  private readonly host: OverlayHost;
  private readonly search: Input;
  private memoryView: MemoryView;
  private contextView: ContextView;
  private tab: OverlayTab = "slots";
  private layer: Layer = "browse";
  private list: SelectList;
  private editor: Editor | undefined;
  private preferredSlot: string | undefined;
  private contextPath: string[] = [];
  private previewOffset = 0;
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
    this.contextView = host.context.read(host.ctx);
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

  sync(): void {
    if (this.closed) return;
    this.memoryView = this.host.memory.read(this.host.ctx);
    this.contextView = this.host.context.read(this.host.ctx);
    if (this.layer === "browse") this.rebuildList();
    this.host.tui.requestRender();
  }

  dispose(): void {
    this.closed = true;
    this.search.focused = false;
    if (this.editor) this.editor.focused = false;
    this.editor = undefined;
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
    const withShadow = renderWidth >= 10;
    const boxWidth = withShadow ? renderWidth - 1 : renderWidth;
    const contentWidth = Math.max(1, boxWidth - 4);
    const rows = this.host.tui.terminal?.rows;
    const maxLines = Math.max(10, Math.min(Number.isFinite(rows) ? Math.floor((rows ?? 24) * 0.9) - 1 : 22, 40));
    const chrome = this.layer === "edit" ? 8 : 9;
    const nextList = Math.max(1, Math.min(8, maxLines - chrome - 3));
    if (nextList !== this.listHeight) {
      this.listHeight = nextList;
      this.rebuildList(true);
    }
    const body = this.layer === "edit" ? this.renderEditor(contentWidth, Math.max(4, maxLines - chrome))
      : this.layer === "confirm-delete" || this.layer === "confirm-discard" ? this.renderConfirm(contentWidth)
      : this.renderBrowse(contentWidth, maxLines - chrome);
    const title = this.host.theme.fg("accent", this.host.theme.bold("Nunc"));
    const topTitle = truncateToWidth(`─ ${title} `, boxWidth - 2);
    const topMiddle = `${topTitle}${"─".repeat(Math.max(0, boxWidth - 2 - visibleWidth(topTitle)))}`;
    const inner = body.slice(0, Math.max(1, maxLines - 3));
    while (inner.length < Math.min(body.length, maxLines - 3)) inner.push("");
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
    if (this.hit(data, "tui.select.up") || this.hit(data, "tui.select.down") || this.hit(data, "tui.select.pageUp") || this.hit(data, "tui.select.pageDown")) {
      const node = this.currentNode();
      const leafPreview = this.tab === "context" && node && node.children.length === 0;
      if (leafPreview && (this.hit(data, "tui.select.up") || this.hit(data, "tui.select.down"))) {
        this.previewOffset = Math.max(0, this.previewOffset + (this.hit(data, "tui.select.down") ? 1 : -1));
      } else {
        this.list.handleInput(data);
        this.previewOffset = 0;
        const selected = this.list.getSelectedItem()?.value;
        if (this.tab === "slots") this.preferredSlot = selected;
      }
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
      if (editor.getText() !== this.editOriginal()) {
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
    this.layer = "edit";
    this.error = undefined;
    this.search.focused = false;
    const editor = new Editor(this.host.tui, {
      borderColor: text => this.host.theme.fg("border", text),
      selectList: this.selectTheme(),
    }, { paddingX: 0 });
    editor.setText(slot.text);
    editor.focused = this._focused;
    editor.onSubmit = text => this.save(slotId, text);
    this.editor = editor;
    this.host.tui.requestRender();
  }

  private leaveEdit(clearError: boolean): void {
    this.editor = undefined;
    this.layer = "browse";
    this.search.focused = this._focused;
    if (clearError) this.error = undefined;
    this.rebuildList();
    this.host.tui.requestRender();
  }

  private save(slotId: string, text: string): void {
    if (this.memoryView.status.occupied) {
      this.error = "维护尚未完成原生提交，草稿未保存。";
      this.host.tui.requestRender();
      return;
    }
    const result = this.host.memory.replace(this.host.ctx, this.memoryView.revision, slotId, text);
    if (!result.ok) {
      this.error = result.message;
      this.memoryView = result.view;
      this.host.tui.requestRender();
      return;
    }
    this.preferredSlot = slotId;
    this.memoryView = this.host.memory.read(this.host.ctx);
    this.contextView = this.host.context.read(this.host.ctx);
    this.leaveEdit(true);
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
      this.memoryView = result.view;
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
    this.rebuildList();
    this.host.tui.requestRender();
  }

  private editOriginal(): string {
    const id = this.preferredSlot;
    return this.memoryView.memory.slots.find(slot => slot.id === id)?.text ?? "";
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.host.done();
  }

  private hit(data: string, id: Keybinding): boolean {
    return this.host.keybindings.matches(data, id);
  }

  private rebuildList(keepFilter = false): void {
    if (!keepFilter) { /* search value already applied */ }
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

  private renderBrowse(contentWidth: number, bodyLines: number): string[] {
    const theme = this.host.theme;
    const tabs = this.tabLine();
    const ready = this.readyLine();
    const filterPrefix = "Search ";
    const inputWidth = Math.max(1, contentWidth - visibleWidth(filterPrefix));
    const inputLine = `${filterPrefix}${this.search.render(inputWidth)[0] ?? ""}`;
    const previewBudget = Math.max(2, bodyLines - this.listHeight - 5);
    const listLines = this.list.render(contentWidth);
    const preview = this.previewLines(contentWidth, previewBudget);
    const hint = this.hintLine();
    const empty = this.emptyLine();
    return [
      tabs,
      ready,
      inputLine,
      ...(empty ? [theme.fg("warning", empty)] : listLines),
      theme.fg("border", "─".repeat(contentWidth)),
      ...preview,
      ...(this.error ? [theme.fg("error", this.error)] : []),
      theme.fg("dim", hint),
    ];
  }

  private renderEditor(contentWidth: number, height: number): string[] {
    const theme = this.host.theme;
    const editor = this.editor;
    const lines = editor ? editor.render(contentWidth) : [];
    const notice = wrapTextWithAnsi(theme.fg("muted", UNLOAD_LIMIT), contentWidth);
    const error = this.error ? wrapTextWithAnsi(theme.fg("error", this.error), contentWidth) : [];
    const hint = theme.fg("dim", `${this.keyLabel("tui.input.submit")} save · ${this.keyLabel("tui.input.newLine")} newline · ${this.keyLabel("tui.select.cancel")} cancel`);
    const used = 3 + notice.length + error.length;
    const editorLines = lines.slice(0, Math.max(3, height - used));
    return [this.tabLine(), this.readyLine(), ...notice, ...editorLines, ...error, hint];
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
      ...wrapTextWithAnsi(summary, contentWidth).slice(0, 6),
      hint,
    ];
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
    const maxOffset = Math.max(0, wrapped.length - budget);
    this.previewOffset = Math.min(this.previewOffset, maxOffset);
    const visible = wrapped.slice(this.previewOffset, this.previewOffset + budget);
    if (wrapped.length > this.previewOffset + budget) visible[visible.length - 1] = truncateToWidth(`${visible[visible.length - 1] ?? ""}…`, contentWidth);
    return visible;
  }

  private hintLine(): string {
    if (this.tab === "slots") {
      return `${this.keyLabel("tui.select.up")}/${this.keyLabel("tui.select.down")} select · ${this.keyLabel("tui.select.confirm")} edit · Ctrl+D delete · ${this.keyLabel("tui.input.tab")} switch · ${this.keyLabel("tui.select.cancel")} close`;
    }
    return `${this.keyLabel("tui.select.confirm")} open · ${this.keyLabel("tui.input.tab")} switch · ${this.keyLabel("tui.select.cancel")} back/close`;
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

function buildContextNodes(view: ContextView): Map<string, CtxNode> {
  const nodes = new Map<string, CtxNode>();
  const add = (node: CtxNode) => { nodes.set(node.id, node); return node.id; };
  add(scopeCurrent(view.current, add));
  add(lastMainNode(view.lastMain));
  add(lastMaintenanceNode(view.lastMaintenance));
  return nodes;
}

function scopeCurrent(current: CurrentContext, add: (node: CtxNode) => string): CtxNode {
  const layout = current.layout;
  const toolIds = layout.tools.definitions.map(def => add({
    id: `current:F:tools:${def.name}`,
    label: def.name,
    description: def.unknown ? "unknown" : `${def.tokens ?? "?"} tok`,
    preview: [def.name, def.description, def.unknown ? "estimate unknown" : `${thousands(def.tokens ?? 0)} tok`, JSON.stringify(def.parameters)].join("\n"),
    children: [],
  }));
  const mIds = (layout.memory?.slots ?? []).map(slot => add({
    id: `current:M:${slot.id}`,
    label: slot.id,
    description: slot.text.replace(/\s+/g, " ").trim(),
    preview: slot.text,
    jumpSlot: slot.id,
    children: [],
  }));
  const rIds = layout.messages.map(message => {
    const blockIds = message.blocks.map((block, index) => add({
      id: `current:R:${message.order}:b${index}`,
      label: block.type,
      description: tokenLabel(block.tokens, block.unknown),
      preview: block.text ?? block.thinking ?? (block.toolName ? `${block.toolName} ${JSON.stringify(block.arguments ?? {})}` : block.preview),
      children: [],
    }));
    const assoc = layout.associations.find(item => item.callOrder === message.order || item.resultOrder === message.order);
    return add({
      id: `current:R:${message.order}`,
      label: `${message.order} ${message.role}`,
      description: tokenLabel(message.tokens, message.unknown),
      preview: [`#${message.order} ${message.role} ${tokenLabel(message.tokens, message.unknown)}`, message.preview, assoc ? `tool ${assoc.toolName} ${assoc.toolCallId} call@${assoc.callOrder} result@${assoc.resultOrder}` : ""].filter(Boolean).join("\n"),
      children: blockIds,
    });
  });
  add({ id: "current:F:system", label: "system", description: `${thousands(layout.system.tokens)} tok`, preview: layout.system.text || "(empty system)", children: [] });
  add({ id: "current:F:tools", label: "tools", description: `${layout.tools.count}`, preview: layout.tools.names.join(", ") || "(no tools)", children: toolIds });
  add({ id: "current:F", label: "F", description: tokenLabel(layout.system.tokens + (layout.tools.tokens ?? 0), layout.tools.unknown), preview: `System ${thousands(layout.system.tokens)} tok\nTools ${tokenLabel(layout.tools.tokens, layout.tools.unknown)} (${layout.tools.count})`, children: ["current:F:system", "current:F:tools"] });
  add({ id: "current:M", label: "M", description: `${layout.memory?.slots.length ?? 0} slots`, preview: memoryPreview(current), children: mIds });
  add({ id: "current:R", label: "R", description: `${layout.messageCount} messages / ${layout.blockCount} blocks`, preview: `Delivered source still in the active context.\n${layout.messageCount} messages / ${layout.blockCount} blocks`, children: rIds });
  add({ id: "current:budget", label: "Budget", preview: budgetPreview(current), children: [] });
  add({ id: "current:counts", label: "Counts", preview: `${layout.messageCount} messages / ${layout.blockCount} blocks\npackaging ${thousands(layout.packagingTokens)} · extra input ${thousands(layout.extraInputTokens)}\nheuristic ${tokenLabel(layout.heuristic.tokens, layout.heuristic.unknown)}`, children: [] });
  return {
    id: "scope:current",
    label: "Current projection",
    description: current.model ? `${current.model.provider}/${current.model.id}` : "no model",
    preview: [
      "Scope: current delivered F/M/R. Later context/payload hooks are not included.",
      bars(current),
      current.occupied ? "Maintenance occupied" : "",
      current.unconfirmed ? "Save unconfirmed" : "",
    ].filter(Boolean).join("\n"),
    children: ["current:F", "current:M", "current:R", "current:budget", "current:counts"],
  };
}

function lastMainNode(last: LastMainContext | undefined): CtxNode {
  if (!last) {
    return { id: "scope:last-main", label: "Last main request", description: "none", preview: "暂无记录", children: [] };
  }
  const when = new Date(last.observedAt).toISOString();
  const layout = last.layout.unavailable
    ? "layout unavailable (unknown)"
    : `${last.layout.messageCount} messages / ${last.layout.blockCount} blocks · heuristic ${tokenLabel(last.layout.heuristic.tokens, last.layout.heuristic.unknown)}`;
  const payload = last.payload ? [
    `payload ${last.payload.mode} [${last.payload.categories.join(",") || "none"}]`,
    last.payload.addedTokens !== undefined ? `addedTokens ${last.payload.addedTokens}` : "",
    last.payload.chargedGrowthTokens !== undefined ? `chargedGrowthTokens ${last.payload.chargedGrowthTokens}` : "",
    last.payload.unallocatedOverheadTokens !== undefined ? `unallocatedOverheadTokens ${last.payload.unallocatedOverheadTokens}` : "",
    last.initialMetadataTokens !== undefined ? `initialMetadataTokens ${last.initialMetadataTokens}` : "",
    last.payload.unmappedIncrement ? `unmappedIncrement ${last.payload.unmappedIncrement.tokens} unknown` : "",
  ].filter(Boolean).join("\n") : "payload not observed";
  return {
    id: "scope:last-main",
    label: "Last main request",
    description: `${last.outcome} ${last.model.id}`,
    preview: [
      `Scope: last-main · ${last.outcome}${last.code ? ` ${last.code}` : ""}`,
      `${last.model.provider}/${last.model.id} (${last.model.api})`,
      when,
      last.estimator ? `estimator ${last.estimator}` : "",
      last.inputTokens !== undefined ? `input ${last.inputTokens}${last.inputLimit !== undefined ? ` / enforced ${last.inputLimit}` : ""}${last.plannedInputLimit !== undefined ? ` · planned ${last.plannedInputLimit}` : ""}` : "",
      last.inputExceededPlan === true ? "input exceeded plan" : "",
      last.outputTokens !== undefined ? `output ${last.outputTokens}` : "",
      last.outputReserveTokens !== undefined ? `output reserve ${last.outputReserveTokens}` : "",
      last.outputCapTokens === null ? "output cap none" : last.outputCapTokens !== undefined ? `output cap ${last.outputCapTokens}` : "",
      layout,
      payload,
      last.outcome === "reject" ? "Local reject is not a send." : "Delegate is not HTTP success.",
    ].filter(Boolean).join("\n"),
    children: [],
  };
}

function lastMaintenanceNode(last: LastMaintenanceContext | undefined): CtxNode {
  if (!last) {
    return { id: "scope:last-maintenance", label: "Last maintenance", description: "none", preview: "暂无记录", children: [] };
  }
  const when = new Date(last.observedAt).toISOString();
  const cut = last.cut ? `B ${last.cut.retiredEntryIds.length} · K ${last.cut.keptEntryIds.length} · firstKept ${last.cut.firstKeptEntryId}` : "B/K unknown (no extraction cut yet)";
  const after = last.native === "saved" && last.after ? `native saved · after ${last.after.memory.slots.length} slots` : last.native === "saved" ? "native saved" : `native ${last.native}${last.invalidated ? " · invalidated (no after)" : ""}`;
  const candidate = last.candidate ? `engine candidate ${last.candidate.memory.slots.length} slots @ ${last.candidate.firstKeptEntryId}` : "no candidate";
  return {
    id: "scope:last-maintenance",
    label: "Last maintenance",
    description: `${last.native}${last.engine ? `/${last.engine}` : ""}`,
    preview: [
      `Scope: last-maintenance · ${last.reason ?? "unknown reason"}`,
      `${last.model.provider}/${last.model.id} (${last.model.api})`,
      when,
      `engine ${last.engine ?? "pending"} · ${after}`,
      candidate,
      cut,
      `before M ${last.before.memory.slots.length} slots · ${last.before.messages.length} messages`,
      last.accounting ? `accounting extraction ${last.accounting.extractionTokens} / plan ${last.accounting.extractionInputLimit}` : "",
      last.code ? `${last.code}: ${last.message ?? ""}` : "",
      last.native !== "saved" ? "Candidate success is not a native save." : "",
    ].filter(Boolean).join("\n"),
    children: [],
  };
}

function bars(current: CurrentContext): string {
  const layout = current.layout;
  const f = layout.system.tokens + (layout.tools.tokens ?? 0);
  const fUnknown = layout.tools.unknown;
  const rKnown = layout.messages.every(message => !message.unknown) ? layout.messages.reduce((n, message) => n + (message.tokens ?? 0), 0) : null;
  const rUnknown = layout.messages.some(message => message.unknown);
  const cap = current.budget.modelWindow;
  return [
    `F ${meter(fUnknown ? null : f, cap)} ${tokenLabel(f, fUnknown)}`,
    `M ${meter(current.budget.memoryUnknown ? null : current.budget.memoryOccupied, current.budget.memoryLimit)} ${memoryLine(current)}`,
    `R ${meter(rUnknown ? null : rKnown, cap)} ${tokenLabel(rKnown, rUnknown)}`,
  ].join("\n");
}

function meter(value: number | null, cap: number | null): string {
  const width = 8;
  if (value === null || cap === null || cap <= 0) return "?".repeat(1) + "░".repeat(width - 1);
  const filled = Math.max(0, Math.min(width, Math.round((value / cap) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function tokenLabel(tokens: number | null | undefined, unknown: boolean): string {
  if (unknown && (tokens === null || tokens === undefined)) return "unknown";
  if (tokens === null || tokens === undefined) return "unknown";
  return unknown ? `${thousands(tokens)} + unknown` : `${thousands(tokens)} tok`;
}

function memoryLine(current: CurrentContext): string {
  const occupied = current.budget.memoryOccupied;
  const limit = current.budget.memoryLimit;
  if (current.budget.memoryUnknown) return occupied === null ? "unknown" : `${thousands(occupied)} · unknown limit`;
  if (limit === null) return occupied === null ? "unknown" : `${thousands(occupied)} / unknown`;
  return `${thousands(occupied ?? 0)} / ${thousands(limit)}`;
}

function memoryPreview(current: CurrentContext): string {
  const slots = current.layout.memory?.slots ?? [];
  return [`${slots.length} slots`, memoryLine(current), "Enter a slot to jump to Slots."].join("\n");
}

function budgetPreview(current: CurrentContext): string {
  const b = current.budget;
  return [
    `model window ${nullLabel(b.modelWindow)}`,
    `H / trigger ${nullLabel(b.triggerTokens)}`,
    `planned input ${nullLabel(b.plannedInputLimit)}`,
    `main admission ${nullLabel(b.mainAdmissionLimit)}`,
    `M budget ${b.memoryUnknown ? "unknown" : nullLabel(b.memoryLimit)} occupied ${b.memoryOccupied === null ? "unknown" : thousands(b.memoryOccupied)}`,
    `output reserve ${nullLabel(b.outputReserveTokens)}`,
    `output cap ${b.outputCapKnown ? (b.outputCapTokens === null ? "none" : nullLabel(b.outputCapTokens)) : "not observed"}`,
    `extraction output ${nullLabel(b.extractionOutputTokens)} cap ${b.extractionOutputCapTokens === null ? "none" : nullLabel(b.extractionOutputCapTokens)}`,
    `safety ${nullLabel(b.safetyTokens)}`,
  ].join("\n");
}

function nullLabel(value: number | null): string {
  return value === null ? "unknown" : thousands(value);
}
