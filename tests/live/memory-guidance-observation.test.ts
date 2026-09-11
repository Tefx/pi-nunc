import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseInput, RunnerError, type Selection } from "../../src/live/contract.js";
import { loadScenario, scoreArtifacts, seedScenario, type CheckResult } from "../../src/live/scenarios.js";
import { fixture, repository } from "./fixtures.js";

const DEFAULT_RUN_CONFIG = {
  nunc: {},
  compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 4000 },
};

test("guidance scenarios g1–g8 load assets and seed only task fixture files with private oracle isolation", async () => {
  const allIds: Array<{ id: Selection["id"]; variant?: Selection["variant"] }> = [
    { id: "g1" },
    { id: "g2" },
    { id: "g3" },
    { id: "g4" },
    { id: "g5" },
    { id: "g6" },
    { id: "g7", variant: "conflict" },
    { id: "g7", variant: "unconfirmed" },
    { id: "g8", variant: "fits-required" },
    { id: "g8", variant: "required-too-large" },
  ];

  const tmpRoot = join(repository, ".scratch", `guidance-test-${Date.now()}`);
  await mkdir(tmpRoot, { recursive: true });

  try {
    for (const item of allIds) {
      const selection: Selection = {
        id: item.id,
        ...(item.variant ? { variant: item.variant } : {}),
        config: DEFAULT_RUN_CONFIG,
      };
      const { input, observer } = await loadScenario(repository, selection);
      assert.equal(input.id, item.id);
      assert(input.turns.length > 0, `${item.id} must have input turns`);
      assert(observer.actionChecks.length > 0, `${item.id} must have action checks`);

      const taskDir = join(tmpRoot, `${item.id}-${item.variant ?? "base"}`);
      await seedScenario(input, taskDir);

      // Model-visible turns and task files must NOT leak private expected answer strings
      for (const turn of input.turns) {
        assert(!turn.text.includes("PROVEN"), "Model turn text must not contain PROVEN");
        assert(!turn.text.includes("DISPROVEN"), "Model turn text must not contain DISPROVEN");
        assert(!turn.text.includes("criterion:"), "Model turn text must not contain private criterion");
      }
      for (const [fileName, fileContent] of Object.entries(input.files)) {
        assert(!fileContent.includes("PROVEN"), `Task file ${fileName} must not contain PROVEN`);
        assert(!fileContent.includes("DISPROVEN"), `Task file ${fileName} must not contain DISPROVEN`);
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("public CLI verify-live.mjs --preflight succeeds with zero model calls and no task side effects for guidance selection", async () => {
  const selectionJson = JSON.stringify({
    target: {
      repository,
      stateRoot: join(repository, ".scratch", "nunc-live-preflight-guidance"),
      cleanup: "retain",
    },
    limits: {
      maxDurationMs: 60000,
      maxOutputTokens: 65536,
      maxCalls: 10,
      maxTotalTokens: 100000,
      maxCostUsd: null,
    },
    observations: ["stock_rpc"],
    scenarios: [
      { id: "g1" },
      { id: "g2" },
      { id: "g7", variant: "conflict" },
      { id: "g8", variant: "fits-required" },
    ],
    overrides: [
      {
        requirement: "gemini-model-selection",
        reason: "Offline test of Gemini route",
        model: { provider: "openrouter", id: "google/gemini-3.8-flash" },
      },
    ],
  });

  const env: Record<string, string | undefined> = {
    ...process.env,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  delete env.NODE_OPTIONS;

  const output = execFileSync(
    process.execPath,
    [join(repository, "scripts/verify-live.mjs"), "--preflight"],
    {
      input: selectionJson,
      encoding: "utf8",
      env,
    }
  );

  const parsed = JSON.parse(output.trim());
  assert.equal(parsed.status, "PREFLIGHT");
  assert.equal(parsed.receipt.callsMade, 0);
  assert.equal(parsed.receipt.pi, "0.85.1");
  assert(parsed.scenarios.some((s: any) => s.id === "g1"));
});

test("guidance scenarios strictly enforce Gemini-only selection and reject Astra and non-Gemini models", async () => {
  const baseInput = {
    version: 1,
    mode: "native",
    target: {
      repository,
      stateRoot: join(repository, ".scratch", "tmp-test"),
      cleanup: "retain",
    },
    limits: {
      maxDurationMs: 60000,
      maxOutputTokens: 8192,
      maxCalls: 5,
      maxTotalTokens: 50000,
      maxCostUsd: null,
    },
    scenarios: [{ id: "g1", config: DEFAULT_RUN_CONFIG }],
  };

  // Astra model must be rejected
  assert.throws(
    () => {
      parseInput({
        ...baseInput,
        models: [
          {
            provider: "openai-codex",
            id: "gpt-6-astra",
            contextWindow: 128000,
            maxTokens: 8192,
            baseUrl: "https://api.openai.com/v1",
          },
        ],
      });
    },
    (err: any) => err instanceof RunnerError && err.code === "MODEL" && err.message.includes("Astra and non-Gemini models are forbidden")
  );

  // Non-Gemini model (e.g. Claude) must be rejected
  assert.throws(
    () => {
      parseInput({
        ...baseInput,
        models: [
          {
            provider: "anthropic",
            id: "claude-3-opus",
            contextWindow: 200000,
            maxTokens: 4096,
            baseUrl: "https://api.anthropic.com/v1",
          },
        ],
      });
    },
    (err: any) => err instanceof RunnerError && err.code === "MODEL" && err.message.includes("Astra and non-Gemini models are forbidden")
  );

  // Authorized Gemini model passes validation
  const valid = parseInput({
    ...baseInput,
    models: [
      {
        provider: "openrouter",
        id: "google/gemini-3.8-flash",
        contextWindow: 1000000,
        maxTokens: 8192,
        baseUrl: "https://openrouter.ai/api/v1",
      },
    ],
  });
  assert.equal(valid.models[0]!.id, "google/gemini-3.8-flash");
});

test("scenario g1: routine conversation oracle requires exposed tools and rejects unexpected memory calls", async () => {
  const selection: Selection = { id: "g1", config: DEFAULT_RUN_CONFIG };
  const { observer } = await loadScenario(repository, selection);

  // Negative 1: memory tools not exposed -> UNPROVEN
  const unexposedResult = await scoreArtifacts(repository, observer, [
    { check: "memory tools exposed in session", status: "UNPROVEN", reason: "tools not exposed" },
  ], { actions: [] });
  assert.equal(unexposedResult.actionReview[0]!.status, "UNPROVEN");
  assert(unexposedResult.actionReview[0]!.reason?.includes("not exposed"));

  // Negative 2: agent made unexpected nunc_memory_read call -> DISPROVEN
  const badCallActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_read",
        toolCallId: "call-1",
        input: {},
      },
    },
  ];
  const disprovenResult = await scoreArtifacts(repository, observer, [
    { check: "memory tools exposed in session", status: "PROVEN" },
  ], { actions: badCallActions });
  assert.equal(disprovenResult.actionReview[0]!.status, "DISPROVEN");
  assert(disprovenResult.actionReview[0]!.reason?.includes("called memory tool"));

  // Positive: tools exposed, 0 memory tool calls -> PROVEN
  const goodActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "read",
        toolCallId: "call-read-1",
        input: { path: "reference.txt" },
      },
    },
  ];
  const provenResult = await scoreArtifacts(repository, observer, [
    { check: "memory tools exposed in session", status: "PROVEN" },
  ], { actions: goodActions });
  assert.equal(provenResult.actionReview[0]!.status, "PROVEN");
});

