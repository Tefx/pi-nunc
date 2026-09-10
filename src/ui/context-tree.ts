import type { ContextLayout, ContextMessage, ContextView, CurrentContext, LastMainContext, LastMaintenanceContext } from "../pi/context.js";
import type { Slot } from "../engine/index.js";
import { budgetLines, firstLine, maintenanceLines, thousands, type DiagnosticNote } from "./status.js";

export interface CtxNode {
  id: string;
  label: string;
  description?: string;
  preview: string;
  jumpSlot?: string;
  children: string[];
}

export const CONTEXT_ROOT_IDS = ["scope:current", "scope:last-main", "scope:last-maintenance", "scope:diagnostics", "scope:legend"] as const;

export function buildContextNodes(view: ContextView, diagnostics: readonly DiagnosticNote[] = []): Map<string, CtxNode> {
  const nodes = new Map<string, CtxNode>();
  const add = (node: CtxNode) => { nodes.set(node.id, node); return node.id; };
  add(scopeCurrent(view.current, add));
  add(scopeLastMain(view.lastMain, add));
  add(scopeLastMaintenance(view.lastMaintenance, add));
  add(scopeDiagnostics(diagnostics, add));
  add(scopeLegend(add));
  return nodes;
}

function scopeCurrent(current: CurrentContext, add: (node: CtxNode) => string): CtxNode {
  const children = [
    ...layoutChildren("current", current.layout, add, current.layout.memory?.slots),
    add({ id: "current:budget", label: "Budget", preview: budgetPreview(current), children: [] }),
    add({ id: "current:counts", label: "Counts", preview: countsPreview(current.layout), children: [] }),
  ];
  return {
    id: "scope:current",
    label: "Current projection",
    description: current.model ? `${current.model.provider}/${current.model.id}` : "no model",
    preview: [
      "Scope: current delivered F/M/R. Later context/payload hooks are not included.",
      bars(current),
      current.occupied ? "Maintenance occupied" : "",
      current.unconfirmed ? "Save unconfirmed" : "",
    ].filter(Boolean).join("\n"),
    children,
  };
}

function scopeLastMain(last: LastMainContext | undefined, add: (node: CtxNode) => string): CtxNode {
  if (!last) return { id: "scope:last-main", label: "Last main request", description: "none", preview: "No records", children: [] };
  const children: string[] = [];
  children.push(add({
    id: "last-main:summary",
    label: "Observation",
    description: last.outcome,
    preview: lastMainSummary(last),
    children: [],
  }));
  if (last.initialMetadataTokens !== undefined) {
    children.push(add({
      id: "last-main:metadata",
      label: "initialMetadataTokens",
      description: String(last.initialMetadataTokens),
      preview: `initialMetadataTokens ${last.initialMetadataTokens}`,
      children: [],
    }));
  }
  if (last.payload) {
    children.push(add({
      id: "last-main:payload",
      label: "Payload",
      description: last.payload.mode,
      preview: payloadPreview(last),
      children: last.payload.addedText !== undefined ? [add({
        id: "last-main:payload:added",
        label: "added text",
        ...(last.payload.addedTokens !== undefined ? { description: `${last.payload.addedTokens} tok` } : {}),
        preview: last.payload.addedText,
        children: [],
      })] : [],
    }));
  }
  if (last.layout.unavailable) {
    children.push(add({ id: "last-main:layout", label: "Layout", description: "unavailable", preview: "layout unavailable (unknown)", children: [] }));
  } else {
    children.push(...layoutChildren("last-main", last.layout, add, last.layout.memory?.slots));
  }
  return {
    id: "scope:last-main",
    label: "Last main request",
    description: `${last.outcome} ${last.model.id}`,
    preview: lastMainSummary(last),
    children,
  };
}

function scopeDiagnostics(notes: readonly DiagnosticNote[], add: (node: CtxNode) => string): CtxNode {
  const shown = notes.filter(note => note.level !== "info");
  if (shown.length === 0) {
    return { id: "scope:diagnostics", label: "Diagnostics", description: "none", preview: "No recent diagnostics", children: [] };
  }
  const children = shown.map((note, index) => add({
    id: `diag:${index}`,
    label: note.level,
    description: firstLine(note.message, 80),
    preview: note.message,
    children: [],
  }));
  return {
    id: "scope:diagnostics",
    label: "Diagnostics",
    description: String(shown.length),
    preview: `${shown.length} recent diagnostic${shown.length === 1 ? "" : "s"}`,
    children,
  };
}

