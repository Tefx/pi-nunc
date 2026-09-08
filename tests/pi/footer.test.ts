import { test } from "node:test";
import assert from "node:assert/strict";
import { commandCompletions, compactFooter, COMMAND_USAGE } from "../../src/ui/status.js";

test("compact footer keeps unknown, zero-budget, and over-100 honest", () => {
  assert.deepEqual(compactFooter({ unavailable: true, occupied: false, warning: false, slotCount: 8, budget: { tokens: 10, limit: 20, unknown: false } }), { text: "nunc ×", tone: "error" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: true, warning: true, slotCount: 8, budget: { tokens: 10, limit: 20, unknown: false } }), { text: "nunc ↻ 8", tone: "accent" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, warning: true, slotCount: 8, budget: { tokens: 10, limit: 20, unknown: false } }), { text: "nunc ! 8", tone: "warning" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: 2000, unknown: false } }), { text: "nunc 8·42%", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, warning: false, slotCount: 0, budget: { tokens: 0, limit: 2000, unknown: false } }), { text: "nunc 0·0%", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: null, unknown: true } }), { text: "nunc 8·?", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: 0, unknown: false } }), { text: "nunc 8", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, warning: false, slotCount: 8, budget: { tokens: 2840, limit: 2000, unknown: false } }), { text: "nunc 8·142%", tone: "dim" });
});

test("/nunc completions add status without dropping details", () => {
  assert.deepEqual(commandCompletions(""), [
    { value: "details", label: "details", description: "查看预算与最近维护详情" },
    { value: "status", label: "status", description: "文字概览，不打开面板" },
  ]);
  assert.deepEqual(commandCompletions("d"), [
    { value: "details", label: "details", description: "查看预算与最近维护详情" },
  ]);
  assert.deepEqual(commandCompletions("st"), [
    { value: "status", label: "status", description: "文字概览，不打开面板" },
  ]);
  assert.equal(commandCompletions("unknown"), null);
  assert.equal(commandCompletions("details "), null);
  assert.equal(COMMAND_USAGE, "用法：/nunc [status|details]");
});