test("scenario g2: key decision oracle enforces conciseness and distinguishing diagnostic identifiers", async () => {
  const selection: Selection = { id: "g2", config: DEFAULT_RUN_CONFIG };
  const { observer } = await loadScenario(repository, selection);
  const prereqs: CheckResult[] = [{ check: "memory tools exposed in session", status: "PROVEN" }];

  // Negative 1: no patch called -> UNPROVEN
  const noPatchResult = await scoreArtifacts(repository, observer, prereqs, { actions: [] });
  assert.equal(noPatchResult.actionReview[0]!.status, "UNPROVEN");

  // Negative 2: bloated raw log dump (> 500 chars) -> DISPROVEN
  const bloatedActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        input: {
          expectedRevision: "rev-1",
          add: [{ key: "k1", text: "ERR_SCHEMA_V2 on port 5433 with run-migration --v1: " + "A".repeat(600) }],
        },
      },
    },
  ];
  const bloatedResult = await scoreArtifacts(repository, observer, prereqs, { actions: bloatedActions });
  assert.equal(bloatedResult.actionReview[0]!.status, "DISPROVEN");
  assert(bloatedResult.actionReview[0]!.reason?.includes("conciseness"));

  // Negative 3: selected blocked route migration-v2 -> DISPROVEN
  const blockedRouteActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        input: {
          expectedRevision: "rev-1",
          add: [{ key: "k1", text: "Selected route migration-v2 on port 5433" }],
        },
      },
    },
  ];
  const blockedRouteResult = await scoreArtifacts(repository, observer, prereqs, { actions: blockedRouteActions });
  assert.equal(blockedRouteResult.actionReview[0]!.status, "DISPROVEN");
  assert(blockedRouteResult.actionReview[0]!.reason?.includes("migration-v2"));

  // Negative 4: incomplete command (missing --port 5433 or --v1) -> DISPROVEN
  const missingValActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        input: {
          expectedRevision: "rev-1",
          add: [{ key: "k1", text: "Decided to run-migration because of ERR_SCHEMA_V2" }],
        },
      },
    },
  ];
  const missingValResult = await scoreArtifacts(repository, observer, prereqs, { actions: missingValActions });
  assert.equal(missingValResult.actionReview[0]!.status, "DISPROVEN");
  assert(missingValResult.actionReview[0]!.reason?.includes("distinguishing identifiers"));

  // Positive: concise note with exact error ERR_SCHEMA_V2, port 5433, and recovery command run-migration --v1 --port 5433 -> PROVEN
  const validActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        input: {
          expectedRevision: "rev-1",
          add: [
            {
              key: "k1",
              text: "Observed ERR_SCHEMA_V2 on port 5433. Fallback to pipeline v1 using run-migration --v1 --port 5433.",
            },
          ],
        },
      },
    },
  ];
  const validResult = await scoreArtifacts(repository, observer, prereqs, { actions: validActions });
  assert.equal(validResult.actionReview[0]!.status, "PROVEN");
});

