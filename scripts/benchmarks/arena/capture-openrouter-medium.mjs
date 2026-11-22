// Preserve the Arena extension entrypoint and its catalog/session binding.
import capture from '../capture.mjs';
export default function(pi) { capture(pi, { arena: true }); }
