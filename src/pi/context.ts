import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Accounting, ActiveEntry, EngineConfig, FixedContext, MaintenanceResult, Memory, Slot } from "../engine/index.js";
import { mainAdmissionLimit, memoryPlan, memoryTokens, omitsSerializedOutputCap, textTokens } from "../engine/accounting.js";
import { memoryMessage } from "../engine/memory.js";
import { readSourceRecords } from "../engine/request.js";
import { integer, record } from "../engine/validation.js";
import type { AdmissionLayoutEvent, AdmissionObservation } from "./admission.js";
import type { MemorySurface } from "./manual.js";
import type { PayloadObservation } from "./payload.js";
import { project } from "./projection.js";

export interface TokenCount { tokens: number | null; unknown: boolean }
export interface ContextBlock {
  type: "text" | "thinking" | "toolCall" | "image" | "unknown";
  tokens: number | null;
  unknown: boolean;
  preview: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
  toolCallId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  mimeType?: string;
}
export interface ContextMessage {
  order: number;
  role: string;
  tokens: number | null;
  unknown: boolean;
  preview: string;
  blocks: ContextBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}
export interface ContextEntry {
  entryId: string;
  sourceRole: string;
  messages: ContextMessage[];
}
export interface ToolAssociation { toolCallId: string; toolName: string; callOrder: number; resultOrder: number }
export interface ToolDefinitionView {
  name: string;
  description: string;
  parameters: unknown;
  tokens: number | null;
  unknown: boolean;
}
export interface ToolsLayer {
  count: number;
  names: string[];
  tokens: number | null;
  unknown: boolean;
  definitions: ToolDefinitionView[];
}
export interface ContextLayout {
  system: { text: string; tokens: number };
  tools: ToolsLayer;
  memory?: { slots: Slot[]; tokens: number; envelopeTokens: number };
  entries?: ContextEntry[];
  messages: ContextMessage[];
  messageCount: number;
  blockCount: number;
  packagingTokens: number;
  extraInputTokens: number;
  heuristic: TokenCount;
  associations: ToolAssociation[];
  unavailable?: true;
}
export interface ContextBudget {
  modelWindow: number | null;
  triggerTokens: number | null;
  plannedInputLimit: number | null;
  mainAdmissionLimit: number | null;
  memoryLimit: number | null;
  memoryOccupied: number | null;
  memoryUnknown: boolean;
  outputReserveTokens: number | null;
  outputCapTokens: number | null;
  outputCapKnown: boolean;
  extractionOutputTokens: number | null;
  extractionOutputCapTokens: number | null;
  safetyTokens: number | null;
}
export interface CurrentContext {
  scope: "current";
  sessionId: string;
  leafId: string | null;
  sessionFile?: string;
  model: { id: string; provider: string; api: string } | null;
  revision: string;
  occupied: boolean;
  unconfirmed: boolean;
  contextLayout: { slotCount: number; activeEntries: number; latestCompactionId?: string };
  layout: ContextLayout;
  budget: ContextBudget;
}
export interface LastMainPayload extends PayloadObservation {
  addedTokens?: number;
  addedText?: string;
  chargedGrowthTokens?: number;
  unallocatedOverheadTokens?: number;
  unmappedIncrement?: { tokens: number; unknown: true };
}
export interface LastMainContext {
  scope: "last-main";
  observedAt: number;
  sessionId: string;
  leafId: string | null;
  model: { id: string; provider: string; api: string };
  outcome: "delegate" | "reject";
  code?: string;
  estimator?: AdmissionObservation["estimator"];
  estimateReason?: AdmissionObservation["estimateReason"];
  hostPromptMatchesRequest?: boolean;
  anchorTrailingMessages?: number;
  inputTokens?: number;
  inputLimit?: number;
  plannedInputLimit?: number;
  inputExceededPlan?: boolean;
  outputTokens?: number;
  outputReserveTokens?: number;
  outputCapTokens?: number | null;
  initialMetadataTokens?: number;
  layout: ContextLayout;
  payload?: LastMainPayload;
}
export interface LastMaintenanceContext {
  scope: "last-maintenance";
  observedAt: number;
  sessionId: string;
  leafId: string | null;
  model: { id: string; provider: string; api: string };
  reason?: string;
  engine?: "ok" | "fail" | "cancel";
  native: "pending" | "saved" | "failed" | "none";
  invalidated?: true;
  before: {
    memory: Memory;
    entries: ContextEntry[];
    messages: ContextMessage[];
    system: { text: string; tokens: number };
    tools: ToolsLayer;
  };
  cut?: { firstKeptEntryId: string; retiredEntryIds: string[]; keptEntryIds: string[] };
  candidate?: { memory: Memory; firstKeptEntryId: string };
  after?: { memory: Memory; keptEntryIds: string[] };
  accounting?: Accounting;
  code?: string;
  message?: string;
}
export interface ContextView {
  current: CurrentContext;
  lastMain?: LastMainContext;
  lastMaintenance?: LastMaintenanceContext;
}
export interface ContextSurface {
  read(ctx: ExtensionContext): ContextView;
}
export interface ContextObserver extends ContextSurface {
  observeAdmission(event: AdmissionLayoutEvent): void;
  beginMaintenance(input: { ctx: ExtensionContext; model: Model<Api>; fixed: FixedContext; memory: Memory; active: ActiveEntry[]; reason: string; config?: EngineConfig }): void;
  noteEngine(result: MaintenanceResult): void;
  noteNative(status: "saved" | "failed"): void;
  noteInvalidated(): void;
  resetPath(): void;
}