test("scenario g3: instruction correction oracle requires updating stale notes while retaining valid ones", async () => {
  const selection: Selection = { id: "g3", config: DEFAULT_RUN_CONFIG };
  const { observer } = await loadScenario(repository, selection);
  const prereqs: CheckResult[] = [{ check: "memory tools exposed in session", status: "PROVEN" }];

  // Negative 1: valid sqlite dropped -> DISPROVEN
  const dropValidActions = [
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-2",
        input: {
          expectedRevision: "rev-2",
          update: [{ id: "s1", text: "port: 9090" }],
          remove: ["s2"],
        },
      },
    },
    {
      turn: "b",
      event: {
        type: "memory_state",
        slots: [{ id: "s1", text: "port: 9090" }],
      },
    },
  ];
  const dropResult = await scoreArtifacts(repository, observer, prereqs, { actions: dropValidActions });
  assert.equal(dropResult.actionReview[0]!.status, "DISPROVEN");
  assert(dropResult.actionReview[0]!.reason?.includes("sqlite storage note was dropped"));

  // Negative 2: stale 8080 retained without 9090 -> DISPROVEN
  const staleRetainedActions = [
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-2",
        input: {
          expectedRevision: "rev-2",
          add: [{ key: "k2", text: "extra" }],
        },
      },
    },
    {
      turn: "b",
      event: {
        type: "memory_state",
        slots: [
          { id: "s1", text: "port: 8080" },
          { id: "s2", text: "database: sqlite" },
        ],
      },
    },
  ];
  const staleRetainedResult = await scoreArtifacts(repository, observer, prereqs, { actions: staleRetainedActions });
  assert.equal(staleRetainedResult.actionReview[0]!.status, "DISPROVEN");
  assert(staleRetainedResult.actionReview[0]!.reason?.includes("8080"));

  // Positive: stale 8080 updated to 9090 and sqlite preserved -> PROVEN
  const goodActions = [
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-2",
        input: {
          expectedRevision: "rev-2",
          update: [{ id: "s1", text: "port: 9090" }],
        },
      },
    },
    {
      turn: "b",
      event: {
        type: "memory_state",
        slots: [
          { id: "s1", text: "port: 9090" },
          { id: "s2", text: "database: sqlite" },
        ],
      },
    },
  ];
  const goodResult = await scoreArtifacts(repository, observer, prereqs, { actions: goodActions });
  assert.equal(goodResult.actionReview[0]!.status, "PROVEN");
});

