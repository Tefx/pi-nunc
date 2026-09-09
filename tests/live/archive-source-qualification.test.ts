import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { fixture, repository } from "./fixtures.js";
import { parseScenario, type ScenarioInput } from "../../src/live/scenarios.js";
import { archiveCloseoutEffects } from "../../src/live/archive-closeout.js";

const FEBRUARY_PAGES = [
  { offset: 1, limit: 100 },
  { offset: 101, limit: 100 },
  { offset: 201, limit: 100 },
  { offset: 190, limit: 25 },
  { offset: 280, limit: 120 },
] as const;

async function archiveInput(): Promise<ScenarioInput> {
  const a = JSON.parse(await readFile(join(repository, "tests/scenarios/extraction-inputs.json"), "utf8"));
  const b = JSON.parse(await readFile(join(repository, "tests/scenarios/extraction-observer.json"), "utf8"));
  return parseScenario(a, b, { id: "e3", variant: "archive-closeout", config: (await fixture()).scenarios[0]!.config }).input;
}

function totals(input: ScenarioInput, month: string) {
  const channels: Record<string, { netUnits: number; netCents: number }> = Object.fromEntries(["web", "counter", "partner"].map(c => [c, { netUnits: 0, netCents: 0 }]));
  const excludedInvoices = [];
  for (const row of JSON.parse(input.files[`archive/${month}.json`]!)) {
    if (row.state === "void") excludedInvoices.push(row.invoice);
    else { const c = channels[row.channel]!; c.netUnits += row.quantity - row.refundedUnits; c.netCents += (row.quantity - row.refundedUnits) * row.unitCents; }
  }
  return { channels, excludedInvoices };
}

function combinedOf(input: ScenarioInput) {
  const monthly = ["january", "february"].map(m => totals(input, m));
  return { months: ["january", "february"], channels: Object.fromEntries(Object.keys(monthly[0]!.channels).map(c => [c, { netUnits: monthly[0]!.channels[c]!.netUnits + monthly[1]!.channels[c]!.netUnits, netCents: monthly[0]!.channels[c]!.netCents + monthly[1]!.channels[c]!.netCents }])), excludedInvoices: monthly.flatMap(m => m.excludedInvoices) };
}

function call(turn: string, toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return { turn, event: { type: "tool_call", toolName, toolCallId, input } };
}
function result(turn: string, toolName: string, toolCallId: string, content: unknown, isError = false) {
  return { turn, event: { type: "tool_result", toolName, toolCallId, isError, content } };
}
function jsonContent(value: unknown) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; }
function stockLines(text: string) { return text.split("\n"); }
function nonemptyLines(text: string) {
  const lines = stockLines(text);
  return text.endsWith("\n") && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

async function stockRead(cwd: string, path: string, offset?: number, limit?: number) {
  const tool = createReadToolDefinition(cwd);
  const input = offset === undefined && limit === undefined ? { path } : { path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) };
  const executed = await tool.execute("read", input, undefined, undefined, { cwd } as never);
  assert(executed && typeof executed === "object" && Array.isArray((executed as { content?: unknown }).content));
  return executed as { content: Array<{ type: string; text?: string }> };
}

async function seededTask(input: ScenarioInput) {
  const cwd = await mkdtemp(join(tmpdir(), "nunc-archive-src-"));
  await mkdir(join(cwd, "archive"), { recursive: true });
  await mkdir(join(cwd, "closeout"), { recursive: true });
  await mkdir(join(cwd, "files"), { recursive: true });
  await writeFile(join(cwd, "archive/january.json"), input.files["archive/january.json"]!);
  await writeFile(join(cwd, "archive/february.json"), input.files["archive/february.json"]!);
  await writeFile(join(cwd, "files/february.json"), input.files["archive/february.json"]!);
  return cwd;
}

async function februaryStockPages(cwd: string, pages = FEBRUARY_PAGES) {
  const out = [];
  for (const [i, page] of pages.entries()) {
    const executed = await stockRead(cwd, "archive/february.json", page.offset, page.limit);
    const text = executed.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    out.push({ id: `feb-${i}`, page, executed, text });
  }
  return out;
}