function scopeLastMaintenance(last: LastMaintenanceContext | undefined, add: (node: CtxNode) => string): CtxNode {
  if (!last) return { id: "scope:last-maintenance", label: "Last maintenance", description: "none", preview: "No records", children: [] };
  const children: string[] = [
    add({ id: "maint:summary", label: "Observation", preview: maintenanceSummary(last), children: [] }),
    add({
      id: "maint:before",
      label: "Before",
      description: `${last.before.memory.slots.length} slots`,
      preview: `Frozen F/M/R at maintenance start.\nM ${last.before.memory.slots.length} slots · ${last.before.messages.length} messages`,
      children: frozenChildren("maint:before", last.before, add),
    }),
  ];
  if (last.cut) {
    children.push(add({
      id: "maint:cut",
      label: "B/K · cut history",
      description: `B ${last.cut.retiredEntryIds.length} · K ${last.cut.keptEntryIds.length}`,
      preview: [
        `firstKept ${last.cut.firstKeptEntryId}`,
        `B (Retiring): ${last.cut.retiredEntryIds.length} items · K (Kept): ${last.cut.keptEntryIds.length} items`,
        "The cut is determined at actual maintenance, not predicted in advance.",
      ].join("\n"),
      children: [
        add({ id: "maint:cut:B", label: "B (Retiring)", description: String(last.cut.retiredEntryIds.length), preview: `B (selected retiring prefix):\n${last.cut.retiredEntryIds.join("\n") || "(empty B)"}`, children: [] }),
        add({ id: "maint:cut:K", label: "K (Kept)", description: String(last.cut.keptEntryIds.length), preview: `K (kept recent suffix):\n${last.cut.keptEntryIds.join("\n") || "(empty K)"}`, children: [] }),
      ],
    }));
  }
  if (last.candidate) {
    children.push(add({
      id: "maint:candidate",
      label: "Candidate",
      description: `${last.candidate.memory.slots.length} slots`,
      preview: `engine candidate @ ${last.candidate.firstKeptEntryId}\nNot a native save.`,
      children: slotChildren("maint:candidate", last.candidate.memory.slots, add),
    }));
  }
  if (last.after) {
    children.push(add({
      id: "maint:after",
      label: "After",
      description: `${last.after.memory.slots.length} slots`,
      preview: `native saved · kept ${last.after.keptEntryIds.length}`,
      children: [
        ...slotChildren("maint:after", last.after.memory.slots, add),
        add({ id: "maint:after:kept", label: "kept ids", preview: last.after.keptEntryIds.join("\n") || "(none)", children: [] }),
      ],
    }));
  }
  return {
    id: "scope:last-maintenance",
    label: "Last maintenance",
    description: `${last.native}${last.engine ? `/${last.engine}` : ""}`,
    preview: maintenanceSummary(last),
    children,
  };
}

function layoutChildren(prefix: string, layout: ContextLayout, add: (node: CtxNode) => string, slots?: Slot[]): string[] {
  const toolIds = layout.tools.definitions.map(def => add({
    id: `${prefix}:F:tools:${def.name}`,
    label: def.name,
    description: def.unknown ? "unknown" : `${def.tokens ?? "?"} tok`,
    preview: [def.name, def.description, def.unknown ? "estimate unknown" : `${thousands(def.tokens ?? 0)} tok`, JSON.stringify(def.parameters)].join("\n"),
    children: [],
  }));
  const mIds = slotChildren(`${prefix}:M`, slots ?? [], add);
  const rIds = messageChildren(prefix, layout.messages, layout.associations, add);
  return [
    add({
      id: `${prefix}:F`,
      label: "F · Fixed",
      description: tokenLabel(layout.system.tokens + (layout.tools.tokens ?? 0), layout.tools.unknown),
      preview: `F (Fixed): effective system prompt and tool definitions\nSystem ${thousands(layout.system.tokens)} tok\nTools ${tokenLabel(layout.tools.tokens, layout.tools.unknown)} (${layout.tools.count})`,
      children: [
        add({ id: `${prefix}:F:system`, label: "system", description: `${thousands(layout.system.tokens)} tok`, preview: layout.system.text || "(empty system)", children: [] }),
        add({ id: `${prefix}:F:tools`, label: "tools", description: `${layout.tools.count}`, preview: layout.tools.names.join(", ") || "(no tools)", children: toolIds }),
      ],
    }),
    add({
      id: `${prefix}:M`,
      label: "M · Memory",
      description: `${slots?.length ?? 0} slots`,
      preview: slots ? `M (Memory): current working memory (${slots.length} slots)\n${slots.length} slots` : "M not in this observation",
      children: mIds,
    }),
    add({
      id: `${prefix}:R`,
      label: "R · Raw history",
      description: `${layout.messageCount} messages / ${layout.blockCount} blocks`,
      preview: `R (Raw history): delivered active verbatim history\n${layout.messageCount} messages / ${layout.blockCount} blocks`,
      children: rIds,
    }),
  ];
}

