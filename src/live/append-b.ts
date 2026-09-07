import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyLastUserTextAppend } from "../pi/payload.js";

/** Second synthetic last-user text only. Never ambient or personal content. */
export const SYNTHETIC_LAST_USER_APPEND_B = "nunc-synthetic-last-user-append-b";

/** Verification-only public callback; loaded when payload-append-b is selected. */
export default function appendB(pi: ExtensionAPI): void {
  pi.on("before_provider_request", event => {
    const result = applyLastUserTextAppend(event.payload, SYNTHETIC_LAST_USER_APPEND_B);
    return result.changed ? result.payload : undefined;
  });
}
