import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyLastUserTextAppend } from "../pi/payload.js";

/** Synthetic last-user text only. Never ambient or personal content. */
export const SYNTHETIC_LAST_USER_APPEND = "nunc-synthetic-last-user-append";

/** Verification-only public callback; loaded by the stock CLI when payload-append is selected. */
export function createAppendExtension(text: string): (pi: ExtensionAPI) => void {
  return pi => {
    pi.on("before_provider_request", event => {
      const result = applyLastUserTextAppend(event.payload, text);
      return result.changed ? result.payload : undefined;
    });
  };
}
export default createAppendExtension(SYNTHETIC_LAST_USER_APPEND);
