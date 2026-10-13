import { test } from "node:test";
import assert from "node:assert/strict";
import { maintain } from "../../src/engine/engine.js";
import { engineConfig } from "../../src/pi/config.js";
import { answer, assistant, input, tool, user } from "./fixtures.js";

test("default full refuses oversized complete tool source without dispatch; explicit auto reduces once and keeps original K", async () => {
  const s = await input(); s.model.maxTokens = 64000;
  s.config = engineConfig({}, s.model, { reserveTokens: 16384, keepRecentTokens: 8000 });
  const body = "original useful middle material".repeat(10000);
  s.active = [user("old", "continue"), assistant("call", [{ type: "toolCall", id: "t", name: "read", arguments: { path: "source.txt", exact: "preserve arguments" } }]), tool("result", "t", body), user("tail", "continue the established task")];
  let calls = 0;
  const full = await maintain(s, async request => { calls++; return answer(undefined, request.model); });
  assert(!full.ok); assert.equal(full.code, "CAPACITY"); assert.equal(calls, 0); assert.equal(full.observations.omissions.length, 0);
  s.config.extraction.toolResults = "auto";
  const reduced = await maintain(s, async request => {
    calls++; const text = JSON.stringify(request.context); assert(text.includes("preserve arguments")); assert(text.includes("continue the established task"));
    assert(!text.includes(body)); return answer(undefined, request.model);
  });
  assert(reduced.ok, reduced.ok ? "" : reduced.message); assert.equal(calls, 1); assert.equal(reduced.observations.omissions.length, 1);
  assert.equal(s.active[2]!.messages[0]!.content instanceof Array && s.active[2]!.messages[0]!.content[0]?.type === "text" ? s.active[2]!.messages[0]!.content[0].text : null, body);
  assert.deepEqual(reduced.candidate.kept, s.active.slice(s.active.findIndex(e => e.entryId === reduced.candidate.firstKeptEntryId)));
});
