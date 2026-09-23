import type { ActiveEntry, CleanupAction, CleanupSkipped, CleanupSkippedReason, Memory, Omission, SourceRef, ToolResultDecision, ToolResultEdit, ToolResultCleanupResult, ToolResultRef } from "./types.js";
import { isMemoryUnchanged } from "./memory.js";
import { integer, nonempty, record } from "./validation.js";

export function refKey(ref: ToolResultRef): string {
  return `${ref.entryId}:${ref.messageIndex}`;
}

export function formatOmitMarker(ref: ToolResultRef): string {
  return `[Nunc: tool result omitted; original recoverable from entry ${ref.entryId} message ${ref.messageIndex}]`;
}

export function formatReplaceMarker(ref: ToolResultRef, summaryText: string): string {
  return `[Nunc summary; original recoverable from entry ${ref.entryId} message ${ref.messageIndex}]:\n${summaryText}`;
}

export function formatDeduplicateMarker(target: ToolResultRef, keeper: ToolResultRef): string {
  return `[Nunc: identical tool result deduplicated; identical to entry ${keeper.entryId} message ${keeper.messageIndex}]`;
}

export function formatBoilerplateMarker(firstRef: ToolResultRef): string {
  return `[Nunc: repeated tool boilerplate stripped; see entry ${firstRef.entryId} message ${firstRef.messageIndex}]`;
}

export function formatTocMarker(): string {
  return `[Nunc reversible Invar TOC v1]`;
}

/**
 * Lossless JSON compaction: validates full JSON syntax using JSON.parse as a
 * syntax check only, then strips whitespace strictly outside string literals.
 * Preserves exact original lexical representations of numbers (> 2^53, floats),
 * duplicate keys, and formatting. Returns null if invalid, already compact, or
 * not an object/array.
 */
export function losslessCompactJson(text: string): string | null {
  const trimmed = text.trim();
  if ((!trimmed.startsWith("{") || !trimmed.endsWith("}")) && (!trimmed.startsWith("[") || !trimmed.endsWith("]"))) {
    return null;
  }

  // Syntax validation: ensure input is valid JSON syntax without using parsed values
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object") return null;
  } catch {
    return null;
  }

  let inString = false;
  let escape = false;
  let out = "";
  let hadWhitespaceOutsideString = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        hadWhitespaceOutsideString = true;
      } else {
        out += ch;
      }
    }
  }

  if (inString || escape) return null;

  if (hadWhitespaceOutsideString && out.length < text.length) {
    return out;
  }
  return null;
}

const SGR_ONLY_REGEX = /\x1b\[[0-9;]*m/g;
const UNSUPPORTED_ESCAPE_REGEX = /\x1b(?:\[[0-9;]*[A-LN-Za-ln-z]|\]|\(|\))/;

/** Clean terminal ANSI styling and CRLF only. Preserves unsupported terminal control streams. */
export function cleanTerminalText(text: string): string | null {
  // If text contains unsupported terminal control codes (cursor movement, screen clear, OSC), preserve verbatim
  if (UNSUPPORTED_ESCAPE_REGEX.test(text)) {
    return null;
  }
  const hasSgr = SGR_ONLY_REGEX.test(text);
  const hasCrlf = text.includes("\r\n");
  if (!hasSgr && !hasCrlf) {
    return null;
  }

  const cleaned = text.replace(SGR_ONLY_REGEX, "").replace(/\r\n/g, "\n");
  if (cleaned !== text && cleaned.length < text.length) {
    return cleaned;
  }
  return null;
}

export interface InvarDocSection {
  level: number;
  title: string;
  slug: string;
  line_start: number;
  line_end: number;
  char_count: number;
  path?: string;
  children?: InvarDocSection[];
}

export interface InvarDocTocPayload {
  frontmatter?: Record<string, unknown> | null;
  sections: InvarDocSection[];
}

function validateInvarSection(s: unknown): s is InvarDocSection {
  if (!record(s)) return false;
  if (!integer(s.level, 1) || typeof s.title !== "string" || typeof s.slug !== "string") return false;
  if (!integer(s.line_start, 0) || !integer(s.line_end, 0) || !integer(s.char_count, 0)) return false;
  if (s.path !== undefined && typeof s.path !== "string") return false;
  if (s.children !== undefined) {
    if (!Array.isArray(s.children) || !s.children.every(validateInvarSection)) return false;
  }
  return true;
}

function flattenInvarSections(sections: InvarDocSection[], prefix = ""): { section: InvarDocSection; fullSlug: string }[] {
  const result: { section: InvarDocSection; fullSlug: string }[] = [];
  for (const s of sections) {
    const fullSlug = prefix ? `${prefix}/${s.slug}` : s.slug;
    result.push({ section: s, fullSlug });
    if (s.children && s.children.length > 0) {
      result.push(...flattenInvarSections(s.children, fullSlug));
    }
  }
  return result;
}

/**
 * Truly invertible compact encoding for Invar Doc TOC tool results.
 * Preserves hierarchy, headings, slug, line ranges, char counts, and ordering.
 */
export function compactInvarDocToc(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!record(parsed) || !Array.isArray(parsed.sections) || parsed.sections.length === 0) return null;
  if (!parsed.sections.every(validateInvarSection)) return null;

  const flat = flattenInvarSections(parsed.sections as InvarDocSection[]);
  const lines: string[] = [formatTocMarker()];
  if (parsed.frontmatter !== undefined && parsed.frontmatter !== null && record(parsed.frontmatter)) {
    lines.push(`FM:${JSON.stringify(parsed.frontmatter)}`);
  }

  for (const { section } of flat) {
    lines.push(`L${section.level}|${section.line_start}-${section.line_end}|${section.char_count}|${section.slug}|${section.title}`);
  }

  const encoded = lines.join("\n");
  if (encoded.length < text.length) {
    return encoded;
  }
  return null;
}

