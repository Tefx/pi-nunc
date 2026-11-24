import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { project, sealDecisions } from "../../src/pi/projection.js";
import { maintain } from "../../src/engine/engine.js";
import { input as engineInput, answer } from "../engine/fixtures.js";
import observer from "../../src/live/observer.js";
import { DEFAULT_MAX_BYTES, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { checkFullExtraction, expandGeneratedFiles, checkArtifact, validateControl, jsonPointer, loadScenario, parseScenario, qualifyFullGiantSource, scoreArtifacts, seedScenario, type ArtifactCheck } from "../../src/live/scenarios.js";
import { fixture, repository } from "./fixtures.js";
import { parseInput } from "../../src/live/contract.js";

test("full extraction follows native context edits and the configured persisted cleanup view", async () => {
  const entries: SessionEntry[] = [
    { type: "message", id: "u", parentId: null, timestamp: "0", message: { role: "user", content: "Original request", timestamp: 0 } },
    { type: "message", id: "a", parentId: "u", timestamp: "1", message: fauxAssistantMessage(fauxToolCall("read", { path: "task.txt" }, { id: "call" }), { stopReason: "toolUse" }) },
    { type: "message", id: "r", parentId: "a", timestamp: "2", message: { role: "toolResult", toolCallId: "call", toolName: "read", isError: false, timestamp: 2, content: [{ type: "text", text: "Original source evidence" }] } },
    { type: "context_edit", id: "edit", parentId: "r", timestamp: "3", targetId: "u", replacement: { content: "Edited request" } },
    { type: "message", id: "next", parentId: "edit", timestamp: "4", message: { role: "user", content: "Continue", timestamp: 4 } },
  ];
  const projected = project(entries);
  entries.push({ type: "custom", customType: "nunc.memory", id: "save", parentId: "next", timestamp: "5", data: { nunc: projected.memory,
    toolResultCleanup: sealDecisions(projected.active, [{ entryId: "r", messageIndex: 0, toolCallId: "call", toolName: "read", kind: "semantic", action: "replace", text: "Evidence", originalLength: 24, cleanedLength: 8, netSavings: 16 }]) } });
  for (const cleanupEnabled of [true, false]) {
    const source = await engineInput(), current = project(entries);
    source.active = current.active; source.memory = current.memory; source.priorCleanup = current.cleanup;
    source.config.toolResultCleanup = cleanupEnabled;
    let context: Context | undefined;
    await maintain(source, async request => { context = request.context; return answer({ priority: [], required: [] }, request.model); });
    assert(context, "real engine extraction request reached completion seam");
    assert.equal(checkFullExtraction(entries, context, cleanupEnabled).status, "PROVEN");
    assert.equal(checkFullExtraction(entries, context, !cleanupEnabled).status, "UNPROVEN", "raw and cleaned source views must remain distinguishable");
  }
});

test("observer scopes repeated prompt controls to the ordinal user turn on the branch", async () => {
  const input = await fixture();
  const cwd = join(input.target.stateRoot, "task");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "note.txt"), "evidence");
  const events = join(input.target.stateRoot, "events.jsonl"), binding = join(input.target.stateRoot, "binding.json"), sessionFile = join(input.target.stateRoot, "session.jsonl");
  await writeFile(events, ""); await writeFile(sessionFile, "");
  await writeFile(binding, JSON.stringify({ input, cwd, models: input.resolvedModels, deadline: Date.now() + 20000, events, ledger: join(input.target.stateRoot, "calls.jsonl"),
    boundaries: [{ turnOrdinal: 3, requestText: "Repeat", fixtureContent: "evidence", control: { duringTurn: "third", action: "rollover_at_tool_boundary", trigger: { toolName: "read", pathArgument: "note.txt", occurrence: 2 } } }],
    guidanceControls: [{ action: "unconfirmed_save", turnOrdinal: 3, requestText: "Repeat", turn: "third" }] }));
  const previous = process.env.NUNC_LIVE_OBSERVER;
  const handlers = new Map<string, (...args: any[]) => any>(), commands = new Map<string, (...args: any[]) => any>();
  const branch: SessionEntry[] = [];
  const ctx = { sessionManager: { getBranch: () => branch, buildContextEntries: () => branch, getSessionFile: () => sessionFile }, getContextUsage: () => undefined };
  process.env.NUNC_LIVE_OBSERVER = binding;
  try {
    await observer({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), events: { on() {}, emit() {} }, unregisterProvider() {}, registerCommand: (name: string, value: { handler: (...args: any[]) => any }) => commands.set(name, value.handler) } as unknown as ExtensionAPI);
    const records = async () => (await readFile(events, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      branch.push({ type: "message", id: `user-${ordinal}`, parentId: branch.at(-1)?.id ?? null, timestamp: "0", message: { role: "user", content: "Repeat", timestamp: 0 } });
      await handlers.get("tool_call")!({ toolName: "nunc_memory_patch", toolCallId: `patch-${ordinal}`, input: {} }, ctx);
      for (let occurrence = 1; occurrence <= 2; occurrence++) {
        const toolCallId = `read-${ordinal}-${occurrence}`;
        await handlers.get("tool_call")!({ toolName: "read", toolCallId, input: { path: "note.txt" } }, ctx);
        const ended = handlers.get("turn_end")!({ toolResults: [{ toolCallId }] }, ctx);
        const rows = await records();
        assert.equal(rows.filter(r => r.type === "tool-boundary").length, ordinal === 3 && occurrence === 2 ? 1 : 0);
        assert.equal(rows.filter(r => r.data?.phase === "save-file-readonly").length, ordinal === 3 ? 1 : 0);
        if (ordinal === 3 && occurrence === 2) await commands.get("nunc-observer-release")!(JSON.stringify({ stop: "Test boundary observed" }));
        await ended;
      }
    }
    await handlers.get("session_shutdown")!();
  } finally {
    if (previous === undefined) delete process.env.NUNC_LIVE_OBSERVER; else process.env.NUNC_LIVE_OBSERVER = previous;
    await rm(input.target.stateRoot, { recursive: true, force: true });
  }
});