test("scenario g4: multi-task interruption preserves main task obligations across side questions", async () => {
  const selection: Selection = { id: "g4", config: DEFAULT_RUN_CONFIG };
  const { observer } = await loadScenario(repository, selection);
  const prereqs: CheckResult[] = [{ check: "memory tools exposed in session", status: "PROVEN" }];

  // Negative: obligations dropped after side question -> DISPROVEN
  const droppedActions = [
    {
      turn: "b",
      event: {
        type: "memory_state",
        slots: [],
      },
    },
  ];
  const droppedResult = await scoreArtifacts(repository, observer, prereqs, { actions: droppedActions });
  assert.equal(droppedResult.actionReview[0]!.status, "DISPROVEN");
  assert(droppedResult.actionReview[0]!.reason?.includes("obligations dropped"));

  // Positive: obligations preserved -> PROVEN
  const retainedActions = [
    {
      turn: "b",
      event: {
        type: "memory_state",
        slots: [
          { id: "s1", text: "1. Token rotation; 2. Rate limiting; 3. Regression test" },
        ],
      },
    },
  ];
  const retainedResult = await scoreArtifacts(repository, observer, prereqs, { actions: retainedActions });
  assert.equal(retainedResult.actionReview[0]!.status, "PROVEN");
});

test("scenario g5: implemented vs verified status distinction oracle rejects premature claims and failed runs", async () => {
  const selection: Selection = { id: "g5", config: DEFAULT_RUN_CONFIG };
  const { observer } = await loadScenario(repository, selection);
  const prereqs: CheckResult[] = [{ check: "memory tools exposed in session", status: "PROVEN" }];

  // Negative 1: premature verify executed in turn a -> DISPROVEN
  const prematureVerifyActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "call-verify-early",
        input: { command: "python3 verify.py" },
      },
    },
  ];
  const prematureVerifyResult = await scoreArtifacts(repository, observer, prereqs, { actions: prematureVerifyActions });
  assert.equal(prematureVerifyResult.actionReview[0]!.status, "DISPROVEN");
  assert(prematureVerifyResult.actionReview[0]!.reason?.includes("prematurely in turn a"));

  // Negative 2: premature direct write of verified.json in turn a -> DISPROVEN
  const prematureWriteActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "write",
        toolCallId: "call-write-early",
        input: { path: "verified.json", content: '{"passed": true}' },
      },
    },
  ];
  const prematureWriteResult = await scoreArtifacts(repository, observer, prereqs, { actions: prematureWriteActions });
  assert.equal(prematureWriteResult.actionReview[0]!.status, "DISPROVEN");
  assert(prematureWriteResult.actionReview[0]!.reason?.includes("authored prematurely in turn a"));

  // Negative 3: python3 verify.py executed in turn b but failed -> DISPROVEN
  const failedVerifyActions = [
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "call-verify-b",
        input: { command: "python3 verify.py" },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call-verify-b",
        isError: true,
        content: [{ type: "text", text: "AssertionError: test failed" }],
      },
    },
  ];
  const failedVerifyResult = await scoreArtifacts(repository, observer, prereqs, { actions: failedVerifyActions });
  assert.equal(failedVerifyResult.actionReview[1]!.status, "DISPROVEN");
  assert(failedVerifyResult.actionReview[1]!.reason?.includes("failed with an error"));

  // Negative 4: python3 verify.py never executed in turn b -> UNPROVEN
  const noVerifyActions = [
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "read",
        toolCallId: "call-read-b",
        input: { path: "solution.py" },
      },
    },
  ];
  const noVerifyResult = await scoreArtifacts(repository, observer, prereqs, { actions: noVerifyActions });
  assert.equal(noVerifyResult.actionReview[1]!.status, "UNPROVEN");
  assert(noVerifyResult.actionReview[1]!.reason?.includes("not executed in turn b"));

  // Negative 5: claimed user acceptance without confirmation -> DISPROVEN
  const prematureAcceptanceActions = [
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "call-verify-pass",
        input: { command: "python3 verify.py" },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call-verify-pass",
        isError: false,
        content: [{ type: "text", text: "VERIFIED" }],
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "write",
        toolCallId: "call-write-accept",
        input: { path: "accepted.json", content: '{"accepted": true}' },
      },
    },
  ];
  const prematureAcceptanceResult = await scoreArtifacts(repository, observer, prereqs, { actions: prematureAcceptanceActions });
  assert.equal(prematureAcceptanceResult.actionReview[1]!.status, "DISPROVEN");
  assert(prematureAcceptanceResult.actionReview[1]!.reason?.includes("user acceptance without user confirmation"));

  // Positive: marks unverified before test, and marks verified after successful test -> PROVEN
  const validActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-unverified",
        input: {
          expectedRevision: "rev-1",
          add: [{ key: "k1", text: "Double function implemented, unverified pending tests" }],
        },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "call-verify-ok",
        input: { command: "python3 verify.py" },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call-verify-ok",
        isError: false,
        content: [{ type: "text", text: "VERIFIED" }],
      },
    },
  ];
  const validResult = await scoreArtifacts(repository, observer, prereqs, { actions: validActions });
  assert.equal(validResult.actionReview[0]!.status, "PROVEN");
  assert.equal(validResult.actionReview[1]!.status, "PROVEN");
});

