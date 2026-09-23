import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatch,
  applyToolResultCleanup,
  cleanTerminalText,
  compactInvarDocToc,
  decodeInvarDocToc,
  decideToolResultCleanup,
  emptyMemory,
  formatBoilerplateMarker,
  formatDeduplicateMarker,
  formatOmitMarker,
  formatReplaceMarker,
  formatTocMarker,
  isMemoryUnchanged,
  KNOWN_LAUNCH_BOILERPLATES,
  losslessCompactJson,
  maintain,
  parsePatch,
  type ActiveEntry,
  type CleanupDecisionOptions,
  type Memory,
  type ToolResultDecision,
  type ToolResultEdit,
} from "../../src/engine/index.js";
import { extractionContext } from "../../src/engine/request.js";
import { answer, input, model, responder, tool, user, assistant } from "./fixtures.js";

function messageText(msg: ActiveEntry["messages"][number]): string {
  if (typeof msg.content === "string") return msg.content;
  const first = msg.content[0];
  if (first && typeof first === "object" && "text" in first && typeof first.text === "string") {
    return first.text;
  }
  return "";
}

function toolEntry(entryId: string, id: string, content: string, name = "read", isError = false): ActiveEntry {
  return {
    entryId,
    sourceRole: "toolResult",
    messages: [{
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      isError,
      timestamp: 0,
      content: [{ type: "text", text: content }],
    }],
  };
}

test("parsePatch accepts optional toolResultEdits and maintains backwards compatibility with 4 fields", () => {
  const mem: Memory = { version: 1, slots: [{ id: "s1", text: "Note" }], nextId: 2 };
  // Old 4-field patch
  const oldPatch = parsePatch({ add: [], remove: [], priority: ["s1"], required: [] }, mem);
  assert.equal(oldPatch.toolResultEdits, undefined);

  // New patch with toolResultEdits
  const edits: ToolResultEdit[] = [{
    entryId: "e1",
    messageIndex: 0,
    action: "omit",
  }];
  const newPatch = parsePatch({ add: [], remove: [], priority: ["s1"], required: [], toolResultEdits: edits }, mem);
  assert.deepEqual(newPatch.toolResultEdits, edits);

  // Invalid key still fails
  assert.throws(() => parsePatch({ add: [], remove: [], priority: ["s1"], required: [], unknownKey: true }, mem), (err: any) => err.code === "RESPONSE");
});

test("isMemoryUnchanged correctly compares memory slots", () => {
  const m1: Memory = { version: 1, slots: [{ id: "s1", text: "Alpha" }, { id: "s2", text: "Beta" }], nextId: 3 };
  const m2: Memory = { version: 1, slots: [{ id: "s1", text: "Alpha" }, { id: "s2", text: "Beta" }], nextId: 4 };
  const m3: Memory = { version: 1, slots: [{ id: "s1", text: "Alpha" }, { id: "s2", text: "Beta Modified" }], nextId: 3 };
  const m4: Memory = { version: 1, slots: [{ id: "s1", text: "Alpha" }], nextId: 3 };

  assert.equal(isMemoryUnchanged(m1, m2), true);
  assert.equal(isMemoryUnchanged(m1, m3), false);
  assert.equal(isMemoryUnchanged(m1, m4), false);
});

test("semantic omit and replace apply uniform markers and calculate net savings", () => {
  const longText1 = "A".repeat(500);
  const longText2 = "B".repeat(500);
  const t1 = toolEntry("t1", "c1", longText1);
  const t2 = toolEntry("t2", "c2", longText2);
  const active = [t1, t2];
  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "New goal" }], nextId: 2 };

  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "omit" },
    { entryId: "t2", messageIndex: 0, action: "replace", text: "Summary of B" },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }, { entryId: "t2", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  assert.equal(result.skipped.length, 0);
  assert.equal(result.applied.length, 2);

  const omitDecision = result.applied.find(d => d.entryId === "t1");
  assert(omitDecision);
  assert.equal(omitDecision.kind, "semantic");
  assert.equal(omitDecision.action, "omit");
  assert.equal(omitDecision.text, formatOmitMarker({ entryId: "t1", messageIndex: 0 }));
  assert.equal(omitDecision.netSavings, longText1.length - omitDecision.text.length);

  const replaceDecision = result.applied.find(d => d.entryId === "t2");
  assert(replaceDecision);
  assert.equal(replaceDecision.kind, "semantic");
  assert.equal(replaceDecision.action, "replace");
  assert.equal(replaceDecision.text, formatReplaceMarker({ entryId: "t2", messageIndex: 0 }, "Summary of B"));
  assert.equal(replaceDecision.netSavings, longText2.length - replaceDecision.text.length);

  // Test applyToolResultCleanup projection
  const projected = applyToolResultCleanup(active, result.applied);
  assert.equal(projected.length, 2);
  assert.equal(messageText(projected[0]!.messages[0]!), omitDecision.text);
  assert.equal(messageText(projected[1]!.messages[0]!), replaceDecision.text);
  // Original active entries must not be mutated
  assert.equal(messageText(active[0]!.messages[0]!), longText1);
  assert.equal(messageText(active[1]!.messages[0]!), longText2);
});

