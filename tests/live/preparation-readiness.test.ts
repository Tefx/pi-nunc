import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { prepareBoundary } from "../../src/live/preparation.js";
import { metricsCommand } from "../../src/live/tool-path.js";
import { toolBlockReason } from "../../src/live/observer.js";
import { RunnerError } from "../../src/live/contract.js";
import { requestTokens, mainContext } from "../../src/engine/accounting.js";
import { repository } from "./fixtures.js";

function createExactFixtureEntries(): { branch: SessionEntry[]; requestText: string; fixtureContent: string; extraMainInputTokens: number } {
  const requestText = "Read TASK.md. We have work to do.";
  // 7581 chars yields exactly requestedK = 2019 tokens for the retained tool exchange.
  const fixtureContent = "x".repeat(7581);
  const branch: SessionEntry[] = [
    {
      id: "entry-req",
      parentId: null,
      type: "message",
      message: { role: "user", content: requestText, timestamp: 1 },
      timestamp: new Date(1).toISOString(),
    },
    {
      id: "entry-call",
      parentId: "entry-req",
      type: "message",
      message: fauxAssistantMessage(fauxToolCall("read", { path: "TASK.md" }, { id: "call-task" }), { stopReason: "toolUse" }),
      timestamp: new Date(2).toISOString(),
    },
    {
      id: "entry-result",
      parentId: "entry-call",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-task",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: fixtureContent }],
        timestamp: 3,
      },
      timestamp: new Date(3).toISOString(),
    },
  ];
  const fixed = { systemPrompt: "Work on task.", tools: [] };
  const baseF = requestTokens(mainContext(fixed, [], []), undefined);
  // Setting extraMainInputTokens so that F = 1854 exactly as in the observed Luna task.
  const extraMainInputTokens = 1854 - baseF;
  return { branch, requestText, fixtureContent, extraMainInputTokens };
}