const PREVIEW = 80;
export function createContextSurface(options: {
  pi: ExtensionAPI;
  memory: MemorySurface;
  fixed: (ctx: ExtensionContext) => FixedContext;
  config: (ctx: ExtensionContext, model: Model<Api>) => EngineConfig;
}): ContextObserver {
  const state: { lastMain?: LastMainContext; lastMaintenance?: LastMaintenanceContext; frozen?: FrozenMaintenance } = {};
  const surface: ContextObserver = {
    read(ctx) {
      const memory = options.memory.read(ctx);
      const projected = project(ctx.sessionManager.buildContextEntries());
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      const file = ctx.sessionManager.getSessionFile();
      const model = ctx.model ? identity(ctx.model) : null;
      let imageTokens: number | undefined;
      let extraInputTokens = 0;
      let budget = unknownBudget(memory.budget.tokens, memory.budget.unknown);
      if (ctx.model) {
        try {
          const config = options.config(ctx, ctx.model);
          imageTokens = config.imageTokens;
          extraInputTokens = config.main.extraInputTokens;
          budget = measureBudget(ctx.model, config, options.fixed(ctx), memory.budget.tokens, memory.budget.unknown);
        } catch {
          budget = unknownBudget(memory.budget.tokens, true);
        }
      }
      const layout = layoutFromProjection(options.fixed(ctx), memory.memory, projected.active, imageTokens, extraInputTokens);
      const current: CurrentContext = {
        scope: "current",
        sessionId,
        leafId,
        ...(file ? { sessionFile: file } : {}),
        model,
        revision: memory.revision,
        occupied: memory.status.occupied,
        unconfirmed: memory.status.unconfirmed,
        contextLayout: memory.contextLayout,
        layout,
        budget,
      };
      return {
        current,
        ...(applicable(state.lastMain, ctx) ? { lastMain: structuredClone(state.lastMain) } : {}),
        ...(applicable(state.lastMaintenance, ctx) ? { lastMaintenance: structuredClone(state.lastMaintenance) } : {}),
      };
    },
    observeAdmission(event) {
      try {
        if (event.observation.kind === "maintenance") {
          captureSentCut(state.lastMaintenance, event.context);
          return;
        }
        if (event.observation.kind !== "main") return;
        const observation = event.observation;
        const recorded: LastMainContext = {
          scope: "last-main",
          observedAt: Date.now(),
          sessionId: event.ctx.sessionManager.getSessionId(),
          leafId: event.ctx.sessionManager.getLeafId(),
          model: identity(event.model),
          outcome: observation.outcome,
          layout: unavailableLayout(),
          ...(observation.code ? { code: observation.code } : {}),
          ...(observation.estimator ? { estimator: observation.estimator } : {}),
          ...(observation.estimateReason ? { estimateReason: observation.estimateReason } : {}),
          ...(observation.hostPromptMatchesRequest === undefined ? {} : { hostPromptMatchesRequest: observation.hostPromptMatchesRequest }),
          ...(observation.anchorTrailingMessages === undefined ? {} : { anchorTrailingMessages: observation.anchorTrailingMessages }),
          ...(observation.inputTokens === undefined ? {} : { inputTokens: observation.inputTokens }),
          ...(observation.inputLimit === undefined ? {} : { inputLimit: observation.inputLimit }),
          ...(observation.plannedInputLimit === undefined ? {} : { plannedInputLimit: observation.plannedInputLimit }),
          ...(observation.inputExceededPlan === undefined ? {} : { inputExceededPlan: observation.inputExceededPlan }),
          ...(observation.outputTokens === undefined ? {} : { outputTokens: observation.outputTokens }),
          ...(observation.outputReserveTokens === undefined ? {} : { outputReserveTokens: observation.outputReserveTokens }),
          ...(observation.outputCapTokens === undefined ? {} : { outputCapTokens: observation.outputCapTokens }),
          ...(event.initialMetadataTokens === undefined ? {} : { initialMetadataTokens: event.initialMetadataTokens }),
        };
        state.lastMain = recorded;
        try {
          const config = readConfig(options, event.ctx, event.model);
          recorded.layout = layoutFromContext(event.context, config?.imageTokens, config?.main.extraInputTokens ?? 0);
          const payload = payloadView(observation.payload, event.payloadGrowth);
          if (payload) recorded.payload = payload;
        } catch {
          recorded.layout = unavailableLayout();
        }
      } catch { /* Read-only; never change admission. */ }
    },
    beginMaintenance(input) {
      try {
        const imageTokens = input.config?.imageTokens;
        const inspected = inspectEntries(input.active, imageTokens);
        const fixed = structuredClone(input.fixed);
        state.frozen = {
          sessionId: input.ctx.sessionManager.getSessionId(),
          leafId: input.ctx.sessionManager.getLeafId(),
          model: identity(input.model),
          observedAt: Date.now(),
          reason: input.reason,
          fixed,
          memory: structuredClone(input.memory),
          active: structuredClone(input.active),
          ...(imageTokens === undefined ? {} : { imageTokens }),
        };
        state.lastMaintenance = {
          scope: "last-maintenance",
          observedAt: state.frozen.observedAt,
          sessionId: state.frozen.sessionId,
          leafId: state.frozen.leafId,
          model: state.frozen.model,
          reason: input.reason,
          native: "pending",
          before: {
            memory: state.frozen.memory,
            entries: inspected.entries,
            messages: inspected.messages,
            system: { text: fixed.systemPrompt, tokens: textTokens(fixed.systemPrompt) },
            tools: toolLayer(fixed.tools),
          },
        };
      } catch { /* Freeze observation is best-effort. */ }
    },
    noteEngine(result) {
      const current = state.lastMaintenance;
      const frozen = state.frozen;
      if (!current || !frozen || current.native !== "pending") return;
      try {
        if (result.observations.accounting) current.accounting = structuredClone(result.observations.accounting);
        if (result.ok) {
          current.engine = "ok";
          if (!current.cut) {
            current.cut = {
              firstKeptEntryId: result.candidate.firstKeptEntryId,
              retiredEntryIds: [...result.candidate.retiredEntryIds],
              keptEntryIds: result.candidate.kept.map(entry => entry.entryId),
            };
          }
          current.candidate = { memory: structuredClone(result.candidate.memory), firstKeptEntryId: result.candidate.firstKeptEntryId };
        } else {
          current.engine = result.code === "CANCELLED" ? "cancel" : "fail";
          current.code = result.code;
          current.message = result.message;
        }
      } catch { /* Keep the freeze already recorded. */ }
    },
    noteNative(status) {
      const current = state.lastMaintenance;
      if (!current || current.native !== "pending") return;
      current.native = status;
      if (status === "saved" && current.engine === "ok" && !current.invalidated && current.candidate && current.cut) {
        current.after = { memory: structuredClone(current.candidate.memory), keptEntryIds: [...current.cut.keptEntryIds] };
      }
    },
    noteInvalidated() {
      const current = state.lastMaintenance;
      if (!current || current.native === "saved") return;
      if (current.engine === "ok") current.invalidated = true;
    },
    resetPath() {
      delete state.lastMain;
      delete state.lastMaintenance;
      delete state.frozen;
    },
  };
  options.pi.events.on("nunc:context-bind", reply => {
    if (typeof reply === "function") {
      try { (reply as (surface: ContextSurface) => void)(surface); } catch { /* Consumer only. */ }
    }
  });
  return surface;
}

