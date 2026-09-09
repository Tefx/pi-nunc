import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fixture, repository } from "./fixtures.js";
import { loadScenario, parseScenario } from "../../src/live/scenarios.js";
import { archiveCloseoutEffects } from "../../src/live/archive-closeout.js";
import { nativeRpcError, ordinaryNoWork } from "../../src/live/native-no-work.js";
import { prepareBoundary } from "../../src/live/preparation.js";
import { matchedParity } from "../../src/live/comparison-observation.js";
import { comparisonStock, compareCli } from "./comparison-native-fixture.js";

test("archive variant selection cannot mutate the short source or replace its original oracle", async () => {
  const a = JSON.parse(await readFile(join(repository, "tests/scenarios/extraction-inputs.json"), "utf8"));
  const b = JSON.parse(await readFile(join(repository, "tests/scenarios/extraction-observer.json"), "utf8"));
  const saved = structuredClone(a), config = (await fixture()).scenarios[0]!.config;
  const short = parseScenario(a, b, { id: "e3", config });
  const longer = parseScenario(a, b, { id: "e3", variant: "archive-closeout", config });
  assert.deepEqual(a, saved);
  assert.deepEqual(longer.input.turns.slice(-2), short.input.turns);
  for (const [path, content] of Object.entries(short.input.files)) assert.equal(longer.input.files[path], content);
  assert.deepEqual(longer.observer.controls, short.observer.controls);
  assert.deepEqual(longer.observer.artifactChecks.slice(0, short.observer.artifactChecks.length), short.observer.artifactChecks);
  assert(longer.observer.artifactChecks.length > short.observer.artifactChecks.length);
  assert.equal(archiveCloseoutEffects(longer.input, [], "/task").status, "UNPROVEN", "files alone do not establish useful executed history");
  b.cases.find((c: any) => c.id === "e3").variants[0].artifactChecks = "invalid";
  assert.throws(() => parseScenario(a, b, { id: "e3", variant: "archive-closeout", config }));
});

test("positive native no-work needs exact safe reason, unchanged source and zero unresolved effects", () => {
  const before = [{ id: "u", parentId: null, type: "message", timestamp: "2026-09-09T00:00:00Z", message: { role: "user", content: "short task", timestamp: 0 } }] as SessionEntry[];
  const facts = { defaults: true, before, after: structuredClone(before), settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, newPreparations: 0, newMaintenance: 0, newRequests: 0, unresolved: 0, isCompacting: false, pendingMessageCount: 0 };
  const error = nativeRpcError("compact", "Nothing to compact (session too small)");
  assert.equal(ordinaryNoWork(error, facts), true);
  for (const change of [{ defaults: false }, { newPreparations: 1 }, { newMaintenance: 1 }, { newRequests: 1 }, { unresolved: 1 }, { isCompacting: true }, { pendingMessageCount: 1 }, { after: [] }]) assert.equal(ordinaryNoWork(error, { ...facts, ...change }), false);
  for (const body of ["Compaction cancelled", "Authentication failed: private-token", "Nothing to compact (session too small) private-token", "HTTP 503 private-token", undefined]) {
    const unknown = nativeRpcError("compact", body);
    assert.equal(ordinaryNoWork(unknown, facts), false);
    assert(!JSON.stringify(unknown).includes("private-token")); assert(!unknown.message.includes("private-token"));
  }
  assert.equal(nativeRpcError("compact", "Already compacted").diagnostic.reason, "already-compacted");
  assert.equal(ordinaryNoWork(nativeRpcError("prompt", "Nothing to compact (session too small)"), facts), false);
});

