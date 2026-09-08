import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextSurface } from "../pi/context.js";
import type { MemoryFreeze, MemoryView } from "../pi/manual.js";
import { NuncOverlay } from "./overlay.js";
import { compactFooter, type DiagnosticNote } from "./status.js";

export { COMMAND_USAGE, commandCompletions, compactFooter, detailsLines, statusLines, UNLOAD_LIMIT } from "./status.js";
export { NuncOverlay } from "./overlay.js";
export type { CompactFooterInput, DiagnosticNote, FooterTone } from "./status.js";

export function createNuncUi(options: {
  memory: MemoryFreeze;
  context: ContextSurface;
  supported: (ctx: ExtensionContext) => void;
}): NuncUi {
  return new NuncUi(options);
}

export class NuncUi {
  private currentWarning: string | undefined;
  private unavailable: string | undefined;
  private diagnostics: DiagnosticNote[] = [];
  private lastCtx: ExtensionContext | undefined;
  private overlay: NuncOverlay | undefined;
  private opening = false;

  constructor(private readonly options: {
    memory: MemoryFreeze;
    context: ContextSurface;
    supported: (ctx: ExtensionContext) => void;
  }) {}

  recentDiagnostics(): DiagnosticNote[] { return this.diagnostics.slice(); }

  noteDiagnostic(level: DiagnosticNote["level"], message: string): void {
    this.diagnostics.push({ level, message });
    if (this.diagnostics.length > 20) this.diagnostics = this.diagnostics.slice(-20);
    if (level !== "info") this.currentWarning = message;
  }

  recover(): void {
    this.currentWarning = undefined;
    this.unavailable = undefined;
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
      warning: Boolean(this.currentWarning),
      slotCount: view?.memory.slots.length ?? 0,
      budget: view?.budget ?? { tokens: 0, limit: null, unknown: true },
    });
    ctx.ui.setStatus("nunc", ctx.ui.theme.fg(footer.tone, footer.text));
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
          done: () => done(null),
          onFailure: message => { this.noteDiagnostic("warning", message); this.refresh(ctx); },
          onSuccess: () => { this.recover(); this.refresh(ctx); },
        });
        this.overlay = overlay;
        return overlay;
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 } });
    } finally {
      this.opening = false;
      this.overlay = undefined;
      this.refresh(ctx);
    }
  }
}
