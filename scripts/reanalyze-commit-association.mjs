/**
 * purpose: Reanalyze retained comparison rollovers with the tracked compaction-identity resolver and join/K consumers.
 * usage: node scripts/reanalyze-commit-association.mjs RETAINED_ROOT OUT_DIR [WORKTREE]
 * effects: Reads retained execution.json and optional snapshot-origin-data.json; writes OUT_DIR/projection.json. Does not modify retained reports, bindings, source-budget, or sessions.
 * requires: Node, compiled dist/src/live/{compaction-identity,comparison,comparison-observation}.js, retained execution.json; no model/runtime replay.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const retainedRoot = process.argv[2];
const outDir = process.argv[3];
const worktree = resolve(process.argv[4] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
if (!retainedRoot || !outDir) {
  console.error("usage: node scripts/reanalyze-commit-association.mjs RETAINED_ROOT OUT_DIR [WORKTREE]");
  process.exit(1);
}

const live = join(worktree, "dist/src/live");
const { resolveCompactionIdentity } = await import(pathToFileURL(join(live, "compaction-identity.js")).href);
const { joinedObservations } = await import(pathToFileURL(join(live, "comparison.js")).href);
const { rolloverFacts } = await import(pathToFileURL(join(live, "comparison-observation.js")).href);

function parseJsonl(text) {
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)).filter(e => e.type !== "session") : [];
}

const execution = JSON.parse(await readFile(join(retainedRoot, "execution.json"), "utf8"));
const groups = [];
for (const segment of execution.rawSegments ?? []) {
  let entries = [];
  if (segment.sessionFile) {
    try { entries = parseJsonl(await readFile(segment.sessionFile, "utf8")); }
    catch { entries = []; }
  }
  const projected = [];
  for (const row of segment.rollovers ?? []) {
    const preBranchIds = Array.isArray(row.branch) ? row.branch.map(e => e.id) : undefined;
    const leaf = Array.isArray(row.branch) ? row.branch.at(-1)?.id : undefined;
    const pre = new Set(preBranchIds ?? []);
    const added = Array.isArray(row.branch) && leaf ? entries.filter(e => e.type === "compaction" && e.parentId === leaf && !pre.has(e.id)) : [];
    const branch = added.length ? [...row.branch, ...added] : Array.isArray(row.branch) ? row.branch : (row.rebuilt ?? []);
    const identity = resolveCompactionIdentity({
      preBranchIds, branch, rebuilt: row.rebuilt, reported: row.snapshot,
      ...(row.snapshot?.fromHook === true ? {} : row.preparation?.firstKeptEntryId ? { expectedCut: row.preparation.firstKeptEntryId } : {}),
      ...(row.result?.ok && row.result.candidate?.firstKeptEntryId ? { resultCut: row.result.candidate.firstKeptEntryId } : {}),
    });
    const snapshot = identity.status === "resolved" ? identity.snapshot : undefined;
    const next = { ...row, reported: row.snapshot, association: identity.status === "resolved"
      ? { status: "resolved", reportedId: identity.reportedId }
      : { status: "UNPROVEN", reason: identity.reason, reportedId: identity.reportedId },
      ...(snapshot ? { snapshot } : { snapshot: undefined }) };
    const facts = snapshot ? rolloverFacts(next, segment.requests ?? [], segment.group) : { kTokens: null, firstKeptEntryId: null, cutPoint: null };
    projected.push({
      turn: row.turn,
      identity,
      reportedSnapshotId: row.snapshot?.id ?? null,
      reportedCut: row.snapshot?.firstKeptEntryId ?? null,
      actualSnapshotId: snapshot?.id ?? null,
      actualCut: snapshot?.firstKeptEntryId ?? null,
      kTokens: facts.kTokens,
      firstKeptEntryId: facts.firstKeptEntryId,
      cutPoint: facts.cutPoint,
    });
  }
  const joinedRows = projected.map((p, i) => {
    const row = segment.rollovers[i];
    const snapshot = p.identity.status === "resolved" ? p.identity.snapshot : undefined;
    return { ...row, reported: row.snapshot, association: p.identity.status === "resolved"
      ? { status: "resolved", reportedId: p.identity.reportedId }
      : { status: "UNPROVEN", reason: p.identity.reason, reportedId: p.identity.reportedId },
      ...(snapshot ? { snapshot } : { snapshot: undefined }) };
  });
  const unresolved = projected.some(p => p.identity.status !== "resolved");
  const joined = joinedObservations([{ ...segment, rollovers: joinedRows, requests: segment.requests ?? [] }]);
  const facts = unresolved ? [] : joined.rows.map(row => rolloverFacts(row, joined.requests, segment.group));
  groups.push({
    group: segment.group, mode: segment.mode, scenario: segment.scenario, sessionFile: segment.sessionFile,
    originalRowCount: (segment.rollovers ?? []).length,
    originalSnapshotIds: (segment.rollovers ?? []).map(r => r.snapshot?.id ?? null),
    projected, joinedRowCount: unresolved ? 0 : joined.rows.length,
    joinedSnapshotIds: facts.map(f => f.snapshotId),
    joinedKTokens: facts.map(f => f.kTokens),
    nativeReferences: facts.map(f => ({ snapshotId: f.snapshotId ?? "unobserved", mTokens: f.mTokens, outputCaps: f.outputCaps })),
  });
}

let retainedApplicability = [];
try {
  const origin = JSON.parse(await readFile(join(retainedRoot, "snapshot-origin-data.json"), "utf8"));
  retainedApplicability = (origin.retainedApplicability ?? []).map(item => ({
    report: item.report, observedSnapshotRows: item.observedSnapshotRows, mismatchCount: (item.mismatches ?? []).length,
    mismatches: item.mismatches ?? [],
  }));
} catch { retainedApplicability = [{ status: "unavailable" }]; }

const out = {
  predicate: "src/live/compaction-identity.ts resolveCompactionIdentity + src/live/comparison.ts joinedObservations + src/live/comparison-observation.ts rolloverFacts",
  retainedRoot, worktree, originalReportsUntouched: true,
  groups,
  retainedApplicability,
};
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "projection.json"), JSON.stringify(out, null, 2));
const unresolved = groups.some(g => g.projected.some(p => p.identity.status !== "resolved"));
console.log(JSON.stringify({
  wrote: join(outDir, "projection.json"),
  unresolved,
  groups: groups.map(g => ({ group: g.group, original: g.originalSnapshotIds, actual: g.joinedSnapshotIds, k: g.joinedKTokens, rows: g.joinedRowCount, identities: g.projected.map(p => p.identity.status === "resolved" ? p.actualSnapshotId : p.identity.reason) })),
  retainedApplicability: retainedApplicability.map(x => ({ report: x.report, observedSnapshotRows: x.observedSnapshotRows, mismatchCount: x.mismatchCount })),
}));
if (unresolved) {
  console.error("commit-association: unresolved compaction identity; calibration references refused");
  process.exit(1);
}
