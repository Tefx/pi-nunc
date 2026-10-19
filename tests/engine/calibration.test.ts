import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { maintain } from "../../src/engine/engine.js";
import { activeUsageUndercount, maintenanceCalibrationRecord, maintenanceFeedback, selectMaintenanceCalibration } from "../../src/engine/calibration.js";
import { extractionContext, resolveExtractionRequest } from "../../src/engine/request.js";
import { inputLimit, mainPlanningEstimate, requestTokens } from "../../src/engine/accounting.js";
import { answer, assistant, input, noChange, responder, sourceRecords, tool, user } from "./fixtures.js";
import type { MaintenanceInput, MaintenanceResult, ModelRequest } from "../../src/engine/types.js";

test("first threshold maintenance calibrates the 1M window from assistant usage and scales after reduction", async () => {
  const value = await input();
  value.model.contextWindow = 1048576; value.model.maxTokens = 65536;
  value.config.triggerTokens = 1035630;
  value.config.extraction = { ...value.config.extraction, outputTokens: 8192, outputAuto: true, safetyTokens: 1024 };
  value.active = [user("old", "a".repeat(2750000)),
    assistant("call", [{ type: "toolCall", id: "x", name: "read", arguments: {} }]),
    tool("body", "x", "b".repeat(150000)),
    { entryId: "usage", sourceRole: "assistant", messages: [{ ...answer(), usage: { ...answer().usage, input: 1035590, cacheRead: 0, cacheWrite: 0, output: 40, totalTokens: 1035630 } }] },
    user("latest", "Continue.")];
  value.eligibleKeptEntryIds = ["latest"];
  const fullPrefix = value.active.slice(0, 4);
  const prefixTokens = mainPlanningEstimate(value.fixed, value.memory.slots, fullPrefix, value.model, undefined, 0).tokens;
  const rawDelta = 1035630 - prefixTokens;
  assert(rawDelta > 200000 && rawDelta < 210000);
  let requests = 0;
  const result = await maintain(value, async request => {
    requests++;
    const reducedPrefix = sourceRecords(request.context).slice(0, 4).map((entry, index) => ({ ...value.active[index]!, messages: entry.messages }));
    const retainedTokens = mainPlanningEstimate(value.fixed, value.memory.slots, reducedPrefix, value.model, undefined, 0).tokens;
    assert.equal(request.calibratedUndercountTokens, Math.ceil(rawDelta * retainedTokens / prefixTokens));
    assert(request.calibratedUndercountTokens! < rawDelta);
    assert(request.outputTokens >= 8192 && request.outputTokens < 65536);
    assert(requestTokens(request.context) + request.calibratedUndercountTokens! + request.outputTokens + 1024 <= 1048576);
    return answer();
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(requests, 1); assert.equal(result.observations.omissions.length, 1);
  const accounting = result.observations.accounting!;
  const initialLimit = 1048576 - 8192 - 1024;
  assert(accounting.fullExtractionTokens <= initialLimit);
  assert(accounting.fullExtractionTokens + rawDelta > initialLimit);
  assert.equal(accounting.normalExtractionAtTrigger, accounting.fullExtractionTokens - accounting.mainBeforeTokens + accounting.effectiveTrigger);
  assert.equal(accounting.extractionPlanningTokens, accounting.extractionTokens + accounting.calibratedUndercountTokens!);
  assert.equal(accounting.outputLimitedBy, "window");
  assert.equal(result.observations.maintenanceCalibration?.actualInputTokens, 175, "persist only maintenance response input");
});

for (const invalid of ["model", "provider", "api", "aborted", "error", "ineligible", "unavailable", "unknown-edit", "stale-time", "fractional", "missing", "zero"] as const) {
  test(`active usage rejects ${invalid} anchors`, async () => {
    const value = await input();
    const message = { ...answer(), timestamp: 1, usage: { ...answer().usage, input: 50000 } };
    const entry = { entryId: "anchor", sourceRole: "assistant" as const, messages: [message], outputUsageUnavailable: false };
    value.active = [user("old", "source"), entry, user("latest", "Continue.")];
    if (invalid === "model") message.model = "other";
    if (invalid === "provider") message.provider = "other";
    if (invalid === "api") message.api = "anthropic-messages";
    if (invalid === "aborted" || invalid === "error") message.stopReason = invalid;
    if (invalid === "ineligible") value.eligibleUsageEntryIds = ["old", "latest"];
    if (invalid === "unavailable") { entry.outputUsageUnavailable = true; value.eligibleUsageEntryIds = ["anchor"]; }
    if (invalid === "unknown-edit") value.active[0]!.outputUsageUnavailable = true;
    if (invalid === "stale-time") value.active[0]!.messages[0]!.timestamp = 2;
    if (invalid === "fractional") message.usage.cacheRead = 0.5;
    if (invalid === "missing") Reflect.deleteProperty(message.usage, "totalTokens");
    if (invalid === "zero") Object.assign(message.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
    assert.equal(activeUsageUndercount(value), 0);
    const result = await maintain(value, responder());
    assert(result.ok, result.ok ? "" : result.message);
    assert.equal(result.observations.accounting!.calibratedUndercountTokens, 0);
  });
}

test("usage selects the latest valid message prefix and keeps the larger maintenance correction", async () => {
  const value = await input();
  const early = { ...answer(), usage: { ...answer().usage, input: 40000 } };
  const latest = { ...answer(), usage: { ...answer().usage, input: 12000 } };
  value.active = [user("old", "source"), { entryId: "anchors", sourceRole: "assistant", messages: [early, latest] }, user("latest", "z".repeat(80000))];
  const prefix = value.active.slice(0, 2);
  const expected = 12115 - mainPlanningEstimate(value.fixed, value.memory.slots, prefix, value.model, undefined, 0).tokens;
  assert.equal(activeUsageUndercount(value), expected, "later source is excluded and the latest usage wins over the larger earlier usage");
  value.eligibleUsageEntryIds = ["anchors"];
  value.active[0]!.outputUsageUnavailable = true;
  assert.equal(activeUsageUndercount(value), expected, "explicit host scope permits anchors following an edit");
  remember(value, await maintain(value, request => Promise.resolve(measured(request, 20000))));
  const feedback = maintenanceFeedback(value);
  assert.equal(feedback.maintenanceUndercountTokens, 20000);
  assert.equal(feedback.activeUndercountTokens, expected);
  assert.equal(feedback.calibratedUndercountTokens, 20000);
});

test("main usage cannot fabricate a maintenance measurement when the response has no usage", async () => {
  const value = await input();
  value.active.splice(2, 0, { entryId: "main-usage", sourceRole: "assistant", messages: [{ ...answer(), usage: { ...answer().usage, input: 20000 } }] });
  const result = await maintain(value, async () => ({ ...answer(), usage: undefined }));
  assert(result.ok, result.ok ? "" : result.message);
  assert(result.observations.accounting!.calibratedUndercountTokens! > 0);
  assert.equal(result.observations.maintenanceCalibration, undefined);
  assert.equal(maintenanceCalibrationRecord(value, result), undefined);
});

for (const eligible of [["missing"], ["old", "old"], "old"]) test(`invalid usage eligibility ${JSON.stringify(eligible)} fails before dispatch`, async () => {
  const value = await input();
  Object.assign(value, { eligibleUsageEntryIds: eligible });
  const result = await maintain(value, async () => assert.fail("invalid host scope cannot dispatch"));
  assert(!result.ok); assert.equal(result.code, "INPUT"); assert.equal(result.observations.requests, 0);
});

const providerError = "400 INVALID_ARGUMENT: The input token count exceeds the maximum number of tokens allowed 60000.";
function overflow(request: ModelRequest) {
  return { ...answer(noChange, request.model), stopReason: "error", errorMessage: providerError, usage: undefined };
}
async function source() {
  const value = await input();
  value.memory = { version: 1, nextId: 2, slots: [{ id: "s1", text: "Old M must survive a rejected request." }] };
  value.active = [user("old", "Retire this older work."), assistant("call", [{ type: "toolCall", id: "x", name: "read", arguments: { exact: "preserve arguments" } }]),
    tool("body", "x", "HEAD" + "tool evidence ".repeat(1200) + "TAIL"), user("latest", "Current instruction remains intact.")];
  value.eligibleKeptEntryIds = ["call"];
  return value;
}
function remember(value: MaintenanceInput, result: MaintenanceResult) {
  const saved = maintenanceCalibrationRecord(value, result);
  assert(saved, "a provider refusal or measured maintenance input has durable evidence");
  value.calibration = [...(value.calibration ?? []), structuredClone(saved)];
  return saved;
}

test("historical v1 numeric-key digests restore positive undercount and invalidate changed sources", async () => {
  const value = await source();
  const message = value.active[1]!.messages[0]!;
  assert(message.role === "assistant" && message.content[0]?.type === "toolCall");
  message.content[0].arguments = { "2": "two", "10": "ten" };
  // Frozen v1 disk encoding, independent of the current production digest helper.
  // JSON.stringify emits integer-index keys numerically, even after lexical sorting.
  const historicalDigest = (data: unknown) => createHash("sha256").update(JSON.stringify(data, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest("hex");
  const { toolResults: _mode, headTailChars: _chars, ...extraction } = value.config.extraction;
  value.calibration = JSON.parse(JSON.stringify([{
    version: 1, provider: value.model.provider, api: value.model.api, modelId: value.model.id,
    sourceEntryIds: value.active.map(entry => entry.entryId), sourceDigest: historicalDigest(value.active),
    limitsDigest: historicalDigest({ contextWindow: value.model.contextWindow, maxTokens: value.model.maxTokens, extraction, imageTokens: value.config.imageTokens }),
    measurement: { sourceEntryIds: value.active.map(entry => entry.entryId), estimatedInputTokens: 2000, actualInputTokens: 2700, undercountTokens: 700 },
  }]));
  assert.equal(maintenanceFeedback(value).calibratedUndercountTokens, 700);
  message.content[0].arguments["2"] = "changed";
  assert.equal(maintenanceFeedback(value).calibratedUndercountTokens, 0);
});

test("heuristic-admitted provider overflow reports exact evidence once, then auto reduces once without rewriting M or original K", async () => {
  const value = await source(), before = structuredClone({ active: value.active, memory: value.memory });
  let calls = 0;
  const failed = await maintain(value, async request => { calls++; return overflow(request); });
  assert(!failed.ok); assert.equal(failed.code, "RESPONSE"); assert.equal(failed.observations.requests, 1); assert.equal(calls, 1);
  assert.deepEqual(failed.observations.omissions, []);
  const accounting = failed.observations.accounting!;
  assert(accounting.fullExtractionTokens < accounting.extractionInputLimit, "the heuristic would have admitted this full source");
  assert.deepEqual(failed.observations.providerOverflow, { provider: value.model.provider, api: value.model.api, modelId: value.model.id,
    mode: "full", sourceEntryIds: value.active.map(e => e.entryId), estimatedInputTokens: accounting.extractionTokens,
    extractionInputLimit: accounting.extractionInputLimit, outputReserveTokens: accounting.outputReserveTokens, reportedInputTokens: null, errorMessage: providerError });
  assert(!("candidate" in failed)); assert.deepEqual({ active: value.active, memory: value.memory }, before);
  remember(value, failed);
  const recovered = await maintain(value, async request => {
    calls++;
    const records = sourceRecords(request.context), body = records.find(r => r.entryId === "body")!.messages[0]!;
    assert(body.role === "toolResult" && body.content[0]?.type === "text");
    assert.equal(body.content[0].text.match(/\[Nunc omitted/g)?.length, 1);
    for (const id of ["old", "latest"]) assert.deepEqual(records.find(r => r.entryId === id)!.messages,
      before.active.find(e => e.entryId === id)!.messages.map(({ role, content }) => ({ role, content })));
    const call = records.find(r => r.entryId === "call")!.messages[0]!;
    assert(call.role === "assistant"); assert.deepEqual(call.content, (before.active[1]!.messages[0] as typeof call).content);
    return answer({ add: [], remove: [], priority: ["s1"], required: ["s1"] }, request.model);
  });
  assert(recovered.ok, recovered.ok ? "" : recovered.message);
  assert.equal(calls, 2); assert.equal(recovered.observations.requests, 1); assert.equal(recovered.observations.omissions.length, 1);
  assert.deepEqual(recovered.candidate.kept, before.active.slice(1)); assert.deepEqual(recovered.candidate.memory, before.memory);
  assert.deepEqual({ active: value.active, memory: value.memory }, before);
});

test("full never downgrades; full and reduced refusals coexist, repeat reduced sends zero, and changed reduction or extended source permits one bounded attempt", async () => {
  const value = await source();
  remember(value, await maintain(value, async request => overflow(request)));
  value.config.extraction.toolResults = "full";
  const strict = await maintain(value, async () => assert.fail("full must not resend the rejected input"));
  assert(!strict.ok); assert.equal(strict.code, "CAPACITY"); assert.equal(strict.observations.requests, 0); assert.deepEqual(strict.observations.omissions, []);
  value.config.extraction.toolResults = "auto";
  const reduced = await maintain(value, async request => overflow(request));
  assert(!reduced.ok); assert.equal(reduced.observations.providerOverflow?.mode, "reduced");
  remember(value, reduced);
  assert.equal(selectMaintenanceCalibration(value).length, 2);
  assert(maintenanceFeedback(value).full); assert(maintenanceFeedback(value).reduced);
  for (let i = 0; i < 2; i++) {
    const blocked = await maintain(value, async () => assert.fail("same reduced refusal must be zero-dispatch"));
    assert(!blocked.ok); assert.equal(blocked.code, "CAPACITY"); assert.equal(blocked.observations.requests, 0);
  }
  value.config.extraction.toolResults = "full";
  const fullAgain = await maintain(value, async () => assert.fail("the newer reduced refusal must not erase the full refusal"));
  assert(!fullAgain.ok); assert.equal(fullAgain.code, "CAPACITY"); assert.equal(fullAgain.observations.requests, 0);
  value.config.extraction.toolResults = "auto";
  value.config.extraction.headTailChars = 100;
  const smaller = await maintain(value, async request => answer({ add: [], remove: [], priority: ["s1"], required: [] }, request.model));
  assert(smaller.ok, smaller.ok ? "" : smaller.message); assert.equal(smaller.observations.requests, 1); assert.equal(smaller.observations.omissions[0]?.headChars, 100);
  value.config.extraction.headTailChars = 200;
  value.active.push(user("later", "Later delivered instruction extends the original prefix."));
  const extended = await maintain(value, async request => overflow(request));
  assert.equal(extended.observations.requests, 1); assert.equal(extended.observations.omissions.length, 1);
});

test("a full refusal with no reducible tool body cannot be blindly sent by auto", async () => {
  const value = await input();
  remember(value, await maintain(value, async request => overflow(request)));
  const blocked = await maintain(value, async () => assert.fail("no bounded reduction is available"));
  assert(!blocked.ok); assert.equal(blocked.code, "CAPACITY"); assert.equal(blocked.observations.requests, 0); assert.deepEqual(blocked.observations.omissions, []);
});

for (const change of ["model", "provider", "api", "branch", "edit", "prefix", "window", "input-limit", "output-reserve", "safety", "memory", "policy"] as const) {
  test(`${change} change invalidates old refusal rather than blocking or reducing unrelated input`, async () => {
    const value = await source();
    remember(value, await maintain(value, async request => overflow(request)));
    if (change === "model") value.model.id = "other";
    if (change === "provider") value.model.provider = "other";
    if (change === "api") value.model.api = "anthropic-messages";
    if (change === "branch") value.active[0]!.entryId = "other-branch";
    if (change === "edit") (value.active[0]!.messages[0] as { content: string }).content = "Edited content with the same source ID.";
    if (change === "prefix") value.active.shift();
    if (change === "window") value.model.contextWindow++;
    if (change === "input-limit") value.config.extraction.inputLimit = 50000;
    if (change === "output-reserve") value.config.extraction.outputTokens++;
    if (change === "safety") value.config.extraction.safetyTokens++;
    if (change === "memory") value.memory.slots[0]!.text = "Corrected M";
    if (change === "policy") value.policy = { ...value.policy, user: "New maintenance preference." };
    // Retained restriction is a host boundary, not part of this binding test.
    delete value.eligibleKeptEntryIds;
    const result = await maintain(value, async request => answer({ add: [], remove: [], priority: ["s1"], required: [] }, request.model));
    assert(result.ok, result.ok ? "" : result.message); assert.equal(result.observations.requests, 1); assert.deepEqual(result.observations.omissions, []);
  });
}

for (const error of ["429 token limit exceeded", "HTTP 429: too many tokens", "Error code: 429 - too many tokens", "Rate limit: too many tokens", "ECONNRESET: connection reset", "fetch failed"]) {
  test(`${error} is not provider context overflow`, async () => {
    const value = await source();
    const result = await maintain(value, async request => ({ ...overflow(request), errorMessage: error }));
    assert(!result.ok); assert.equal(result.observations.requests, 1); assert.equal(result.observations.providerOverflow, undefined);
    assert.equal(maintenanceCalibrationRecord(value, result), undefined);
  });
}

test("thrown network errors, aborted responses, wrong identity and cancellation cannot become overflow/calibration evidence", async () => {
  const value = await source();
  const disconnected = await maintain(value, async () => { throw new Error("socket closed"); });
  assert(!disconnected.ok); assert.equal(disconnected.code, "MODEL"); assert.equal(disconnected.observations.requests, 1); assert.equal(disconnected.observations.providerOverflow, undefined);
  for (const override of [{ stopReason: "aborted" }, { provider: "wrong" }, { api: "wrong" }, { model: "wrong" }]) {
    const result = await maintain(value, async request => ({ ...overflow(request), usage: answer().usage, ...override }));
    assert(!result.ok); assert.equal(result.observations.providerOverflow, undefined); assert.equal(result.observations.maintenanceCalibration, undefined);
  }
  const controller = new AbortController(); value.signal = controller.signal;
  const cancelled = await maintain(value, async request => { controller.abort(); return overflow(request); });
  assert(!cancelled.ok); assert.equal(cancelled.code, "CANCELLED"); assert.equal(cancelled.observations.providerOverflow, undefined);
  assert.equal(maintenanceCalibrationRecord(value, cancelled), undefined);
});

function measured(request: ModelRequest, delta: number, content = "invalid JSON") {
  const estimated = requestTokens(request.context);
  const actual = estimated + delta;
  return { ...answer(undefined, request.model), content: [{ type: "text", text: content }],
    usage: { ...answer().usage, input: actual - 200, cacheRead: 125, cacheWrite: 75, output: 40, totalTokens: actual + 40 } };
}

test("maintenance-only undercount includes cache writes, is additive in precheck and resolved auto cap, and is never recursively subtracted", async () => {
  const value = await source();
  value.model.maxTokens = 59000;
  value.config.extraction.outputAuto = true;
  const failed = await maintain(value, async request => measured(request, 2000));
  assert(!failed.ok); assert.equal(failed.code, "RESPONSE");
  assert.equal(failed.observations.maintenanceCalibration?.undercountTokens, 2000);
  const beforeMain = failed.observations.accounting!.mainBeforeTokens;
  const plain = resolveExtractionRequest(value, cap => extractionContext(value, 1, 1000, value.active, [], cap));
  const saved = remember(value, failed);
  assert.equal(saved.measurement?.actualInputTokens, failed.observations.usage.contextInput);
  const resolved = resolveExtractionRequest(value, cap => extractionContext(value, 1, 1000, value.active, [], cap));
  assert.equal(resolved.extractionTokens, plain.extractionTokens);
  assert.equal(resolved.extractionPlanningTokens, plain.extractionTokens + 2000);
  assert.equal(resolved.outputTokens, plain.outputTokens - 2000, "auto cap leaves measured extra input room");
  const next = await maintain(value, async request => measured(request, 2000));
  assert(!next.ok); assert.equal(next.observations.maintenanceCalibration?.undercountTokens, 2000, "raw baseline prevents a correction/zero oscillation");
  assert.equal(next.observations.accounting!.mainBeforeTokens, beforeMain);
  assert.equal(next.observations.accounting!.calibratedUndercountTokens, 2000);
  assert.deepEqual(next.observations.accounting!.extractionUncertainties, ["maintenance-usage-undercount"]);
  assert.deepEqual(value.memory.slots, [{ id: "s1", text: "Old M must survive a rejected request." }]);
});

test("positive calibrated undercount activates the one reduction pass even when raw full estimate fits", async () => {
  const value = await source();
  const base = await maintain(value, async request => overflow(request));
  const accounting = base.observations.accounting!;
  value.config.extraction.extraInputTokens = inputLimit(value.model, value.config.extraction) - accounting.fullExtractionTokens - 500;
  const measuredFailure = await maintain(value, async request => {
    const response = measured(request, value.config.extraction.extraInputTokens + 1000);
    return response;
  });
  assert(!measuredFailure.ok); assert.equal(measuredFailure.observations.maintenanceCalibration?.undercountTokens, 1000);
  remember(value, measuredFailure);
  const after = await maintain(value, async request => answer({ add: [], remove: [], priority: ["s1"], required: [] }, request.model));
  assert(after.ok, after.ok ? "" : after.message);
  assert(after.observations.accounting!.fullExtractionTokens <= after.observations.accounting!.extractionInputLimit);
  assert(after.observations.accounting!.fullExtractionTokens + 1000 > after.observations.accounting!.extractionInputLimit);
  assert.equal(after.observations.omissions.length, 1); assert.equal(after.observations.requests, 1);
  value.config.extraction.toolResults = "full";
  const full = await maintain(value, async () => assert.fail("full must account for calibrated undercount"));
  assert(!full.ok); assert.equal(full.code, "CAPACITY"); assert.equal(full.observations.requests, 0);
});

test("valid usage on provider rejection survives a later unknown-usage reduced refusal", async () => {
  const value = await source();
  const full = await maintain(value, async request => ({ ...measured(request, 500), stopReason: "error", errorMessage: providerError }));
  remember(value, full);
  remember(value, await maintain(value, async request => overflow(request)));
  const feedback = maintenanceFeedback(value);
  assert(feedback.full); assert(feedback.reduced); assert.equal(feedback.calibratedUndercountTokens, 500);
  const blocked = await maintain(value, async () => assert.fail("composite state must still block the same reduced request"));
  assert(!blocked.ok); assert.equal(blocked.code, "CAPACITY"); assert.equal(blocked.observations.requests, 0);
});

test("SDK length overflow is evidence; complete stops above catalog occupancy still commit with a measured correction", async () => {
  const value = await source();
  const length = await maintain(value, async request => ({ ...answer(undefined, request.model), stopReason: "length",
    usage: { ...answer().usage, input: value.model.contextWindow, cacheRead: 0, cacheWrite: 0, output: 0 } }));
  assert(!length.ok); assert.equal(length.code, "RESPONSE"); assert.equal(length.observations.providerOverflow?.mode, "full");
  assert.equal(length.observations.providerOverflow?.errorMessage, undefined);
  const complete = await maintain(value, async request => ({ ...answer({ add: [], remove: [], priority: ["s1"], required: [] }, request.model),
    usage: { ...answer().usage, input: value.model.contextWindow + 1, cacheRead: 0, cacheWrite: 0 } }));
  assert(complete.ok, complete.ok ? "" : complete.message);
  assert.equal(complete.observations.providerOverflow?.reportedInputTokens, value.model.contextWindow + 1);
  assert(complete.observations.maintenanceCalibration!.undercountTokens > 0);
  assert.equal(maintenanceCalibrationRecord(value, complete)?.providerOverflow, undefined, "a complete stop is not persisted as a refusal");
});

test("a measured correction can change the resolved reduced cap once; the next identical refusal then blocks", async () => {
  const value = await source(); value.model.maxTokens = 59000; value.config.extraction.outputAuto = true;
  remember(value, await maintain(value, async request => overflow(request)));
  const measuredReduced = await maintain(value, async request => ({ ...measured(request, 900), stopReason: "error", errorMessage: providerError }));
  assert.equal(measuredReduced.observations.providerOverflow?.mode, "reduced");
  remember(value, measuredReduced);
  const changedCap = await maintain(value, async request => overflow(request));
  assert.equal(changedCap.observations.requests, 1);
  assert.equal(changedCap.observations.accounting!.outputReserveTokens, measuredReduced.observations.accounting!.outputReserveTokens - 900);
  remember(value, changedCap);
  const blocked = await maintain(value, async () => assert.fail("the same newly resolved reduced cap must never resend"));
  assert(!blocked.ok); assert.equal(blocked.code, "CAPACITY"); assert.equal(blocked.observations.requests, 0);
  assert.equal(blocked.observations.accounting!.calibratedUndercountTokens, 900);
});

test("malformed saved calibration is ignored and successful calibration rebinds to unchanged original K", async () => {
  const value = await source();
  const result = await maintain(value, async request => measured(request, 700, JSON.stringify({ add: [], remove: [], priority: ["s1"], required: [] })));
  assert(result.ok, result.ok ? "" : result.message);
  const saved = maintenanceCalibrationRecord(value, result)!;
  assert.deepEqual(saved.sourceEntryIds, result.candidate.kept.map(e => e.entryId));
  assert.deepEqual(saved.measurement?.sourceEntryIds, value.active.map(e => e.entryId));
  value.active = structuredClone(result.candidate.kept); value.memory = result.candidate.memory; value.calibration = [saved];
  assert.equal(maintenanceFeedback(value).calibratedUndercountTokens, 700);
  assert.deepEqual(selectMaintenanceCalibration(value, [{ ...saved, sourceDigest: "invalid" }, { ...saved, measurement: { ...saved.measurement, undercountTokens: -1 } }]), []);
  value.active[0]!.messages = [{ role: "user", content: "same ID, different content", timestamp: 0 }];
  assert.equal(maintenanceFeedback(value).calibratedUndercountTokens, 0);
});
