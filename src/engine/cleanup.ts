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

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\([a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function cleanTerminalText(text: string): string {
  const noAnsi = text.replace(ANSI_REGEX, "");
  return noAnsi.replace(/\r\n?/g, "\n");
}

function tryCompactJson(text: string): string | null {
  const trimmed = text.trim();
  if ((!trimmed.startsWith("{") || !trimmed.endsWith("}")) && (!trimmed.startsWith("[") || !trimmed.endsWith("]"))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object") return null;
    const compact = JSON.stringify(parsed);
    if (compact.length < text.length) return compact;
  } catch {
    // Unknown format or invalid JSON; preserve original
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
            action: typeof edit.action === "string" ? edit.action : undefined,
            reason: disabled ? "not_in_candidate_scope" : "m_unchanged",
            details: disabled ? "Tool result cleanup feature disabled" : "Memory M did not change in this transaction",
          });
        }
      }
    }
    return { applied: [], skipped };
  }

  // Resolve candidate scope as a Set<string> ("entryId:messageIndex")
  const candidateScopeSet = new Set<string>();
  if (options.candidateScope instanceof Set) {
    for (const key of options.candidateScope) candidateScopeSet.add(key);
  } else if (Array.isArray(options.candidateScope)) {
    for (const ref of options.candidateScope) {
      if (record(ref) && typeof ref.entryId === "string" && integer(ref.messageIndex)) {
        candidateScopeSet.add(refKey(ref));
      }
    }
  } else {
    // Default candidate scope: completed toolResult messages in retainedEntries
    // excluding the latest business tool group.
    const toolEntries = retainedEntries.filter(e => e.sourceRole === "toolResult");
    const eligibleEntries = toolEntries.length > 1 ? toolEntries.slice(0, -1) : toolEntries;
    for (const entry of eligibleEntries) {
      for (const [idx, msg] of entry.messages.entries()) {
        if (msg.role === "toolResult") {
          candidateScopeSet.add(`${entry.entryId}:${idx}`);
        }
      }
    }
  }

  // Map messages in active for fast lookup
  const messageMap = new Map<string, { entry: ActiveEntry; message: ActiveEntry["messages"][number]; messageIndex: number }>();
  for (const entry of active) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      messageMap.set(`${entry.entryId}:${messageIndex}`, { entry, message, messageIndex });
    }
  }

  // Retained messages set for sourceRefs verification
  const retainedMessageKeys = new Set<string>();
  for (const entry of retainedEntries) {
    for (let i = 0; i < entry.messages.entries.length; i++) {
      retainedMessageKeys.add(`${entry.entryId}:${i}`);
    }
    for (const [i] of entry.messages.entries()) {
      retainedMessageKeys.add(`${entry.entryId}:${i}`);
    }
  }

  // Step 1: Run mechanical rules on candidates in scope
  const protectedKeepers = new Set<string>();
  const mechanicalDecisions = new Map<string, ToolResultDecision>();

  // Deduplication tracker: map toolName:text -> keeper
  const seenIdentical = new Map<string, { ref: ToolResultRef; toolCallId: string; toolName: string; text: string }>();

  for (const entry of active) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      if (message.role !== "toolResult") continue;
      const ref: ToolResultRef = { entryId: entry.entryId, messageIndex };
      const key = refKey(ref);
      const text = messageTextContent(message);
      if (text === null) continue; // Skip non-text or mixed blocks

      const toolName = message.toolName;
      const idKey = `${toolName}\0${text}`;

      const existing = seenIdentical.get(idKey);
      if (!existing) {
        seenIdentical.set(idKey, { ref, toolCallId: message.toolCallId, toolName, text });
      } else {
        // We found an identical earlier occurrence!
        if (candidateScopeSet.has(key)) {
          const marker = formatDeduplicateMarker(ref, existing.ref);
          const netSavings = text.length - marker.length;
          if (netSavings > 0) {
            // Protect keeper from semantic edits in this batch
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

      // If not deduplicated, check JSON compaction and terminal cleaning
      if (candidateScopeSet.has(key) && !mechanicalDecisions.has(key)) {
        // Try terminal ANSI clean first
        let currentText = text;
        const cleanedTerminal = cleanTerminalText(currentText);
        let action: CleanupAction | null = null;
        if (cleanedTerminal !== currentText && cleanedTerminal.length < currentText.length) {
          currentText = cleanedTerminal;
          action = "clean_terminal";
        }

        // Try JSON compaction
        const compactJson = tryCompactJson(currentText);
        if (compactJson !== null && compactJson.length < currentText.length) {
          currentText = compactJson;
          action = "compact_json";
        }

        if (action !== null) {
          const netSavings = text.length - currentText.length;
          if (netSavings > 0) {
            mechanicalDecisions.set(key, {
              entryId: ref.entryId,
              messageIndex: ref.messageIndex,
              toolCallId: message.toolCallId,
              toolName,
              kind: "mechanical",
              action,
              text: currentText,
              originalLength: text.length,
              cleanedLength: currentText.length,
              netSavings,
            });
          }
        }
      }
    }
  }

  // Step 2: Validate semantic edits
  const candidateSemanticEdits: ToolResultEdit[] = [];
  if (Array.isArray(semanticEdits)) {
    const rawEdits = semanticEdits;
    const editsByRefKey = new Map<string, unknown[]>();

    for (const raw of rawEdits) {
      if (!record(raw) || typeof raw.entryId !== "string" || !integer(raw.messageIndex)) {
        skipped.push({
          entryId: typeof raw === "object" && raw !== null && "entryId" in raw && typeof raw.entryId === "string" ? raw.entryId : "",
          messageIndex: typeof raw === "object" && raw !== null && "messageIndex" in raw && typeof raw.messageIndex === "number" ? raw.messageIndex : 0,
          reason: "invalid_shape",
          details: "Edit must be an object with string entryId and non-negative integer messageIndex",
        });
        continue;
      }

      const key = `${raw.entryId}:${raw.messageIndex}`;
      const list = editsByRefKey.get(key) ?? [];
      list.push(raw);
      editsByRefKey.set(key, list);
    }

    // Detect duplicate / batch conflict edits
    for (const [key, list] of editsByRefKey.entries()) {
      if (list.length > 1) {
        for (const item of list) {
          const r = item as Record<string, unknown>;
          skipped.push({
            entryId: String(r.entryId),
            messageIndex: Number(r.messageIndex),
            action: typeof r.action === "string" ? r.action : undefined,
            reason: "duplicate_edit",
            details: `Conflicting multiple edits in same batch for ${key}; retaining original`,
          });
        }
        continue;
      }

      const item = list[0] as Record<string, unknown>;
      const action = item.action;
      if (action !== "omit" && action !== "replace") {
        skipped.push({
          entryId: String(item.entryId),
          messageIndex: Number(item.messageIndex),
          action: typeof action === "string" ? action : undefined,
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
          details: "Action 'replace' requires non-empty text",
        });
        continue;
      }

      if (action === "omit" && item.text !== undefined && nonempty(item.text)) {
        skipped.push({
          entryId: String(item.entryId),
          messageIndex: Number(item.messageIndex),
          action: "omit",
          reason: "invalid_shape",
          details: "Action 'omit' must not carry replacement text",
        });
        continue;
      }

      let memoryRefs: string[] | undefined = undefined;
      if (item.memoryRefs !== undefined) {
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
      if (item.sourceRefs !== undefined) {
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
        text: action === "replace" ? String(item.text) : undefined,
        memoryRefs,
        sourceRefs,
      });
    }
  }

  // Step 3: Evaluate each candidate semantic edit against dependencies, scope, keepers, omissions, and savings
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

    // Check mechanical keeper protection
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
        // Source ref must point to a fully retained message (not omitted/replaced/deduplicated in this batch)
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

  // Step 4: Merge approved mechanical and semantic decisions
  // Semantic decisions override mechanical JSON/terminal cleanups for the same key.
  const finalDecisionMap = new Map<string, ToolResultDecision>();
  for (const [key, mech] of mechanicalDecisions.entries()) {
    finalDecisionMap.set(key, mech);
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
      if (!decision || message.role !== "toolResult") return structuredClone(message);

      // Keep role, toolCallId, toolName, isError, timestamp; replace text block
      const newContent = typeof message.content === "string"
        ? [{ type: "text" as const, text: decision.text }]
        : message.content.map(block => (block.type === "text" ? { type: "text" as const, text: decision.text } : structuredClone(block)));

      const updated: ActiveEntry["messages"][number] = {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        timestamp: message.timestamp,
        content: newContent,
      };
      return updated;
    });

    result.push({
      entryId: entry.entryId,
      sourceRole: entry.sourceRole,
      messages: newMessages,
    });
  }

  return result;
}
