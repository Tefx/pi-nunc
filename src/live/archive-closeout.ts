import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CheckResult, ScenarioInput } from "./scenarios.js";

/** Observable work prerequisites, without supplying the model any result or feedback. */
export function archiveCloseoutEffects(input: ScenarioInput, actions: unknown[], cwd: string): CheckResult {
  const rows = actions as Array<{ turn: string; event: any }>;
  const effects = rows.flatMap((r, i) => {
    if (r.event.type !== "tool_call") return [];
    const end = rows.findIndex((v, j) => j > i && v.turn === r.turn && v.event.type === "tool_result" && v.event.toolCallId === r.event.toolCallId && v.event.toolName === r.event.toolName && v.event.isError === false);
    return end < 0 ? [] : [{ ...r, start: i, end, result: rows[end]!.event }];
  });
  const months = ["january", "february"];
  const monthly: any[] = [];
  const evidence: unknown[] = [];
  let complete = true;
  for (const month of months) {
    const channels: Record<string, { netUnits: number; netCents: number }> = Object.fromEntries(["web", "counter", "partner"].map(c => [c, { netUnits: 0, netCents: 0 }]));
    const excludedInvoices = [];
    for (const row of JSON.parse(input.files[`archive/${month}.json`]!)) {
      if (row.state === "void") excludedInvoices.push(row.invoice);
      else { const c = channels[row.channel]!; c.netUnits += row.quantity - row.refundedUnits; c.netCents += (row.quantity - row.refundedUnits) * row.unitCents; }
    }
    monthly.push({ channels, excludedInvoices });
    const read = effects.find(e => e.turn === month && e.event.toolName === "read" && resolve(cwd, e.event.input.path) === resolve(cwd, `archive/${month}.json`) && e.result.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim() === input.files[`archive/${month}.json`]!.trim());
    const write = effects.find(e => e.turn === month && e.event.toolName === "write" && resolve(cwd, e.event.input.path) === resolve(cwd, `closeout/${month}.json`) && read && e.start > read.end && sameJson(e.event.input.content, monthly.at(-1)));
    complete &&= Boolean(read && write);
    evidence.push({ month, read: read?.event.toolCallId ?? null, write: write?.event.toolCallId ?? null });
  }
  const combined = { months, channels: Object.fromEntries(Object.keys(monthly[0].channels).map(c => [c, { netUnits: monthly[0].channels[c].netUnits + monthly[1].channels[c].netUnits, netCents: monthly[0].channels[c].netCents + monthly[1].channels[c].netCents }])), excludedInvoices: monthly.flatMap(m => m.excludedInvoices) };
  const reads = months.map((m, i) => effects.find(e => e.turn === "closeout" && e.event.toolName === "read" && resolve(cwd, e.event.input.path) === resolve(cwd, `closeout/${m}.json`) && sameJson(e.result.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""), monthly[i])));
  const write = effects.find(e => e.turn === "closeout" && e.event.toolName === "write" && resolve(cwd, e.event.input.path) === resolve(cwd, "closeout/quarter-to-date.json") && reads.every(r => r && r.end < e.start) && sameJson(e.event.input.content, combined));
  complete &&= Boolean(write);
  return { check: "archive closeout produced monthly and combined finance effects before original a", status: complete ? "PROVEN" : "UNPROVEN", observed: { monthly: evidence, combinedWrite: write?.event.toolCallId ?? null } };
}
function sameJson(text: string, expected: unknown) { try { return isDeepStrictEqual(JSON.parse(text), expected); } catch { return false; } }
