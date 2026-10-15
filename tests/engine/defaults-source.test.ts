import { test } from "node:test";
import assert from "node:assert/strict";
import { maintain } from "../../src/engine/engine.js";
import { engineConfig } from "../../src/pi/config.js";
import { answer, assistant, input, tool, user } from "./fixtures.js";

test("explicit full refuses oversized complete tool source; default auto reduces once and keeps original K", async () => {
  const s = await input(); s.model.maxTokens = 64000;
  s.config = engineConfig({ extraction: { toolResults: "full" } }, s.model, { reserveTokens: 16384, keepRecentTokens: 8000 });
  const body = "original useful middle material".repeat(10000);
  s.active = [user("old", "continue"), assistant("call", [{ type: "toolCall", id: "t", name: "read", arguments: { path: "source.txt", exact: "preserve arguments" } }]), tool("result", "t", body), user("tail", "continue the established task")];
  let calls = 0;
  const full = await maintain(s, async request => { calls++; return answer(undefined, request.model); });
  assert(!full.ok); assert.equal(full.code, "CAPACITY"); assert.equal(calls, 0); assert.equal(full.observations.omissions.length, 0);
  s.config = engineConfig({}, s.model, { reserveTokens: 16384, keepRecentTokens: 8000 });
  const reduced = await maintain(s, async request => {
    calls++; const text = JSON.stringify(request.context); assert(text.includes("preserve arguments")); assert(text.includes("continue the established task"));
    assert(!text.includes(body)); return answer(undefined, request.model);
  });
  assert(reduced.ok, reduced.ok ? "" : reduced.message); assert.equal(calls, 1); assert.equal(reduced.observations.requests, 1);
  assert.equal(reduced.observations.omissions.length, 1);
  assert(reduced.observations.accounting!.fullExtractionTokens > reduced.observations.accounting!.extractionInputLimit);
  assert.equal(s.active[2]!.messages[0]!.content instanceof Array && s.active[2]!.messages[0]!.content[0]?.type === "text" ? s.active[2]!.messages[0]!.content[0].text : null, body);
  assert.deepEqual(reduced.candidate.kept, s.active.slice(s.active.findIndex(e => e.entryId === reduced.candidate.firstKeptEntryId)));
});

test("default auto sends full tool results without reduction when complete extraction fits", async () => {
  const s = await input(); s.model.maxTokens = 64000;
  s.config = engineConfig({}, s.model, { reserveTokens: 16384, keepRecentTokens: 8000 });
  const body = "Useful original middle and boundaries. ".repeat(80);
  s.active = [user("old", "continue"), assistant("call", [{ type: "toolCall", id: "t", name: "read", arguments: { path: "source.txt" } }]), tool("result", "t", body), user("tail", "continue")];
  let calls = 0;
  const result = await maintain(s, async request => { calls++; assert(JSON.stringify(request.context).includes(body)); return answer(undefined, request.model); });
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(calls, 1); assert.deepEqual(result.observations.omissions, []);
  assert.equal(result.observations.accounting!.extractionTokens, result.observations.accounting!.fullExtractionTokens);
});
