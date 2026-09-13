import type { CheckResult } from "./scenarios.js";
import type { NuncConfig } from "../pi/config.js";
import type { RequestObservation } from "./comparison-observation.js";
import type { CallEnd, LedgerRecord } from "./budget.js";

export interface LayoutObservation {
  turn: string;
  model: string;
  kind: string;
  callId?: number;
  messageCount: number;
  memoryIndex?: number;
  memoryContent?: string;
  uniqueCarrier: boolean;
  payloadSyntheticMissing?: boolean;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  keepRecentFraction?: number;
}

export interface PositionEpoch {
  content: string;
  indexes: number[];
}

export function layoutsFromRequests(
  requests: readonly RequestObservation[],
  ledger: readonly LedgerRecord[],
  keepRecentFraction?: number,
): LayoutObservation[] {
  const terminals = ledger.filter((row): row is CallEnd => row.kind === "terminal");
  return requests.filter(request => request.kind === "main").map(request => {
    const admission = request.admission;
    const terminal = terminals.find(row => row.id === request.callId);
    const memoryIndex = admission?.memoryIndex;
    const memoryContent = admission?.memoryContent;
    const usage = terminal?.usage;
    const synthetic = (request as RequestObservation & { syntheticMissing?: boolean }).syntheticMissing;
    return {
      turn: request.turn,
      model: `${request.model.provider}/${request.model.id}`,
      kind: request.kind,
      callId: request.callId,
      messageCount: request.context.messages.length,
      uniqueCarrier: memoryIndex !== undefined,
      ...(memoryIndex !== undefined ? { memoryIndex } : {}),
      ...(memoryContent !== undefined ? { memoryContent } : {}),
      ...(synthetic !== undefined ? { payloadSyntheticMissing: synthetic } : {}),
      ...(usage?.input !== null && usage?.input !== undefined ? { input: usage.input } : {}),
      ...(usage?.cacheRead !== null && usage?.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
      ...(usage?.cacheWrite !== null && usage?.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
      ...(keepRecentFraction !== undefined ? { keepRecentFraction } : {}),
    };
  });
}

export function mainLayouts(rows: readonly LayoutObservation[]): LayoutObservation[] {
  return rows.filter(row => row.kind === "main");
}

export function unchangedContentEpochs(rows: readonly LayoutObservation[], expectedContent?: string): PositionEpoch[] {
  const epochs: PositionEpoch[] = [];
  for (const row of mainLayouts(rows)) {
    if (row.memoryIndex === undefined || row.memoryContent === undefined) continue;
    if (expectedContent !== undefined && row.memoryContent !== expectedContent) continue;
    const last = epochs.at(-1);
    if (last && last.content === row.memoryContent) last.indexes.push(row.memoryIndex);
    else epochs.push({ content: row.memoryContent, indexes: [row.memoryIndex] });
  }
  return epochs;
}

export function positionStable(rows: readonly LayoutObservation[], expectedContent?: string): boolean {
  const epochs = unchangedContentEpochs(rows, expectedContent).filter(epoch => epoch.indexes.length >= 2);
  return epochs.length > 0 && epochs.every(epoch => epoch.indexes.every(index => index === epoch.indexes[0]));
}

export function movingUsesTail(rows: readonly LayoutObservation[], expectedContent?: string): boolean {
  const placed = mainLayouts(rows).filter(row => row.memoryIndex !== undefined && (expectedContent === undefined || row.memoryContent === expectedContent));
  return placed.length >= 2 && placed.every(row => row.memoryIndex === row.messageCount - 1);
}

export function noSyntheticMissing(rows: readonly LayoutObservation[]): boolean | undefined {
  const scanned = rows.filter(row => row.payloadSyntheticMissing !== undefined);
  if (!scanned.length) return undefined;
  return scanned.every(row => row.payloadSyntheticMissing === false);
}

export function uniqueCarriers(rows: readonly LayoutObservation[], expectedContent?: string): boolean {
  const main = mainLayouts(rows);
  if (!main.length) return false;
  if (expectedContent !== undefined) {
    const expected = main.filter(row => row.memoryContent === expectedContent);
    return expected.length > 0 && expected.every(row => row.uniqueCarrier && row.memoryIndex !== undefined);
  }
  return main.every(row => row.memoryContent ? row.uniqueCarrier && row.memoryIndex !== undefined : !row.uniqueCarrier);
}

export function explicitKeepFraction(config: { nunc?: NuncConfig }, expected: 0.5 | 0.67): boolean {
  return config.nunc?.rolling?.keepRecentFraction === expected;
}

export function scoreStableMemory(input: {
  id: string;
  variant?: string;
  layouts: LayoutObservation[];
  config: { nunc?: NuncConfig; retentionCalibration?: unknown };
  expectedContent?: string;
}): CheckResult[] {
  const results: CheckResult[] = [
    { check: "unique injected M carrier on main requests", status: uniqueCarriers(input.layouts, input.expectedContent) ? "PROVEN" : "UNPROVEN", observed: { layouts: input.layouts } },
  ];
  const synthetic = noSyntheticMissing(input.layouts);
  results.push({
    check: "no serializer-synthesized missing tool results",
    status: synthetic === true ? "PROVEN" : "UNPROVEN",
    ...(synthetic === undefined ? { reason: "No serialized payload scan is bound to these requests" } : {}),
  });
  if (input.id === "m1" && input.variant === "fixed") {
    results.push({ check: "fixed layout keeps M at a stable request index across an unchanged-content epoch", status: positionStable(input.layouts, input.expectedContent) ? "PROVEN" : "UNPROVEN" });
  }
  if (input.id === "m1" && input.variant === "moving") {
    results.push({ check: "moving baseline places M at the request tail", status: movingUsesTail(input.layouts, input.expectedContent) ? "PROVEN" : "UNPROVEN" });
  }
  if (input.id === "m4") {
    const expected = input.variant === "keep-0.67" ? 0.67 : 0.5;
    results.push({
      check: `explicit keepRecentFraction ${expected} without retentionCalibration`,
      status: explicitKeepFraction(input.config, expected) && input.config.retentionCalibration === undefined ? "PROVEN" : "UNPROVEN",
      observed: { keepRecentFraction: input.config.nunc?.rolling?.keepRecentFraction },
    });
  }
  return results;
}
