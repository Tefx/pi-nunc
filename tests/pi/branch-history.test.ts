import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { effectiveActive, originalResults, project, searchBranchHistory, sealDecisions } from "../../src/pi/projection.js";
import type { ToolResultDecision } from "../../src/engine/index.js";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const tool = (content: string) => ({ role: "toolResult" as const, toolCallId: "read-1", toolName: "read", content: [{ type: "text" as const, text: content }], isError: false, timestamp: 0 });
function retire(manager: SessionManager) {
  const kept = manager.appendMessage(user("Current active work"));
  manager.appendCompaction("", kept, 10000);
  return project(manager.buildContextEntries());
}

test("retired text ranks distinct case-insensitive substring hits before branch recency", () => {
  const manager = SessionManager.inMemory();
  const old = manager.appendMessage(user("Stored amber and COBALT materials"));
  const answer = manager.appendMessage(fauxAssistantMessage("amber and cobalt decision"));
  const result = manager.appendMessage(tool("Only amber diagnostic"));
  const projected = retire(manager);
  const before = structuredClone(manager.getBranch());
  const found = searchBranchHistory(manager.getBranch(), projected.active, { query: "AMBER cobalt amber" });
  assert.deepEqual(found.matches.map(hit => [hit.entryId, hit.messageIndex, hit.role]), [
    [answer, 0, "assistant"], [old, 0, "user"], [result, 0, "toolResult"],
  ]);
  assert.equal(found.matches[2]?.toolName, "read");
  assert.deepEqual(searchBranchHistory(manager.getBranch(), projected.active, { query: "obalt", limit: 1 }).matches.map(hit => hit.entryId), [answer]);
  assert.deepEqual(searchBranchHistory(manager.getBranch(), projected.active, { query: "Current" }).matches, []);
  assert.deepEqual(searchBranchHistory(manager.getBranch(), projected.active, { query: "   " }).matches, []);
  assert.deepEqual(manager.getBranch(), before, "lookup must not mutate entries, memory or leaf");
});

test("query defaults to five hits, permits ten, and exact IDs have an independent shared text bound", () => {
  const manager = SessionManager.inMemory();
  const ids = Array.from({ length: 12 }, (_, i) => manager.appendMessage(user(`archive ${i}`)));
  const long = "p".repeat(1000) + "ANCHOR" + "q".repeat(6000);
  const longId = manager.appendMessage(user(long));
  const projected = retire(manager), branch = manager.getBranch();
  assert.deepEqual(searchBranchHistory(branch, projected.active, { query: "archive" }).matches.map(hit => hit.entryId), ids.slice(-5).reverse());
  assert.equal(searchBranchHistory(branch, projected.active, { query: "archive", limit: 10 }).matches.length, 10);
  const found = searchBranchHistory(branch, projected.active, { query: "anchor", entryIds: [longId, ids[0]!] });
  assert.equal(found.matches[0]?.snippet, long.slice(600, 1406));
  assert(found.matches.every(hit => hit.snippet.length <= 1200));
  assert.equal(found.entries[0]?.messages[0]?.text, long.slice(0, 4000));
  assert.equal(found.entries[0]?.truncated, true);
  assert.equal(found.entries[1]?.messages[0]?.text, "archive 0");
  assert.equal(found.entries[1]?.truncated, false);
  for (const limit of [0, -1, 11, 1.5, Infinity]) assert.throws(() => searchBranchHistory(branch, projected.active, { query: "archive", limit }), /limit/);
  assert.throws(() => searchBranchHistory(branch, projected.active, { entryIds: ids.slice(0, 11) }), /entryIds/);
});

test("literal punctuation, Unicode match offsets and long matches keep snippets bounded", () => {
  const manager = SessionManager.inMemory();
  const body = "İ".repeat(900) + "a+b" + "z".repeat(900);
  manager.appendMessage(user(body));
  const long = "x".repeat(2000);
  manager.appendMessage(user(long));
  const projected = retire(manager), branch = manager.getBranch();
  assert.equal(searchBranchHistory(branch, projected.active, { query: "A+B" }).matches[0]?.snippet, body.slice(500, 1303));
  assert.equal(searchBranchHistory(branch, projected.active, { query: "İ" }).matches.length, 1);
  assert.equal(searchBranchHistory(branch, projected.active, { query: long }).matches[0]?.snippet.length, 1200);
  assert.deepEqual(searchBranchHistory(branch, projected.active, { query: "a.b" }).matches, []);
});