test("scenario g6: split-turn wait and action ordering oracle requires split premise and rejects premature actions", async () => {
  const selection: Selection = { id: "g6", config: DEFAULT_RUN_CONFIG };
  const { observer } = await loadScenario(repository, selection);
  const prereqsWithSplit: CheckResult[] = [
    { check: "memory tools exposed in session", status: "PROVEN" },
    { check: "actual tool batch followed by automatic native split compaction and same-loop continuation", status: "PROVEN" },
  ];
  const prereqsWithoutSplit: CheckResult[] = [
    { check: "memory tools exposed in session", status: "PROVEN" },
  ];

  // Negative 1: no actions at all -> UNPROVEN (missing split prerequisite, deployed.json not produced)
  const noActionsResult = await scoreArtifacts(repository, observer, prereqsWithoutSplit, { actions: [] });
  assert.equal(noActionsResult.actionReview[1]!.status, "UNPROVEN");
  assert(noActionsResult.actionReview[1]!.reason?.includes("split-turn"));

  // Negative 2: premature deploy action in turn a before lock cleared -> DISPROVEN
  const prematureActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "write",
        toolCallId: "call-deploy-early",
        input: { path: "deployed.json", content: '{"deployed": true}' },
      },
    },
  ];
  const prematureResult = await scoreArtifacts(repository, observer, prereqsWithSplit, { actions: prematureActions });
  assert.equal(prematureResult.actionReview[0]!.status, "DISPROVEN");
  assert(prematureResult.actionReview[0]!.reason?.includes("ordering violated"));

  // Negative 3: split-turn prerequisite missing in turn b -> UNPROVEN
  const deployActions = [
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "write",
        toolCallId: "call-deploy-b",
        input: { path: "deployed.json", content: '{"deployed": true}' },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "call-verify-b",
        input: { command: "python3 verify.py" },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call-verify-b",
        isError: false,
      },
    },
  ];
  const missingSplitResult = await scoreArtifacts(repository, observer, prereqsWithoutSplit, { actions: deployActions });
  assert.equal(missingSplitResult.actionReview[1]!.status, "UNPROVEN");
  assert(missingSplitResult.actionReview[1]!.reason?.includes("split-turn"));

  // Negative 4: deployed.json not produced in turn b -> UNPROVEN
  const noDeployResult = await scoreArtifacts(repository, observer, prereqsWithSplit, { actions: [] });
  assert.equal(noDeployResult.actionReview[1]!.status, "UNPROVEN");
  assert(noDeployResult.actionReview[1]!.reason?.includes("deployed.json was not produced"));

  // Negative 5: verify failed in turn b -> DISPROVEN
  const failedVerifyActions = [
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "write",
        toolCallId: "call-deploy-b",
        input: { path: "deployed.json", content: '{"deployed": true}' },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "call-verify-b",
        input: { command: "python3 verify.py" },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call-verify-b",
        isError: true,
      },
    },
  ];
  const failedResult = await scoreArtifacts(repository, observer, prereqsWithSplit, { actions: failedVerifyActions });
  assert.equal(failedResult.actionReview[1]!.status, "DISPROVEN");
  assert(failedResult.actionReview[1]!.reason?.includes("Verification command failed"));

  // Positive: split proven, no premature deploy in turn a, deployed and verified in turn b -> PROVEN
  const validActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "read",
        toolCallId: "call-read-status",
        input: { path: "status.json" },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "write",
        toolCallId: "call-deploy-b",
        input: { path: "deployed.json", content: '{"deployed": true}' },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "call-verify-b",
        input: { command: "python3 verify.py" },
      },
    },
    {
      turn: "b",
      event: {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call-verify-b",
        isError: false,
      },
    },
  ];
  const validResult = await scoreArtifacts(repository, observer, prereqsWithSplit, { actions: validActions });
  assert.equal(validResult.actionReview[0]!.status, "PROVEN");
  assert.equal(validResult.actionReview[1]!.status, "PROVEN");
});