test("reproduces exact numerical gap: usage=2929, H=2928, F=1854, growth=1024, memoryLimit=107, requestedK=2019; defers when allowed and fails when not", async () => {
  const provider = fauxProvider({ provider: "nunc-test", models: [{ id: "luna", contextWindow: 60000, maxTokens: 4096 }] });
  const model = provider.getModel();
  const { branch, requestText, fixtureContent, extraMainInputTokens } = createExactFixtureEntries();
  const active = buildContextEntries(branch);

  const control = {
    duringTurn: "a",
    action: "rollover_at_tool_boundary" as const,
    trigger: {
      occurrence: 1,
      pathArgument: "TASK.md",
      toolName: "read",
      when: "after_result_before_continuation" as const,
    },
    placement: {
      retireRequestOfTurn: "a",
      retainToolExchange: {
        occurrence: 1,
        pathArgument: "TASK.md",
        toolName: "read",
        turn: "a",
      },
    },
  };

  const baseConfig = {
    compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 },
    nunc: {
      memory: { fraction: 0.1, maxTokens: 1200 },
      growthTokens: 1024,
      budget: { extraMainInputTokens },
      extraction: { outputTokens: 2048 },
    },
    retentionCalibration: { minFraction: 0.0001, maxFraction: 0.9999 },
  };

  const turns = { a: ["entry-req", "entry-call", "entry-result"] };

  // 1. With allowDeferred: true and usage = 2929 (H = 2928):
  // H=2928 > F(1854) + growth(1024) = 2878, so the old check passed,
  // but H=2928 < F(1854) + memory(107) + K(2019) + growth(1024) = 5004!
  // The complete legal calibration detects this shortfall and throws INSUFFICIENT_CONTEXT.
  const deferredInput = {
    branch,
    active,
    control,
    turns,
    turnOrder: ["a"],
    config: baseConfig,
    model,
    fixed: { systemPrompt: "Work on task.", tools: [] },
    repository,
    signal: new AbortController().signal,
    trigger: {
      callId: "call-task",
      requestText,
      path: "TASK.md",
      cwd: "/task",
      fixtureContent,
      contextTokens: 2929,
      allowDeferred: true,
    },
    allowDeferred: true,
  };

  await assert.rejects(
    async () => prepareBoundary(deferredInput),
    (error: unknown) => {
      assert(error instanceof RunnerError, "Must be a RunnerError");
      assert.equal(error.code, "INSUFFICIENT_CONTEXT", "Must throw INSUFFICIENT_CONTEXT");
      assert.match(error.message, /insufficient to establish a compaction boundary/);
      assert.match(error.message, /H=2928/);
      assert.match(error.message, /F=1854/);
      assert.match(error.message, /memoryLimit=107/);
      assert.match(error.message, /growth=1024/);
      assert.match(error.message, /requestedK=2019/);
      return true;
    }
  );

  // 2. With allowDeferred: false: cannot defer, must throw PREPARATION (stays UNPROVEN).
  const nonDeferredInput = {
    ...deferredInput,
    allowDeferred: false,
    trigger: { ...deferredInput.trigger, allowDeferred: false },
  };

  await assert.rejects(
    async () => prepareBoundary(nonDeferredInput),
    (error: unknown) => {
      assert(error instanceof RunnerError, "Must be a RunnerError");
      assert.equal(error.code, "PREPARATION", "Must throw PREPARATION when defer is disabled");
      assert.match(error.message, /cannot pay fixed\/memory\/growth costs/);
      assert.match(error.message, /H=2928/);
      assert.match(error.message, /F=1854/);
      assert.match(error.message, /memoryLimit=107/);
      assert.match(error.message, /growth=1024/);
      assert.match(error.message, /requestedK=2019/);
      return true;
    }
  );

  // 3. Causal progress: context tokens grow to 6000 (H = 5999 >= 5004).
  // Legal calibration succeeds and returns valid PreparedBoundary!
  const progressInput = {
    ...deferredInput,
    trigger: { ...deferredInput.trigger, contextTokens: 6000 },
  };

  const prepared = await prepareBoundary(progressInput);
  assert(prepared.calibration, "Calibration must be established");
  assert.equal(prepared.calibration.firstKeptEntryId, "entry-call");
  assert.equal(prepared.calibration.accounting.keptTokens, 2019, "Requested K must be exactly 2019");
  assert.equal(prepared.calibration.accounting.fixedTokens, 1854, "Fixed tokens must be 1854");
  assert.equal(prepared.calibration.accounting.growthReserve, 1024, "Growth reserve must be 1024");
  assert.equal(prepared.calibration.accounting.effectiveTrigger, 5999, "Effective trigger must be 5999");
  assert(prepared.calibration.selectedFraction >= baseConfig.retentionCalibration.minFraction);
  assert(prepared.calibration.selectedFraction <= baseConfig.retentionCalibration.maxFraction);
  assert.equal(prepared.config.compaction.enabled, true);
  assert.equal(prepared.firstKeptEntryId, "entry-call");
});

