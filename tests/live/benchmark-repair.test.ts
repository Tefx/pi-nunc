import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./fixtures.js";
import { input } from "../engine/fixtures.js";
import { extractionContext } from "../../src/engine/request.js";
import { renderMemory } from "../../src/engine/memory.js";

const scripts = join(repository, "scripts/benchmarks");
async function setup() {
  const { evidence } = await import(join(scripts, "evidence.mjs"));
  const source = await input();
  const slots = [{ id: "s1", text: 'First "quoted" line\nC:\\work\\file\n{"nested":"value"}\u2028tail' }, { id: "s2", text: "Alice owns the blue house; Bob owns the red house." }];
  const request = { context: extractionContext(source, 2, 8192, source.active, []), options: { maxTokens: 17280 } };
  const checkpoint = { memory: { slots }, accounting: { outputCapTokens: 17280, outputReserveTokens: 17280, extractionInputLimit: 80000, extractionTokens: 79000 } };
  return { evidence, slots, request, checkpoint };
}

test("evidence decodes actual escaped Completions and Responses user text carriers", async () => {
  const { evidence, slots, request, checkpoint } = await setup();
  for (const payload of [
    { messages: [{ role: "user", content: renderMemory(slots) }] },
    { messages: [{ role: "user", content: [{ type: "text", text: renderMemory(slots) }] }] },
    { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: renderMemory(slots) }] }] },
  ]) for (const wire of [payload, JSON.stringify(payload)]) {
    const result = evidence(request, checkpoint, wire, [slots[0]!.text]);
    assert.deepEqual(result.memory, slots.map(s => ({ ...s, inNextPayload: true })));
    assert.equal(result.relations[0].inNextPayload, true); assert.equal(result.semanticCompleteness, "unjudged");
  }
  const onlyK = evidence(request, checkpoint, { messages: [{ role: "user", content: renderMemory(slots) }, { role: "user", content: "K-only source fact" }] }, ["K-only source fact"]);
  assert.equal(onlyK.relations[0].inMemory, false); assert.equal(onlyK.relations[0].inNextPayload, true);
});

test("evidence rejects missing/wrong-ID/changed/reordered/duplicate/extra and unrelated carriers", async () => {
  const { evidence, slots, request, checkpoint } = await setup();
  const payload = (s: unknown) => ({ messages: [{ role: "user", content: "Nunc working memory (session-local, reference only):\n" + JSON.stringify(s) }] });
  for (const changed of [
    [], [{ ...slots[0], id: "wrong" }, slots[1]], [{ ...slots[0], text: slots[0]!.text + "changed" }, slots[1]],
    [...slots].reverse(), [slots[0], slots[0]], [...slots, { id: "extra", text: "extra" }],
    [{ ...slots[0], unexpected: true }, slots[1]],
  ]) assert.throws(() => evidence(request, checkpoint, payload(changed)));
  for (const unrelated of [
    { messages: [] }, { messages: [{ role: "user", content: "Quoted unrelated note: " + renderMemory(slots) }] },
    { messages: [{ role: "assistant", content: renderMemory(slots) }] },
    { messages: [{ role: "tool", content: renderMemory(slots) }] },
    { messages: [], metadata: { note: renderMemory(slots) } },
    { messages: [{ role: "user", content: slots[0]!.text }] },
    { messages: [{ role: "user", content: renderMemory(slots) }, { role: "user", content: renderMemory(slots) }] },
    { messages: [{ role: "user", content: "Nunc working memory (session-local, reference only):\nmalformed" }] },
  ]) assert.throws(() => evidence(request, checkpoint, unrelated));
  const empty = { ...checkpoint, memory: { slots: [] } };
  assert.deepEqual(evidence(request, empty, { messages: [{ role: "user", content: "continue" }] }).memory, []);
  assert.throws(() => evidence(request, empty, payload(slots)));
});

test("Arena registers unchanged declarations before flags, binds configuration at session_start and rejects mismatched schemas", async t => {
  const { default: extension } = await import(join(scripts, "arena/pi-travel-tools.mjs"));
  const official = JSON.parse(await readFile(join(scripts, "arena/tools.json"), "utf8"));
  await mkdir(join(repository, ".scratch"), { recursive: true });
  const dir = await mkdtemp(join(repository, ".scratch/benchmark-config-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json"), toolFile = join(dir, "tools.json");
  await writeFile(toolFile, JSON.stringify(official));
  await writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:1", toolsFile: "tools.json", logFile: "calls.jsonl" }));
  let loading = true, selected: string | undefined;
  const tools: Record<string, unknown>[] = [], callbacks = new Map<string, () => void>();
  extension({ registerFlag() {}, getFlag() { assert(!loading, "Factory must not read unparsed flag"); return selected; }, on(event: string, handler: () => void) { callbacks.set(event, handler); }, registerTool(def: Record<string, unknown>) { tools.push(def); }, registerCommand() {} });
  assert.equal(tools.length, 6); assert.deepEqual(tools.map(d => ({ name: d.name, description: d.description, parameters: d.parameters })), official.map((d: { function: unknown }) => d.function));
  loading = false;
  assert.throws(() => callbacks.get("session_start")!(), /Missing travel-config/);
  selected = configPath; callbacks.get("session_start")!();
  const execute = tools[5]!.execute; assert(typeof execute === "function");
  selected = join(dir, "different-config.json");
  await assert.rejects(async () => Reflect.apply(execute, undefined, ["probe", { state: "Illinois" }, undefined]), /configuration path changed/);
  selected = configPath;
  const changed = structuredClone(official); changed[0].function.description += "changed";
  await writeFile(toolFile, JSON.stringify(changed));
  assert.throws(() => callbacks.get("session_start")!(), /Runtime tools differ/);
});