function closeoutTrace(input: ScenarioInput, january: { id: string; content: unknown; path?: string; offset?: number; limit?: number }, february: Array<{ id: string; content: unknown; path?: string; offset?: number; limit?: number }>, options: { lateFebruaryWrite?: boolean; combinedFirst?: boolean; delayFirstFebruaryResult?: boolean } = {}) {
  const jan = totals(input, "january"), feb = totals(input, "february"), combined = combinedOf(input);
  const janInput: Record<string, unknown> = { path: january.path ?? "archive/january.json" };
  if (january.offset !== undefined) janInput.offset = january.offset;
  if (january.limit !== undefined) janInput.limit = january.limit;
  const actions: unknown[] = [
    call("january", "read", january.id, janInput),
    result("january", "read", january.id, january.content),
    call("january", "write", "jan-write", { path: "closeout/january.json", content: JSON.stringify(jan) }),
    result("january", "write", "jan-write", jsonContent("written")),
  ];
  const februaryReads = february.flatMap(page => {
    const inputArgs: Record<string, unknown> = { path: page.path ?? "archive/february.json" };
    if (page.offset !== undefined) inputArgs.offset = page.offset;
    if (page.limit !== undefined) inputArgs.limit = page.limit;
    return [call("february", "read", page.id, inputArgs), result("february", "read", page.id, page.content)];
  });
  const februaryWrite = [
    call("february", "write", "feb-write", { path: "closeout/february.json", content: JSON.stringify(feb) }),
    result("february", "write", "feb-write", jsonContent("written")),
  ];
  if (options.lateFebruaryWrite) actions.push(...februaryWrite, ...februaryReads);
  else if (options.delayFirstFebruaryResult && februaryReads.length >= 2) actions.push(februaryReads[0], ...februaryReads.slice(2), ...februaryWrite, februaryReads[1]);
  else actions.push(...februaryReads, ...februaryWrite);
  const closeoutReads = [
    call("closeout", "read", "q-jan", { path: "closeout/january.json" }),
    result("closeout", "read", "q-jan", jsonContent(jan)),
    call("closeout", "read", "q-feb", { path: "closeout/february.json" }),
    result("closeout", "read", "q-feb", jsonContent(feb)),
  ];
  const closeoutWrite = [
    call("closeout", "write", "q-write", { path: "closeout/quarter-to-date.json", content: JSON.stringify(combined) }),
    result("closeout", "write", "q-write", jsonContent("written")),
  ];
  if (options.combinedFirst) actions.push(...closeoutWrite, ...closeoutReads);
  else actions.push(...closeoutReads, ...closeoutWrite);
  return actions;
}

