import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface RecordTriple {
  gross: number | null;
  refunds: number | null;
  cost: number | null;
}

export interface MetricResult {
  net: number | null;
  margin: number | null;
}

export const HELD_OUT_RECORDS: readonly RecordTriple[] = [
  { gross: 23, refunds: 5, cost: 7 },
  { gross: 0, refunds: 0, cost: 0 },
  { gross: -4, refunds: 2, cost: 3 },
  { gross: null, refunds: 2, cost: 3 },
  { gross: 8, refunds: null, cost: 2 },
  { gross: 8, refunds: 3, cost: null },
] as const;

export function calculateMetric(record: RecordTriple): MetricResult {
  const { gross, refunds, cost } = record;
  const net = gross === null || refunds === null ? null : gross - refunds;
  const margin = net === null || cost === null ? null : net - cost;
  return { net, margin };
}

export const EXPECTED_HELD_OUT_RESULTS: readonly MetricResult[] = HELD_OUT_RECORDS.map(calculateMetric);

export const EXPECTED_GRAPH_NODES = new Set(["gross", "refunds", "cost", "net", "margin"]);
export const EXPECTED_GRAPH_EDGES: readonly [string, string][] = [
  ["gross", "net"],
  ["refunds", "net"],
  ["net", "margin"],
  ["cost", "margin"],
];

export interface MetricsOracleReport {
  status: "PROVEN" | "DISPROVEN" | "UNPROVEN";
  reason?: string;
  observed?: Record<string, unknown>;
  operations?: Array<{ op: string; passed: boolean; error?: string }>;
}

function runSolutionSubprocess(cwd: string, requestPayload: unknown): { status: number; stdout: unknown; error?: string } {
  const solutionPath = join(cwd, "solution.py");
  if (!existsSync(solutionPath)) {
    return { status: 1, stdout: null, error: "solution.py does not exist in workspace" };
  }
  const proc = spawnSync("python3", ["solution.py"], {
    cwd,
    input: JSON.stringify(requestPayload) + "\n",
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
  });
  if (proc.error) {
    return { status: 1, stdout: null, error: `Subprocess execution error: ${proc.error.message}` };
  }
  if (proc.status !== 0) {
    return { status: proc.status ?? 1, stdout: null, error: `solution.py exited with code ${proc.status}: ${proc.stderr?.slice(0, 500)}` };
  }
  try {
    const parsed = JSON.parse(proc.stdout.trim());
    return { status: 0, stdout: parsed };
  } catch {
    return { status: 1, stdout: proc.stdout, error: `solution.py stdout was not valid JSON: ${proc.stdout?.slice(0, 500)}` };
  }
}

function compareEdges(actualEdges: unknown, expectedEdges: readonly [string, string][]): boolean {
  if (!Array.isArray(actualEdges)) return false;
  if (actualEdges.length !== expectedEdges.length) return false;
  const normalizeEdge = (e: unknown) => (Array.isArray(e) && e.length === 2 && e.every(v => typeof v === "string") ? JSON.stringify(e) : "");
  const actualSet = new Set(actualEdges.map(normalizeEdge));
  if (actualSet.size !== expectedEdges.length) return false; // Duplicate edges rejected
  const expectedSet = new Set(expectedEdges.map(e => JSON.stringify(e)));
  return isDeepStrictEqual(actualSet, expectedSet);
}

function compareNodes(actualNodes: unknown, expectedNodes: Set<string>): boolean {
  if (!Array.isArray(actualNodes)) return false;
  const actualSet = new Set(actualNodes);
  if (actualSet.size !== actualNodes.length) return false; // Duplicate nodes rejected
  return isDeepStrictEqual(actualSet, expectedNodes);
}

