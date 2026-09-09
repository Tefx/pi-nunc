import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { compactionAssociationError, resolveCompactionIdentity } from "../../src/live/compaction-identity.js";
import { joinedObservations } from "../../src/live/comparison.js";
import { rolloverFacts, type RolloverObservation } from "../../src/live/comparison-observation.js";
import type { ComparisonGroup, ComparisonMode, RunInput } from "../../src/live/contract.js";
import type { MatchReference } from "../../src/live/preparation.js";
import { runSegment, type SegmentReport } from "../../src/live/worker.js";
import { repository } from "./fixtures.js";
import { comparisonStock } from "./comparison-native-fixture.js";

function entry(id: string, cut = "k", summary = "same", fromHook?: boolean): Extract<SessionEntry, { type: "compaction" }> {
  return { type: "compaction", id, parentId: null, timestamp: "2026-09-09T00:00:00Z", summary, firstKeptEntryId: cut, tokensBefore: 1, ...(fromHook === true ? { fromHook } : {}) };
}
function reason(identity: ReturnType<typeof resolveCompactionIdentity>): string | undefined {
  return identity.status === "UNPROVEN" ? identity.reason : undefined;
}
function kept(id: string): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-09-09T00:00:00Z", message: { role: "user", content: id, timestamp: 0 } };
}
function row(snapshot: Extract<SessionEntry, { type: "compaction" }>, callIds: number[]): RolloverObservation {
  return { turn: "b", reason: "manual", model: { id: "m", provider: "p" } as RolloverObservation["model"], thinking: "off",
    preparation: { firstKeptEntryId: snapshot.firstKeptEntryId, settings: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 }, isSplitTurn: false, messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 1 },
    branch: [kept("a"), snapshot], active: [kept(snapshot.firstKeptEntryId)], config: { compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 }, nunc: {} },
    snapshot, rebuilt: [snapshot, kept(snapshot.firstKeptEntryId)], callIds };
}

test("resolver binds the unique new compaction, not the first equal summary", () => {
  const first = entry("old", "k1"), second = entry("new", "k2"), k2 = kept("k2");
  const resolved = resolveCompactionIdentity({
    preBranchIds: ["old", "k1"], branch: [first, second], rebuilt: [second, k2], reported: first, expectedCut: "k2",
  });
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    assert.equal(resolved.snapshot.id, "new");
    assert.equal(resolved.reportedId, "old");
  }
});

test("resolver refuses missing prestate, no new compaction, ambiguity and inconsistent cut", () => {
  const first = entry("old", "k1"), second = entry("new", "k2"), third = entry("other", "k3");
  assert.equal(reason(resolveCompactionIdentity({ branch: [second], reported: first })), "missing-prestate");
  assert.equal(reason(resolveCompactionIdentity({ preBranchIds: ["old"], branch: [first], reported: first })), "no-new-compaction");
  assert.equal(reason(resolveCompactionIdentity({ preBranchIds: [], branch: [first, second], reported: first })), "ambiguous-new-compaction");
  assert.equal(reason(resolveCompactionIdentity({ preBranchIds: ["old"], branch: [first, second], reported: first, expectedCut: "k1" })), "inconsistent-cut-or-result");
  assert.equal(reason(resolveCompactionIdentity({ preBranchIds: ["old"], branch: [first, second], rebuilt: [first, kept("k1")], reported: first })), "inconsistent-cut-or-result");
  assert.equal(reason(resolveCompactionIdentity({ preBranchIds: ["old"], branch: [first, third], reported: first, resultCut: "nope" })), "inconsistent-cut-or-result");
});

test("Nunc fromHook ignores native expectedCut; resultCut still binds", () => {
  const hook = entry("new", "nunc-cut", "same", true);
  const ok = resolveCompactionIdentity({ preBranchIds: ["old"], branch: [entry("old"), hook], rebuilt: [hook, kept("nunc-cut")], expectedCut: "native-cut" });
  assert.equal(ok.status, "resolved");
  const bad = resolveCompactionIdentity({ preBranchIds: ["old"], branch: [entry("old"), hook], rebuilt: [hook, kept("nunc-cut")], resultCut: "other" });
  assert.equal(bad.status, "UNPROVEN");
});

