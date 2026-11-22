import type { LastMainContext } from "../../src/pi/context.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandCompletions, compactFooter, COMMAND_USAGE, firstLine, lastMainLines } from "../../src/ui/status.js";

test("single-line status handles CR, LF, and CRLF without leaking another line", () => {
  for (const separator of ["\r", "\n", "\r\n"]) assert.equal(firstLine(`warning${separator}hidden`), "warning");
  assert.equal(firstLine("abcdef", 3), "abc…");
  const lines = lastMainLines({ scope: "last-main", observedAt: 0, sessionId: "s", leafId: null,
    model: { id: "m", provider: "p", api: "a" }, outcome: "delegate", outputCapTokens: 8192,
    layout: { unavailable: true, system: { text: "", tokens: 0 },
      tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] },
      messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0,
      heuristic: { tokens: 0, unknown: false }, associations: [] } });
  assert(lines.includes("output cap 8,192"));
});

test("last-main labels advisory limits and separates additional M from occupied M", () => {
  const last: LastMainContext = { scope: "last-main", observedAt: 0, sessionId: "s", leafId: null,
    model: { id: "m", provider: "p", api: "a" }, outcome: "delegate", inputTokens: 1200, inputLimit: 1000,
    receiptBreakdown: { observedU: 900, deltaRTokens: 200, currentMTokens: 400, additionalMTokens: 100,
      retainedOldMMargin: true, oldMTokensEstimate: 300 },
    layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] },
      messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0,
      heuristic: { tokens: 0, unknown: false }, associations: [] } };
  for (const enforced of [false, true, undefined]) {
    const report = lastMainLines({ ...last, ...(enforced === undefined ? {} : { inputLimitEnforced: enforced }) }).join("\n");
    assert.match(report, enforced === false ? /\/ advisory 1,000/ : /\/ enforced 1,000/);
    assert.match(report, /\+ delta R 200 \+ additional M 100 \(current M occupancy 400\)/);
    assert.doesNotMatch(report, /\+ current M/);
  }
});

test("compact footer keeps unknown, zero-budget, and over-100 honest", () => {
  const base = { warning: false, unconfirmed: false, slotCount: 8, budget: { tokens: 10, limit: 20, unknown: false } };
  assert.deepEqual(compactFooter({ ...base, unavailable: true, occupied: false }), { text: "🧠 ×", tone: "error" });
  assert.deepEqual(compactFooter({ ...base, unavailable: false, occupied: true, warning: true }), { text: "🧠 ↻8", tone: "accent" });
  assert.deepEqual(compactFooter({ ...base, unavailable: false, occupied: false, warning: true }), { text: "🧠 !8", tone: "warning" });
  assert.deepEqual(compactFooter({ ...base, unavailable: false, occupied: false, unconfirmed: true, budget: { tokens: 20, limit: 2000, unknown: false } }), { text: "🧠 !8", tone: "warning" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: 2000, unknown: false } }), { text: "🧠 8·42%", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 0, budget: { tokens: 0, limit: 2000, unknown: false } }), { text: "🧠 0", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: null, unknown: true } }), { text: "🧠 8·?", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 8, budget: { tokens: 840, limit: 0, unknown: false } }), { text: "🧠 8", tone: "dim" });
  assert.deepEqual(compactFooter({ unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount: 8, budget: { tokens: 2840, limit: 2000, unknown: false } }), { text: "🧠 8·142%", tone: "dim" });
});

test("/nunc completions offer read-only details and explicit targeted compaction", () => {
  const details = { value: "details", label: "details", description: "Complete memory, budget, maintenance, and diagnostic report" };
  assert.deepEqual(commandCompletions("")?.map(c => c.value), ["details", "compact-for"]);
  assert.deepEqual(commandCompletions("d"), [details]);
  assert.equal(commandCompletions("st"), null);
  assert.equal(commandCompletions("status"), null);
  assert.equal(commandCompletions("unknown"), null);
  assert.equal(commandCompletions("details "), null);
  assert.equal(COMMAND_USAGE, "Usage: /nunc [details | compact-for <provider/model-id>]");
});

test("mechanical roll warning takes precedence over every normal dim state including empty M", () => {
  for (const slotCount of [0, 8]) for (const limit of [null, 0, 2000]) {
    const input = { unavailable: false, occupied: false, unconfirmed: false, warning: false, slotCount, budget: { tokens: 0, limit, unknown: limit === null }, fallback: true };
    assert.deepEqual(compactFooter(input), { text: `🧠 !${slotCount}·roll`, tone: "warning" });
    assert.equal(compactFooter({ ...input, fallback: false }).tone, "dim");
  }
});