function frozenChildren(prefix: string, before: LastMaintenanceContext["before"], add: (node: CtxNode) => string): string[] {
  const tools = before.tools;
  const toolIds = tools.definitions.map(def => add({
    id: `${prefix}:F:tools:${def.name}`,
    label: def.name,
    preview: [def.name, def.description, JSON.stringify(def.parameters)].join("\n"),
    children: [],
  }));
  return [
    add({
      id: `${prefix}:F`,
      label: "F",
      preview: `System ${thousands(before.system.tokens)} tok\nTools ${tokenLabel(tools.tokens, tools.unknown)}`,
      children: [
        add({ id: `${prefix}:F:system`, label: "system", preview: before.system.text || "(empty system)", children: [] }),
        add({ id: `${prefix}:F:tools`, label: "tools", description: `${tools.count}`, preview: tools.names.join(", ") || "(no tools)", children: toolIds }),
      ],
    }),
    add({
      id: `${prefix}:M`,
      label: "M",
      description: `${before.memory.slots.length} slots`,
      preview: `${before.memory.slots.length} slots`,
      children: slotChildren(`${prefix}:M`, before.memory.slots, add),
    }),
    add({
      id: `${prefix}:R`,
      label: "R",
      description: `${before.messages.length} messages`,
      preview: `${before.messages.length} messages · ${before.entries.length} entries`,
      children: [
        ...messageChildren(prefix, before.messages, [], add),
        ...before.entries.map(entry => add({
          id: `${prefix}:entry:${entry.entryId}`,
          label: entry.entryId,
          description: entry.sourceRole,
          preview: `${entry.sourceRole} ${entry.entryId}\n${entry.messages.length} messages`,
          children: [],
        })),
      ],
    }),
  ];
}

function slotChildren(prefix: string, slots: readonly Slot[], add: (node: CtxNode) => string): string[] {
  return slots.map(slot => add({
    id: `${prefix}:${slot.id}`,
    label: slot.id,
    description: slot.text.replace(/\s+/g, " ").trim(),
    preview: slot.text,
    ...(prefix === "current:M" ? { jumpSlot: slot.id } : {}),
    children: [],
  }));
}

function messageChildren(prefix: string, messages: readonly ContextMessage[], associations: ContextLayout["associations"], add: (node: CtxNode) => string): string[] {
  return messages.map(message => {
    const blockIds = message.blocks.map((block, index) => add({
      id: `${prefix}:R:${message.order}:b${index}`,
      label: block.type,
      description: tokenLabel(block.tokens, block.unknown),
      preview: block.text ?? block.thinking ?? (block.toolName ? `${block.toolName} ${JSON.stringify(block.arguments ?? {})}` : block.preview),
      children: [],
    }));
    const assoc = associations.find(item => item.callOrder === message.order || item.resultOrder === message.order);
    return add({
      id: `${prefix}:R:${message.order}`,
      label: `${message.order} ${message.role}`,
      description: tokenLabel(message.tokens, message.unknown),
      preview: [`#${message.order} ${message.role} ${tokenLabel(message.tokens, message.unknown)}`, message.preview, assoc ? `tool ${assoc.toolName} ${assoc.toolCallId} call@${assoc.callOrder} result@${assoc.resultOrder}` : ""].filter(Boolean).join("\n"),
      children: blockIds,
    });
  });
}