test("public archive variant executes useful history, complete automatic split, restored suffix, restart and original check in three groups", { timeout: 180000 }, async () => {
  const f = await comparisonStock({ e3: "archive" });
  try {
    const { code, report } = await compareCli(f, [{ id: "e3", variant: "archive-closeout" }], ["matched"], "archive-closeout", true);
    assert.equal(code, 0, JSON.stringify(report?.rawSegments?.map((s: any) => ({ group: s.group, status: s.status, reason: s.reason, diagnostic: s.diagnostic, prerequisites: s.prerequisites }))));
    assert.equal(report.rawSegments.length, 6);
    for (const group of ["native", "current", "candidate"]) {
      const [first, second] = report.rawSegments.filter((s: any) => s.group === group);
      assert.equal(first.status, "PAUSED"); assert.equal(second.status, "OBSERVED"); assert.notEqual(first.pid, second.pid);
      assert.equal(first.sessionFile, second.sessionFile);
      assert(first.prerequisites.every((c: any) => c.status === "PROVEN"));
      assert(second.score.checks.every((c: any) => c.status === "PROVEN"));
      assert.equal(second.score.actionReview[0].status, "PROVEN");
      assert.equal(first.configurationChanges.length, 2);
      assert.deepEqual(first.configurationChanges[1].to, first.configurationChanges[0].from);
      assert.equal(first.configurationChanges[1].to.compaction.enabled, true);
      const row = first.rollovers[0], p = row.prepared;
      assert(p.native.contextTokens > p.native.trigger);
      assert.equal(row.reason, "threshold"); assert.equal(row.preparation.isSplitTurn, true);
      assert.equal(row.snapshot.firstKeptEntryId, p.firstKeptEntryId);
      assert.equal(row.callIds.length, group === "native" ? 2 : 1, "real prior history makes native use both summary requests");
      if (group !== "native") {
        const a = p.calibration.accounting;
        assert(a.fixedTokens + a.memoryLimit + a.keptTokens + a.growthReserve <= a.effectiveTrigger);
        assert(a.effectiveTrigger <= a.mainInputLimit);
        assert(a.fullExtractionTokens <= a.extractionInputLimit);
      }
      assert.equal(row.rebuilt.filter((e: any) => e.type !== "compaction").length, 3, "calling assistant and both sibling results remain intact");
      const { input } = await loadScenario(repository, { id: "e3", variant: "archive-closeout", config: first.configurationChanges[0].from });
      const cwd = join(report.selection.target.stateRoot, `matched-${group}-e3-archive-closeout`, "task");
      assert.equal(archiveCloseoutEffects(input, first.actions, cwd).status, "PROVEN");
      const missing = first.actions.filter((a: any) => !(a.turn === "january" && a.event.type === "tool_result" && a.event.toolName === "read"));
      assert.equal(archiveCloseoutEffects(input, missing, cwd).status, "UNPROVEN");
      const firstA = first.requests.find((r: any) => r.turn === "a" && r.kind === "main");
      const supplied = report.ledger.find((r: any) => r.kind === "terminal" && r.id === firstA.callId).usage.input;
      assert(supplied > 2000, "history has real provided fixture usage, without the old isolated high constant");
      const triggerCall = row.active.find((e: any) => e.type === "message" && e.message.role === "assistant" && e.message.content.some((b: any) => b.type === "toolCall" && b.arguments.path === "investigation.json"));
      const triggerId = triggerCall.message.content.find((b: any) => b.type === "toolCall" && b.arguments.path === "investigation.json").id;
      const prepareInput = { branch: row.branch, active: row.active, control: row.placement.control, turns: {}, turnOrder: input.turns.map(t => t.id), config: first.configurationChanges[0].from,
        model: row.model, fixed: { systemPrompt: firstA.context.systemPrompt, tools: firstA.context.tools }, signal: new AbortController().signal,
        trigger: { callId: triggerId, requestText: input.turns.find(t => t.id === "a")!.text, path: "investigation.json", cwd, fixtureContent: input.files["investigation.json"]!, contextTokens: p.native.contextTokens } };
      for (const kind of ["request", "sibling", "late"] as const) {
        const bad = structuredClone({ branch: prepareInput.branch });
        if (kind === "request") bad.branch = bad.branch.filter((e: any) => !(e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("Resume the export")));
        if (kind === "sibling") bad.branch.pop();
        if (kind === "late") bad.branch.push({ ...triggerCall, id: "late-assistant", parentId: bad.branch.at(-1)!.id, message: { ...triggerCall.message, content: [{ type: "text", text: "Suffix already ran" }] } });
        await assert.rejects(prepareBoundary({ ...prepareInput, branch: bad.branch, active: buildContextEntries(bad.branch) }), /Matching request|sibling|suffix/);
      }
    }
    assert.deepEqual(report.usage.unreconciledCallIds, []);
    assert.equal(report.usage.calls, f.requests.length);
    assert.equal(report.comparison.modes[0].records.matchedParity.budgetMatched, false);
  } finally { await f.close(); }
});

