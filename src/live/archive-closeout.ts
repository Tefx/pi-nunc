import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CheckResult, ScenarioInput } from "./scenarios.js";

const MONTHS = ["january", "february"] as const;
/** Stock read continuation notices from createReadToolDefinition. */
const STOCK_READ_FOOTER = /\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]+ limit\))?\.|\d+ more lines in file\.) Use offset=\d+ to continue\.\]$/;

type ActionRow = { turn: string; event: any };
type Effect = ActionRow & { start: number; end: number; result: any };
interface SourcePage {
  callId: string;
  offset: number;
  limit: number | null;
  returnedLines: number;
  from: number;
  to: number;
  end: number;
}

function textOf(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return "";
  return result.content.filter((block: { type?: unknown; text?: unknown }) => block?.type === "text" && typeof block.text === "string").map((block: { text: string }) => block.text).join("");
}

function pageArgs(input: { offset?: unknown; limit?: unknown }): { offset: number; limit?: number } | undefined {
  const offset = input.offset === undefined ? 1 : input.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1) return undefined;
  if (input.limit === undefined) return { offset };
  if (typeof input.limit !== "number" || !Number.isSafeInteger(input.limit) || input.limit < 1) return undefined;
  return { offset, limit: input.limit };
}

function sameJson(text: string, expected: unknown) { try { return isDeepStrictEqual(JSON.parse(text), expected); } catch { return false; } }

function monthlyTotals(input: ScenarioInput, month: string) {
  const channels: Record<string, { netUnits: number; netCents: number }> = Object.fromEntries(["web", "counter", "partner"].map(c => [c, { netUnits: 0, netCents: 0 }]));
  const excludedInvoices = [];
  for (const row of JSON.parse(input.files[`archive/${month}.json`]!)) {
    if (row.state === "void") excludedInvoices.push(row.invoice);
    else { const c = channels[row.channel]!; c.netUnits += row.quantity - row.refundedUnits; c.netCents += (row.quantity - row.refundedUnits) * row.unitCents; }
  }
  return { channels, excludedInvoices };
}

/** Exact path/offset/limit pages whose returned bytes match the fixture; overlap does not fill gaps. */
function sourceExposure(effects: Effect[], turn: string, relativePath: string, cwd: string, fixture: string): { pages: SourcePage[]; completeEnd?: number | undefined; completeCallId?: string | undefined; totalLines: number } {
  const lines = fixture.split("\n");
  const pages: SourcePage[] = [];
  for (const effect of effects) {
    if (effect.turn !== turn || effect.event.toolName !== "read" || typeof effect.event.input?.path !== "string") continue;
    if (resolve(cwd, effect.event.input.path) !== resolve(cwd, relativePath)) continue;
    const args = pageArgs(effect.event.input);
    if (!args) continue;
    const startLine = args.offset - 1;
    if (startLine >= lines.length) continue;
    const body = textOf(effect.result).replace(STOCK_READ_FOOTER, "");
    const returned = body.split("\n");
    if (returned.length === 0 || args.limit !== undefined && returned.length > args.limit) continue;
    if (!isDeepStrictEqual(returned, lines.slice(startLine, startLine + returned.length))) continue;
    pages.push({ callId: effect.event.toolCallId, offset: args.offset, limit: args.limit ?? null, returnedLines: returned.length, from: args.offset, to: args.offset + returned.length - 1, end: effect.end });
  }
  const covered = new Set<number>();
  let completeEnd: number | undefined;
  let completeCallId: string | undefined;
  for (const page of [...pages].sort((a, b) => a.end - b.end)) {
    for (let i = page.from - 1; i < page.to; i++) covered.add(i);
    if (completeEnd === undefined && lines.length > 0 && covered.size === lines.length) {
      completeEnd = page.end;
      completeCallId = page.callId;
    }
  }
  return { pages, completeEnd, completeCallId, totalLines: lines.length };
}

/** Observable work prerequisites, without supplying the model any result or feedback. */
export function archiveCloseoutEffects(input: ScenarioInput, actions: unknown[], cwd: string): CheckResult {
  const rows = actions as ActionRow[];
  const effects = rows.flatMap((row, i) => {
    if (row.event.type !== "tool_call") return [];
    const end = rows.findIndex((v, j) => j > i && v.turn === row.turn && v.event.type === "tool_result" && v.event.toolCallId === row.event.toolCallId && v.event.toolName === row.event.toolName && v.event.isError === false);
    return end < 0 ? [] : [{ ...row, start: i, end, result: rows[end]!.event }];
  });
  const monthly = MONTHS.map(month => monthlyTotals(input, month));
  const evidence: unknown[] = [];
  let complete = true;
  for (const [index, month] of MONTHS.entries()) {
    const source = `archive/${month}.json`;
    const exposure = sourceExposure(effects, month, source, cwd, input.files[source]!);
    const write = effects.find(e => e.turn === month && e.event.toolName === "write" && typeof e.event.input?.path === "string" && resolve(cwd, e.event.input.path) === resolve(cwd, `closeout/${month}.json`) && exposure.completeEnd !== undefined && e.start > exposure.completeEnd && sameJson(e.event.input.content, monthly[index]));
    complete &&= Boolean(write);
    evidence.push({
      month,
      read: exposure.completeCallId ?? null,
      write: write?.event.toolCallId ?? null,
      pages: exposure.pages.map(({ callId, offset, limit, returnedLines, from, to }) => ({ callId, offset, limit, returnedLines, from, to })),
      completeAt: exposure.completeCallId === undefined ? null : { toolCallId: exposure.completeCallId, end: exposure.completeEnd },
      totalLines: exposure.totalLines,
    });
  }
  const combined = { months: [...MONTHS], channels: Object.fromEntries(Object.keys(monthly[0]!.channels).map(c => [c, { netUnits: monthly[0]!.channels[c]!.netUnits + monthly[1]!.channels[c]!.netUnits, netCents: monthly[0]!.channels[c]!.netCents + monthly[1]!.channels[c]!.netCents }])), excludedInvoices: monthly.flatMap(m => m.excludedInvoices) };
  const reads = MONTHS.map((m, i) => effects.find(e => e.turn === "closeout" && e.event.toolName === "read" && typeof e.event.input?.path === "string" && resolve(cwd, e.event.input.path) === resolve(cwd, `closeout/${m}.json`) && sameJson(textOf(e.result), monthly[i])));
  const write = effects.find(e => e.turn === "closeout" && e.event.toolName === "write" && typeof e.event.input?.path === "string" && resolve(cwd, e.event.input.path) === resolve(cwd, "closeout/quarter-to-date.json") && reads.every(r => r && r.end < e.start) && sameJson(e.event.input.content, combined));
  complete &&= Boolean(write);
  return { check: "archive closeout produced monthly and combined finance effects before original a", status: complete ? "PROVEN" : "UNPROVEN", observed: { monthly: evidence, combinedWrite: write?.event.toolCallId ?? null, combinedReads: reads.map(r => r?.event.toolCallId ?? null) } };
}
