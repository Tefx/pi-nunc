import { test } from "node:test";
import assert from "node:assert/strict";
import { commandCompletions, compactFooter, COMMAND_USAGE } from "../../src/ui/status.js";

test("compact footer keeps unknown, zero-budget, and over-100 honest", () => {
  const base = { warning: false, unconfirmed: false, slotCount: 8, budget: { tokens: 10, limit: 20, unknown: false } };
  assert.deepEqual(compactFooter({ ...base, unavailable: true, occupied: false }), { text: "nunc ×", tone: "error" });
  assert.deepEqual(compactFooter({ ...base, unavailable: false, occupied: true, warning: true }), { text: "nunc ↻ 8", tone: "accent" });
  assert.deepEqual(compactFooter({ ...base, unavailable: false, occupied: false, warning: true }), { text: "nunc ! 8", tone: "warning" });
  assert.deepEqual(compactFooter({ ...base, unavailable: false, occupied: false, unconfirmed: true, budget: { tokens: 20, limit: 2000, unknown: false } }), { text: "nunc ! 8", tone: "warning" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: 2000, unknown: false } }), { text: "nunc 8·42%", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 0, budget: { tokens: 0, limit: 2000, unknown: false } }), { text: "nunc 0·0%", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: null, unknown: true } }), { text: "nunc 8·?", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: 0, unknown: false } }), { text: "nunc 8", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 8, budget: { tokens: 2840, limit: 2000, unknown: false } }), { text: "nunc 8·142%", tone: "dim" });
});

test("/nunc completions offer only details", () => {
  const details = { value: "details", label: "details", description: "Complete memory, budget, maintenance, and diagnostic report" };
  assert.deepEqual(commandCompletions(""), [details]);
  assert.deepEqual(commandCompletions("d"), [details]);
  assert.equal(commandCompletions("st"), null);
  assert.equal(commandCompletions("status"), null);
  assert.equal(commandCompletions("unknown"), null);
  assert.equal(commandCompletions("details "), null);
  assert.equal(COMMAND_USAGE, "Usage: /nunc [details]");
});
