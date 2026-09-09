import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { estimateTokens, findCutPoint, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Context } from "@earendil-works/pi-ai";
import { requireValue, type RunConfig } from "./contract.js";
import type { Control } from "./scenarios.js";
import { calibrateRetention } from "./calibration.js";

export interface PreparedBoundary {
  firstKeptEntryId: string;
  config: RunConfig;
  native: { keepRecentTokens: number; cut: ReturnType<typeof findCutPoint>; contextTokens: number | null; trigger: number; contextTokensSource: "public turn_end getContextUsage().tokens" | "not a threshold observation" };
  calibration?: ReturnType<typeof calibrateRetention>;
  matching?: { referenceSnapshot: string; requestedMemoryLimit: number | null; requestedOutputCap: number | null; limitations: string[] };
}
export interface MatchReference { snapshotId: string; mTokens: number | null; outputCaps: Array<number | null> }

/** Pure selection on actual persisted entries. Pi reselects the boundary after public reload. */
export async function prepareBoundary(input: {
  branch: SessionEntry[]; active: SessionEntry[]; control: Control; turns: Record<string, string[]>; turnOrder: string[];
  config: RunConfig; model: Model<Api>; fixed: { systemPrompt: string; tools: NonNullable<Context["tools"]> }; repository?: string;
  signal: AbortSignal; trigger?: { callId: string; requestText: string; path: string; cwd: string; fixtureContent: string; contextTokens: number | null };
  matched?: boolean; reference?: MatchReference;
}): Promise<PreparedBoundary> {
  const { branch, control, turns, model } = input;
  const config = structuredClone(input.config), placement = control.placement!;
  const previous = branch.findLast(e => e.type === "compaction");
  const start = previous?.type === "compaction" ? Math.max(0, branch.findIndex(e => e.id === previous.firstKeptEntryId)) : 0;
  const retired = new Set<string>(), retained = new Set<string>();
  const mapped = (turn: string) => { const ids = turns[turn]; requireValue(ids?.length, "CALIBRATION", `Missing delivered turn ${turn}`); return ids; };
  if (placement.retireThroughTurn) for (const turn of input.turnOrder.slice(0, input.turnOrder.indexOf(placement.retireThroughTurn) + 1)) mapped(turn).forEach(id => retired.add(id));
  for (const turn of placement.retainTurns ?? []) mapped(turn).forEach(id => retained.add(id));
  if (placement.retireEvidenceFromTurn) for (const e of branch) if (mapped(placement.retireEvidenceFromTurn).includes(e.id) && e.type === "message" && e.message.role === "toolResult") retired.add(e.id);
  let toolIndex: number | undefined;
  if (input.trigger) {
    const t = input.trigger;
    const req = branch.findLast(e => e.type === "message" && e.message.role === "user" && (typeof e.message.content === "string" ? e.message.content : e.message.content.filter(b => b.type === "text").map(b => b.text).join("")) === t.requestText);
    toolIndex = branch.findIndex(e => e.type === "message" && e.message.role === "assistant" && e.message.content.some(b => b.type === "toolCall" && b.id === t.callId && b.name === "read" && typeof b.arguments.path === "string" && resolve(t.cwd, b.arguments.path) === resolve(t.cwd, t.path)));
    requireValue(req && toolIndex > branch.indexOf(req), "PREPARATION", "Matching request/calling assistant not present");
    retired.add(req.id);
    const call = branch[toolIndex]!;
    const siblings = call.type === "message" && call.message.role === "assistant" ? call.message.content.filter(b => b.type === "toolCall") : [];
    const tail = branch.slice(toolIndex + 1).filter(e => sessionEntryToContextMessages(e).length > 0);
    requireValue(tail.every(e => e.type === "message" && e.message.role === "toolResult"), "PREPARATION", "Assistant suffix already ran after the requested tool batch");
    const results = tail;
    requireValue(siblings.length > 0 && new Set(siblings.map(c => c.id)).size === siblings.length && results.length === siblings.length && siblings.every(c => results.filter(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === c.id && e.message.toolName === c.name).length === 1), "PREPARATION", "Incomplete persisted sibling tool batch");
    const result = results.find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === t.callId);
    requireValue(result?.type === "message" && result.message.role === "toolResult" && !result.message.isError && result.message.content.filter(b => b.type === "text").map(b => b.text).join("").trim() === t.fixtureContent.trim(), "PREPARATION", "Required read was unsuccessful or incomplete");
    [call, ...results].forEach(e => retained.add(e.id));
    requireValue(t.contextTokens !== null && Number.isFinite(t.contextTokens), "PREPARATION", "Native threshold usage is unknown");
    const h = Math.min(model.contextWindow - config.compaction.reserveTokens, Math.ceil(t.contextTokens) - 1);
    requireValue(h > 0, "PREPARATION", "Native context cannot cross a positive threshold");
    config.compaction = { ...config.compaction, enabled: true, reserveTokens: model.contextWindow - h };
  }
  let chosen: { keep: number; cut: ReturnType<typeof findCutPoint> } | undefined;
  for (let i = start; i < branch.length; i++) {
    if (toolIndex !== undefined && i !== toolIndex) continue;
    const keep = branch.slice(i).reduce((sum, e) => sum + sessionEntryToContextMessages(e).reduce((s, m) => s + estimateTokens(m), 0), 0);
    if (keep <= 0 || keep >= model.contextWindow - config.compaction.reserveTokens) continue;
    const cut = findCutPoint(branch, start, branch.length, keep);
    if (toolIndex !== undefined && cut.firstKeptEntryIndex !== toolIndex) continue;
    if (cut.firstKeptEntryIndex <= start) continue;
    if (branch.slice(cut.firstKeptEntryIndex).some(e => retired.has(e.id)) || branch.slice(0, cut.firstKeptEntryIndex).some(e => retained.has(e.id))) continue;
    chosen = { keep, cut }; break;
  }
  requireValue(chosen, "CALIBRATION", "No native legal cut retains the complete requested suffix and retires its source");
  config.compaction.keepRecentTokens = chosen.keep;
  const firstKeptEntryId = branch[chosen.cut.firstKeptEntryIndex]!.id;
  const prepared: PreparedBoundary = { firstKeptEntryId, config, native: { keepRecentTokens: chosen.keep, cut: chosen.cut, contextTokens: input.trigger?.contextTokens ?? null, trigger: model.contextWindow - config.compaction.reserveTokens, contextTokensSource: input.trigger ? "public turn_end getContextUsage().tokens" : "not a threshold observation" } };
  if (input.repository) {
    // Arithmetic comes from the actually loaded product target, including its policy and wire contract.
    const load = (file: string) => import(pathToFileURL(join(input.repository!, `dist/src/${file}.js`)).href);
    const [pi, accounting, request, validation, engine, memory] = await Promise.all([load("pi/index"), load("engine/accounting"), load("engine/request"), load("engine/validation"), load("engine/index"), load("engine/memory")]);
    if (input.matched) {
      const ref = input.reference;
      const caps = ref?.outputCaps;
      const cap = caps?.length === 1 ? caps[0]! : null;
      const limit = ref?.mTokens === null || ref?.mTokens === undefined ? null : ref.mTokens - accounting.messageTokens(memory.memoryMessage([]));
      const limitations = ["Native summary has no enforced rendered-memory limit; matching its realized envelope cannot prove equal memory constraints."];
      if (cap === null) limitations.push("Native output is uncapped, missing, or split across calls; no single enforced output cap can be matched.");
      if (limit !== null && limit > 0) {
        const ec = pi.engineConfig(config.nunc, model, config.compaction);
        const available = Math.min(ec.triggerTokens, accounting.inputLimit(model, ec.main)) - accounting.requestTokens(accounting.mainContext(input.fixed, [], []), ec.imageTokens) - ec.main.extraInputTokens;
        requireValue(limit + 1 < available, "CALIBRATION", `Native realized memory ${limit} cannot fit available Nunc space ${available}`);
        config.nunc.memory = { fraction: (limit + 0.5) / available, maxTokens: limit };
      } else limitations.push("Native realized summary memory is unobserved.");
      if (cap !== null && cap > 0 && cap <= model.maxTokens) config.nunc.extraction = { ...config.nunc.extraction, outputTokens: cap };
      prepared.matching = { referenceSnapshot: ref?.snapshotId ?? "unobserved", requestedMemoryLimit: limit, requestedOutputCap: cap, limitations };
    }
    const projected = pi.project(input.active);
    const source = { binding: { sessionId: "observer-arithmetic", leafId: branch.at(-1)!.id, generation: "prepared" }, model,
      fixed: input.fixed, memory: projected.memory, active: projected.active,
      eligibleKeptEntryIds: pi.eligibleStarts(branch, projected.active, projected.latestId),
      config: pi.engineConfig(config.nunc, model, config.compaction), policy: await engine.loadPolicy({ ...config.nunc, configFile: join(input.repository, "nunc-config.json") }), signal: input.signal };
    prepared.calibration = calibrateRetention(source, control, turns, input.turnOrder,
      input.config.retentionCalibration ?? { minFraction: Number.EPSILON, maxFraction: 1 - Number.EPSILON },
      { firstKeptEntryId, accounting, request, validation });
    config.nunc.rolling = { ...config.nunc.rolling, keepRecentFraction: prepared.calibration.selectedFraction };
  }
  return prepared;
}