test("scenario g7/conflict: revision conflict oracle requires actual premise, re-reading, and reconciliation", async () => {
  const selection: Selection = { id: "g7", variant: "conflict", config: DEFAULT_RUN_CONFIG };
  const { observer } = await loadScenario(repository, selection);

  // Negative 1: missing conflict premise -> UNPROVEN
  const missingPremiseResult = await scoreArtifacts(repository, observer, [
    { check: "actual revision conflict triggered on nunc_memory_patch", status: "UNPROVEN", reason: "no conflict" },
  ], { actions: [] });
  assert.equal(missingPremiseResult.actionReview[0]!.status, "UNPROVEN");

  // Negative 2: blind retry with old revision without re-reading -> DISPROVEN
  const prereqs: CheckResult[] = [{ check: "actual revision conflict triggered on nunc_memory_patch", status: "PROVEN" }];
  const blindRetryActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        input: { expectedRevision: "rev-old", add: [{ key: "k1", text: "note" }] },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_result",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        isError: true,
        details: { ok: false, code: "conflict", message: "Session path or memory revision changed" },
      },
    },
    // Immediately retries patch without nunc_memory_read
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-retry",
        input: { expectedRevision: "rev-old", add: [{ key: "k1", text: "note" }] },
      },
    },
  ];
  const blindResult = await scoreArtifacts(repository, observer, prereqs, { actions: blindRetryActions });
  assert.equal(blindResult.actionReview[0]!.status, "DISPROVEN");
  assert(blindResult.actionReview[0]!.reason?.includes("without re-reading memory"));

  // Negative 3: retried with stale revision -> DISPROVEN
  const staleRetryActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        input: { expectedRevision: "rev-old", add: [{ key: "k1", text: "note" }] },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_result",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        isError: true,
        details: { ok: false, code: "conflict", message: "Session path or memory revision changed" },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_read",
        toolCallId: "call-reread",
        input: {},
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_result",
        toolName: "nunc_memory_read",
        toolCallId: "call-reread",
        isError: false,
        details: { revision: "rev-new", slots: [] },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-stale",
        input: { expectedRevision: "rev-old", add: [{ key: "k1", text: "note" }] },
      },
    },
  ];
  const staleResult = await scoreArtifacts(repository, observer, prereqs, { actions: staleRetryActions });
  assert.equal(staleResult.actionReview[0]!.status, "DISPROVEN");
  assert(staleResult.actionReview[0]!.reason?.includes("stale revision"));

  // Positive: conflict observed, agent re-reads memory, and then retries with reconciled revision -> PROVEN
  const goodActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        input: { expectedRevision: "rev-old", add: [{ key: "k1", text: "note" }] },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_result",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-1",
        isError: true,
        details: { ok: false, code: "conflict", message: "Session path or memory revision changed" },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_read",
        toolCallId: "call-reread",
        input: {},
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_result",
        toolName: "nunc_memory_read",
        toolCallId: "call-reread",
        isError: false,
        details: { revision: "rev-new", slots: [] },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-reconciled",
        input: { expectedRevision: "rev-new", add: [{ key: "k1", text: "note" }] },
      },
    },
  ];
  const goodResult = await scoreArtifacts(repository, observer, prereqs, { actions: goodActions });
  assert.equal(goodResult.actionReview[0]!.status, "PROVEN");
});

