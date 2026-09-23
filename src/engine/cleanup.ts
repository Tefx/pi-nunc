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
  return `[Nunc reversible TOC index]`;
}

/**
 * Truly lossless JSON compaction: strips whitespace outside strings while
 * preserving exact lexical characters for all numbers (including > 2^53),
 * duplicate keys, property ordering, and string literals.
 */
export function losslessCompactJson(text: string): string | null {
  const trimmed = text.trim();
  if ((!trimmed.startsWith("{") || !trimmed.endsWith("}")) && (!trimmed.startsWith("[") || !trimmed.endsWith("]"))) {
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

  // Verify structure has balanced brackets/braces
  const stack: string[] = [];
  inString = false;
  escape = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}") {
        if (stack.pop() !== "{") return null;
      } else if (ch === "]") {
        if (stack.pop() !== "[") return null;
      }
    }
  }
  if (stack.length !== 0 || inString) return null;

  if (hadWhitespaceOutsideString && out.length < text.length) {
    return out;
  }
  return null;
}

const SGR_ONLY_REGEX = /\x1b\[[0-9;]*m/g;
const UNSUPPORTED_ESCAPE_REGEX = /\x1b(?:\[[0-9;]*[A-LN-Za-ln-z]|\]|\(|\))/;

/** Clean terminal ANSI styling and CRLF only. Preserves unsupported terminal control streams. */
export function cleanTerminalText(text: string): string | null {
  // If text contains unsupported terminal control codes (cursor movement, OSC, etc.), preserve verbatim
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

/**
 * Reversible compact directory TOC: groups multi-line path listings by common
 * directory prefix, rendering a deterministic reversible index when space is saved.
 */
export function reversibleCompactToc(text: string): string | null {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 3) return null;

  // Check if every line looks like a valid file/directory path
  const looksLikePath = (l: string) => l.includes("/") && !l.includes(" ") && !l.startsWith("error") && !l.startsWith("warn");
  if (!lines.every(looksLikePath)) return null;

  // Group by directory prefix
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const lastSlash = line.lastIndexOf("/");
    const dir = line.slice(0, lastSlash + 1);
    const file = line.slice(lastSlash + 1);
    if (!file) return null;
    const list = groups.get(dir) ?? [];
    list.push(file);
    groups.set(dir, list);
  }

  // Only apply if grouping creates net savings (e.g. at least one directory with 2+ files)
  let multipleCount = 0;
  for (const list of groups.values()) {
    if (list.length >= 2) multipleCount++;
  }
  if (multipleCount === 0) return null;

  const entries: string[] = [];
  for (const [dir, files] of groups.entries()) {
    entries.push(`${dir}: [${files.join(", ")}]`);
  }
  const compact = `${formatTocMarker()}:\n${entries.join("\n")}`;

  if (compact.length < text.length) {
    return compact;
  }
  return null;
}