test("proximity snippets ignore early partial-name and substring distractors", () => {
  for (const [query, early, fact] of [
    ["Shaman King", "United Kingdom; Shaman names", "Shaman King was created in the country of Greece."],
    ["Joseph Mitchell", "Joseph elsewhere; Margaret Mitchell", "Joseph Mitchell is a citizen of United Kingdom."],
    ["Aki Takase", "Aki elsewhere; Takase elsewhere", "The music that Aki Takase plays is Carnatic music."],
  ] as const) {
    const manager = SessionManager.inMemory();
    const body = early + " filler".repeat(1500) + "\n" + fact + " tail".repeat(1000);
    const id = manager.appendMessage(user(body));
    const projected = retire(manager);
    const found = searchBranchHistory(manager.getBranch(), projected.active, { query, entryIds: [id] });
    assert(found.matches[0]!.snippet.includes(fact), query);
    assert(found.matches[0]!.snippet.length <= 1200);
    assert(found.entries[0]!.messages[0]!.text.includes(fact));
    assert.equal(found.entries[0]!.messages[0]!.text.length, 4000);
    assert.equal(found.entries[0]!.truncated, true);
    assert.equal(searchBranchHistory(manager.getBranch(), projected.active, { entryIds: [id] }).entries[0]!.messages[0]!.text, body.slice(0, 4000));
    assert.equal(searchBranchHistory(manager.getBranch(), projected.active, { query: "missing", entryIds: [id] }).entries[0]!.messages[0]!.text, body.slice(0, 4000));
  }
});

test("whole Unicode words outrank later substring clusters, including underscore boundaries", () => {
  const manager = SessionManager.inMemory();
  const fact = "Élan King exact record";
  manager.appendMessage(user(fact + " filler".repeat(1000) + "\nÉlan_ Kingdom weak record"));
  const projected = retire(manager);
  const snippet = searchBranchHistory(manager.getBranch(), projected.active, { query: "élan King" }).matches[0]!.snippet;
  assert(snippet.includes(fact));
  assert(!snippet.includes("weak record"));
});

test("equal full-phrase clusters choose the latest occurrence and center exact reads near the end", () => {
  const manager = SessionManager.inMemory();
  const early = "Silver Falcon old value", later = "Silver Falcon revised value";
  const body = early + " filler".repeat(1600) + "\n" + later;
  const id = manager.appendMessage(user(body));
  const projected = retire(manager);
  const found = searchBranchHistory(manager.getBranch(), projected.active, { query: "Silver Falcon", entryIds: [id] });
  assert(found.matches[0]!.snippet.includes(later));
  assert(!found.matches[0]!.snippet.includes(early));
  assert.equal(found.entries[0]!.messages[0]!.text, body.slice(-4000));
});

test("two disjoint snippets cover separated query terms within the shared 1200 character bound", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user("alpha source" + " filler".repeat(1500) + "beta updated source"));
  const projected = retire(manager);
  const snippet = searchBranchHistory(manager.getBranch(), projected.active, { query: "alpha beta" }).matches[0]!.snippet;
  assert(snippet.includes("alpha source"));
  assert(snippet.includes("beta updated source"));
  assert(snippet.includes("\n...\n"));
  assert(snippet.length <= 1200);
  assert.equal(snippet.split("\n...\n").length, 2);
});

test("overlapping context around separate clusters merges without dropping either query word", () => {
  const manager = SessionManager.inMemory();
  const body = "alpha " + ".".repeat(443) + " beta";
  manager.appendMessage(user(body));
  const projected = retire(manager);
  const snippet = searchBranchHistory(manager.getBranch(), projected.active, { query: "alpha beta" }).matches[0]!.snippet;
  assert.equal(snippet, body);
  assert(snippet.length <= 1200);
});

test("the second passage maximizes missing-term coverage before its cluster tie breakers", () => {
  const manager = SessionManager.inMemory();
  const body = "gamma delta source\n" + " filler".repeat(1000) + "\nalpha gamma distractor\n" +
    " filler".repeat(1000) + "\nalpha beta alpha latest";
  manager.appendMessage(user(body));
  const projected = retire(manager);
  const snippet = searchBranchHistory(manager.getBranch(), projected.active, { query: "alpha beta gamma delta" }).matches[0]!.snippet;
  assert(snippet.includes("alpha beta alpha latest"));
  assert(snippet.includes("gamma delta source"));
  assert(!snippet.includes("distractor"));
  assert(snippet.length <= 1200);
});

test("bash, custom and branch-summary visible text is searchable without thinking, arguments or hidden data", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user("Root"));
  const bash = manager.appendMessage({ role: "bashExecution", command: "echo shell-evidence", output: "bash material", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 });
  manager.appendMessage({ role: "bashExecution", command: "echo excluded-shell", output: "excluded-shell", excludeFromContext: true, exitCode: 0, cancelled: false, truncated: false, timestamp: 0 });
  const custom = manager.appendCustomMessageEntry("notice", "custom material", true, { hidden: "hidden-details" });
  const summary = manager.branchWithSummary(manager.getLeafId(), "branch material");
  manager.appendCustomEntry("private-state", { text: "hidden-metadata" });
  manager.appendMessage({ role: "system", content: "hidden-system", timestamp: 0 });
  manager.appendMessage(fauxAssistantMessage([
    { type: "thinking", thinking: "hidden-thinking" },
    { type: "toolCall", id: "argument-only", name: "read", arguments: { path: "hidden-arguments" } },
    { type: "text", text: "assistant material" },
  ]));
  const projected = retire(manager), branch = manager.getBranch();
  const results = searchBranchHistory(branch, projected.active, { query: "material", limit: 10 }).matches;
  assert(results.some(hit => hit.entryId === bash && hit.role === "bashExecution"));
  assert(results.some(hit => hit.entryId === custom && hit.role === "custom"));
  assert(results.some(hit => hit.entryId === summary && hit.role === "branchSummary"));
  assert.deepEqual(searchBranchHistory(branch, projected.active, { query: "hidden excluded-shell" }).matches, []);
});