test("memoryRefs are mapped to final slot IDs and budget-dropped slots skip only dependent edits", () => {
  const t1 = toolEntry("t1", "c1", "X".repeat(300));
  const t2 = toolEntry("t2", "c2", "Y".repeat(300));
  const active = [t1, t2];

  const memBefore: Memory = { version: 1, slots: [{ id: "s1", text: "Existing" }], nextId: 2 };
  // Simulated applyPatch: 'new-kept' was kept as s2, 'new-dropped' was dropped due to budget
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Existing" }, { id: "s2", text: "Kept added" }], nextId: 3 };
  const keyToSlotMap = new Map([["new-kept", "s2"], ["s1", "s1"]]);
  const retainedKeys = new Set(["s1", "new-kept"]);

  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "replace", text: "Depends on kept", memoryRefs: ["new-kept"] },
    { entryId: "t2", messageIndex: 0, action: "replace", text: "Depends on dropped", memoryRefs: ["new-dropped"] },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }, { entryId: "t2", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    keyToSlotMap,
    retainedKeys,
    semanticEdits: edits,
  });

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0]!.entryId, "t1");
  assert.deepEqual(result.applied[0]!.memoryRefs, ["s2"]); // mapped from new-kept to s2

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.entryId, "t2");
  assert.equal(result.skipped[0]!.reason, "missing_memory_dependency");
});

test("sourceRefs must point to fully retained non-omitted messages", () => {
  const t1 = toolEntry("t1", "c1", "Z".repeat(300));
  const t2 = toolEntry("t2", "c2", "W".repeat(300));
  const t3 = toolEntry("t3", "c3", "V".repeat(300));
  const active = [t1, t2, t3];

  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  // t3 is retained and unedited; t2 is in retired entries (not in retainedEntries)
  const retainedEntries = [t1, t3];

  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "replace", text: "Summary 1", sourceRefs: [{ entryId: "t3", messageIndex: 0 }] },
    { entryId: "t3", messageIndex: 0, action: "replace", text: "Summary 3", sourceRefs: [{ entryId: "t2", messageIndex: 0 }] }, // t2 retired
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }, { entryId: "t3", messageIndex: 0 }],
    retainedEntries,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  // t1 succeeds because t3 is in retainedEntries and not omitted
  // Wait, t3 proposed an edit in candidateSemanticEdits, so t3 was proposed to be replaced!
  // Therefore, t1's sourceRef to t3 fails because t3 is also being edited in this batch!
  // And t3's sourceRef to t2 fails because t2 is retired.
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.equal(result.skipped[0]!.reason, "missing_source_dependency");
  assert.equal(result.skipped[1]!.reason, "missing_source_dependency");
});

test("mutual source dependencies in same batch are both skipped", () => {
  const t1 = toolEntry("t1", "c1", "A".repeat(300));
  const t2 = toolEntry("t2", "c2", "B".repeat(300));
  const active = [t1, t2];

  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "replace", text: "Note 1", sourceRefs: [{ entryId: "t2", messageIndex: 0 }] },
    { entryId: "t2", messageIndex: 0, action: "replace", text: "Note 2", sourceRefs: [{ entryId: "t1", messageIndex: 0 }] },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }, { entryId: "t2", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.equal(result.skipped[0]!.reason, "missing_source_dependency");
  assert.equal(result.skipped[1]!.reason, "missing_source_dependency");
});

test("mechanical deduplication protects keeper from same-batch semantic edits", () => {
  const identicalText = "Identical listing output:\n" + "file.txt\n".repeat(30);
  const call1 = assistant("call-1-entry", [{ type: "toolCall", id: "call-1", name: "find_files", arguments: { path: "." } }]);
  const t1 = toolEntry("t1", "call-1", identicalText, "find_files");
  const call2 = assistant("call-2-entry", [{ type: "toolCall", id: "call-2", name: "find_files", arguments: { path: "." } }]);
  const t2 = toolEntry("t2", "call-2", identicalText, "find_files");
  const active = [call1, t1, call2, t2];

  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  // Model attempts to omit the first occurrence (the mechanical keeper)
  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "omit" },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }, { entryId: "t2", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  // t1 semantic edit is rejected because t1 is a protected keeper
  const t1Skipped = result.skipped.find(s => s.entryId === "t1");
  assert(t1Skipped);
  assert.equal(t1Skipped.reason, "keeper_protected");

  // t2 is mechanically deduplicated
  const t2Applied = result.applied.find(d => d.entryId === "t2");
  assert(t2Applied);
  assert.equal(t2Applied.kind, "mechanical");
  assert.equal(t2Applied.action, "deduplicate");
  assert.equal(t2Applied.text, formatDeduplicateMarker({ entryId: "t2", messageIndex: 0 }, { entryId: "t1", messageIndex: 0 }));

  // t1 is kept intact (not in applied)
  assert(!result.applied.some(d => d.entryId === "t1"));
});