/** Check if two tool result texts share an identical multi-line static banner. */
function stripToolBoilerplate(text: string, firstText: string, firstRef: ToolResultRef): string | null {
  const firstLines = firstText.split("\n");
  const currentLines = text.split("\n");
  if (firstLines.length < 3 || currentLines.length < 3) return null;

  // Find common header lines
  let commonCount = 0;
  while (commonCount < firstLines.length && commonCount < currentLines.length && firstLines[commonCount] === currentLines[commonCount]) {
    commonCount++;
  }

  if (commonCount >= 2) {
    const commonPrefix = currentLines.slice(0, commonCount).join("\n") + "\n";
    if (commonPrefix.length >= 40) {
      const dynamicRemainder = text.slice(commonPrefix.length).trimStart();
      if (dynamicRemainder.length > 0) {
        const cleaned = `${formatBoilerplateMarker(firstRef)}\n${dynamicRemainder}`;
        if (cleaned.length < text.length) {
          return cleaned;
        }
      }
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

/** Extract text content of a message if it contains only text. Returns null if non-text present. */
function messageTextContent(message: ActiveEntry["messages"][number]): string | null {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    } else {
      // Non-text block present (e.g. image)
      return null;
    }
  }
  return text;
}

/** Map all assistant tool calls in active history by toolCallId. */
function extractToolCallMap(active: ActiveEntry[]): Map<string, { toolName: string; argsJson: string }> {
  const map = new Map<string, { toolName: string; argsJson: string }>();
  for (const entry of active) {
    for (const msg of entry.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "toolCall") {
            map.set(block.id, { toolName: block.name, argsJson: JSON.stringify(block.arguments) });
          }
        }
      }
    }
  }
  return map;
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

  // M unchanged or feature disabled: no new cleanups are applied.
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

  // Defect 1: Fail closed if candidateScope is missing, empty, or not provided.
  // Pure engine never manufactures candidate scope without an explicit safe anchor.
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
  // Candidate scope must be intersected with final retained entries.
  const retainedMessageKeys = new Set<string>();
  for (const entry of retainedEntries) {
    for (const [i] of entry.messages.entries()) {
      retainedMessageKeys.add(`${entry.entryId}:${i}`);
    }
  }
  // Remove any candidates that are not in final retained history
  for (const key of candidateScopeSet) {
    if (!retainedMessageKeys.has(key)) {
      candidateScopeSet.delete(key);
    }
  }

  // Map messages in active for fast lookup
  const messageMap = new Map<string, { entry: ActiveEntry; message: ActiveEntry["messages"][number]; messageIndex: number }>();
  for (const entry of active) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      messageMap.set(`${entry.entryId}:${messageIndex}`, { entry, message, messageIndex });
    }
  }

  // Extract tool call arguments to establish demonstrable same-source identity (Defect 3)
  const toolCallMap = extractToolCallMap(active);

  // Defect 7: Validate semantic edits first to catch duplicate/conflicting edits and invalid shapes
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
      const editsByRefKey = new Map<string, Record<string, unknown>[]>();

      for (const raw of semanticEdits) {
        if (!record(raw) || typeof raw.entryId !== "string" || !integer(raw.messageIndex)) {
          skipped.push({
            entryId: record(raw) && typeof raw.entryId === "string" ? raw.entryId : "",
            messageIndex: record(raw) && typeof raw.messageIndex === "number" ? raw.messageIndex : 0,
            reason: "invalid_shape",
            details: "Edit must be an object with string entryId and non-negative integer messageIndex",
          });
          continue;
        }

        // Defect 7: Check for unknown fields in edit
        const allowedKeys = ["entryId", "messageIndex", "action", "text", "memoryRefs", "sourceRefs"];
        const hasUnknown = Object.keys(raw).some(k => !allowedKeys.includes(k));
        if (hasUnknown) {
          skipped.push({
            entryId: raw.entryId,
            messageIndex: raw.messageIndex,
            ...(typeof raw.action === "string" ? { action: raw.action } : {}),
            reason: "invalid_shape",
            details: "Edit contains unrecognized fields",
          });
          continue;
        }

        const key = `${raw.entryId}:${raw.messageIndex}`;
        const list = editsByRefKey.get(key) ?? [];
        list.push(raw);
        editsByRefKey.set(key, list);
      }

      // Check duplicates / conflicting edits per target
      for (const [key, list] of editsByRefKey.entries()) {
        if (list.length > 1) {
          rejectedConflictKeys.add(key);
          for (const item of list) {
            skipped.push({
              entryId: String(item.entryId),
              messageIndex: Number(item.messageIndex),
              ...(typeof item.action === "string" ? { action: item.action } : {}),
              reason: "duplicate_edit",
              details: `Conflicting multiple edits in same batch for ${key}; retaining original`,
            });
          }
          continue;
        }

        const item = list[0]!;
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

        // Defect 7: Action 'omit' must NOT specify text (even null/0/'')
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

  // Step 1: Run mechanical rules on candidates in scope
  const protectedKeepers = new Set<string>();
  const mechanicalDecisions = new Map<string, ToolResultDecision>();

  // Map to find first occurrence of static boilerplate per toolName
  const firstOccurrenceByTool = new Map<string, { ref: ToolResultRef; text: string }>();

  // Deduplication tracker: map sameSourceKey -> keeper (must be in retainedEntries!)
  const seenIdentical = new Map<string, { ref: ToolResultRef; toolCallId: string; toolName: string; text: string }>();

  // Scan retainedEntries first for potential keepers, or active entries that are retained
  for (const entry of active) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      if (message.role !== "toolResult") continue;
      const ref: ToolResultRef = { entryId: entry.entryId, messageIndex };
      const key = refKey(ref);
      const text = messageTextContent(message);
      if (text === null) continue;

      const toolName = message.toolName;
      if (!firstOccurrenceByTool.has(toolName)) {
        firstOccurrenceByTool.set(toolName, { ref, text });
      }

      // Defect 3: Same-source identity requires same toolName AND same call arguments
      const call = toolCallMap.get(message.toolCallId);
      const isRetained = retainedMessageKeys.has(key);

      if (call) {
        const sameSourceKey = `${toolName}\0${call.argsJson}\0${text}`;
        const existing = seenIdentical.get(sameSourceKey);

        if (!existing) {
          // Defect 3: Only an entry in retainedEntries can be a keeper!
          if (isRetained) {
            seenIdentical.set(sameSourceKey, { ref, toolCallId: message.toolCallId, toolName, text });
          }
        } else if (candidateScopeSet.has(key) && !rejectedConflictKeys.has(key)) {
          // Both are same origin with identical text, and existing keeper is in retainedEntries!
          const marker = formatDeduplicateMarker(ref, existing.ref);
          const netSavings = text.length - marker.length;
          if (netSavings > 0) {
            // Protect keeper from ANY modifications
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

      // If not deduplicated, check other mechanical families (only for candidates in scope not in rejectedConflictKeys)
      if (candidateScopeSet.has(key) && !mechanicalDecisions.has(key) && !rejectedConflictKeys.has(key)) {
        // Family: Reversible directory TOC
        const compactToc = reversibleCompactToc(text);
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

        // Family: Truly lossless JSON compact (Defect 2)
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

        // Family: Constrained Terminal ANSI SGR & CRLF cleaning (Defect 2)
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

        // Family: Fixed tool launch boilerplate stripping (Defect 6)
        const first = firstOccurrenceByTool.get(toolName);
        if (first && refKey(first.ref) !== key) {
          const stripped = stripToolBoilerplate(text, first.text, first.ref);
          if (stripped !== null) {
            const netSavings = text.length - stripped.length;
            if (netSavings > 0) {
              mechanicalDecisions.set(key, {
                entryId: ref.entryId,
                messageIndex: ref.messageIndex,
                toolCallId: message.toolCallId,
                toolName,
                kind: "mechanical",
                action: "strip_boilerplate",
                text: stripped,
                originalLength: text.length,
                cleanedLength: stripped.length,
                netSavings,
                sourceRefs: [first.ref],
              });
            }
          }
        }
      }
    }
  }

  // Defect 3: Ensure protected keeper cannot have any mechanical reduction
  for (const keeperKey of protectedKeepers) {
    mechanicalDecisions.delete(keeperKey);
  }

  // Step 2: Evaluate candidate semantic edits
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

    // Check non-text content
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

    // Check omissions
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

    // Check mechanical keeper protection (Defect 3)
    if (protectedKeepers.has(key)) {
      skipped.push({
        entryId: edit.entryId,
        messageIndex: edit.messageIndex,
        action: edit.action,
        reason: "keeper_protected",
        details: "Tool result is a mechanical keeper for deduplicated results in this batch; retaining full copy",
      });
      continue;
    }

    // Check memory dependencies (memoryRefs)
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

    // Check source dependencies (sourceRefs)
    let sourceRefError: string | null = null;
    if (edit.sourceRefs && edit.sourceRefs.length > 0) {
      for (const sRef of edit.sourceRefs) {
        const sKey = refKey(sRef);
        if (!retainedMessageKeys.has(sKey)) {
          sourceRefError = `Source ref '${sKey}' is not in final retained history (retired or non-existent)`;
          break;
        }
        if (proposedSemanticOmitOrReplaceKeys.has(sKey)) {
          sourceRefError = `Source ref '${sKey}' is also being omitted/replaced in this batch`;
          break;
        }
        if (mechanicalDecisions.has(sKey) && mechanicalDecisions.get(sKey)?.action === "deduplicate") {
          sourceRefError = `Source ref '${sKey}' is deduplicated in this batch and not a full copy`;
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

    // Format uniform marker and check net savings
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

  // Merge approved decisions
  const finalDecisionMap = new Map<string, ToolResultDecision>();
  for (const [key, mech] of mechanicalDecisions.entries()) {
    if (!rejectedConflictKeys.has(key)) {
      finalDecisionMap.set(key, mech);
    }
  }
  for (const [key, sem] of approvedSemanticDecisions.entries()) {
    finalDecisionMap.set(key, sem);
  }

  // Order decisions stably according to entry order in active and message index
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

      // Defect 4: Keep mixed / non-text blocks untouched as contract states
      if (Array.isArray(message.content) && message.content.some(b => b.type !== "text")) {
        return structuredClone(message);
      }

      // Defect 4: Replace body exactly once with single text block; preserve all host metadata
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
