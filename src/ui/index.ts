import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextSurface } from "../pi/context.js";
import type { MemoryFreeze, MemoryView } from "../pi/manual.js";
import type { Memory } from "../engine/index.js";
import { NuncOverlay } from "./overlay.js";
import { compactFooter, DIAGNOSTIC_LIMIT, type DiagnosticNote } from "./status.js";

export { COMMAND_USAGE, commandCompletions, detailsLines } from "./status.js";

export class NuncUi {
  private warning: string | undefined;
  private unavailable: string | undefined;
  private diagnostics: DiagnosticNote[] = [];
  private lastCtx: ExtensionContext | undefined;
  private overlay: NuncOverlay | undefined;
  private opening = false;

  constructor(private readonly options: {
    memory: MemoryFreeze;
    context: ContextSurface;
    supported: (ctx: ExtensionContext) => void;
    prepareSave?: (ctx: ExtensionContext, proposal: Memory, signal: AbortSignal) => Promise<{ edits?: unknown; warning?: string; stale?: boolean }>;
  }) {}

  recentDiagnostics(): DiagnosticNote[] { return this.diagnostics.slice(); }
  currentWarning(): string | undefined { return this.warning; }

  noteDiagnostic(level: DiagnosticNote["level"], message: string): void {
    if (level === "info") return;
    this.diagnostics.push({ level, message });
    if (this.diagnostics.length > DIAGNOSTIC_LIMIT) this.diagnostics = this.diagnostics.slice(-DIAGNOSTIC_LIMIT);
    this.warning = message;
  }

  recover(): void {
    this.warning = undefined;
    this.unavailable = undefined;
  }

  resetSession(): void {
    this.diagnostics = [];
    this.recover();
  }

  attach(ctx: ExtensionContext): void {
    this.lastCtx = ctx;
    try {
      this.options.supported(ctx);
      this.recover();
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : "Unavailable";
    }
    this.refresh(ctx);
  }

  shutdown(ctx: ExtensionContext): void {
    this.resetSession();
    this.overlay?.dispose();
    this.overlay = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("nunc", undefined);
    this.lastCtx = undefined;
  }

  refresh(ctx = this.lastCtx): void {
    if (!ctx?.hasUI) return;
    let view: MemoryView | undefined;
    try {
      this.options.supported(ctx);
      view = this.options.memory.read(ctx);
      if (this.unavailable) this.unavailable = undefined;
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : "Unavailable";
    }
    const footer = compactFooter({
      unavailable: Boolean(this.unavailable),
      occupied: view?.status.occupied ?? false,
      unconfirmed: view?.status.unconfirmed ?? false,
      warning: Boolean(this.warning),
      fallback: view?.mechanicalFallback !== undefined,
      slotCount: view?.memory.slots.length ?? 0,
      budget: view?.budget ?? { tokens: 0, limit: null, unknown: true },
    });
    try { ctx.ui.setStatus("nunc", ctx.ui.theme.fg(footer.tone, footer.text)); } catch { /* Footer paint only. */ }
    this.overlay?.sync();
  }

  async openOverlay(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || this.opening) return;
    this.opening = true;
    try {
      await ctx.ui.custom((tui, theme, keybindings, done) => {
        const overlay = new NuncOverlay({
          tui, theme, keybindings, ctx,
          memory: this.options.memory,
          context: this.options.context,
          ...(this.options.prepareSave ? { prepareSave: this.options.prepareSave } : {}),
          diagnostics: () => ({ notes: this.diagnostics.slice(), ...(this.warning ? { warning: this.warning } : {}) }),
          done: () => done(null),
          onFailure: message => { this.noteDiagnostic("warning", message); this.refresh(ctx); },
          onWarning: message => { this.noteDiagnostic("warning", message); this.refresh(ctx); },
          onSuccess: () => { this.recover(); this.refresh(ctx); },
        });
        this.overlay = overlay;
        return overlay;
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 } });
    } finally {
      this.overlay?.dispose();
      this.opening = false;
      this.overlay = undefined;
      if (this.lastCtx === ctx) this.refresh(ctx);
    }
  }
}