test("scenario g7/unconfirmed: unconfirmed save oracle forbids automatic replay", async () => {
  const selection: Selection = { id: "g7", variant: "unconfirmed", config: DEFAULT_RUN_CONFIG };
  const { observer } = await loadScenario(repository, selection);

  // Negative 1: missing unconfirmed premise -> UNPROVEN
  const missingPremiseResult = await scoreArtifacts(repository, observer, [
    { check: "actual unconfirmed save triggered on nunc_memory_patch", status: "UNPROVEN", reason: "no unconfirmed" },
  ], { actions: [] });
  assert.equal(missingPremiseResult.actionReview[0]!.status, "UNPROVEN");

  // Negative 2: automatic replay of unconfirmed save -> DISPROVEN
  const prereqs: CheckResult[] = [{ check: "actual unconfirmed save triggered on nunc_memory_patch", status: "PROVEN" }];
  const replayActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-unconf",
        input: { expectedRevision: "rev-1", add: [{ key: "k1", text: "checkpoint" }] },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_result",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-unconf",
        isError: true,
        details: { ok: false, code: "unconfirmed", message: "Save unconfirmed" },
      },
    },
    // Automatic replay
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-replay",
        input: { expectedRevision: "rev-1", add: [{ key: "k1", text: "checkpoint" }] },
      },
    },
  ];
  const replayResult = await scoreArtifacts(repository, observer, prereqs, { actions: replayActions });
  assert.equal(replayResult.actionReview[0]!.status, "DISPROVEN");
  assert(replayResult.actionReview[0]!.reason?.includes("automatically replayed unconfirmed save"));

  // Positive: unconfirmed observed, agent reports or stops without replaying patch -> PROVEN
  const goodActions = [
    {
      turn: "a",
      event: {
        type: "tool_call",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-unconf",
        input: { expectedRevision: "rev-1", add: [{ key: "k1", text: "checkpoint" }] },
      },
    },
    {
      turn: "a",
      event: {
        type: "tool_result",
        toolName: "nunc_memory_patch",
        toolCallId: "patch-unconf",
        isError: true,
        details: { ok: false, code: "unconfirmed", message: "Save unconfirmed" },
      },
    },
  ];
  const goodResult = await scoreArtifacts(repository, observer, prereqs, { actions: goodActions });
  assert.equal(goodResult.actionReview[0]!.status, "PROVEN");
});