export function contextSurface(pi: { events: { emit: (channel: string, data: unknown) => void } }): ContextSurface | undefined {
  let found: ContextSurface | undefined;
  pi.events.emit("nunc:context-bind", (surface: ContextSurface) => { found = surface; });
  return found;
}

interface FrozenMaintenance {
  sessionId: string;
  leafId: string | null;
  model: { id: string; provider: string; api: string };
  observedAt: number;
  reason: string;
  fixed: FixedContext;
  memory: Memory;
  active: ActiveEntry[];
  imageTokens?: number;
}

function identity(model: Model<Api>): { id: string; provider: string; api: string } {
  return { id: model.id, provider: model.provider, api: model.api };
}

function applicable<T extends { sessionId: string; leafId: string | null }>(observation: T | undefined, ctx: ExtensionContext): observation is T {
  if (!observation || observation.sessionId !== ctx.sessionManager.getSessionId()) return false;
  if (observation.leafId === ctx.sessionManager.getLeafId()) return true;
  return Boolean(observation.leafId && ctx.sessionManager.getBranch().some(entry => entry.id === observation.leafId));
}

function readConfig(options: { config: (ctx: ExtensionContext, model: Model<Api>) => EngineConfig }, ctx: ExtensionContext, model: Model<Api>): EngineConfig | undefined {
  try { return options.config(ctx, model); } catch { return undefined; }
}