/** Decoder for compact Invar Doc TOC encoding. Guaranteed roundtrip invertibility. */
export function decodeInvarDocToc(encoded: string): InvarDocTocPayload | null {
  const lines = encoded.split("\n");
  if (lines.length < 2 || lines[0] !== formatTocMarker()) return null;

  let frontmatter: Record<string, unknown> | null = null;
  let startIdx = 1;
  if (lines[1]?.startsWith("FM:")) {
    try {
      frontmatter = JSON.parse(lines[1].slice(3));
    } catch {
      return null;
    }
    startIdx = 2;
  }

  const flat: InvarDocSection[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("L")) return null;
    const parts = line.slice(1).split("|");
    if (parts.length !== 5) return null;

    const level = parseInt(parts[0]!, 10);
    const rangeParts = parts[1]!.split("-");
    if (rangeParts.length !== 2) return null;
    const line_start = parseInt(rangeParts[0]!, 10);
    const line_end = parseInt(rangeParts[1]!, 10);
    const char_count = parseInt(parts[2]!, 10);
    const slug = parts[3]!;
    const title = parts[4]!;

    if (!Number.isSafeInteger(level) || !Number.isSafeInteger(line_start) || !Number.isSafeInteger(line_end) || !Number.isSafeInteger(char_count)) {
      return null;
    }

    flat.push({
      level,
      title,
      slug,
      line_start,
      line_end,
      char_count,
      children: [],
    });
  }

  // Reconstruct tree and paths from level hierarchy
  const rootSections: InvarDocSection[] = [];
  const stack: { section: InvarDocSection; fullSlug: string }[] = [];

  for (const s of flat) {
    while (stack.length > 0 && stack.at(-1)!.section.level >= s.level) {
      stack.pop();
    }
    const parent = stack.at(-1);
    const fullSlug = parent ? `${parent.fullSlug}/${s.slug}` : s.slug;
    s.path = fullSlug;

    if (parent) {
      parent.section.children!.push(s);
    } else {
      rootSections.push(s);
    }
    stack.push({ section: s, fullSlug });
  }

  return {
    ...(frontmatter !== null ? { frontmatter } : { frontmatter: null }),
    sections: rootSections,
  };
}

export const KNOWN_LAUNCH_BOILERPLATES = [
  "=== Invar Guard static analysis and contract verification ===\nRunning doctest + hypothesis + crosshair\n",
  "[CodeGraph] Server initialized\nDatabase index: ready\nCall graph available\n",
  "[pty-driver] POSIX PTY session opened\nProcess attached\n",
  "=== Test Runner Context ===\nEnvironment: POSIX PTY\nNode test runner initialized\n",
];