test("duplicate or conflicting edits in the same batch are rejected", () => {
  const t1 = toolEntry("t1", "c1", "D".repeat(400));
  const active = [t1];
  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "omit" },
    { entryId: "t1", messageIndex: 0, action: "replace", text: "Conflict" },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 2);
  assert(result.skipped.every(s => s.reason === "duplicate_edit"));
});

test("tool results with omissions cannot be semantically cleaned", () => {
  const t1 = toolEntry("t1", "c1", "E".repeat(400));
  const active = [t1];
  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "omit" },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
    omissions: [{
      entryId: "t1",
      messageIndex: 0,
      blockIndex: 0,
      toolCallId: "c1",
      omittedCodePoints: 200,
      headChars: 100,
      tailChars: 100,
    }],
  });

  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.reason, "has_omissions");
});

test("tool results with non-text or outside candidate scope are rejected", () => {
  const t1: ActiveEntry = {
    entryId: "t1",
    sourceRole: "toolResult",
    messages: [{
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
      timestamp: 0,
      content: [
        { type: "text", text: "Image caption: " },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    }],
  };
  const t2 = toolEntry("t2", "c2", "Normal text ".repeat(30));
  const active = [t1, t2];

  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "omit" },
    { entryId: "t2", messageIndex: 0, action: "omit" }, // t2 omitted from candidateScope
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }], // only t1 in scope
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  assert.equal(result.applied.length, 0);
  const s1 = result.skipped.find(s => s.entryId === "t1");
  assert(s1);
  assert.equal(s1.reason, "non_text_content");

  const s2 = result.skipped.find(s => s.entryId === "t2");
  assert(s2);
  assert.equal(s2.reason, "not_in_candidate_scope");
});

test("invalid edit shapes are locally rejected without blocking legal M", () => {
  const t1 = toolEntry("t1", "c1", "G".repeat(400));
  const active = [t1];
  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  const invalidEdits = [
    { entryId: "t1", messageIndex: 0, action: "unknown_action" },
    { entryId: "t1", messageIndex: 0, action: "replace", text: "" },
    { entryId: "t1", messageIndex: 0, action: "omit", text: "Illegal text for omit" },
    { entryId: "t1", messageIndex: -1, action: "omit" },
    { entryId: 123, messageIndex: 0, action: "omit" },
    { entryId: "t1", messageIndex: 0, action: "replace", text: "Valid text", memoryRefs: [123] },
  ];

  for (const edit of invalidEdits) {
    const result = decideToolResultCleanup({
      active,
      candidateScope: [{ entryId: "t1", messageIndex: 0 }],
      retainedEntries: active,
      initialMemory: memBefore,
      finalMemory: memAfter,
      semanticEdits: [edit],
    });
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.reason, "invalid_shape");
  }
});

test("edits without net savings are rejected", () => {
  const shortText = "ok"; // 2 characters
  const t1 = toolEntry("t1", "c1", shortText);
  const active = [t1];
  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  // Omit marker is ~90 chars, which is longer than 2 chars!
  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "omit" },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.reason, "no_net_savings");
});

test("no cleanups applied when M is unchanged or feature is disabled", () => {
  const longText = "H".repeat(400);
  const t1 = toolEntry("t1", "c1", longText);
  const active = [t1];
  const mem: Memory = { version: 1, slots: [{ id: "s1", text: "Same note" }], nextId: 2 };

  const edits: ToolResultEdit[] = [
    { entryId: "t1", messageIndex: 0, action: "omit" },
  ];

  // Case 1: M unchanged
  const mUnchangedResult = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: mem,
    finalMemory: mem,
    semanticEdits: edits,
  });
  assert.equal(mUnchangedResult.applied.length, 0);
  assert.equal(mUnchangedResult.skipped.length, 1);
  assert.equal(mUnchangedResult.skipped[0]!.reason, "m_unchanged");

  // Case 2: Feature disabled
  const memNew: Memory = { version: 1, slots: [{ id: "s1", text: "New note" }], nextId: 2 };
  const disabledResult = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: mem,
    finalMemory: memNew,
    semanticEdits: edits,
    disabled: true,
  });
  assert.equal(disabledResult.applied.length, 0);
  assert.equal(disabledResult.skipped.length, 1);
  assert.equal(disabledResult.skipped[0]!.reason, "not_in_candidate_scope");
});