function unknownBudget(occupied: number, unknown: boolean): ContextBudget {
  return {
    modelWindow: null, triggerTokens: null, plannedInputLimit: null, mainAdmissionLimit: null,
    memoryLimit: null, memoryOccupied: occupied, memoryUnknown: unknown,
    outputReserveTokens: null, outputCapTokens: null, outputCapKnown: false,
    extractionOutputTokens: null, extractionOutputCapTokens: null, safetyTokens: null,
  };
}

function measureBudget(model: Model<Api>, config: EngineConfig, fixed: FixedContext, occupied: number, memoryUnknown: boolean): ContextBudget {
  const plan = memoryPlan(fixed, model, config);
  const uncapped = omitsSerializedOutputCap(model);
  return {
    modelWindow: model.contextWindow,
    triggerTokens: config.triggerTokens,
    plannedInputLimit: plan.mainInputLimit,
    mainAdmissionLimit: mainAdmissionLimit(model, config.main),
    memoryLimit: plan.memoryLimit,
    memoryOccupied: occupied,
    memoryUnknown,
    outputReserveTokens: config.main.nativeOutputReserve ?? config.main.outputTokens,
    outputCapTokens: null,
    outputCapKnown: uncapped,
    extractionOutputTokens: config.extraction.outputTokens,
    extractionOutputCapTokens: uncapped ? null : config.extraction.outputTokens,
    safetyTokens: config.main.safetyTokens,
  };
}

function payloadView(observation: PayloadObservation | undefined, growth: AdmissionLayoutEvent["payloadGrowth"]): LastMainPayload | undefined {
  if (!observation && !growth) return;
  const base: LastMainPayload = observation ? { ...observation } : { mode: "noop", categories: [] };
  if (!growth) return base;
  base.chargedGrowthTokens = growth.chargedTokens;
  if (growth.append) {
    base.transform = "last-user-text-append";
    if (growth.addedTokens !== undefined) base.addedTokens = growth.addedTokens;
    if (growth.addedText !== undefined) base.addedText = growth.addedText;
    const overhead = growth.chargedTokens - (growth.addedTokens ?? 0);
    if (overhead > 0) base.unallocatedOverheadTokens = overhead;
    return base;
  }
  const categories = observation?.categories ?? [];
  if (categories.some(category => category === "input" || category === "tools" || category === "media")) {
    base.unmappedIncrement = { tokens: growth.chargedTokens, unknown: true };
  } else if (growth.chargedTokens > 0) {
    base.unallocatedOverheadTokens = growth.chargedTokens;
  }
  return base;
}

function captureSentCut(current: LastMaintenanceContext | undefined, context: Context): void {
  if (!current || current.native !== "pending" || current.cut) return;
  try {
    const texts: string[] = [];
    for (const message of context.messages) {
      if (typeof message.content === "string") texts.push(message.content);
      else if (Array.isArray(message.content)) {
        for (const block of message.content) if (block.type === "text") texts.push(block.text);
      }
    }
    const records = texts.flatMap(text => readSourceRecords(text));
    const retiredEntryIds = records.filter(record => record.region === "B").map(record => String(record.entryId));
    const keptEntryIds = records.filter(record => record.region === "K").map(record => String(record.entryId));
    const firstKeptEntryId = keptEntryIds[0];
    if (!firstKeptEntryId) return;
    current.cut = { firstKeptEntryId, retiredEntryIds, keptEntryIds };
  } catch { /* Leave cut unknown rather than invent a partition. */ }
}