test("contract errors never defer: invalid config, corrupted turn mapping, placement conflict, or extraction overflow hard fail", async () => {
  const provider = fauxProvider({ provider: "nunc-test", models: [{ id: "luna", contextWindow: 60000, maxTokens: 4096 }] });
  const model = provider.getModel();
  const { branch, requestText, fixtureContent, extraMainInputTokens } = createExactFixtureEntries();
  const active = buildContextEntries(branch);

  const validControl = {
    duringTurn: "a",
    action: "rollover_at_tool_boundary" as const,
    trigger: {
      occurrence: 1,
      pathArgument: "TASK.md",
      toolName: "read",
      when: "after_result_before_continuation" as const,
    },
    placement: {
      retireRequestOfTurn: "a",
      retainToolExchange: {
        occurrence: 1,
        pathArgument: "TASK.md",
        toolName: "read",
        turn: "a",
      },
    },
  };

  const baseConfig = {
    compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 },
    nunc: {
      memory: { fraction: 0.1, maxTokens: 1200 },
      growthTokens: 1024,
      budget: { extraMainInputTokens },
      extraction: { outputTokens: 2048 },
    },
    retentionCalibration: { minFraction: 0.0001, maxFraction: 0.9999 },
  };

  const makeInput = (overrides: Record<string, any> = {}) => ({
    branch,
    active,
    control: validControl,
    turns: { a: ["entry-req", "entry-call", "entry-result"] },
    turnOrder: ["a"],
    config: baseConfig,
    model,
    fixed: { systemPrompt: "Work on task.", tools: [] },
    repository,
    signal: new AbortController().signal,
    trigger: {
      callId: "call-task",
      requestText,
      path: "TASK.md",
      cwd: "/task",
      fixtureContent,
      contextTokens: 6000,
      allowDeferred: true,
    },
    allowDeferred: true,
    ...overrides,
  });

  // A. Corrupted turn mapping (missing turn 'b' declared in retainTurns)
  const missingTurnControl = {
    ...validControl,
    placement: {
      ...validControl.placement,
      retainTurns: ["b"],
    },
  };
  await assert.rejects(
    async () => prepareBoundary(makeInput({ control: missingTurnControl, turnOrder: ["a", "b"] })),
    (error: unknown) => {
      assert(error instanceof RunnerError, "Must be RunnerError");
      assert.equal(error.code, "CALIBRATION", "Missing turn mapping must fail CALIBRATION, not defer");
      assert.match(error.message, /Missing delivered turn b/);
      return true;
    }
  );

  // B. Placement conflict: retain entry conflicts with retirement
  const conflictControl = {
    ...validControl,
    placement: {
      ...validControl.placement,
      retireThroughTurn: "a",
      retainTurns: ["a"],
    },
  };
  await assert.rejects(
    async () => prepareBoundary(makeInput({ control: conflictControl })),
    (error: unknown) => {
      assert(error instanceof RunnerError, "Must be RunnerError");
      assert.equal(error.code, "CALIBRATION", "Placement conflict must fail CALIBRATION, not defer");
      assert.match(error.message, /No native legal cut|conflicts with retirement/);
      return true;
    }
  );

  // C. Invalid authorized fraction range
  const badRangeConfig = {
    ...baseConfig,
    retentionCalibration: { minFraction: 0.9, maxFraction: 0.1 },
  };
  await assert.rejects(
    async () => prepareBoundary(makeInput({ config: badRangeConfig })),
    (error: unknown) => {
      assert(error instanceof RunnerError, "Must be RunnerError");
      assert.equal(error.code, "CALIBRATION", "Invalid range must fail CALIBRATION, not defer");
      assert.match(error.message, /Invalid authorized fraction range/);
      return true;
    }
  );

  // D. Target cut not found in legal cuts (e.g. invalid toolIndex / requestText mismatch)
  const wrongTriggerInput = makeInput({
    trigger: {
      ...makeInput().trigger,
      requestText: "Non-matching user prompt",
    },
  });
  await assert.rejects(
    async () => prepareBoundary(wrongTriggerInput),
    (error: unknown) => {
      assert(error instanceof RunnerError, "Must be RunnerError");
      assert.equal(error.code, "PREPARATION", "Mismatched request text must fail PREPARATION, not defer");
      assert.match(error.message, /Matching request/);
      return true;
    }
  );
});