test("stock paginated february reads with overlap expose the archive before monthly and combined writes", async () => {
  const input = await archiveInput();
  const cwd = await seededTask(input);
  try {
    const january = await stockRead(cwd, "archive/january.json");
    const pages = await februaryStockPages(cwd);
    const fixture = input.files["archive/february.json"]!;
    assert.equal(stockLines(fixture).length, 399);
    assert.equal(nonemptyLines(fixture).length, 398);
    assert.equal(stockLines(fixture).at(-1), "");
    assert.match(pages[0]!.text, /more lines in file\. Use offset=101 to continue/);
    assert.match(pages[3]!.text, /more lines in file\. Use offset=215 to continue/);
    assert.equal(/more lines in file|Showing lines /.test(pages[4]!.text), false);
    assert.equal(stockLines(pages[4]!.text).length, 120);
    assert.equal(nonemptyLines(pages[4]!.text).length, 119);
    assert.equal(stockLines(pages[4]!.text).at(-1), "");
    const actions = closeoutTrace(input, { id: "jan-read", content: january.content }, pages.map(p => ({ id: p.id, content: p.executed.content, offset: p.page.offset, limit: p.page.limit })));
    const check = archiveCloseoutEffects(input, actions, cwd);
    assert.equal(check.status, "PROVEN", JSON.stringify(check.observed));
    const february = (check.observed as any).monthly[1];
    assert.equal(february.pages.length, 5);
    assert.deepEqual(february.pages.map((p: any) => [p.offset, p.limit, p.returnedLines, p.from, p.to]), [
      [1, 100, 100, 1, 100],
      [101, 100, 100, 101, 200],
      [201, 100, 100, 201, 300],
      [190, 25, 25, 190, 214],
      [280, 120, 120, 280, 399],
    ]);
    assert.equal(february.totalLines, 399);
    assert.equal(february.write, "feb-write");
    assert.equal((check.observed as any).combinedWrite, "q-write");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("stock whole-file archive reads still prove closeout before original a", async () => {
  const input = await archiveInput();
  const cwd = await seededTask(input);
  try {
    const january = await stockRead(cwd, "archive/january.json");
    const february = await stockRead(cwd, "archive/february.json");
    const actions = closeoutTrace(input, { id: "jan-read", content: january.content }, [{ id: "feb-read", content: february.content }]);
    const check = archiveCloseoutEffects(input, actions, cwd);
    assert.equal(check.status, "PROVEN", JSON.stringify(check.observed));
    assert.equal((check.observed as any).monthly[0].read, "jan-read");
    assert.equal((check.observed as any).monthly[1].read, "feb-read");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("tracked source predicate rejects missing, overlap-only, failed, wrong-source, stale, invalid, late and early-combined traces", async () => {
  const input = await archiveInput();
  const cwd = await seededTask(input);
  try {
    const january = await stockRead(cwd, "archive/january.json");
    const pages = await februaryStockPages(cwd);
    const fullFebruary = pages.map(p => ({ id: p.id, content: p.executed.content, offset: p.page.offset, limit: p.page.limit }));
    const proven = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, fullFebruary), cwd);
    assert.equal(proven.status, "PROVEN");

    const missing = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, fullFebruary.slice(0, 4)), cwd);
    assert.equal(missing.status, "UNPROVEN");
    assert.equal((missing.observed as any).monthly[1].write, null);

    const overlapOnly = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, [fullFebruary[0]!, fullFebruary[3]!]), cwd);
    assert.equal(overlapOnly.status, "UNPROVEN");
    assert.equal((overlapOnly.observed as any).monthly[1].completeAt, null);

    const failedActions = closeoutTrace(input, { id: "jan-read", content: january.content }, fullFebruary);
    for (const row of failedActions as any[]) {
      if (row.turn === "february" && row.event.toolName === "read" && row.event.type === "tool_result") row.event.isError = true;
    }
    const failed = archiveCloseoutEffects(input, failedActions, cwd);
    assert.equal(failed.status, "UNPROVEN");
    assert.equal((failed.observed as any).monthly[1].pages.length, 0);

    const wrongSource = await stockRead(cwd, "files/february.json", 1, 100);
    const wrong = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, [
      { id: "feb-wrong", content: wrongSource.content, path: "files/february.json", offset: 1, limit: 100 },
      ...fullFebruary.slice(1),
    ]), cwd);
    assert.equal(wrong.status, "UNPROVEN");
    assert.equal((wrong.observed as any).monthly[1].pages.some((p: any) => p.callId === "feb-wrong"), false);

    const stalePage = structuredClone(fullFebruary[0]!);
    stalePage.content = jsonContent((input.files["archive/february.json"]!.split("\n").slice(0, 100).join("\n") + "\n").replace("FEB-001", "FEB-STALE"));
    const stale = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, [stalePage, ...fullFebruary.slice(1)]), cwd);
    assert.equal(stale.status, "UNPROVEN");

    for (const bad of [{ offset: 0, limit: 100 }, { offset: 10000, limit: 10 }, { offset: 1, limit: 0 }, { offset: 1.5, limit: 10 }]) {
      const invalid = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, [
        { id: "feb-bad", content: fullFebruary[0]!.content, offset: bad.offset, limit: bad.limit },
        ...fullFebruary.slice(1),
      ]), cwd);
      assert.equal(invalid.status, "UNPROVEN", JSON.stringify(bad));
    }

    const late = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, fullFebruary, { lateFebruaryWrite: true }), cwd);
    assert.equal(late.status, "UNPROVEN");
    assert.equal((late.observed as any).monthly[1].write, null);
    assert.equal((late.observed as any).monthly[1].completeAt.toolCallId, "feb-4");

    const earlyCombined = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, fullFebruary, { combinedFirst: true }), cwd);
    assert.equal(earlyCombined.status, "UNPROVEN");
    assert.equal((earlyCombined.observed as any).monthly[1].write, "feb-write");
    assert.equal((earlyCombined.observed as any).combinedWrite, null);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("stock EOF-limited page, full-body invalid ranges, and delayed necessary results do not qualify", async () => {
  const input = await archiveInput();
  const cwd = await seededTask(input);
  try {
    const january = await stockRead(cwd, "archive/january.json");
    const omitted = await stockRead(cwd, "archive/february.json", 1, 398);
    const omittedText = omitted.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    assert.match(omittedText, /\[1 more lines in file\. Use offset=399 to continue\.\]$/);
    const omittedCheck = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, [{ id: "feb-398", content: omitted.content, offset: 1, limit: 398 }]), cwd);
    assert.equal(omittedCheck.status, "UNPROVEN");
    const omittedFeb = (omittedCheck.observed as any).monthly[1];
    assert.equal(omittedFeb.write, null);
    assert.equal(omittedFeb.completeAt, null);
    assert.deepEqual(omittedFeb.pages.map((p: any) => [p.offset, p.limit, p.returnedLines, p.from, p.to]), [[1, 398, 398, 1, 398]]);

    const whole = await stockRead(cwd, "archive/february.json");
    for (const bad of [{ offset: 0, limit: 0 }, { offset: 10000, limit: 1 }, { offset: 1, limit: 1 }]) {
      const actions = closeoutTrace(input, { id: "jan-read", content: january.content }, [{ id: "feb-read", content: whole.content, offset: bad.offset, limit: bad.limit }]);
      const check = archiveCloseoutEffects(input, actions, cwd);
      assert.equal(check.status, "UNPROVEN", JSON.stringify(bad));
      assert.equal((check.observed as any).monthly[1].write, null);
      assert.equal((check.observed as any).monthly[1].pages.length, 0);
    }

    const pages = await februaryStockPages(cwd);
    const fullFebruary = pages.map(p => ({ id: p.id, content: p.executed.content, offset: p.page.offset, limit: p.page.limit }));
    const delayed = archiveCloseoutEffects(input, closeoutTrace(input, { id: "jan-read", content: january.content }, fullFebruary, { delayFirstFebruaryResult: true }), cwd);
    assert.equal(delayed.status, "UNPROVEN");
    assert.equal((delayed.observed as any).monthly[1].write, null);
    assert.equal((delayed.observed as any).monthly[1].completeAt.toolCallId, "feb-0");
    assert.equal((delayed.observed as any).combinedWrite, "q-write");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
