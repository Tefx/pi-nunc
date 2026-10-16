import { createAppendExtension } from "./append.js";

/** Second synthetic last-user text only. Never ambient or personal content. */
export const SYNTHETIC_LAST_USER_APPEND_B = "nunc-synthetic-last-user-append-b";

/** Verification-only public callback; loaded when payload-append-b is selected. */
export default createAppendExtension(SYNTHETIC_LAST_USER_APPEND_B);