test("all groups omitting required source cannot establish matched exposure from equal empty traces", { timeout: 120000 }, async () => {
  const f = await comparisonStock();
  const base = f.response;
  f.response = (row: any, source: any) => {
    const reply = base(row, source);
    return reply?.tool?.name === "read" && reply.tool.input.path === "rows.json" ? "Skipped input inspection." : reply;
  };
  try {
    const { code, report } = await compareCli(f, [{ id: "e1" }], ["matched"], "missing-source");
    assert.equal(code, 0, JSON.stringify(report?.reason));
    const p = report.comparison.modes[0].records.matchedParity;
    assert.equal(p.exposureMatched, false);
    assert.equal(p.cutMatched, true);
    assert(p.differences[0].groups.every((g: any) => g.missingNecessaryReads.includes("a:rows.json")));
  } finally { await f.close(); }
});

test("omitted closeout effect stops the variant before original a or maintenance transport", { timeout: 120000 }, async () => {
  const f = await comparisonStock({ e3: "archive" });
  const base = f.response;
  f.response = (row: any, source: any) => {
    const reply = base(row, source);
    return reply?.tool?.input.path === "closeout/quarter-to-date.json" ? "Omitted the combined handoff." : reply;
  };
  try {
    const { code, report } = await compareCli(f, [{ id: "e3", variant: "archive-closeout" }], ["matched"], "missing-history-effect", true);
    assert.equal(code, 2);
    for (const segment of report.rawSegments) {
      assert.equal(segment.status, "UNPROVEN");
      assert.equal(segment.nextTurn, 3);
      assert.equal(segment.rollovers.length, 0);
      assert(segment.requests.every((r: any) => r.kind === "main" && r.turn !== "a"));
      assert(segment.prerequisites.some((p: any) => p.status === "UNPROVEN" && p.check.includes("finance effects")));
    }
    assert.deepEqual(report.usage.unreconciledCallIds, []);
  } finally { await f.close(); }
});

test("matched logical placement survives differing tool counts and K sizes; missing source and split units fail independently", { timeout: 180000 }, async () => {
  const f = await comparisonStock({ variedTools: true });
  try {
    const { code, report, stateRoot } = await compareCli(f, [{ id: "e1" }], ["matched"], "logical-placement");
    assert.equal(code, 0, JSON.stringify(report?.reason));
    const pair = [{ label: "e1", groups: ["native", "current", "candidate"].map(group => {
      const s = report.rawSegments.filter((s: any) => s.group === group).at(-1);
      return { group, complete: true, cwd: join(stateRoot, `matched-${group}-e1`, "task"), rows: s.rollovers, requests: s.requests };
    }) }];
    const p = matchedParity(pair);
    for (const key of ["modelMatched", "exposureMatched", "cutMatched", "kMatched", "wrappersMeasured", "fileListsMeasured"] as const) assert.equal(p[key], true, JSON.stringify(p.discrepancies));
    assert.equal(p.budgetMatched, false); assert.equal(p.status, "UNPROVEN");
    const first: any = p.differences[0];
    assert.equal(first.exactTrajectory.rawCutIndicesEqual, false);
    assert.equal(first.exactTrajectory.kTokensEqual, false);
    assert.equal(first.exactTrajectory.kContentEqual, false);
    for (const kind of ["cut", "unit", "source", "rewrite"] as const) {
      const bad = structuredClone(pair), row = bad[0]!.groups[1]!.rows[0];
      if (kind === "cut" || kind === "unit") {
        const index = row.active.findIndex((e: any) => e.id === row.snapshot.firstKeptEntryId);
        row.snapshot.firstKeptEntryId = row.active[index + (kind === "unit" ? 2 : 1)].id;
      } else if (kind === "rewrite") row.rebuilt.at(-1).message.content = [{ type: "text", text: "changed own K" }];
      else {
        const source = row.active.find((e: any) => e.type === "message" && e.message.role === "toolResult" && JSON.stringify(e.message.content).includes("[1,null,3]"));
        source.message.content = [{ type: "text", text: "missing source" }];
      }
      const failed = matchedParity(bad);
      assert.equal(kind === "source" ? failed.exposureMatched : failed.kMatched, false, kind);
    }
  } finally { await f.close(); }
});