test("scenario g8: budget qualification rejects missing competition and distinguishes clean CAPACITY", async () => {
  const selectionFits: Selection = { id: "g8", variant: "fits-required", config: DEFAULT_RUN_CONFIG };
  const { observer: obsFits } = await loadScenario(repository, selectionFits);

  // Negative 1: competition not proven -> UNPROVEN
  const unprovenResult = await scoreArtifacts(repository, obsFits, [
    { check: "all marked necessary candidates jointly fit within full memory limit", status: "PROVEN" },
    { check: "all candidates together exceed memory limit (actual competition)", status: "UNPROVEN" },
  ], { actions: [] });
  assert.equal(unprovenResult.actionReview[0]!.status, "UNPROVEN");
  assert(unprovenResult.actionReview[0]!.reason?.includes("budget competition not proven"));

  // Negative 2: empty prerequisites -> UNPROVEN
  const emptyPrereqResult = await scoreArtifacts(repository, obsFits, [], { actions: [] });
  assert.equal(emptyPrereqResult.actionReview[0]!.status, "UNPROVEN");

  // Positive fits-required -> PROVEN
  const provenResult = await scoreArtifacts(repository, obsFits, [
    { check: "all marked necessary candidates jointly fit within full memory limit", status: "PROVEN" },
    { check: "all candidates together exceed memory limit (actual competition)", status: "PROVEN" },
  ], { actions: [] });
  assert.equal(provenResult.actionReview[0]!.status, "PROVEN");

  const selectionTooLarge: Selection = { id: "g8", variant: "required-too-large", config: DEFAULT_RUN_CONFIG };
  const { observer: obsTooLarge } = await loadScenario(repository, selectionTooLarge);

  // Negative 1: necessary set did not exceed limit -> UNPROVEN
  const notExceedResult = await scoreArtifacts(repository, obsTooLarge, [
    { check: "marked necessary set exceeds rendered memory limit", status: "UNPROVEN" },
    { check: "at least one optional candidate fits within memory limit", status: "PROVEN" },
  ], { actions: [] });
  assert.equal(notExceedResult.actionReview[0]!.status, "UNPROVEN");
  assert(notExceedResult.actionReview[0]!.reason?.includes("overflow not proven"));

  // Negative 2: no optional candidate fits -> UNPROVEN
  const noOptFitResult = await scoreArtifacts(repository, obsTooLarge, [
    { check: "marked necessary set exceeds rendered memory limit", status: "PROVEN" },
    { check: "at least one optional candidate fits within memory limit", status: "UNPROVEN" },
  ], { actions: [] });
  assert.equal(noOptFitResult.actionReview[0]!.status, "UNPROVEN");

  // Positive: necessary set exceeded and clean CAPACITY observed -> PROVEN
  const capacityResult = await scoreArtifacts(repository, obsTooLarge, [
    { check: "marked necessary set exceeds rendered memory limit", status: "PROVEN" },
    { check: "at least one optional candidate fits within memory limit", status: "PROVEN" },
  ], { actions: [] });
  assert.equal(capacityResult.actionReview[0]!.status, "PROVEN");
});
