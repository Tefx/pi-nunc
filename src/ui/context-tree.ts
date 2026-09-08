import type { ContextLayout, ContextMessage, ContextView, CurrentContext, LastMainContext, LastMaintenanceContext } from "../pi/context.js";
import type { Slot } from "../engine/index.js";
import { thousands } from "./status.js";

export interface CtxNode {
  id: string;
  label: string;
  description?: string;
  preview: string;
  jumpSlot?: string;
  children: string[];
}

export function buildContextNodes(view: ContextView): Map<string, CtxNode> {
  const nodes = new Map<string, CtxNode>();
  const add = (node: CtxNode) => { nodes.set(node.id, node); return node.id; };
  add(scopeCurrent(view.current, add));
  add(scopeLastMain(view.lastMain, add));
  add(scopeLastMaintenance(view.lastMaintenance, add));
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
  if (!last) return { id: "scope:last-main", label: "Last main request", description: "none", preview: "暂无记录", children: [] };
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

function scopeLastMaintenance(last: LastMaintenanceContext | undefined, add: (node: CtxNode) => string): CtxNode {
  if (!last) return { id: "scope:last-maintenance", label: "Last maintenance", description: "none", preview: "暂无记录", children: [] };
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
      label: "B/K · 切分历史",
      description: `B ${last.cut.retiredEntryIds.length} · K ${last.cut.keptEntryIds.length}`,
      preview: [
        `firstKept ${last.cut.firstKeptEntryId}`,
        `B (Retiring): ${last.cut.retiredEntryIds.length} 项 · K (Kept): ${last.cut.keptEntryIds.length} 项`,
        "切分在实际维护时确定，不提前预测。",
      ].join("\n"),
      children: [
        add({ id: "maint:cut:B", label: "B (Retiring)", description: String(last.cut.retiredEntryIds.length), preview: `B (选定退役的历史前段):\n${last.cut.retiredEntryIds.join("\n") || "(empty B)"}`, children: [] }),
        add({ id: "maint:cut:K", label: "K (Kept)", description: String(last.cut.keptEntryIds.length), preview: `K (继续保留的近期历史后缀):\n${last.cut.keptEntryIds.join("\n") || "(empty K)"}`, children: [] }),
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
      preview: `F (Fixed): 有效 system prompt 与工具定义\nSystem ${thousands(layout.system.tokens)} tok\nTools ${tokenLabel(layout.tools.tokens, layout.tools.unknown)} (${layout.tools.count})`,
      children: [
        add({ id: `${prefix}:F:system`, label: "system", description: `${thousands(layout.system.tokens)} tok`, preview: layout.system.text || "(empty system)", children: [] }),
        add({ id: `${prefix}:F:tools`, label: "tools", description: `${layout.tools.count}`, preview: layout.tools.names.join(", ") || "(no tools)", children: toolIds }),
      ],
    }),
    add({
      id: `${prefix}:M`,
      label: "M · Memory",
      description: `${slots?.length ?? 0} slots`,
      preview: slots ? `M (Memory): 当前有效工作记忆 (${slots.length} slots)\n${slots.length} slots` : "M not in this observation",
      children: mIds,
    }),
    add({
      id: `${prefix}:R`,
      label: "R · Raw history",
      description: `${layout.messageCount} messages / ${layout.blockCount} blocks`,
      preview: `R (Raw history): 已交付活动原文历史\n${layout.messageCount} messages / ${layout.blockCount} blocks`,
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
  const when = new Date(last.observedAt).toISOString();
  const cut = last.cut ? `B ${last.cut.retiredEntryIds.length} · K ${last.cut.keptEntryIds.length} · firstKept ${last.cut.firstKeptEntryId}` : "B/K unknown (no extraction cut yet)";
  const after = last.native === "saved" && last.after ? `native saved · after ${last.after.memory.slots.length} slots` : last.native === "saved" ? "native saved" : `native ${last.native}${last.invalidated ? " · invalidated (no after)" : ""}`;
  const candidate = last.candidate ? `engine candidate ${last.candidate.memory.slots.length} slots @ ${last.candidate.firstKeptEntryId}` : "no candidate";
  return [
    `Scope: last-maintenance · ${last.reason ?? "unknown reason"}`,
    `${last.model.provider}/${last.model.id} (${last.model.api})`,
    when,
    `engine ${last.engine ?? "pending"} · ${after}`,
    candidate,
    cut,
    `before M ${last.before.memory.slots.length} slots · ${last.before.messages.length} messages`,
    last.accounting ? `accounting extraction ${last.accounting.extractionTokens} / plan ${last.accounting.extractionInputLimit}` : "",
    last.code ? `${last.code}: ${last.message ?? ""}` : "",
    last.native !== "saved" ? "Candidate success is not a native save." : "",
  ].filter(Boolean).join("\n");
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
  const b = current.budget;
  return [
    `model window ${nullLabel(b.modelWindow)}`,
    `H / trigger ${nullLabel(b.triggerTokens)}`,
    `planned input ${nullLabel(b.plannedInputLimit)}`,
    `main admission ${nullLabel(b.mainAdmissionLimit)}`,
    `M budget ${b.memoryUnknown ? "unknown" : nullLabel(b.memoryLimit)} occupied ${b.memoryOccupied === null ? "unknown" : thousands(b.memoryOccupied)}`,
    `output reserve ${nullLabel(b.outputReserveTokens)}`,
    `output cap ${b.outputCapKnown ? (b.outputCapTokens === null ? "none" : nullLabel(b.outputCapTokens)) : "not observed"}`,
    `extraction output ${nullLabel(b.extractionOutputTokens)} cap ${b.extractionOutputCapTokens === null ? "none" : nullLabel(b.extractionOutputCapTokens)}`,
    `safety ${nullLabel(b.safetyTokens)}`,
  ].join("\n");
}

function countsPreview(layout: ContextLayout): string {
  return `${layout.messageCount} messages / ${layout.blockCount} blocks\npackaging ${thousands(layout.packagingTokens)} · extra input ${thousands(layout.extraInputTokens)}\nheuristic ${tokenLabel(layout.heuristic.tokens, layout.heuristic.unknown)}`;
}

function nullLabel(value: number | null): string {
  return value === null ? "unknown" : thousands(value);
}

function scopeLegend(add: (node: CtxNode) => string): CtxNode {
  const children = [
    add({
      id: "legend:F",
      label: "F · Fixed (系统提示词与工具)",
      description: "有效 system prompt 与工具定义",
      preview: [
        "F (Fixed): 有效 system prompt 与可用工具定义。",
        "• 提供当前请求的基础运行环境与指令约束。",
        "• 并非绝对不可变：切换模型、修改配置或工具集时按当时有效设置重新确定。",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:M",
      label: "M · Memory (结构化工作记忆)",
      description: "当前有效工作记忆 slots 及预算",
      preview: [
        "M (Memory): 当前有效结构化工作记忆。",
        "• 由若干具名 slot（含 id 与正文）构成，每次主请求完整携带。",
        "• 承载跨越近期窗口继续工作所需的关键约束与事实，独立于消息条数。",
        "• 可通过人工编辑单条修改，或在触发维护时由模型提议增删。",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:R",
      label: "R · Raw history (活动原文历史)",
      description: "已交付并仍在活动上下文中的原文历史",
      preview: [
        "R (Raw history): 已交付并保留在当前活动上下文中的历史记录。",
        "• 包含近期对话的用户输入、助手回复与工具调用结果等。",
        "• 普通工作时保留完整原文，维护前 R 由 B 与 K 两部分构成 (R = B | K)。",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:B",
      label: "B · Retiring (选定退役的历史)",
      description: "维护时选定退役的较早原文前段",
      preview: [
        "B (Retiring): 维护时选定退出模型可见上下文的较早连续历史前段。",
        "• 仅在实际触发维护时根据当前窗口与保留目标切分确定，不会提前预测。",
        "• 退出上下文后仍保留在完整会话文件 (JSONL) 中，但后续模型请求不再加载。",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:K",
      label: "K · Kept (继续保留的近期历史)",
      description: "维护后继续逐字保留的近期原文后缀",
      preview: [
        "K (Kept): 维护后继续保留在活跃上下文中的近期原文历史后缀。",
        "• 保持原始输入顺序与内容，不重新生成或压缩。",
        "• 后续主请求携带有效 M 与保留的 K，继续处理新交付输入。",
      ].join("\n"),
      children: [],
    }),
    add({
      id: "legend:D",
      label: "D · 未交付输入",
      description: "排队中或尚未交付给模型的输入",
      preview: [
        "D (Queued): 排队中或尚未交付给模型的后续输入或在途指令。",
        "• 由 Pi 按原生队列与调度规则交付；交付前不进入 R 或维护来源。",
        "• 正式交付前不计入当前活动布局或维护切分。",
      ].join("\n"),
      children: [],
    }),
  ];
  return {
    id: "scope:legend",
    label: "Legend · 缩写说明",
    description: "F / M / R / B / K / D 语义",
    preview: [
      "Context 缩写说明 (Legend)：",
      "• F (Fixed): 当前有效 system prompt 与可用工具定义（随模型/配置重新确定）",
      "• M (Memory): 当前有效结构化工作记忆 slots 及预算（独立于消息条数）",
      "• R (Raw history): 已交付并保留在当前活动上下文中的原文历史 (R = B | K)",
      "• B (Retiring): 维护时选定退役的较早历史（实际维护时确定，不提前预测）",
      "• K (Kept): 维护后继续逐字保留的近期原文历史后缀（后续主请求协同处理新输入）",
      "• D (Queued): 排队中尚未交付的输入（交付前不进入 R 或维护来源）",
      "",
      "按 Enter 可进入查看各缩写的详细定义与设计含义。",
    ].join("\n"),
    children,
  };
}

