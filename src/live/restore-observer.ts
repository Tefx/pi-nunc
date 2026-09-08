import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observerState } from "./observer.js";

/** Last-loaded observer: product commit handlers must finish before reload, and
 * Pi must capture the next loop's tool definitions only after reload. A turn_start
 * hold is too late: its already-captured tools would retain a stale extension ctx.
 */
export default function restoreObserver(pi: ExtensionAPI): void {
  const source = process.env.NUNC_LIVE_OBSERVER!;
  const { events } = JSON.parse(readFileSync(source, "utf8")) as { events: string };
  pi.on("session_compact", async () => {
    const state = observerState(source);
    if (!state?.restorePending) return;
    const held = new Promise<void>(resolve => { state.held = resolve; });
    appendFileSync(events, JSON.stringify({ type: "boundary-restore", data: {} }) + "\n", { mode: 0o600 });
    // The public command/reload releases plain state; never use old pi/ctx after await.
    await held;
  });
}