test("mechanical rules compactly format JSON and clean terminal ANSI escapes", () => {
  const rawJson = '{\n  "status": "success",\n  "count": 42,\n  "data": [\n    1,\n    2,\n    3\n  ]\n}';
  const rawTerminal = "\x1b[32mSUCCESS:\x1b[0m Build passed in 1.2s\r\n\x1b[33mWarning:\x1b[0m 0 issues\r\n";
  const unknownFormat = "Just some arbitrary text output with no special format.";

  const t1 = toolEntry("t1", "c1", rawJson);
  const t2 = toolEntry("t2", "c2", rawTerminal);
  const t3 = toolEntry("t3", "c3", unknownFormat);
  const active = [t1, t2, t3];

  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  const result = decideToolResultCleanup({
    active,
    candidateScope: [
      { entryId: "t1", messageIndex: 0 },
      { entryId: "t2", messageIndex: 0 },
      { entryId: "t3", messageIndex: 0 },
    ],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
  });

  // t1: compact_json
  const d1 = result.applied.find(d => d.entryId === "t1");
  assert(d1);
  assert.equal(d1.kind, "mechanical");
  assert.equal(d1.action, "compact_json");
  assert.equal(d1.text, '{"status":"success","count":42,"data":[1,2,3]}');
  assert(d1.netSavings > 0);

  // t2: clean_terminal
  const d2 = result.applied.find(d => d.entryId === "t2");
  assert(d2);
  assert.equal(d2.kind, "mechanical");
  assert.equal(d2.action, "clean_terminal");
  assert(!d2.text.includes("\x1b"));
  assert(!d2.text.includes("\r"));
  assert(d2.text.includes("SUCCESS: Build passed in 1.2s"));
  assert(d2.netSavings > 0);

  // t3: unknown format preserved intact
  assert(!result.applied.some(d => d.entryId === "t3"));
});

test("maintain() integrates cleanup into candidate and observations, preserving original kept entries", async () => {
  const source = await input();
  const longResult = "File contents line\n".repeat(40);
  // Insert a completed tool call and tool result in active history before latest user
  const tCall = assistant("call-entry", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "foo.txt" } }]);
  const tResult = toolEntry("result-entry", "call-1", longResult);
  source.active = [user("u1", "First"), tCall, tResult, user("u2", "Second question")];
  source.cleanupCandidateScope = [{ entryId: "result-entry", messageIndex: 0 }];

  // Model returns M change AND a toolResultEdit
  const patchWithEdit = {
    add: [{ key: "k1", text: "Important fact discovered" }],
    remove: [],
    priority: ["k1"],
    required: ["k1"],
    toolResultEdits: [
      { entryId: "result-entry", messageIndex: 0, action: "replace", text: "Read 40 lines of foo.txt", memoryRefs: ["k1"] },
    ],
  };

  const result = await maintain(source, responder(patchWithEdit));
  assert(result.ok, result.ok ? "" : result.message);

  // Candidate memory updated
  assert.equal(result.candidate.memory.slots.length, 1);
  assert.equal(result.candidate.memory.slots[0]!.id, "s1");
  assert.equal(result.candidate.memory.slots[0]!.text, "Important fact discovered");

  // candidate.kept retains the original unreduced tool result body
  const keptTool = result.candidate.kept.find(e => e.entryId === "result-entry");
  assert(keptTool);
  assert.equal(messageText(keptTool.messages[0]!), longResult);

  // candidate.toolResultCleanup records the decision
  const cleanup = result.candidate.toolResultCleanup;
  assert(cleanup);
  assert.equal(cleanup.applied.length, 1);
  assert.equal(cleanup.applied[0]!.entryId, "result-entry");
  assert.equal(cleanup.applied[0]!.kind, "semantic");
  assert.equal(cleanup.applied[0]!.action, "replace");
  assert.deepEqual(cleanup.applied[0]!.memoryRefs, ["s1"]); // mapped k1 -> s1

  // observations also contain toolResultCleanup
  assert.deepEqual(result.observations.toolResultCleanup, cleanup);
});

test("maintain() does not apply cleanup when M is unchanged or config.toolResultCleanup is false", async () => {
  const source = await input();
  const longResult = "Repetitive log line\n".repeat(30);
  const tCall = assistant("call-entry", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "bar.txt" } }]);
  const tResult = toolEntry("result-entry", "call-1", longResult);
  source.active = [user("u1", "First"), tCall, tResult, user("u2", "Second question")];

  // Response with no M change (empty add/remove/priority/required)
  const noMChangePatch = {
    add: [],
    remove: [],
    priority: [],
    required: [],
    toolResultEdits: [
      { entryId: "result-entry", messageIndex: 0, action: "omit" },
    ],
  };

  const res1 = await maintain(source, responder(noMChangePatch));
  assert(res1.ok);
  assert.equal(res1.candidate.toolResultCleanup?.applied.length, 0);
  assert.equal(res1.candidate.toolResultCleanup?.skipped.length, 1);
  assert.equal(res1.candidate.toolResultCleanup?.skipped[0]!.reason, "m_unchanged");

  // Response with M change but toolResultCleanup: false
  source.config.toolResultCleanup = false;
  const mChangePatch = {
    add: [{ key: "k1", text: "New note" }],
    remove: [],
    priority: ["k1"],
    required: ["k1"],
    toolResultEdits: [
      { entryId: "result-entry", messageIndex: 0, action: "omit" },
    ],
  };
  const res2 = await maintain(source, responder(mChangePatch));
  assert(res2.ok);
  assert.equal(res2.candidate.toolResultCleanup?.applied.length, 0);
});