export function executeMetricsOracle(cwd: string, fixtures?: Record<string, string>): MetricsOracleReport {
  const operations: Array<{ op: string; passed: boolean; error?: string }> = [];
  const frozen = new Map<string, string>();
  for (const name of [...Object.keys(fixtures ?? {}), "solution.py", "test_solution.py"]) {
    if (existsSync(join(cwd, name))) frozen.set(name, readFileSync(join(cwd, name), "utf8"));
  }
  const mismatch = Object.entries(fixtures ?? {}).find(([name, expected]) => frozen.get(name) !== expected);
  if (mismatch) return { status: "DISPROVEN", reason: `Frozen task fixture changed or missing: ${mismatch[0]}`, operations };

  // 1. Fixture file integrity checks
  const solutionPath = join(cwd, "solution.py");
  if (!existsSync(solutionPath)) {
    return { status: "DISPROVEN", reason: "solution.py does not exist", operations };
  }
  const buildPath = join(cwd, "build.py");
  if (!existsSync(buildPath)) {
    return { status: "DISPROVEN", reason: "build.py is missing from task directory", operations };
  }
  const recordsPath = join(cwd, "records.json");
  if (!existsSync(recordsPath)) {
    return { status: "DISPROVEN", reason: "records.json was deleted", operations };
  }

  // 2. Build verification: python3 build.py
  const buildProc = spawnSync("python3", ["build.py"], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
  });
  if (buildProc.status !== 0) {
    const error = `python3 build.py failed with exit code ${buildProc.status}: ${buildProc.stderr?.slice(0, 500)}`;
    operations.push({ op: "build.py", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "build.py", passed: true });

  // 3. Candidate unittests: python3 -m unittest test_solution.py (if provided)
  const testSolutionPath = join(cwd, "test_solution.py");
  let testSuiteChecked = false;
  if (existsSync(testSolutionPath)) {
    const unittestProc = spawnSync("python3", ["-m", "unittest", "test_solution.py"], {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
    });
    if (unittestProc.status !== 0) {
      const error = `python3 -m unittest test_solution.py failed: ${unittestProc.stderr?.slice(0, 500)}`;
      operations.push({ op: "test_solution.py", passed: false, error });
      return { status: "DISPROVEN", reason: error, operations };
    }
    // Execution is observed; the tests' semantic adequacy needs independent review.
    testSuiteChecked = true;
    operations.push({ op: "test_solution.py", passed: true });
  } else return { status: "DISPROVEN", reason: "Required test_solution.py is missing", operations };

  // 4. Held-out single records evaluation
  for (let i = 0; i < HELD_OUT_RECORDS.length; i++) {
    const record = HELD_OUT_RECORDS[i]!;
    const expected = EXPECTED_HELD_OUT_RESULTS[i]!;
    const res = runSolutionSubprocess(cwd, { op: "single", record });
    if (res.status !== 0 || !res.stdout || typeof res.stdout !== "object") {
      const error = `op: single for record ${i} (${JSON.stringify(record)}) failed: ${res.error ?? "invalid response"}`;
      operations.push({ op: `single_${i}`, passed: false, error });
      return { status: "DISPROVEN", reason: error, operations };
    }
    const actual = res.stdout as Record<string, unknown>;
    if (actual.net !== expected.net || actual.margin !== expected.margin) {
      const error = `op: single for record ${i} (${JSON.stringify(record)}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
      operations.push({ op: `single_${i}`, passed: false, error });
      return { status: "DISPROVEN", reason: error, operations };
    }
    operations.push({ op: `single_${i}`, passed: true });
  }

  // 5. Held-out batch evaluation (ordered array + empty array)
  const batchRes = runSolutionSubprocess(cwd, { op: "batch", records: HELD_OUT_RECORDS });
  if (batchRes.status !== 0 || !Array.isArray(batchRes.stdout)) {
    const error = `op: batch for held-out records failed: ${batchRes.error ?? "did not return array"}`;
    operations.push({ op: "batch", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  if (!isDeepStrictEqual(batchRes.stdout, EXPECTED_HELD_OUT_RESULTS)) {
    const error = `op: batch result order or values differed from expected: got ${JSON.stringify(batchRes.stdout)}, expected ${JSON.stringify(EXPECTED_HELD_OUT_RESULTS)}`;
    operations.push({ op: "batch", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "batch", passed: true });

  const emptyBatchRes = runSolutionSubprocess(cwd, { op: "batch", records: [] });
  if (emptyBatchRes.status !== 0 || !Array.isArray(emptyBatchRes.stdout) || emptyBatchRes.stdout.length !== 0) {
    const error = `op: batch for empty records array must return empty array, got: ${JSON.stringify(emptyBatchRes.stdout)}`;
    operations.push({ op: "batch_empty", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "batch_empty", passed: true });

  // 6. Held-out history evaluation (north first 2, south next 2, west last 2)
  const historySeries = {
    north: HELD_OUT_RECORDS.slice(0, 2),
    south: HELD_OUT_RECORDS.slice(2, 4),
    west: HELD_OUT_RECORDS.slice(4, 6),
  };
  const historyRes = runSolutionSubprocess(cwd, { op: "history", series: historySeries });
  if (historyRes.status !== 0 || !historyRes.stdout || typeof historyRes.stdout !== "object") {
    const error = `op: history failed: ${historyRes.error ?? "did not return object"}`;
    operations.push({ op: "history", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const hist = historyRes.stdout as Record<string, unknown>;
  for (const region of ["north", "south", "west"] as const) {
    if (!Array.isArray(hist[region])) {
      const error = `op: history missing or invalid series key "${region}"`;
      operations.push({ op: "history", passed: false, error });
      return { status: "DISPROVEN", reason: error, operations };
    }
  }
  if (!isDeepStrictEqual(Object.keys(hist).sort(), ["north", "south", "west"]) || !isDeepStrictEqual(hist.north, EXPECTED_HELD_OUT_RESULTS.slice(0, 2)) ||
      !isDeepStrictEqual(hist.south, EXPECTED_HELD_OUT_RESULTS.slice(2, 4)) ||
      !isDeepStrictEqual(hist.west, EXPECTED_HELD_OUT_RESULTS.slice(4, 6))) {
    const error = "op: history results do not match expected series computations";
    operations.push({ op: "history", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "history", passed: true });

  // 7. Graph evaluation: nodes and edges sets
  const graphRes = runSolutionSubprocess(cwd, { op: "graph" });
  if (graphRes.status !== 0 || !graphRes.stdout || typeof graphRes.stdout !== "object") {
    const error = `op: graph failed: ${graphRes.error ?? "did not return object"}`;
    operations.push({ op: "graph", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const graphData = graphRes.stdout as Record<string, unknown>;
  if (!compareNodes(graphData.nodes, EXPECTED_GRAPH_NODES)) {
    const error = `op: graph nodes mismatch: expected {gross, refunds, cost, net, margin}, got ${JSON.stringify(graphData.nodes)}`;
    operations.push({ op: "graph", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  if (!compareEdges(graphData.edges, EXPECTED_GRAPH_EDGES)) {
    const error = `op: graph edges mismatch: expected directed {[gross,net], [refunds,net], [net,margin], [cost,margin]}, got ${JSON.stringify(graphData.edges)}`;
    operations.push({ op: "graph", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "graph", passed: true });

  // 8. Trace evaluation: margin and net for first record and last record
  // 8a. Trace margin (first record: gross=23, refunds=5, cost=7) -> all 5 nodes, 4 edges, full values
  const traceMarginFirst = runSolutionSubprocess(cwd, { op: "trace", metric: "margin", record: HELD_OUT_RECORDS[0] });
  if (traceMarginFirst.status !== 0 || !traceMarginFirst.stdout || typeof traceMarginFirst.stdout !== "object") {
    const error = `op: trace margin record 0 failed: ${traceMarginFirst.error}`;
    operations.push({ op: "trace_margin_0", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const tmf = traceMarginFirst.stdout as Record<string, unknown>;
  if (!compareNodes(tmf.nodes, EXPECTED_GRAPH_NODES) || !compareEdges(tmf.edges, EXPECTED_GRAPH_EDGES)) {
    const error = "op: trace margin record 0 must return the full recursive graph (all 5 nodes and 4 edges)";
    operations.push({ op: "trace_margin_0", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const expectedValuesMarginFirst = { gross: 23, refunds: 5, cost: 7, net: 18, margin: 11 };
  if (!isDeepStrictEqual(tmf.values, expectedValuesMarginFirst)) {
    const error = `op: trace margin record 0 values mismatch: got ${JSON.stringify(tmf.values)}, expected ${JSON.stringify(expectedValuesMarginFirst)}`;
    operations.push({ op: "trace_margin_0", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "trace_margin_0", passed: true });

  // 8b. Trace margin (last record: gross=8, refunds=3, cost=null) -> all 5 nodes, 4 edges, null margin
  const traceMarginLast = runSolutionSubprocess(cwd, { op: "trace", metric: "margin", record: HELD_OUT_RECORDS[5] });
  if (traceMarginLast.status !== 0 || !traceMarginLast.stdout || typeof traceMarginLast.stdout !== "object") {
    const error = `op: trace margin record 5 failed: ${traceMarginLast.error}`;
    operations.push({ op: "trace_margin_5", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const tml = traceMarginLast.stdout as Record<string, unknown>;
  if (!compareNodes(tml.nodes, EXPECTED_GRAPH_NODES) || !compareEdges(tml.edges, EXPECTED_GRAPH_EDGES)) {
    const error = "op: trace margin record 5 must return the full recursive graph (all 5 nodes and 4 edges)";
    operations.push({ op: "trace_margin_5", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const expectedValuesMarginLast = { gross: 8, refunds: 3, cost: null, net: 5, margin: null };
  if (!isDeepStrictEqual(tml.values, expectedValuesMarginLast)) {
    const error = `op: trace margin record 5 values mismatch: got ${JSON.stringify(tml.values)}, expected ${JSON.stringify(expectedValuesMarginLast)}`;
    operations.push({ op: "trace_margin_5", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "trace_margin_5", passed: true });

  // 8c. Trace net (first record: gross=23, refunds=5, cost=7) -> exactly {gross, refunds, net}, 2 edges, excludes cost and margin!
  const expectedNetNodes = new Set(["gross", "refunds", "net"]);
  const expectedNetEdges: readonly [string, string][] = [
    ["gross", "net"],
    ["refunds", "net"],
  ];
  const traceNetFirst = runSolutionSubprocess(cwd, { op: "trace", metric: "net", record: HELD_OUT_RECORDS[0] });
  if (traceNetFirst.status !== 0 || !traceNetFirst.stdout || typeof traceNetFirst.stdout !== "object") {
    const error = `op: trace net record 0 failed: ${traceNetFirst.error}`;
    operations.push({ op: "trace_net_0", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const tnf = traceNetFirst.stdout as Record<string, unknown>;
  if (!compareNodes(tnf.nodes, expectedNetNodes)) {
    const error = `op: trace net record 0 nodes mismatch: must exclude cost and margin; got ${JSON.stringify(tnf.nodes)}`;
    operations.push({ op: "trace_net_0", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  if (!compareEdges(tnf.edges, expectedNetEdges)) {
    const error = `op: trace net record 0 edges mismatch: must exclude cost and margin edges; got ${JSON.stringify(tnf.edges)}`;
    operations.push({ op: "trace_net_0", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const expectedValuesNetFirst = { gross: 23, refunds: 5, net: 18 };
  if (!isDeepStrictEqual(tnf.values, expectedValuesNetFirst)) {
    const error = `op: trace net record 0 values mismatch: got ${JSON.stringify(tnf.values)}, expected ${JSON.stringify(expectedValuesNetFirst)}`;
    operations.push({ op: "trace_net_0", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "trace_net_0", passed: true });

  // 8d. Trace net (last record: gross=8, refunds=3, cost=null) -> exactly {gross, refunds, net}, 2 edges, excludes cost and margin
  const traceNetLast = runSolutionSubprocess(cwd, { op: "trace", metric: "net", record: HELD_OUT_RECORDS[5] });
  if (traceNetLast.status !== 0 || !traceNetLast.stdout || typeof traceNetLast.stdout !== "object") {
    const error = `op: trace net record 5 failed: ${traceNetLast.error}`;
    operations.push({ op: "trace_net_5", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const tnl = traceNetLast.stdout as Record<string, unknown>;
  if (!compareNodes(tnl.nodes, expectedNetNodes) || !compareEdges(tnl.edges, expectedNetEdges)) {
    const error = `op: trace net record 5 must return exactly gross, refunds, net and exclude cost/margin; got nodes ${JSON.stringify(tnl.nodes)}`;
    operations.push({ op: "trace_net_5", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  const expectedValuesNetLast = { gross: 8, refunds: 3, net: 5 };
  if (!isDeepStrictEqual(tnl.values, expectedValuesNetLast)) {
    const error = `op: trace net record 5 values mismatch: got ${JSON.stringify(tnl.values)}, expected ${JSON.stringify(expectedValuesNetLast)}`;
    operations.push({ op: "trace_net_5", passed: false, error });
    return { status: "DISPROVEN", reason: error, operations };
  }
  operations.push({ op: "trace_net_5", passed: true });

  const mutated = [...frozen].find(([name, before]) => !existsSync(join(cwd, name)) || readFileSync(join(cwd, name), "utf8") !== before);
  if (mutated) return { status: "DISPROVEN", reason: `Oracle execution modified its input: ${mutated[0]}`, operations };
  return {
    status: fixtures ? "PROVEN" : "UNPROVEN",
    ...(fixtures ? {} : { reason: "Behavior checks passed; original fixture binding was not supplied" }),
    observed: {
      fixtureIntegrity: fixtures ? "PROVEN" : "UNPROVEN",
      candidateTestCoverage: "UNPROVEN", testSource: frozen.get("test_solution.py"),
      operationsEvaluated: operations.length,
      singleRecords: HELD_OUT_RECORDS.length,
      batch: true,
      batchEmpty: true,
      history: ["north", "south", "west"],
      graph: { nodeCount: EXPECTED_GRAPH_NODES.size, edgeCount: EXPECTED_GRAPH_EDGES.length },
      trace: { margin: true, netExcludesMarginAndCost: true },
      buildSuccess: true,
      unittestSuccess: testSuiteChecked,
    },
    operations,
  };
}