function lastMainSummary(last: LastMainContext): string {
  const when = new Date(last.observedAt).toISOString();
  const layout = last.layout.unavailable
    ? "layout unavailable (unknown)"
    : `${last.layout.messageCount} messages / ${last.layout.blockCount} blocks · heuristic ${tokenLabel(last.layout.heuristic.tokens, last.layout.heuristic.unknown)}`;
  return [
    `Scope: last-main · ${last.outcome}${last.code ? ` ${last.code}` : ""}`,
    `${last.model.provider}/${last.model.id} (${last.model.api})`,
    when,
    last.estimator ? `estimator ${last.estimator}` : "",
    last.inputTokens !== undefined ? `input ${last.inputTokens}${last.inputLimit !== undefined ? ` / enforced ${last.inputLimit}` : ""}${last.plannedInputLimit !== undefined ? ` · planned ${last.plannedInputLimit}` : ""}` : "",
    last.inputExceededPlan === true ? "input exceeded plan (advisory if delegated)" : "",
    last.outputTokens !== undefined ? `output ${last.outputTokens}` : "",
    last.outputReserveTokens !== undefined ? `output reserve ${last.outputReserveTokens}` : "",
    last.outputCapTokens === null ? "output cap none" : last.outputCapTokens !== undefined ? `output cap ${last.outputCapTokens}` : "",
    last.initialMetadataTokens !== undefined ? `initialMetadataTokens ${last.initialMetadataTokens}` : "",
    layout,
    last.outcome === "reject" ? "Local reject is not a send." : "Delegate is not HTTP success.",
  ].filter(Boolean).join("\n");
}

function payloadPreview(last: LastMainContext): string {
  const payload = last.payload;
  if (!payload) return "payload not observed";
  return [
    `payload ${payload.mode} [${payload.categories.join(",") || "none"}]`,
    payload.addedTokens !== undefined ? `addedTokens ${payload.addedTokens}` : "",
    payload.chargedGrowthTokens !== undefined ? `chargedGrowthTokens ${payload.chargedGrowthTokens}` : "",
    payload.unallocatedOverheadTokens !== undefined ? `unallocatedOverheadTokens ${payload.unallocatedOverheadTokens}` : "",
    last.initialMetadataTokens !== undefined ? `initialMetadataTokens ${last.initialMetadataTokens}` : "",
    payload.unmappedIncrement ? `unmappedIncrement ${payload.unmappedIncrement.tokens} unknown` : "",
  ].filter(Boolean).join("\n");
}

function maintenanceSummary(last: LastMaintenanceContext): string {
  const cut = last.cut ? `B ${last.cut.retiredEntryIds.length} · K ${last.cut.keptEntryIds.length} · firstKept ${last.cut.firstKeptEntryId}` : "B/K unknown (no extraction cut yet)";
  return [
    ...maintenanceLines(last),
    cut,
    `before M ${last.before.memory.slots.length} slots · ${last.before.messages.length} messages`,
  ].join("\n");
}

function bars(current: CurrentContext): string {
  const layout = current.layout;
  const f = layout.system.tokens + (layout.tools.tokens ?? 0);
  const fUnknown = layout.tools.unknown;
  const rKnown = layout.messages.every(message => !message.unknown) ? layout.messages.reduce((n, message) => n + (message.tokens ?? 0), 0) : null;
  const rUnknown = layout.messages.some(message => message.unknown);
  const cap = current.budget.modelWindow;
  return [
    `F ${meter(fUnknown ? null : f, cap)} ${tokenLabel(f, fUnknown)}`,
    `M ${meter(current.budget.memoryUnknown ? null : current.budget.memoryOccupied, current.budget.memoryLimit)} ${memoryLine(current)}`,
    `R ${meter(rUnknown ? null : rKnown, cap)} ${tokenLabel(rKnown, rUnknown)}`,
  ].join("\n");
}