test("selected branch excludes sibling text and exact IDs, including after multiple checkpoints", () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage(user("Common source"));
  const sibling = manager.appendMessage(tool("sibling-only material"));
  manager.appendMessage(fauxAssistantMessage("Sibling response"));
  manager.branch(root);
  const selected = manager.appendMessage(tool("selected-only material"));
  retire(manager);
  const after = manager.appendMessage(user("Later active work"));
  manager.appendCompaction("", after, 10000);
  const foreign = SessionManager.inMemory();
  const foreignId = foreign.appendMessage(tool("foreign-session material"));
  const projected = project(manager.buildContextEntries()), branch = manager.getBranch();
  const found = searchBranchHistory(branch, projected.active, { query: "material", entryIds: [selected, sibling, foreignId] });
  assert.deepEqual(found.matches.map(hit => hit.entryId), [selected]);
  assert.equal(found.entries[0]?.messages[0]?.text, "selected-only material");
  assert.match(found.entries[1]?.error ?? "", /unavailable/);
  assert.match(found.entries[2]?.error ?? "", /unavailable/);
  const originals = originalResults(projected, [{ entryId: selected, messageIndex: 0 }, { entryId: sibling, messageIndex: 0 }], branch);
  assert.equal(originals[0]?.text, "selected-only material");
  assert.match(originals[1]?.error ?? "", /unavailable/);
  assert.equal(originalResults(projected, [{ entryId: selected, messageIndex: 0 }])[0]?.text, undefined, "branch is required for retired fallback");
});

test("active originals are searchable only when effective cleanup changes the body", () => {
  const manager = SessionManager.inMemory();
  const id = manager.appendMessage(tool("Preserved source material ".repeat(80)));
  const current = project(manager.buildContextEntries());
  const body = current.active[0]!.messages[0];
  assert(body?.role === "toolResult");
  const original = body.content.filter(block => block.type === "text").map(block => block.text).join("");
  const replacement = "[Nunc: omitted]";
  const decision: ToolResultDecision = { entryId: id, messageIndex: 0, toolCallId: "read-1", toolName: "read", text: replacement,
    action: "omit", kind: "semantic", originalLength: original.length, cleanedLength: replacement.length, netSavings: original.length - replacement.length };
  manager.appendCompaction("", id, 10000, { toolResultCleanup: sealDecisions(current.active, [decision]) });
  const projected = project(manager.buildContextEntries()), branch = manager.getBranch();
  assert.equal(projected.cleanup.length, 1);
  const edited = searchBranchHistory(branch, effectiveActive(projected, true), { query: "Preserved source", entryIds: [id] });
  assert.equal(edited.matches[0]?.entryId, id);
  assert.equal(edited.entries[0]?.messages[0]?.text, original);
  assert.deepEqual(searchBranchHistory(branch, effectiveActive(projected, false), { query: "Preserved source" }).matches, []);
  assert.equal(originalResults(projected, [{ entryId: id, messageIndex: 0 }], branch)[0]?.text, original);
});

test("retired originals reject non-text results and invalid message indices, while retain-none history remains readable", () => {
  const manager = SessionManager.inMemory();
  const id = manager.appendMessage(tool("Plain result"));
  const mixed = manager.appendMessage({ ...tool("Mixed result"), content: [{ type: "text", text: "Mixed result" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
  manager.appendCompaction("", null, 10000);
  const projected = project(manager.buildContextEntries());
  assert.equal(projected.active.length, 0);
  const result = originalResults(projected, [{ entryId: id, messageIndex: 0 }, { entryId: mixed, messageIndex: 0 }, { entryId: id, messageIndex: 1 }], manager.getBranch());
  assert.equal(result[0]?.text, "Plain result");
  assert.match(result[1]?.error ?? "", /non-text/);
  assert.match(result[2]?.error ?? "", /unavailable/);
  assert.equal(searchBranchHistory(manager.getBranch(), projected.active, { query: "Plain" }).matches[0]?.entryId, id);
});

test("branch-local native edits suppress omitted bodies and expose replacement text only", () => {
  const manager = SessionManager.inMemory();
  const hidden = manager.appendMessage(user("old-hidden source"));
  const changed = manager.appendMessage(user("old-replaced source"));
  manager.appendContextEdit(hidden, null);
  manager.appendContextEdit(changed, { content: "current-replacement source" });
  const projected = retire(manager);
  const result = searchBranchHistory(manager.getBranch(), projected.active, { query: "old-hidden old-replaced current-replacement", entryIds: [hidden, changed] });
  assert.deepEqual(result.matches.map(hit => hit.entryId), [changed]);
  assert.match(result.entries[0]?.error ?? "", /unavailable/);
  assert.equal(result.entries[1]?.messages[0]?.text, "current-replacement source");
});
