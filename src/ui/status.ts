import { VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Accounting } from "../engine/index.js";
import { inputLimit, mainAdmissionLimit, omitsSerializedOutputCap } from "../engine/accounting.js";
import { engineConfig, readConfig } from "../pi/config.js";
import type { MemoryView } from "../pi/manual.js";

export type FooterTone = "dim" | "accent" | "warning" | "error";
export interface CompactFooterInput {
  unavailable: boolean;
  occupied: boolean;
  unconfirmed: boolean;
  warning: boolean;
  slotCount: number;
  budget: { tokens: number; limit: number | null; unknown: boolean };
}
export interface DiagnosticNote { level: "warning" | "error" | "info"; message: string }

export const COMMAND_USAGE = "用法：/nunc [status|details]";
export const UNLOAD_LIMIT = "尚未纳入下一次原生 compaction 的人工修改需要新版 Nunc 解读；卸载或旧版仍读取上一次原生摘要。";

const COMPLETIONS = [
  { value: "details", label: "details", description: "查看预算与最近维护详情" },
  { value: "status", label: "status", description: "文字概览，不打开面板" },
] as const;

export function commandCompletions(prefix: string): { value: string; label: string; description: string }[] | null {
  const trimmed = prefix.trimStart();
  if (trimmed.includes(" ")) return null;
  const hits = COMPLETIONS.filter(item => item.value.startsWith(trimmed));
  return hits.length ? hits.map(item => ({ ...item })) : null;
}

export function compactFooter(input: CompactFooterInput): { text: string; tone: FooterTone } {
  if (input.unavailable) return { text: "nunc ×", tone: "error" };
  const n = String(input.slotCount);
  if (input.occupied) return { text: `nunc ↻ ${n}`, tone: "accent" };
  if (input.unconfirmed || input.warning) return { text: `nunc ! ${n}`, tone: "warning" };
  if (input.budget.unknown || input.budget.limit === null) return { text: `nunc ${n}·?`, tone: "dim" };
  if (input.budget.limit === 0) return { text: `nunc ${n}`, tone: "dim" };
  return { text: `nunc ${n}·${Math.round((input.budget.tokens / input.budget.limit) * 100)}%`, tone: "dim" };
}

export function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

export function statusLines(view: MemoryView, triggerTokens: number | undefined): string {
  return [
    `记忆：${view.memory.slots.length} 条`,
    `压缩触发：${triggerTokens === undefined ? "未选择模型" : `${thousands(triggerTokens)} tokens`}`,
    "预算详情：/nunc details",
  ].join("\n");
}

export function detailsLines(input: {
  view: MemoryView;
  ctx: ExtensionContext;
  configPath: string | undefined;
  compaction: Parameters<typeof engineConfig>[2];
  lastAccounting: Accounting | null;
  diagnostics: readonly DiagnosticNote[];
}): string {
  const selection = readConfig(input.configPath, input.ctx.cwd);
  const config = input.ctx.model ? engineConfig(selection.config, input.ctx.model, input.compaction) : undefined;
  const summary = [
    `记忆：${input.view.memory.slots.length} 条`,
    `压缩触发：${config ? thousands(config.triggerTokens) + " tokens" : "未选择模型"}`,
  ];
  const details = config && input.ctx.model ? [
    "", "输入预算（tokens）",
    `  主请求准入：${thousands(mainAdmissionLimit(input.ctx.model, config.main))}`,
    `  记忆规划：${thousands(inputLimit(input.ctx.model, config.main))}`,
    `  维护：${thousands(inputLimit(input.ctx.model, config.extraction))}`,
    "", "输出预留（tokens）",
    `  主请求：${thousands(config.main.nativeOutputReserve ?? config.main.outputTokens)}`,
    `  维护：${thousands(config.extraction.outputTokens)}`,
    `  维护输出 cap：${omitsSerializedOutputCap(input.ctx.model) ? "无" : thousands(config.extraction.outputTokens)}`,
    `安全余量：${thousands(config.extraction.safetyTokens)} tokens`,
  ] : [];
  const last = input.lastAccounting ? [
    "", "最近维护（本上下文）",
    `  输入估算：完整 ${thousands(input.lastAccounting.fullExtractionTokens)} → 选用 ${thousands(input.lastAccounting.extractionTokens)}`,
    `  正常触发余量：${input.lastAccounting.normalHeadroomSufficient ? "充足" : "不足；建议 reserveTokens ≥ " + thousands(input.lastAccounting.suggestedReserveTokens)}`,
    `  超出规划记录：输入${input.lastAccounting.inputExceededPlan ? "有" : "无"} / 输出${input.lastAccounting.outputExceededPlan ? "有" : "无"}`,
  ] : ["", "本上下文暂无维护记录。"];
  const notes = input.diagnostics.length === 0 ? [] : [
    "", "最近诊断",
    ...input.diagnostics.slice(-5).map(note => `  ${note.level}: ${firstLine(note.message)}`),
  ];
  return [...summary, ...details, ...last, ...notes, "", `Pi ${VERSION} · 预算为估算值`].join("\n");
}

function firstLine(message: string): string {
  const line = message.split("\n")[0] ?? message;
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
