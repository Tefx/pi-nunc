import { getLatestCompactionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";

export type CompactionIdentityReason = "missing-prestate" | "no-new-compaction" | "ambiguous-new-compaction" | "inconsistent-cut-or-result";
export type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
export type CompactionIdentity =
  | { status: "resolved"; snapshot: CompactionEntry; reportedId: string | null }
  | { status: "UNPROVEN"; reason: CompactionIdentityReason; reportedId: string | null };

/** Unique new compaction on the active branch versus frozen pre-maintenance IDs. Does not use equal-summary or latest-text selection. */
export function resolveCompactionIdentity(input: {
  preBranchIds?: Iterable<string> | undefined;
  branch: SessionEntry[];
  rebuilt?: SessionEntry[] | undefined;
  reported?: { id?: string; fromHook?: boolean } | undefined;
  expectedCut?: string | undefined;
  resultCut?: string | undefined;
}): CompactionIdentity {
  const reportedId = typeof input.reported?.id === "string" ? input.reported.id : null;
  if (input.preBranchIds == null) return { status: "UNPROVEN", reason: "missing-prestate", reportedId };
  const pre = new Set(input.preBranchIds);
  const candidates = input.branch.filter((e): e is CompactionEntry => e.type === "compaction" && !pre.has(e.id));
  if (candidates.length === 0) return { status: "UNPROVEN", reason: "no-new-compaction", reportedId };
  if (candidates.length > 1) return { status: "UNPROVEN", reason: "ambiguous-new-compaction", reportedId };
  const snapshot = candidates[0]!;
  if (snapshot.fromHook !== true && input.expectedCut !== undefined && snapshot.firstKeptEntryId !== input.expectedCut) {
    return { status: "UNPROVEN", reason: "inconsistent-cut-or-result", reportedId };
  }
  if (input.resultCut !== undefined && snapshot.firstKeptEntryId !== input.resultCut) {
    return { status: "UNPROVEN", reason: "inconsistent-cut-or-result", reportedId };
  }
  if (input.rebuilt) {
    const latest = getLatestCompactionEntry(input.rebuilt);
    if (!latest || latest.id !== snapshot.id || !input.rebuilt.some(e => e.id === snapshot.firstKeptEntryId)) {
      return { status: "UNPROVEN", reason: "inconsistent-cut-or-result", reportedId };
    }
  }
  return { status: "resolved", snapshot, reportedId };
}

export function compactionAssociationStop(reason: CompactionIdentityReason): string {
  return `Compaction identity unproven (${reason}); dependent transport refused`;
}

export function compactionAssociationError(row: { snapshot?: { id: string }; association?: { status?: string; reason?: string } } | undefined): string | undefined {
  if (row?.association?.status === "UNPROVEN") {
    const reason = row.association.reason;
    return compactionAssociationStop(reason === "missing-prestate" || reason === "no-new-compaction" || reason === "ambiguous-new-compaction" || reason === "inconsistent-cut-or-result" ? reason : "no-new-compaction");
  }
  if (row?.snapshot) return undefined;
  return compactionAssociationStop("no-new-compaction");
}