function matchKnownBoilerplate(text: string): string | null {
  for (const pattern of KNOWN_LAUNCH_BOILERPLATES) {
    if (text.startsWith(pattern)) {
      return pattern;
    }
  }
  return null;
}

export interface CleanupDecisionOptions {
  active: ActiveEntry[];
  candidateScope?: ToolResultRef[] | Set<string> | undefined;
  retainedEntries: ActiveEntry[];
  initialMemory: Memory;
  finalMemory: Memory;
  keyToSlotMap?: Map<string, string> | undefined;
  retainedKeys?: Set<string> | undefined;
  semanticEdits?: unknown;
  omissions?: Omission[] | undefined;
  disabled?: boolean | undefined;
}

function messageTextContent(message: ActiveEntry["messages"][number]): string | null {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    } else {
      return null;
    }
  }
  return text;
}

/**
 * Build ordered linear toolCall -> toolResult association map.
 * Preserves existing source association contract across reused toolCall IDs.
 */
function extractToolCallAssociationMap(active: ActiveEntry[]): Map<string, { toolName: string; argsJson: string }> {
  const resultCallMap = new Map<string, { toolName: string; argsJson: string }>();
  const openCalls = new Map<string, { toolName: string; argsJson: string }>();

  for (const entry of active) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "toolCall") {
            openCalls.set(block.id, { toolName: block.name, argsJson: JSON.stringify(block.arguments) });
          }
        }
      } else if (message.role === "toolResult") {
        const call = openCalls.get(message.toolCallId);
        if (call && call.toolName === message.toolName) {
          resultCallMap.set(`${entry.entryId}:${messageIndex}`, call);
          openCalls.delete(message.toolCallId);
        }
      }
    }
  }

  return resultCallMap;
}