test("metricsCommand recognizes minimal necessary invocation forms and rejects unauthorized commands", () => {
  // 1. Build invocations
  assert.equal(metricsCommand("python3 build.py"), "build");
  assert.equal(metricsCommand("python build.py"), "build");
  assert.equal(metricsCommand("/usr/bin/python3 build.py"), "build");
  assert.equal(metricsCommand("python3 ./build.py"), "build");
  assert.equal(metricsCommand("python3 -m py_compile solution.py"), "build");
  assert.equal(metricsCommand("python3 -m py_compile ./solution.py"), "build");
  assert.equal(metricsCommand("/usr/bin/python3 -m py_compile solution.py"), "build");

  // 2. Test invocations
  assert.equal(metricsCommand("python3 -m unittest test_solution.py"), "tests");
  assert.equal(metricsCommand("python3 -m unittest -v test_solution.py"), "tests");
  assert.equal(metricsCommand("python3 -m unittest test_solution.py -v"), "tests");
  assert.equal(metricsCommand("python3 -m unittest test_solution"), "tests");
  assert.equal(metricsCommand("python3 -m unittest -v test_solution"), "tests");
  assert.equal(metricsCommand("python3 -m unittest test_solution -v"), "tests");
  assert.equal(metricsCommand("python3 -m unittest"), "tests");
  assert.equal(metricsCommand("python3 -m unittest -v"), "tests");
  assert.equal(metricsCommand("python3 -m unittest discover"), "tests");
  assert.equal(metricsCommand("python3 -m unittest discover -v"), "tests");
  assert.equal(metricsCommand("python3 test_solution.py"), "tests");
  assert.equal(metricsCommand("python3 ./test_solution.py"), "tests");
  assert.equal(metricsCommand("python3 test_solution.py -v"), "tests");

  // 3. Solution invocations
  assert.equal(metricsCommand("python3 solution.py"), "solution");
  assert.equal(metricsCommand("python3 ./solution.py"), "solution");
  assert.equal(metricsCommand("python3 solution.py <<'JSON'\n{\"op\":\"single\",\"record\":{\"gross\":10,\"refunds\":2}}\nJSON"), "solution");
  assert.equal(metricsCommand("python3 solution.py <<\"JSON\"\n{\"op\":\"single\",\"record\":{\"gross\":10,\"refunds\":2}}\nJSON"), "solution");
  assert.equal(metricsCommand("python3 solution.py <<JSON\n{\"op\":\"single\",\"record\":{\"gross\":10,\"refunds\":2}}\nJSON"), "solution");

  // 4. Unauthorized commands are rejected (no arbitrary shell expansion, no unauthorized tools)
  assert.equal(metricsCommand("find . -maxdepth 2 -type f -print"), undefined);
  assert.equal(metricsCommand("ls -la"), undefined);
  assert.equal(metricsCommand("cat solution.py"), undefined);
  assert.equal(metricsCommand("python3 verify.py"), undefined);
  assert.equal(metricsCommand("python3 build.py && python3 -m unittest test_solution.py"), undefined);
  assert.equal(metricsCommand("python3 -m unittest test_solution.py; ls"), undefined);
  assert.equal(metricsCommand("python3 solution.py | grep net"), undefined);
  assert.equal(metricsCommand("python3 -c \"print('hack')\""), undefined);
});

test("toolBlockReason produces truthful scenario-specific diagnostics and never misleads task retention with verify.py", () => {
  const err = new RunnerError("TOOL_COMMAND", "Command blocked");

  // A. Task retention scenario (g4)
  const taskReason = toolBlockReason(err, false, { isTaskRetention: true, hasVerification: false });
  assert.equal(taskReason.includes("verify.py"), false, "Must NOT mention verify.py in task retention");
  assert(taskReason.includes("build.py"), "Must mention build.py in task retention diagnostic");
  assert(taskReason.includes("unittest"), "Must mention unittest in task retention diagnostic");
  assert(taskReason.includes("solution.py"), "Must mention solution.py in task retention diagnostic");
  assert.match(taskReason, /^Tool kind or command is outside authorization/);

  // B. Legacy scenario with verification script
  const legacyReason = toolBlockReason(err, false, { isTaskRetention: false, hasVerification: true });
  assert(legacyReason.includes("python3 verify.py"), "Must mention verify.py in legacy scenario");
  assert.match(legacyReason, /^Tool kind or command is outside authorization/);

  // C. Tool-only scenario without verification or task retention
  const toolsOnlyReason = toolBlockReason(err, false, { isTaskRetention: false, hasVerification: false });
  assert.equal(toolsOnlyReason.includes("verify.py"), false);
  assert.match(toolsOnlyReason, /only scenario-local read\/write\/edit tools are permitted/);
});