function meter(value: number | null, cap: number | null): string {
  const width = 8;
  if (value === null || cap === null || cap <= 0) return `?${"░".repeat(width - 1)}`;
  const filled = Math.max(0, Math.min(width, Math.round((value / cap) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function tokenLabel(tokens: number | null | undefined, unknown: boolean): string {
  if (unknown && (tokens === null || tokens === undefined)) return "unknown";
  if (tokens === null || tokens === undefined) return "unknown";
  return unknown ? `${thousands(tokens)} + unknown` : `${thousands(tokens)} tok`;
}

function memoryLine(current: CurrentContext): string {
  const occupied = current.budget.memoryOccupied;
  const limit = current.budget.memoryLimit;
  if (current.budget.memoryUnknown) return occupied === null ? "unknown" : `${thousands(occupied)} · unknown limit`;
  if (limit === null) return occupied === null ? "unknown" : `${thousands(occupied)} / unknown`;
  return `${thousands(occupied ?? 0)} / ${thousands(limit)}`;
}

function budgetPreview(current: CurrentContext): string {
  return budgetLines(current).join("\n");
}

function countsPreview(layout: ContextLayout): string {
  return `${layout.messageCount} messages / ${layout.blockCount} blocks\npackaging ${thousands(layout.packagingTokens)} · extra input ${thousands(layout.extraInputTokens)}\nheuristic ${tokenLabel(layout.heuristic.tokens, layout.heuristic.unknown)}`;
}

function scopeLegend(add: (node: CtxNode) => string): CtxNode {
  const children = [
    add({
      id: "legend:F",
      label: "F · Fixed (system prompt and tools)",
      description: "Effective system prompt and tool definitions",
      preview: [
        "F (Fixed): effective system prompt and available tool definitions.",
        "• Provides the request's base runtime and instruction constraints.",
        "• Redetermined from the current model, config, or tool set.",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:M",
      label: "M · Memory (structured working memory)",
      description: "Current working-memory slots and budget",
      preview: [
        "M (Memory): current structured working memory.",
        "• Named slots (id + body) carried in full on every main request.",
        "• Holds constraints and facts needed beyond the recent window.",
        "• Editable by hand per slot, or proposed add/remove during maintenance.",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:R",
      label: "R · Raw history (active verbatim history)",
      description: "Delivered history still in the active context",
      preview: [
        "R (Raw history): delivered records still kept in the active context.",
        "• Includes recent user input, assistant replies, and tool results.",
        "• Ordinary work keeps the full verbatim text; before maintenance, R is B | K.",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:B",
      label: "B · Retiring (selected retiring history)",
      description: "Earlier verbatim prefix selected to leave at maintenance",
      preview: [
        "B (Retiring): earlier history selected to leave model-visible context.",
        "• Determined only when maintenance actually runs; not predicted in advance.",
        "• Remains in the session file (JSONL); later model requests do not load it.",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:K",
      label: "K · Kept (kept recent history)",
      description: "Recent verbatim suffix kept after maintenance",
      preview: [
        "K (Kept): recent verbatim history suffix kept after maintenance.",
        "• Original order and content are preserved; not regenerated or compressed.",
        "• Later main requests carry effective M and kept K with new input.",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:D",
      label: "D · Queued input",
      description: "Queued or not-yet-delivered input",
      preview: [
        "D (Queued): queued or not-yet-delivered later input or in-flight instructions.",
        "• Pi delivers it under native queue and scheduling rules.",
        "• Not part of R or the maintenance source before delivery.",
      ].join("\n"),
      children: [],
    }),
  ];
  return {
    id: "scope:legend",
    label: "Legend · abbreviations",
    description: "F / M / R / B / K / D meanings",
    preview: [
      "Context abbreviations (Legend):",
      "• F (Fixed): current effective system prompt and available tool definitions (redetermined with model/config)",
      "• M (Memory): current structured working-memory slots and budget (independent of message count)",
      "• R (Raw history): delivered verbatim history still in the active context (R = B | K)",
      "• B (Retiring): earlier history selected to leave at maintenance (determined at actual maintenance, not predicted)",
      "• K (Kept): recent verbatim suffix kept after maintenance (later main requests continue with new input)",
      "• D (Queued): queued not-yet-delivered input (not part of R or the maintenance source before delivery)",
      "",
      "Press Enter to open each abbreviation's definition.",
    ].join("\n"),
    children,
  };
}