test("after-turn controls reject during-turn and trigger fields across all actions", () => {
  for (const action of ["rollover", "pause_resume_same_session", "switch_to_authorized_smaller_model"]) {
    const control = { action, afterTurn: "b", ...(action === "rollover" ? { capacity: "available" } : {}) };
    assert.doesNotThrow(() => validateControl(control, ["a", "b"]));
    for (const extra of [{ duringTurn: "b" }, { trigger: {} }, { duringTurn: "b", trigger: {} }]) {
      assert.throws(() => validateControl({ ...control, ...extra }, ["a", "b"]), /mixed timing/);
    }
  }
});

test("generated expansion is shared with seeding and does not mutate scenario files", async () => {
  const scenario = { id: "fixture", files: { "fixed.txt": "fixed" }, turns: [], generatedFiles: [{ path: "generated.txt", segments: [{ text: "x", repeat: 3 }] }] };
  assert.deepEqual(expandGeneratedFiles(scenario), { "fixed.txt": "fixed", "generated.txt": "xxx" });
  assert.deepEqual(scenario.files, { "fixed.txt": "fixed" });
});

test("every tracked input/observer variant loads separately; only task fixture files are seeded", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const sizes: Record<string, number> = {};
    for (const id of ["c1", "c2", "c3", "c4", "c5"] as const) for (const variant of id === "c4" ? ["full", "capacity"] as const : id === "c1" ? [undefined, "late-d"] as const : [undefined]) {
      const selected = { ...input.scenarios[0]!, id, ...(variant ? { variant } : {}) };
      const scenario = await loadScenario(repository, selected); assert.equal(scenario.input.id, id); assert(scenario.input.turns.length > 0); assert(scenario.observer.controls.length > 0);
      const cwd = join(input.target.stateRoot, `${id}-${variant ?? "base"}`);
      await seedScenario(scenario.input, cwd);
      if (id === "c4") {
        const text = await readFile(join(cwd, "inspection.txt"), "utf8");
        sizes[variant!] = Buffer.byteLength(text);
        assert(text.includes("verified exception: batch Q7"));
        if (variant === "full") {
          assert.equal(qualifyFullGiantSource(scenario.input.generatedFiles).status, "PROVEN");
          assert(sizes.full! > DEFAULT_MAX_BYTES);
          assert.notEqual(text.split("\n").length, 6002);
        } else {
          assert.equal(text.split("\n").length, 6002); assert(text.length > 250000);
        }
      }
      if (id === "c1" && variant === "late-d") {
        assert(scenario.observer.controls.some(c => c.steer === "d"));
        assert.equal(scenario.input.turns.map(t => t.id).join(","), "a,b,d,c");
        assert.equal(scenario.input.generatedFiles, undefined);
        assert.equal(scenario.input.files["probe.json"], undefined);
        assert(scenario.observer.artifactChecks.some(c => c.pointer === "/route" && c.operator === "unequal" && c.value === "cache"));
        assert(!scenario.observer.artifactChecks.some(c => c.operator === "equal" && c.value === "direct"));
        assert(scenario.input.turns.find(t => t.id === "c")?.text.includes("leave route null"));
      }
      assert(!Object.hasOwn(scenario.input.files, "observer.json"));
    }
    assert(sizes.capacity! > sizes.full!);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("m5 cleanup-on/off select the same original task and independent observer without a legacy baseline", async () => {
  const input = await fixture();
  for (const variant of ["cleanup-on", "cleanup-off"] as const) {
    const selection = { ...input.scenarios[0]!, id: "m5" as const, variant };
    const { input: scenario, observer } = await loadScenario(repository, selection);
    assert.equal(scenario.turns.length, 4);
    assert.equal(observer.artifactChecks[0]?.operator, "semantic");
    assert.deepEqual(scenario.files, (await loadScenario(repository, { ...selection, variant: variant === "cleanup-on" ? "cleanup-off" : "cleanup-on" })).input.files);
    assert.equal(parseInput({ ...input, scenarios: [selection] }).scenarios[0]?.variant, variant);
  }
  assert.throws(() => parseInput({ ...input, scenarios: [{ ...input.scenarios[0], id: "m5", variant: "cleanup-on" }], comparison: { modes: ["defaults"], targets: {} } }));
});

test("c4/full rejects a fixture that fits in one native read or exposes the exception in the first chunk", async () => {
  const source = JSON.parse(await readFile(join(repository, "tests/scenarios/inputs.json"), "utf8"));
  const observer = JSON.parse(await readFile(join(repository, "tests/scenarios/observer.json"), "utf8"));
  const selection = { ...(await fixture()).scenarios[0]!, id: "c4" as const, variant: "full" as const };
  const full = source.cases.find((c: { id: string }) => c.id === "c4").variants.find((v: { id: string }) => v.id === "full");
  full.generatedFiles[0].segments = [{ repeat: 10, text: "sample: nominal; no routing decision recorded\n" }, { repeat: 1, text: "verified exception: batch Q7 requires quarantine because its seal is broken; nominal samples do not clear Q7\n" }, { repeat: 10, text: "sample: nominal; no routing decision recorded\n" }];
  assert.throws(() => parseScenario(source, observer, selection));
});
test("consumed scenario schema rejects malformed placements, operators, expected values and source structure", async () => {
  const source = JSON.parse(await readFile(join(repository, "tests/scenarios/inputs.json"), "utf8"));
  const observer = JSON.parse(await readFile(join(repository, "tests/scenarios/observer.json"), "utf8"));
  const selection = (await fixture()).scenarios[0]!;
  // Deliberately malformed external JSON shapes are test inputs, not bypasses in production parsing.
  const mutations: Array<(s: any, o: any) => void> = [
    (_s, o) => o.cases[1].controls[0].placement = [],
    (_s, o) => o.cases[1].controls[0].placement.retainedTurns = ["b"],
    (_s, o) => delete o.cases[1].controls[0].placement.retainTurns,
    (_s, o) => o.cases[1].controls[0].placement.retireThroughTurn = "unknown",
    (_s, o) => o.cases[1].controls[0].placement.retireThroughTurn = "e",
    (_s, o) => o.cases[1].controls[0].placement.retainTurns = "b",
    (_s, o) => o.cases[1].controls[0].placement.retainTurns = ["a"],
    (_s, o) => o.cases[1].controls[0].placement.retainTurns = ["b", "b"],
    (_s, o) => o.cases[1].controls[0].capacity = {},
    (_s, o) => o.cases[1].controls[0].action = "force_boundary",
    (_s, o) => o.cases[1].controls[0].duringTurn = "b",
    (_s, o) => o.cases[1].controls[0].trigger = { toolName: "read", pathArgument: "notes.txt", occurrence: 1, when: "after_result_before_continuation" },
    (_s, o) => o.cases[1].controls[0].steer = "a",
    (_s, o) => o.cases[1].controls[0].steer = "b",
    (_s, o) => o.cases[1].controls.push(o.cases[1].controls[0]),
    (_s, o) => o.cases[1].artifactChecks[0].operator = "anything",
    (_s, o) => delete o.cases[1].artifactChecks[0].value,
    (_s, o) => o.cases[1].artifactChecks[0].value = undefined,
    (_s, o) => o.cases[1].artifactChecks[0].pointer = "/bad~escape",
    (_s, o) => o.cases[1].artifactChecks[0].path = "../outside.json",
    (_s, o) => o.cases[1].artifactChecks[0] = { path: "x.json", pointer: "/why", operator: "semantic" },
    (s, _o) => s.cases[1].turns[1].id = "a",
    (s, _o) => s.cases[1].turns[0].text = "",
    (s, _o) => s.cases.push(s.cases[1]),
    (s, _o) => s.cases[1].generatedFiles = [{ path: "x.txt", segments: [{ repeat: -1, text: "x" }] }],
  ];
  for (const mutate of mutations) { const s = structuredClone(source), o = structuredClone(observer); mutate(s, o); assert.throws(() => parseScenario(s, o, selection)); }
  assert.throws(() => checkArtifact({ path: "x.json", pointer: "/missing", operator: "equal" } as ArtifactCheck, {}), /defined JSON value/);
  assert.equal(checkArtifact({ path: "x.json", pointer: "/missing", operator: "equal", value: null }, {}).status, "DISPROVEN");
});

test("artifact observers detect wrong exact constraints, null loss and unsafe choices without rewarding semantic self-report", () => {
  assert.equal(checkArtifact({ path: "x", pointer: "/retryLimit", operator: "equal", value: 2 }, { retryLimit: 3 }).status, "DISPROVEN");
  assert.equal(checkArtifact({ path: "x", pointer: "/records", operator: "equal", value: [1, null, 3] }, { records: [1, 3] }).status, "DISPROVEN");
  assert.equal(checkArtifact({ path: "x", pointer: "/supportedNodeMajors", operator: "contains", value: 18 }, { supportedNodeMajors: [18, 22] }).status, "PROVEN");
  assert.equal(checkArtifact({ path: "x", pointer: "/reason", operator: "semantic", criterion: "Requires independent evidence" }, { reason: "PASS: all requirements proven" }).status, "UNPROVEN");
  assert.equal(jsonPointer({ "a/b": { "~key": [17] } }, "/a~1b/~0key/0"), 17);
  assert.equal(jsonPointer({}, "/toString"), undefined);
});
test("late-d cache refusal is mechanical; missing alternative is not a direct-route failure", () => {
  const forbidden = { path: "decision.json", pointer: "/route", operator: "unequal" as const, value: "cache" };
  assert.equal(checkArtifact(forbidden, { route: "cache" }).status, "DISPROVEN");
  assert.equal(checkArtifact(forbidden, { route: null }).status, "PROVEN");
  assert.equal(checkArtifact(forbidden, { route: "direct" }).status, "PROVEN");
  assert.equal(checkArtifact({ path: "decision.json", pointer: "/route", operator: "equal", value: "direct" }, { route: null }).status, "DISPROVEN");
  assert.equal(checkArtifact({ path: "decision.json", pointer: "/reason", operator: "semantic", criterion: "Independent evidence review" }, { reason: "direct because the previous run said so" }).status, "UNPROVEN");
});
test("even a correct artifact cannot score when actual rollover prerequisites are missing", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const { observer } = await loadScenario(repository, input.scenarios[0]!);
    await writeFile(join(input.target.stateRoot, "retry.json"), JSON.stringify({ supportedNodeMajors: [18], retryLimit: 2, retryBeforeCommit: true, retryAfterSuccessfulCommit: false }));
    const unproven = await scoreArtifacts(input.target.stateRoot, observer, [{ check: "three persisted rollovers", status: "UNPROVEN" }]);
    assert(unproven.checks.every(c => c.status === "UNPROVEN"));
    const proven = await scoreArtifacts(input.target.stateRoot, observer, [{ check: "three persisted rollovers", status: "PROVEN" }]);
    assert(proven.checks.every(c => c.status === "PROVEN")); assert(proven.actionReview.every(c => c.status === "UNPROVEN"));
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