/** Pure deterministic decision engine for mechanical rules and semantic tool-result edits. */
export function decideToolResultCleanup(options: CleanupDecisionOptions): ToolResultCleanupResult {
  const {
    active,
    retainedEntries,
    initialMemory,
    finalMemory,
    keyToSlotMap = new Map(),
    retainedKeys = new Set(finalMemory.slots.map(s => s.id)),
    semanticEdits,
    omissions = [],
    disabled = false,
  } = options;

  const applied: ToolResultDecision[] = [];
  const skipped: CleanupSkipped[] = [];

  const mChanged = !isMemoryUnchanged(initialMemory, finalMemory);
  if (!mChanged || disabled) {
    if (Array.isArray(semanticEdits)) {
      for (const edit of semanticEdits) {
        if (record(edit) && typeof edit.entryId === "string" && integer(edit.messageIndex)) {
          skipped.push({
            entryId: edit.entryId,
            messageIndex: edit.messageIndex,
            ...(typeof edit.action === "string" ? { action: edit.action } : {}),
            reason: disabled ? "not_in_candidate_scope" : "m_unchanged",
            details: disabled ? "Tool result cleanup feature disabled" : "Memory M did not change in this transaction",
          });
        }
      }
    }
    return { applied: [], skipped };
  }

  // Candidate scope must be explicitly supplied by caller; pure engine never manufactures scope
  const candidateScopeSet = new Set<string>();
  if (Array.isArray(options.candidateScope)) {
    for (const ref of options.candidateScope) {
      if (record(ref) && typeof ref.entryId === "string" && integer(ref.messageIndex)) {
        candidateScopeSet.add(refKey(ref));
      }
    }
  } else if (options.candidateScope instanceof Set) {
    for (const key of options.candidateScope) {
      if (typeof key === "string") candidateScopeSet.add(key);
    }
  }

  // Intersect candidate scope with final retained entries
  const retainedMessageKeys = new Set<string>();
  for (const entry of retainedEntries) {
    for (const [i] of entry.messages.entries()) {
      retainedMessageKeys.add(`${entry.entryId}:${i}`);
    }
  }
  for (const key of candidateScopeSet) {
    if (!retainedMessageKeys.has(key)) {
      candidateScopeSet.delete(key);
    }
  }

  const messageMap = new Map<string, { entry: ActiveEntry; message: ActiveEntry["messages"][number]; messageIndex: number }>();
  for (const entry of active) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      messageMap.set(`${entry.entryId}:${messageIndex}`, { entry, message, messageIndex });
    }
  }

  const toolCallMap = extractToolCallAssociationMap(active);

  // Group all edits by target key first to prevent malformed edits from masking conflict
  const candidateSemanticEdits: ToolResultEdit[] = [];
  const rejectedConflictKeys = new Set<string>();

  if (semanticEdits !== undefined) {
    if (!Array.isArray(semanticEdits)) {
      skipped.push({
        entryId: "",
        messageIndex: 0,
        reason: "invalid_shape",
        details: "toolResultEdits must be an array",
      });
    } else {
      const editsByRefKey = new Map<string, unknown[]>();

      for (const raw of semanticEdits) {
        if (record(raw) && typeof raw.entryId === "string" && integer(raw.messageIndex)) {
          const key = `${raw.entryId}:${raw.messageIndex}`;
          const list = editsByRefKey.get(key) ?? [];
          list.push(raw);
          editsByRefKey.set(key, list);
        } else {
          skipped.push({
            entryId: record(raw) && typeof raw.entryId === "string" ? raw.entryId : "",
            messageIndex: record(raw) && typeof raw.messageIndex === "number" ? raw.messageIndex : 0,
            reason: "invalid_shape",
            details: "Edit must be an object with string entryId and non-negative integer messageIndex",
          });
        }
      }

      // Check duplicates / conflicting edits per target
      for (const [key, list] of editsByRefKey.entries()) {
        if (list.length > 1) {
          rejectedConflictKeys.add(key);
          for (const item of list) {
            const r = record(item) ? item : {};
            skipped.push({
              entryId: typeof r.entryId === "string" ? r.entryId : "",
              messageIndex: typeof r.messageIndex === "number" ? r.messageIndex : 0,
              ...(typeof r.action === "string" ? { action: r.action } : {}),
              reason: "duplicate_edit",
              details: `Conflicting multiple edits in same batch for ${key}; retaining original`,
            });
          }
          continue;
        }

        const item = list[0]!;
        if (!record(item)) continue;

        const allowedKeys = ["entryId", "messageIndex", "action", "text", "memoryRefs", "sourceRefs"];
        const hasUnknown = Object.keys(item).some(k => !allowedKeys.includes(k));
        if (hasUnknown) {
          skipped.push({
            entryId: String(item.entryId),
            messageIndex: Number(item.messageIndex),
            ...(typeof item.action === "string" ? { action: item.action } : {}),
            reason: "invalid_shape",
            details: "Edit contains unrecognized fields",
          });
          continue;
        }

        const action = item.action;
        if (action !== "omit" && action !== "replace") {
          skipped.push({
            entryId: String(item.entryId),
            messageIndex: Number(item.messageIndex),
            ...(typeof action === "string" ? { action: action } : {}),
            reason: "invalid_shape",
            details: `Invalid action '${String(action)}'; must be 'omit' or 'replace'`,
          });
          continue;
        }

        if (action === "replace" && !nonempty(item.text)) {
          skipped.push({
            entryId: String(item.entryId),
            messageIndex: Number(item.messageIndex),
            action: "replace",
            reason: "invalid_shape",
            details: "Action 'replace' requires non-empty string text",
          });
          continue;
        }

        // Action 'omit' must not specify text (even null/0/'')
        if (action === "omit" && "text" in item && item.text !== undefined) {
          skipped.push({
            entryId: String(item.entryId),
            messageIndex: Number(item.messageIndex),
            action: "omit",
            reason: "invalid_shape",
            details: "Action 'omit' must not specify text",
          });
          continue;
        }

        let memoryRefs: string[] | undefined = undefined;
        if ("memoryRefs" in item && item.memoryRefs !== undefined) {
          if (!Array.isArray(item.memoryRefs) || !item.memoryRefs.every(ref => typeof ref === "string" && ref.trim().length > 0)) {
            skipped.push({
              entryId: String(item.entryId),
              messageIndex: Number(item.messageIndex),
              action: action as "omit" | "replace",
              reason: "invalid_shape",
              details: "memoryRefs must be an array of non-empty strings",
            });
            continue;
          }
          memoryRefs = item.memoryRefs as string[];
        }

        let sourceRefs: SourceRef[] | undefined = undefined;
        if ("sourceRefs" in item && item.sourceRefs !== undefined) {
          if (
            !Array.isArray(item.sourceRefs) ||
            !item.sourceRefs.every(ref => record(ref) && typeof ref.entryId === "string" && integer(ref.messageIndex))
          ) {
            skipped.push({
              entryId: String(item.entryId),
              messageIndex: Number(item.messageIndex),
              action: action as "omit" | "replace",
              reason: "invalid_shape",
              details: "sourceRefs must be an array of { entryId, messageIndex } objects",
            });
            continue;
          }
          sourceRefs = item.sourceRefs as SourceRef[];
        }

        candidateSemanticEdits.push({
          entryId: String(item.entryId),
          messageIndex: Number(item.messageIndex),
          action: action as "omit" | "replace",
          ...(action === "replace" ? { text: String(item.text) } : {}),
          ...(memoryRefs !== undefined ? { memoryRefs } : {}),
          ...(sourceRefs !== undefined ? { sourceRefs } : {}),
        });
      }
    }
  }

  // Mechanical rules evaluation
  const protectedKeepers = new Set<string>();
  const mechanicalDecisions = new Map<string, ToolResultDecision>();

  // Boilerplate keeper tracker: pattern -> keeper in retainedEntries
  const boilerplateKeepers = new Map<string, { ref: ToolResultRef; toolName: string }>();

  // Deduplication tracker: sameSourceKey -> keeper in retainedEntries
  const seenIdentical = new Map<string, { ref: ToolResultRef; toolCallId: string; toolName: string; text: string }>();

  for (const entry of active) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      if (message.role !== "toolResult") continue;
      const ref: ToolResultRef = { entryId: entry.entryId, messageIndex };
      const key = refKey(ref);
      const text = messageTextContent(message);
      if (text === null) continue;

      const toolName = message.toolName;
      const call = toolCallMap.get(key);
      const isRetained = retainedMessageKeys.has(key);

      // Track known launch boilerplate keeper (must be retained)
      const matchedBoilerplate = matchKnownBoilerplate(text);
      if (matchedBoilerplate !== null) {
        const existingBp = boilerplateKeepers.get(matchedBoilerplate);
        if (!existingBp && isRetained) {
          boilerplateKeepers.set(matchedBoilerplate, { ref, toolName });
        } else if (existingBp && candidateScopeSet.has(key) && !rejectedConflictKeys.has(key)) {
          // Dynamic remainder after stripped boilerplate
          const remainder = text.slice(matchedBoilerplate.length).trimStart();
          const cleaned = `${formatBoilerplateMarker(existingBp.ref)}\n${remainder}`;
          const netSavings = text.length - cleaned.length;
          if (netSavings > 0) {
            protectedKeepers.add(refKey(existingBp.ref));
            mechanicalDecisions.set(key, {
              entryId: ref.entryId,
              messageIndex: ref.messageIndex,
              toolCallId: message.toolCallId,
              toolName,
              kind: "mechanical",
              action: "strip_boilerplate",
              text: cleaned,
              originalLength: text.length,
              cleanedLength: cleaned.length,
              netSavings,
              sourceRefs: [existingBp.ref],
            });
          }
        }
      }

      // Deduplication: require matching toolName AND call arguments
      if (call) {
        const sameSourceKey = `${toolName}\0${call.argsJson}\0${text}`;
        const existing = seenIdentical.get(sameSourceKey);

        if (!existing) {
          if (isRetained) {
            seenIdentical.set(sameSourceKey, { ref, toolCallId: message.toolCallId, toolName, text });
          }
        } else if (candidateScopeSet.has(key) && !rejectedConflictKeys.has(key) && !mechanicalDecisions.has(key)) {
          const marker = formatDeduplicateMarker(ref, existing.ref);
          const netSavings = text.length - marker.length;
          if (netSavings > 0) {
            protectedKeepers.add(refKey(existing.ref));
            mechanicalDecisions.set(key, {
              entryId: ref.entryId,
              messageIndex: ref.messageIndex,
              toolCallId: message.toolCallId,
              toolName,
              kind: "mechanical",
              action: "deduplicate",
              text: marker,
              originalLength: text.length,
              cleanedLength: marker.length,
              netSavings,
              sourceRefs: [existing.ref],
            });
          }
        }
      }

      // If not deduplicated or stripped, check Invar TOC, JSON compaction, and terminal cleaning
      if (candidateScopeSet.has(key) && !mechanicalDecisions.has(key) && !rejectedConflictKeys.has(key)) {
        // Family: Reversible Invar Doc TOC
        const compactToc = compactInvarDocToc(text);
        if (compactToc !== null) {
          const netSavings = text.length - compactToc.length;
          if (netSavings > 0) {
            mechanicalDecisions.set(key, {
              entryId: ref.entryId,
              messageIndex: ref.messageIndex,
              toolCallId: message.toolCallId,
              toolName,
              kind: "mechanical",
              action: "compact_toc",
              text: compactToc,
              originalLength: text.length,
              cleanedLength: compactToc.length,
              netSavings,
            });
            continue;
          }
        }

        // Family: Truly lossless JSON compact
        const compactJson = losslessCompactJson(text);
        if (compactJson !== null) {
          const netSavings = text.length - compactJson.length;
          if (netSavings > 0) {
            mechanicalDecisions.set(key, {
              entryId: ref.entryId,
              messageIndex: ref.messageIndex,
              toolCallId: message.toolCallId,
              toolName,
              kind: "mechanical",
              action: "compact_json",
              text: compactJson,
              originalLength: text.length,
              cleanedLength: compactJson.length,
              netSavings,
            });
            continue;
          }
        }

        // Family: Constrained Terminal ANSI SGR & CRLF cleaning
        const cleanedTerminal = cleanTerminalText(text);
        if (cleanedTerminal !== null) {
          const netSavings = text.length - cleanedTerminal.length;
          if (netSavings > 0) {
            mechanicalDecisions.set(key, {
              entryId: ref.entryId,
              messageIndex: ref.messageIndex,
              toolCallId: message.toolCallId,
              toolName,
              kind: "mechanical",
              action: "clean_terminal",
              text: cleanedTerminal,
              originalLength: text.length,
              cleanedLength: cleanedTerminal.length,
              netSavings,
            });
            continue;
          }
        }
      }
    }
  }

  // Protected keepers receive ZERO mechanical modifications
  for (const keeperKey of protectedKeepers) {
    mechanicalDecisions.delete(keeperKey);
  }

  // Semantic edits evaluation
  const approvedSemanticDecisions = new Map<string, ToolResultDecision>();
  const proposedSemanticOmitOrReplaceKeys = new Set(candidateSemanticEdits.map(e => refKey(e)));

  for (const edit of candidateSemanticEdits) {
    const key = refKey(edit);
    const itemInfo = messageMap.get(key);

    if (!itemInfo) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "not_a_tool_result",
        details: "Referenced entry or message was not found in active history",
      });
      continue;
    }

    if (itemInfo.message.role !== "toolResult") {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "not_a_tool_result",
        details: `Referenced message role is '${itemInfo.message.role}', not 'toolResult'`,
      });
      continue;
    }

    if (!candidateScopeSet.has(key)) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "not_in_candidate_scope",
        details: "Tool result is not within the eligible candidate scope",
      });
      continue;
    }

    const originalText = messageTextContent(itemInfo.message);
    if (originalText === null) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "non_text_content",
        details: "Tool result contains non-text or mixed blocks (e.g. image); semantic edit refused",
      });
      continue;
    }

    const hasOmissions = omissions.some(o => o.entryId === edit.entryId && o.messageIndex === edit.messageIndex);
    if (hasOmissions) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "has_omissions",
        details: "Tool result had omissions in extraction input; incomplete source cannot be semantically cleaned",
      });
      continue;
    }

    // Protected keeper check across all families (deduplication & boilerplate)
    if (protectedKeepers.has(key)) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "keeper_protected",
        details: "Tool result is a protected keeper for results in this batch; retaining full copy",
      });
      continue;
    }

    // Memory dependencies validation
    let memoryRefError: string | null = null;
    const finalMemoryRefs: string[] = [];
    if (edit.memoryRefs && edit.memoryRefs.length > 0) {
      for (const mRef of edit.memoryRefs) {
        if (!retainedKeys.has(mRef)) {
          memoryRefError = `Dependency memory ref '${mRef}' was removed or dropped by budget selection`;
          break;
        }
        finalMemoryRefs.push(keyToSlotMap.get(mRef) ?? mRef);
      }
    }
    if (memoryRefError !== null) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "missing_memory_dependency",
        details: memoryRefError,
      });
      continue;
    }

    // Source dependencies validation: must point to a full, unmodified source message
    let sourceRefError: string | null = null;
    if (edit.sourceRefs && edit.sourceRefs.length > 0) {
      for (const sRef of edit.sourceRefs) {
        const sKey = refKey(sRef);
        if (!retainedMessageKeys.has(sKey)) {
          sourceRefError = `Source ref '${sKey}' is not in final retained history (retired or non-existent)`;
          break;
        }
        // Full source condition: cannot point to a message being modified semantically or mechanically
        if (proposedSemanticOmitOrReplaceKeys.has(sKey)) {
          sourceRefError = `Source ref '${sKey}' is also being omitted/replaced in this batch`;
          break;
        }
        if (mechanicalDecisions.has(sKey)) {
          sourceRefError = `Source ref '${sKey}' receives a mechanical modification in this batch and is not a full original copy`;
          break;
        }
      }
    }
    if (sourceRefError !== null) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "missing_source_dependency",
        details: sourceRefError,
      });
      continue;
    }

    const cleanedText = edit.action === "omit"
      ? formatOmitMarker(edit)
      : formatReplaceMarker(edit, edit.text!);

    const netSavings = originalText.length - cleanedText.length;
    if (netSavings <= 0) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "no_net_savings",
        details: `Cleaned text length (${cleanedText.length}) >= original text length (${originalText.length})`,
      });
      continue;
    }

    approvedSemanticDecisions.set(key, {
      entryId: edit.entryId,
      messageIndex: edit.messageIndex,
      toolCallId: itemInfo.message.toolCallId,
      toolName: itemInfo.message.toolName,
      kind: "semantic",
      action: edit.action,
      text: cleanedText,
      originalLength: originalText.length,
      cleanedLength: cleanedText.length,
      netSavings,
      ...(finalMemoryRefs.length > 0 ? { memoryRefs: finalMemoryRefs } : {}),
      ...(edit.sourceRefs && edit.sourceRefs.length > 0 ? { sourceRefs: edit.sourceRefs } : {}),
    });
  }

  // Merge approved decisions; conflicting targets receive no mechanical decisions
  const finalDecisionMap = new Map<string, ToolResultDecision>();
  for (const [key, mech] of mechanicalDecisions.entries()) {
    if (!rejectedConflictKeys.has(key)) {
      finalDecisionMap.set(key, mech);
    }
  }
  for (const [key, sem] of approvedSemanticDecisions.entries()) {
    finalDecisionMap.set(key, sem);
  }

  // Stable ordering by active entry and message index
  for (const entry of active) {
    for (const [messageIndex] of entry.messages.entries()) {
      const key = `${entry.entryId}:${messageIndex}`;
      const decision = finalDecisionMap.get(key);
      if (decision) {
        applied.push(decision);
      }
    }
  }

  return { applied, skipped };
}

/** Pure helper to project active entries with applied tool-result cleanups. Returns a new detached copy. */
export function applyToolResultCleanup(entries: ActiveEntry[], decisions: ToolResultDecision[]): ActiveEntry[] {
  if (decisions.length === 0) return structuredClone(entries);

  const decisionMap = new Map<string, ToolResultDecision>();
  for (const d of decisions) {
    decisionMap.set(`${d.entryId}:${d.messageIndex}`, d);
  }

  const result: ActiveEntry[] = [];
  for (const entry of entries) {
    const newMessages = entry.messages.map((message, messageIndex) => {
      const decision = decisionMap.get(`${entry.entryId}:${messageIndex}`);
      if (!decision || message.role !== "toolResult") {
        return structuredClone(message);
      }

      // Keep mixed / non-text blocks untouched
      if (Array.isArray(message.content) && message.content.some(b => b.type !== "text")) {
        return structuredClone(message);
      }

      // Replace text body exactly once; preserve all host metadata via copy
      const newContent = [{ type: "text" as const, text: decision.text }];

      return {
        ...structuredClone(message),
        content: newContent,
      };
    });

    result.push({
      ...structuredClone(entry),
      messages: newMessages,
    });
  }

  return result;
}