test("joined observations dedup inherited copies and keep distinct equal-summary IDs", () => {
  const a = row(entry("id-a", "k1"), [1]), b = row(entry("id-b", "k2"), [2]);
  a.snapshot!.summary = b.snapshot!.summary = "same memory";
  const first = { rollovers: [a, b], requests: [] } as unknown as SegmentReport;
  assert.equal(joinedObservations([first]).rows.map(r => r.snapshot!.id).join(","), "id-a,id-b");
  const resume = { rollovers: [a, b], requests: [] } as unknown as SegmentReport;
  assert.equal(joinedObservations([first, resume]).rows.length, 2);
  const stale = { rollovers: [a, { ...b, snapshot: a.snapshot }], requests: [] } as unknown as SegmentReport;
  assert.equal(joinedObservations([stale]).rows.length, 1);
});

test("association error helper names missing identity without crediting a reported snapshot", () => {
  const reported = entry("old");
  const refused = compactionAssociationError({ association: { status: "UNPROVEN", reason: "ambiguous-new-compaction" }, snapshot: reported });
  assert.match(refused!, /ambiguous-new-compaction/);
  assert.match(refused!, /dependent transport refused/);
  assert.equal(compactionAssociationError({ snapshot: entry("new"), association: { status: "resolved" } }), undefined);
  assert.match(compactionAssociationError(undefined)!, /no-new-compaction/);
});

test("public reanalysis CLI refuses missing prestate and emits no usable native references", async () => {
  const root = await mkdtemp(join(repository, ".scratch", "commit-association-cli-"));
  const out = join(root, "out");
  await writeFile(join(root, "execution.json"), JSON.stringify({ rawSegments: [{ group: "native", mode: "matched", scenario: "synthetic", rollovers: [{
    turn: "b", reason: "manual", model: { id: "synthetic", provider: "fixture", contextWindow: 60000 }, thinking: "off",
    preparation: { firstKeptEntryId: "kept", settings: { reserveTokens: 1 }, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false },
    active: [kept("kept")], rebuilt: [entry("new", "kept"), kept("kept")], snapshot: entry("old", "kept"), callIds: [],
  }], requests: [] }] }));
  const run = spawnSync(process.execPath, [join(repository, "scripts/reanalyze-commit-association.mjs"), root, out, repository], {
    encoding: "utf8", env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  const projection = JSON.parse(await readFile(join(out, "projection.json"), "utf8"));
  assert.equal(projection.groups[0]!.projected[0]!.identity.status, "UNPROVEN");
  assert.equal(projection.groups[0]!.projected[0]!.identity.reason, "missing-prestate");
  assert.equal(projection.groups[0]!.projected[0]!.actualSnapshotId, null);
  assert.deepEqual(projection.groups[0]!.nativeReferences, []);
});

async function groupRun(f: Awaited<ReturnType<typeof comparisonStock>>, group: ComparisonGroup, mode: ComparisonMode, matchReferences?: MatchReference[], caseRoot?: string) {
  const model: Model<Api> = { id: f.modelId, name: f.modelId, provider: f.provider, api: f.api, baseUrl: f.endpoint, reasoning: false, input: ["text", "image"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stateRoot = join(f.state, "worker-run"); await mkdir(join(stateRoot, "tmp"), { recursive: true });
  const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
    limits: { maxCalls: 24, maxTotalTokens: 1920000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 90000 },
    scenarios: [{ id: "e2", config: { compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 100 }, extraction: { outputTokens: 1024 } }, retentionCalibration: { minFraction: 0.000001, maxFraction: 0.999999 } } }],
    comparison: { modes: [mode], targets: { native: { repository }, current: { repository }, candidate: { repository } } } };
  const overrides = { models: [model], controlledModels: { providers: { groq: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [{ ...model, provider: undefined, cost: undefined }] } } } };
  const report = await runSegment({ input, scenarioIndex: 0, deadline: Date.now() + 90000, resume: false, group, mode, ...(caseRoot ? { caseRoot } : {}), ...(matchReferences ? { matchReferences } : {}) }, overrides);
  await writeFile(join(f.dir, `${group}-association.json`), JSON.stringify(report, null, 2));
  return report;
}