test("decideToolResultCleanup with NO candidateScope fails closed and never manufactures scope", () => {
  const jsonText = '{\n  "status": "ok",\n  "code": 200\n}';
  const t = toolEntry("t1", "c1", jsonText);
  const active = [t];
  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  // Call with NO candidateScope (undefined)
  const resNoScope = decideToolResultCleanup({
    active,
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  // Must fail closed with 0 applied cleanups!
  assert.equal(resNoScope.applied.length, 0);

  // Call with empty array
  const resEmptyScope = decideToolResultCleanup({
    active,
    candidateScope: [],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  assert.equal(resEmptyScope.applied.length, 0);

  // Candidate references not in final retained history must be rejected
  const resRetiredScope = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }],
    retainedEntries: [], // t1 not in retainedEntries
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  assert.equal(resRetiredScope.applied.length, 0);
});

test("losslessCompactJson validates JSON syntax before stripping whitespace and preserves exact lexemes", () => {
  // Syntax validation: invalid JSON syntax with missing comma must NOT be stripped or altered into valid data
  assert.equal(losslessCompactJson('{ "value": 1 2 }'), null);
  assert.equal(losslessCompactJson('{\n  "unclosed": "string\n}'), null);
  assert.equal(losslessCompactJson('not json at all'), null);

  // Valid JSON with large integer > Number.MAX_SAFE_INTEGER (9007199254740993)
  const largeIntJson = '{\n  "value": 9007199254740993\n}';
  const compactedLarge = losslessCompactJson(largeIntJson);
  assert(compactedLarge);
  assert.equal(compactedLarge, '{"value":9007199254740993}');
  assert(compactedLarge.includes("9007199254740993"));
  assert(!compactedLarge.includes("9007199254740992"));

  // Duplicate keys preserved verbatim
  const dupKeyJson = '{\n  "a": 1,\n  "a": 2\n}';
  assert.equal(losslessCompactJson(dupKeyJson), '{"a":1,"a":2}');

  // High precision floats preserved verbatim
  const floatJson = '{\n  "ratio": 1.0000000000000000001\n}';
  assert.equal(losslessCompactJson(floatJson), '{"ratio":1.0000000000000000001}');

  // Strings with spaces and escaped quotes preserved verbatim
  const stringJson = '{\n  "msg": "hello   world",\n  "quote": "he said \\"hi\\""\n}';
  assert.equal(losslessCompactJson(stringJson), '{"msg":"hello   world","quote":"he said \\"hi\\""}');

  // Already compact JSON returns null (no net savings)
  assert.equal(losslessCompactJson('{"a":1}'), null);
});

test("cleanTerminalText cleans ANSI SGR and CRLF but preserves unsupported terminal control streams", () => {
  const sgrText = "\x1b[1;32mSUCCESS:\x1b[0m Build passed\r\n\x1b[33mWarning:\x1b[0m None\r\n";
  const cleanedSgr = cleanTerminalText(sgrText);
  assert(cleanedSgr);
  assert.equal(cleanedSgr, "SUCCESS: Build passed\nWarning: None\n");

  // Unsupported terminal escape sequences (cursor movement, clear screen) must be preserved verbatim (returns null)
  const cursorStream = "Updating...\x1b[2J\x1b[1;1HRow 1\x1b[2;1HRow 2";
  assert.equal(cleanTerminalText(cursorStream), null);

  // OSC escape codes (window title setting) preserved verbatim
  const oscStream = "\x1b]0;Current Process\x07Running command...";
  assert.equal(cleanTerminalText(oscStream), null);

  // Plain text without SGR or CRLF returns null
  assert.equal(cleanTerminalText("Plain output without codes\n"), null);
});

test("deduplication requires keeper in retainedEntries and demonstrable source identity from call association", () => {
  const bodyText = "Line of output\n".repeat(30);

  // Case A: Earlier entry b is retired (not in retainedEntries); c is in retainedEntries
  const callB = assistant("call-b-entry", [{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "data.txt" } }]);
  const entryB = toolEntry("b", "call-b", bodyText, "read");
  const callC = assistant("call-c-entry", [{ type: "toolCall", id: "call-c", name: "read", arguments: { path: "data.txt" } }]);
  const entryC = toolEntry("c", "call-c", bodyText, "read");
  const activeA = [callB, entryB, callC, entryC];

  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  const resRetiredKeeper = decideToolResultCleanup({
    active: activeA,
    candidateScope: [{ entryId: "c", messageIndex: 0 }],
    retainedEntries: [callC, entryC], // entryB is retired
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  // c CANNOT deduplicate to retired b!
  assert.equal(resRetiredKeeper.applied.length, 0);

  // Case B: Same toolName but DIFFERENT arguments (read file1 vs read file2)
  const callDiff1 = assistant("call-diff-1-entry", [{ type: "toolCall", id: "c-diff-1", name: "read", arguments: { path: "file1.txt" } }]);
  const entryDiff1 = toolEntry("d1", "c-diff-1", bodyText, "read");
  const callDiff2 = assistant("call-diff-2-entry", [{ type: "toolCall", id: "c-diff-2", name: "read", arguments: { path: "file2.txt" } }]);
  const entryDiff2 = toolEntry("d2", "c-diff-2", bodyText, "read");
  const activeB = [callDiff1, entryDiff1, callDiff2, entryDiff2];

  const resDiffArgs = decideToolResultCleanup({
    active: activeB,
    candidateScope: [{ entryId: "d1", messageIndex: 0 }, { entryId: "d2", messageIndex: 0 }],
    retainedEntries: activeB,
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  // Must NOT deduplicate because call arguments differ!
  assert.equal(resDiffArgs.applied.filter(d => d.action === "deduplicate").length, 0);

  // Case C: Same toolName and SAME arguments (both read file1.txt) and both retained
  const callSame1 = assistant("call-same-1-entry", [{ type: "toolCall", id: "c-same-1", name: "read", arguments: { path: "file1.txt" } }]);
  const entrySame1 = toolEntry("s1", "c-same-1", bodyText, "read");
  const callSame2 = assistant("call-same-2-entry", [{ type: "toolCall", id: "c-same-2", name: "read", arguments: { path: "file1.txt" } }]);
  const entrySame2 = toolEntry("s2", "c-same-2", bodyText, "read");
  const activeC = [callSame1, entrySame1, callSame2, entrySame2];

  const resSameArgs = decideToolResultCleanup({
    active: activeC,
    candidateScope: [{ entryId: "s1", messageIndex: 0 }, { entryId: "s2", messageIndex: 0 }],
    retainedEntries: activeC,
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  const dedup = resSameArgs.applied.find(d => d.entryId === "s2" && d.action === "deduplicate");
  assert(dedup);
  assert.equal(dedup.text, formatDeduplicateMarker({ entryId: "s2", messageIndex: 0 }, { entryId: "s1", messageIndex: 0 }));
  // s1 is a protected keeper and has ZERO modifications applied
  assert(!resSameArgs.applied.some(d => d.entryId === "s1"));
});

test("sequential tool calls reusing toolCallId with different arguments do not deduplicate", () => {
  const commonBody = "Output matching across sequential calls\n".repeat(20);

  // Turn 1: call-reused reads path A
  const call1 = assistant("a1", [{ type: "toolCall", id: "call-reused", name: "read", arguments: { path: "path_A.txt" } }]);
  const res1 = toolEntry("r1", "call-reused", commonBody, "read");
  // Turn 2: call-reused reads path B (different argument, same toolCallId)
  const call2 = assistant("a2", [{ type: "toolCall", id: "call-reused", name: "read", arguments: { path: "path_B.txt" } }]);
  const res2 = toolEntry("r2", "call-reused", commonBody, "read");

  const active = [call1, res1, call2, res2];
  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "r1", messageIndex: 0 }, { entryId: "r2", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
  });

  // Linear association correctly pairs r1 -> path_A and r2 -> path_B: they must NOT deduplicate!
  assert.equal(result.applied.filter(d => d.action === "deduplicate").length, 0);
});

test("applyToolResultCleanup replaces text body exactly once and preserves all host message metadata", () => {
  const originalMessage = {
    role: "toolResult" as const,
    toolCallId: "call-custom",
    toolName: "fetch_data",
    isError: false,
    timestamp: 123456789,
    content: [
      { type: "text" as const, text: "Chunk 1 of output\n" },
      { type: "text" as const, text: "Chunk 2 of output\n" },
    ],
    details: { executionTimeMs: 150, exitCode: 0, customFlag: true },
  };

  const entry: ActiveEntry = {
    entryId: "e-multi",
    sourceRole: "toolResult",
    messages: [originalMessage],
  };

  const decision: ToolResultDecision = {
    entryId: "e-multi",
    messageIndex: 0,
    toolCallId: "call-custom",
    toolName: "fetch_data",
    kind: "semantic",
    action: "replace",
    text: "[Nunc summary; original recoverable from entry e-multi message 0]:\nSingle summary text",
    originalLength: 36,
    cleanedLength: 85,
    netSavings: 20,
  };

  const projected = applyToolResultCleanup([entry], [decision]);
  assert.equal(projected.length, 1);
  const projMsg = projected[0]!.messages[0]! as typeof originalMessage;

  // Body replaced EXACTLY ONCE (content array has length 1, not 2!)
  assert.equal(projMsg.content.length, 1);
  assert.equal(projMsg.content[0]!.type, "text");
  assert.equal(projMsg.content[0]!.text, decision.text);

  // All metadata preserved via copying
  assert.equal(projMsg.toolCallId, "call-custom");
  assert.equal(projMsg.toolName, "fetch_data");
  assert.equal(projMsg.isError, false);
  assert.equal(projMsg.timestamp, 123456789);
  assert.deepEqual(projMsg.details, { executionTimeMs: 150, exitCode: 0, customFlag: true });
});

test("request.ts extractionContext preserves prefix stability, puts candidates at tail, and pre-filters omissions/mixed", async () => {
  const baseInput = await input();
  const tCall = assistant("call-entry", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "data.txt" } }]);
  const tResultClean = toolEntry("res-clean", "call-1", "A".repeat(500));
  const tResultOmission = toolEntry("res-omission", "call-1", "B".repeat(500));
  const tResultImage: ActiveEntry = {
    entryId: "res-image",
    sourceRole: "toolResult",
    messages: [{
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      timestamp: 0,
      content: [
        { type: "text", text: "Caption: " },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    }],
  };
  baseInput.active = [user("u1", "Start"), tCall, tResultClean, tResultOmission, tResultImage, user("u2", "Next")];
  baseInput.cleanupCandidateScope = [
    { entryId: "res-clean", messageIndex: 0 },
    { entryId: "res-omission", messageIndex: 0 },
    { entryId: "res-image", messageIndex: 0 },
  ];

  const omissions = [{
    entryId: "res-omission", messageIndex: 0, blockIndex: 0, toolCallId: "call-1",
    omittedCodePoints: 200, headChars: 100, tailChars: 100,
  }];

  // 1. Prefix stability: system prompt must be fixed conditional statement (does not vary with candidate count)
  const ctxWithCandidates = extractionContext(baseInput, 1, 1000, baseInput.active, omissions);
  const baseInputEmpty = structuredClone(baseInput);
  baseInputEmpty.cleanupCandidateScope = [];
  const ctxEmptyCandidates = extractionContext(baseInputEmpty, 1, 1000, baseInputEmpty.active, []);
  assert.equal(ctxWithCandidates.systemPrompt, ctxEmptyCandidates.systemPrompt);

  // 2. First block (source: "F/M") is stable ahead of transcript and does NOT contain cleanupCandidates
  const firstBlock = JSON.parse((ctxWithCandidates.messages[0]!.content[0]! as { text: string }).text);
  assert.equal(firstBlock.cleanupCandidates, undefined);

  // 3. Varying cleanupCandidates is placed AFTER transcript at the tail
  const userContent = ctxWithCandidates.messages[0]!.content;
  const tailCandBlock = JSON.parse((userContent.at(-2)! as { text: string }).text);
  assert(Array.isArray(tailCandBlock.cleanupCandidates));

  // 4. Pre-filtering: safeCandidates must ONLY contain clean text results (omissions and mixed/image blocks filtered out)
  assert.equal(tailCandBlock.cleanupCandidates.length, 1);
  assert.equal(tailCandBlock.cleanupCandidates[0].entryId, "res-clean");

  // 5. Disabled configuration exposes no candidates
  baseInput.config.toolResultCleanup = false;
  const ctxDisabled = extractionContext(baseInput, 1, 1000, baseInput.active, []);
  assert(!JSON.stringify(ctxDisabled.messages[0]!.content).includes("cleanupCandidates"));
});

test("compactInvarDocToc and decodeInvarDocToc provide guaranteed roundtrip invertibility", () => {
  const originalPayload = {
    frontmatter: null,
    sections: [
      {
        level: 1,
        title: "Root Title",
        slug: "root-title",
        line_start: 1,
        line_end: 10,
        char_count: 500,
        path: "root-title",
        children: [
          {
            level: 2,
            title: "Child Section",
            slug: "child-section",
            line_start: 11,
            line_end: 25,
            char_count: 1200,
            path: "root-title/child-section",
            children: [],
          },
        ],
      },
    ],
  };

  const jsonText = JSON.stringify(originalPayload, null, 2);
  const compact = compactInvarDocToc(jsonText);
  assert(compact);
  assert(compact.includes(formatTocMarker()));
  assert(compact.length < jsonText.length);

  // Decode and assert exact roundtrip equality
  const decoded = decodeInvarDocToc(compact);
  assert.deepEqual(decoded, originalPayload);

  // Negative cases: arbitrary text with slashes or invalid JSON return null
  assert.equal(compactInvarDocToc("/a/long/path/repeated/".repeat(30)), null);
  assert.equal(compactInvarDocToc(JSON.stringify({ notSections: true })), null);
});

test("stripToolBoilerplate requires keeper in retainedEntries and protects keeper across families", () => {
  const launchBp = KNOWN_LAUNCH_BOILERPLATES[0]!;
  const out1 = launchBp + "Doctest: 14 passed\nHypothesis: 20 passed\n";
  const out2 = launchBp + "Doctest: 14 passed\nHypothesis: 10 passed, 1 failed\n";

  const call1 = assistant("a1", [{ type: "toolCall", id: "c1", name: "invar_guard", arguments: { path: "." } }]);
  const t1 = toolEntry("t1", "c1", out1, "invar_guard");
  const call2 = assistant("a2", [{ type: "toolCall", id: "c2", name: "invar_guard", arguments: { path: "." } }]);
  const t2 = toolEntry("t2", "c2", out2, "invar_guard");
  const active = [call1, t1, call2, t2];

  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  // Case A: Keeper t1 survives in retainedEntries
  const resSurvives = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t2", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  const stripped = resSurvives.applied.find(d => d.entryId === "t2" && d.action === "strip_boilerplate");
  assert(stripped);
  assert(stripped.text.includes(formatBoilerplateMarker({ entryId: "t1", messageIndex: 0 })));

  // Case B: Same-batch semantic edit attempting to omit keeper t1 is rejected (keeper protected)
  const resOmitKeeper = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }, { entryId: "t2", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: [{ entryId: "t1", messageIndex: 0, action: "omit" }],
  });
  const t1Omit = resOmitKeeper.skipped.find(s => s.entryId === "t1");
  assert(t1Omit);
  assert.equal(t1Omit.reason, "keeper_protected");

  // Case C: Keeper t1 is retired (not in retainedEntries) -> t2 must NOT strip boilerplate referencing retired t1!
  const resRetiredKeeper = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t2", messageIndex: 0 }],
    retainedEntries: [call2, t2], // t1 is retired
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  assert.equal(resRetiredKeeper.applied.length, 0);

  // Case D: Arbitrary shared header lines (not known launch boilerplate) must NOT strip
  const arbOut1 = "Unique diagnostic line A\nUnique diagnostic line B\nTail 1\n".repeat(10);
  const arbOut2 = "Unique diagnostic line A\nUnique diagnostic line B\nTail 2\n".repeat(10);
  const tArb1 = toolEntry("ta1", "ca1", arbOut1, "bash");
  const tArb2 = toolEntry("ta2", "ca2", arbOut2, "bash");
  const resArb = decideToolResultCleanup({
    active: [tArb1, tArb2],
    candidateScope: [{ entryId: "ta2", messageIndex: 0 }],
    retainedEntries: [tArb1, tArb2],
    initialMemory: memBefore,
    finalMemory: memAfter,
  });
  assert.equal(resArb.applied.length, 0);
});

test("sourceRefs enforces final full-source condition and rejects mechanically reduced targets", () => {
  const jsonText = '{\n  "longKey": "value",\n  "another": [1, 2, 3]\n}';
  const t1 = toolEntry("t1", "c1", jsonText);
  const t2 = toolEntry("t2", "c2", "Dependent summary target ".repeat(20));
  const active = [t1, t2];

  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  // t1 will be mechanically compacted. Edit on t2 depends on t1 as a sourceRef.
  const edits: ToolResultEdit[] = [
    { entryId: "t2", messageIndex: 0, action: "replace", text: "Summary", sourceRefs: [{ entryId: "t1", messageIndex: 0 }] },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }, { entryId: "t2", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  // t2 edit must be rejected because t1 receives mechanical compact_json and is not full original copy
  const t2Skip = result.skipped.find(s => s.entryId === "t2");
  assert(t2Skip);
  assert.equal(t2Skip.reason, "missing_source_dependency");
});

test("malformed edit plus valid edit on same target both trigger duplicate_edit rejection", () => {
  const t1 = toolEntry("t1", "c1", "Long tool output text ".repeat(20));
  const active = [t1];
  const memBefore: Memory = { version: 1, slots: [], nextId: 1 };
  const memAfter: Memory = { version: 1, slots: [{ id: "s1", text: "Goal" }], nextId: 2 };

  // One valid edit and one malformed edit (unknown field) on the same target
  const edits = [
    { entryId: "t1", messageIndex: 0, action: "replace", text: "Valid replace text" },
    { entryId: "t1", messageIndex: 0, action: "replace", text: "Conflict replace text", unknownField: "bad" },
  ];

  const result = decideToolResultCleanup({
    active,
    candidateScope: [{ entryId: "t1", messageIndex: 0 }],
    retainedEntries: active,
    initialMemory: memBefore,
    finalMemory: memAfter,
    semanticEdits: edits,
  });

  // Neither edit should win: both must be rejected as duplicate_edit
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 2);
  assert(result.skipped.every(s => s.reason === "duplicate_edit"));
});

test("legacy callers without cleanupCandidateScope preserve 100% consistent raw history", async () => {
  const source = await input();
  const longResult = '{\n  "status": "legacy",\n  "data": [1, 2, 3]\n}';
  const tCall = assistant("call-entry", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "data.json" } }]);
  const tResult = toolEntry("res-entry", "call-1", longResult);
  source.active = [user("u1", "First"), tCall, tResult, user("u2", "Second question")];
  delete source.cleanupCandidateScope;

  const patch = {
    add: [{ key: "k1", text: "Updated goal" }],
    remove: [],
    priority: ["k1"],
    required: ["k1"],
  };

  const result = await maintain(source, responder(patch));
  assert(result.ok);

  assert.equal(result.candidate.toolResultCleanup?.applied.length, 0);
  const deliveredTool = result.candidate.kept.find(e => e.entryId === "res-entry");
  assert(deliveredTool);
  assert.equal(messageText(deliveredTool.messages[0]!), longResult);
});