function layoutFromProjection(fixed: FixedContext, memory: Memory, active: ActiveEntry[], imageTokens: number | undefined, extraInputTokens: number): ContextLayout {
  const inspected = inspectEntries(active, imageTokens);
  const tools = toolLayer(fixed.tools);
  const envelopeTokens = messageCost(memoryMessage([]), undefined).tokens ?? 0;
  const memoryLayer = { slots: structuredClone(memory.slots), tokens: imageTokens === undefined ? memoryTokens(memory.slots) : memoryTokens(memory.slots, imageTokens), envelopeTokens };
  const packagingTokens = 64 + extraInputTokens;
  const known = knownSum([
    { tokens: textTokens(fixed.systemPrompt), unknown: false },
    tools,
    { tokens: packagingTokens, unknown: false },
    { tokens: memoryLayer.tokens + envelopeTokens, unknown: false },
    ...inspected.messages,
  ]);
  return {
    system: { text: fixed.systemPrompt, tokens: textTokens(fixed.systemPrompt) },
    tools,
    memory: memoryLayer,
    entries: inspected.entries,
    messages: inspected.messages,
    messageCount: inspected.messages.length,
    blockCount: inspected.messages.reduce((n, message) => n + message.blocks.length, 0),
    packagingTokens,
    extraInputTokens,
    heuristic: known,
    associations: inspected.associations,
  };
}

function layoutFromContext(context: Context, imageTokens: number | undefined, extraInputTokens: number): ContextLayout {
  const messages = inspectMessages(context.messages, imageTokens);
  const tools = toolLayer(context.tools ?? []);
  const packagingTokens = 64 + extraInputTokens;
  const systemTokens = textTokens(context.systemPrompt ?? "");
  const known = knownSum([{ tokens: systemTokens, unknown: false }, tools, { tokens: packagingTokens, unknown: false }, ...messages]);
  return {
    system: { text: context.systemPrompt ?? "", tokens: systemTokens },
    tools,
    messages,
    messageCount: messages.length,
    blockCount: messages.reduce((n, message) => n + message.blocks.length, 0),
    packagingTokens,
    extraInputTokens,
    heuristic: known,
    associations: associationsOf(messages),
  };
}

function unavailableLayout(): ContextLayout {
  return {
    system: { text: "", tokens: 0 },
    tools: { count: 0, names: [], tokens: null, unknown: true, definitions: [] },
    messages: [],
    messageCount: 0,
    blockCount: 0,
    packagingTokens: 0,
    extraInputTokens: 0,
    heuristic: { tokens: null, unknown: true },
    associations: [],
    unavailable: true,
  };
}

function toolLayer(tools: readonly { name: string; description?: string; parameters?: unknown }[]): ToolsLayer {
  const names = tools.map(tool => tool.name);
  const definitions: ToolDefinitionView[] = tools.map(tool => {
    try {
      const parameters = structuredClone(tool.parameters ?? {});
      const description = typeof tool.description === "string" ? tool.description : "";
      return { name: tool.name, description, parameters, tokens: textTokens(JSON.stringify({ name: tool.name, description, parameters })), unknown: false };
    } catch {
      return { name: tool.name, description: typeof tool.description === "string" ? tool.description : "", parameters: {}, tokens: null, unknown: true };
    }
  });
  try {
    return { count: tools.length, names, tokens: textTokens(JSON.stringify(tools)), unknown: definitions.some(item => item.unknown), definitions };
  } catch {
    return { count: tools.length, names, tokens: null, unknown: true, definitions };
  }
}

function inspectEntries(active: readonly ActiveEntry[], imageTokens: number | undefined): { entries: ContextEntry[]; messages: ContextMessage[]; associations: ToolAssociation[] } {
  let order = 0;
  const entries: ContextEntry[] = [];
  const messages: ContextMessage[] = [];
  for (const entry of active) {
    const owned: ContextMessage[] = [];
    for (const message of entry.messages) {
      const view = inspectMessage(message, order++, imageTokens);
      owned.push(view);
      messages.push(view);
    }
    entries.push({ entryId: entry.entryId, sourceRole: entry.sourceRole, messages: owned });
  }
  return { entries, messages, associations: associationsOf(messages) };
}