test("stock persist with dropped prestate refuses later provider transport and keeps the compaction", { timeout: 60000 }, async () => {
  const f = await comparisonStock({ e3: "siblings" });
  try {
    const model: Model<Api> = { id: f.modelId, name: f.modelId, provider: f.provider, api: f.api, baseUrl: f.endpoint, reasoning: false, input: ["text", "image"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const stateRoot = join(f.state, "worker-run-prestate"); await mkdir(join(stateRoot, "tmp"), { recursive: true });
    const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
      limits: { maxCalls: 24, maxTotalTokens: 1920000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 60000 },
      overrides: [{ requirement: "identity-prestate-probe", reason: "Drop frozen prestate after a real persist" }],
      scenarios: [{ id: "e3", config: { compaction: { enabled: true, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 100 }, extraction: { outputTokens: 1024 } }, retentionCalibration: { minFraction: 0.000001, maxFraction: 0.999999 } } }],
      comparison: { modes: ["defaults"], targets: { native: { repository }, current: { repository }, candidate: { repository } } } };
    const report = await runSegment({ input, scenarioIndex: 0, deadline: Date.now() + 60000, resume: false, group: "native" },
      { models: [model], controlledModels: { providers: { groq: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [{ ...model, provider: undefined, cost: undefined }] } } } });
    assert.equal(report.status, "UNPROVEN", JSON.stringify({ status: report.status, reason: report.reason, diagnostic: report.diagnostic }));
    const row = report.rollovers?.find(r => r.reason === "threshold");
    assert.equal(row?.association?.status, "UNPROVEN");
    assert.equal(row?.association?.reason, "missing-prestate");
    assert.equal(row?.snapshot, undefined);
    assert.equal(row?.continuationCallId, undefined);
    assert.ok(report.sessionFile);
    const comps = SessionManager.open(report.sessionFile).getBranch().filter(e => e.type === "compaction");
    assert.equal(comps.length, 1);
    const lastMaintenance = Math.max(0, ...(row?.callIds ?? []));
    assert.equal((report.requests ?? []).filter(r => r.kind === "main" && r.callId > lastMaintenance).length, 0);
  } finally { await f.close(); }
});

test("stock equal-summary compactons keep distinct actual IDs through observer, join and native references", { timeout: 120000 }, async () => {
  const f = await comparisonStock({ sameMemory: true });
  try {
    const native = await groupRun(f, "native", "matched");
    assert.equal(native.status, "OBSERVED", JSON.stringify({ status: native.status, reason: native.reason, diagnostic: native.diagnostic, failed: native.prerequisites.filter(p => p.status !== "PROVEN") }));
    const nativeIds = (native.rollovers ?? []).map(r => r.snapshot!.id);
    assert.equal(new Set(nativeIds).size, 3);
    const matchReferences = (native.rollovers ?? []).map(r => {
      const x = rolloverFacts(r, native.requests ?? [], "native");
      return { snapshotId: x.snapshotId ?? "unobserved", mTokens: x.mTokens, outputCaps: x.outputCaps };
    });
    const candidate = await groupRun(f, "candidate", "matched", matchReferences, join(f.state, "worker-run-candidate"));
    assert.equal(candidate.status, "OBSERVED", JSON.stringify({ status: candidate.status, reason: candidate.reason, diagnostic: candidate.diagnostic, failed: candidate.prerequisites.filter(p => p.status !== "PROVEN") }));
    const rolls = candidate.rollovers ?? [];
    assert.equal(rolls.filter(r => r.snapshot).length, 3);
    const ids = rolls.map(r => r.snapshot!.id);
    assert.equal(new Set(ids).size, 3);
    assert.notEqual(rolls[0]!.snapshot!.firstKeptEntryId, rolls[1]!.snapshot!.firstKeptEntryId);
    assert.notEqual(rolls[1]!.snapshot!.firstKeptEntryId, rolls[2]!.snapshot!.firstKeptEntryId);
    assert.equal(rolls[0]!.snapshot!.summary, rolls[1]!.snapshot!.summary);
    assert.equal(rolls[1]!.snapshot!.summary, rolls[2]!.snapshot!.summary);
    assert.equal(rolls[1]!.association?.reportedId, ids[0]);
    assert.equal(rolls[2]!.association?.reportedId, ids[0]);
    assert.notEqual(ids[1], rolls[1]!.association?.reportedId);
    assert.notEqual(ids[2], rolls[2]!.association?.reportedId);
    const facts = rolls.map(r => rolloverFacts(r, candidate.requests ?? [], "candidate"));
    assert(facts.every(x => x.snapshotId && x.kTokens && x.kTokens > 0 && x.firstKeptEntryId));
    const joined = joinedObservations([candidate]);
    assert.deepEqual(joined.rows.map(r => r.snapshot!.id), ids);
    const inherited = joinedObservations([candidate, { ...candidate, rollovers: rolls.map(r => ({ ...r })) }]);
    assert.equal(inherited.rows.length, 3);
    assert.deepEqual(rolls.map(r => r.prepared?.matching?.referenceSnapshot), nativeIds);
  } finally { await f.close(); }
});