function inspectMessages(messages: readonly Message[], imageTokens: number | undefined): ContextMessage[] {
  return messages.map((message, order) => inspectMessage(message, order, imageTokens));
}

function inspectMessage(message: Message, order: number, imageTokens: number | undefined): ContextMessage {
  const framing = messageCost(message, imageTokens);
  const blocks: ContextBlock[] = [];
  if (typeof message.content === "string") {
    blocks.push({ type: "text", tokens: textTokens(message.content), unknown: false, preview: preview(message.content), text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) blocks.push(inspectBlock(block, imageTokens));
  } else {
    blocks.push({ type: "unknown", tokens: null, unknown: true, preview: "[unavailable content]" });
  }
  const unknown = framing.unknown || blocks.some(block => block.unknown);
  const view: ContextMessage = {
    order, role: message.role, tokens: framing.tokens, unknown, preview: messagePreview(message, blocks), blocks,
  };
  if (message.role === "toolResult") {
    view.toolCallId = message.toolCallId;
    view.toolName = message.toolName;
    view.isError = message.isError;
  }
  return view;
}

function inspectBlock(block: { type: string; text?: string; thinking?: string; redacted?: boolean; id?: string; name?: string; arguments?: unknown; mimeType?: string }, imageTokens: number | undefined): ContextBlock {
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      return { type: "text", tokens: 16 + textTokens(text), unknown: false, preview: preview(text), text };
    }
    case "thinking": {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      const redacted = block.redacted === true;
      return {
        type: "thinking", tokens: 16 + textTokens(thinking), unknown: false, preview: redacted ? "[redacted thinking]" : preview(thinking),
        ...(redacted ? { redacted: true } : { thinking }),
      };
    }
    case "toolCall": {
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      const args = record(block.arguments) ? structuredClone(block.arguments) as Record<string, unknown> : {};
      let argumentText = "";
      try { argumentText = JSON.stringify(args); } catch { argumentText = ""; }
      return {
        type: "toolCall", tokens: 16 + textTokens(id) + textTokens(name) + textTokens(argumentText), unknown: false,
        preview: preview(`${name}(${argumentText})`), toolCallId: id, toolName: name, arguments: args,
      };
    }
    case "image": {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
      const known = integer(imageTokens, 1);
      return {
        type: "image", tokens: known ? 16 + imageTokens : null, unknown: !known, preview: `image ${mimeType}`, mimeType,
      };
    }
    default:
      return { type: "unknown", tokens: null, unknown: true, preview: `[${block.type}]` };
  }
}

function messageCost(message: Message, imageTokens: number | undefined): TokenCount {
  let tokens = 32 + textTokens(message.role);
  let unknown = false;
  if (message.role === "toolResult") tokens += textTokens(message.toolCallId) + textTokens(message.toolName) + 8;
  if (typeof message.content === "string") return { tokens: tokens + textTokens(message.content), unknown: false };
  if (!Array.isArray(message.content)) return { tokens, unknown: true };
  for (const block of message.content) {
    const view = inspectBlock(block, imageTokens);
    if (view.unknown || view.tokens === null) unknown = true;
    else tokens += view.tokens;
  }
  return { tokens, unknown };
}

function associationsOf(messages: readonly ContextMessage[]): ToolAssociation[] {
  const pending = new Map<string, { toolName: string; callOrder: number }>();
  const associations: ToolAssociation[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.blocks) {
        if (block.type === "toolCall" && block.toolCallId && block.toolName) pending.set(block.toolCallId, { toolName: block.toolName, callOrder: message.order });
      }
    } else if (message.role === "toolResult" && message.toolCallId && message.toolName) {
      const call = pending.get(message.toolCallId);
      if (call && call.toolName === message.toolName) {
        associations.push({ toolCallId: message.toolCallId, toolName: message.toolName, callOrder: call.callOrder, resultOrder: message.order });
        pending.delete(message.toolCallId);
      }
    }
  }
  return associations;
}

function knownSum(parts: TokenCount[]): TokenCount {
  let tokens = 0;
  let unknown = false;
  for (const part of parts) {
    if (part.unknown || part.tokens === null) unknown = true;
    if (part.tokens !== null) tokens += part.tokens;
  }
  return { tokens, unknown };
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW ? flat : `${flat.slice(0, PREVIEW)}…`;
}

function messagePreview(message: Message, blocks: ContextBlock[]): string {
  if (typeof message.content === "string") return preview(message.content);
  const first = blocks.find(block => block.preview);
  return first?.preview ?? message.role;
}
