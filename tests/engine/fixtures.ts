import type { AssistantMessage, Context, Message, Model, Api } from "@earendil-works/pi-ai";
import { emptyMemory, loadPolicy } from "../../src/engine/index.js";
import type { ActiveEntry, MaintenanceInput, ModelRequest } from "../../src/engine/index.js";

export const model: Model<Api> = {
  id: "engine-test", name: "controlled service", api: "openai-completions", provider: "engine-test",
  baseUrl: "https://invalid.example", reasoning: false, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 60000, maxTokens: 8192,
};
export const noChange = { add: [], remove: [], priority: [] };
export const usage = { input: 100, cacheRead: 50, cacheWrite: 25, output: 40, reasoning: 10, totalTokens: 215, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export function answer(patch: unknown = noChange, requestModel = model): AssistantMessage {
  return { role: "assistant", api: requestModel.api, model: requestModel.id, provider: requestModel.provider, content: [{ type: "text", text: JSON.stringify(patch) }], timestamp: 0, stopReason: "stop", usage: structuredClone(usage) };
}
export function user(entryId: string, content: string): ActiveEntry {
  return { entryId, sourceRole: "user", messages: [{ role: "user", content, timestamp: 0 }] };
}
export function assistant(entryId: string, content: AssistantMessage["content"]): ActiveEntry {
  return { entryId, sourceRole: "assistant", messages: [{ ...answer(), content, stopReason: content.some(b => b.type === "toolCall") ? "toolUse" : "stop" }] };
}
export function tool(entryId: string, id: string, content: string, name = "read"): ActiveEntry {
  return { entryId, sourceRole: "toolResult", messages: [{ role: "toolResult", toolCallId: id, toolName: name, isError: false, timestamp: 0, content: [{ type: "text", text: content }] }] };
}
export async function input(): Promise<MaintenanceInput> {
  return {
    binding: { sessionId: "isolated-session", leafId: "latest", generation: "0" }, model: structuredClone(model),
    fixed: { systemPrompt: "Continue the user's engineering task.", tools: [{ name: "read", description: "Read complete file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] },
    memory: emptyMemory(), active: [user("old", "Old question. " + "a".repeat(11000)), assistant("answer", [{ type: "text", text: "Old result" }]), user("latest", "Correct that earlier result; continue current work.")],
    policy: await loadPolicy(), signal: new AbortController().signal,
    config: { triggerTokens: 25000, memory: { fraction: 0.1 }, keepRecentFraction: 0.67, growthTokens: 2000,
      main: { outputTokens: 4096, safetyTokens: 512, extraInputTokens: 0 },
      extraction: { outputTokens: 4096, safetyTokens: 512, extraInputTokens: 0, toolResults: "auto", headTailChars: 200 },
    },
  };
}
export function sourceRecords(context: Context): { region: "B" | "K"; entryId: string; sourceRole: string; messages: Message[] }[] {
  return context.messages.flatMap(m => typeof m.content === "string" ? [] : m.content.flatMap(b => {
    if (b.type !== "text") return [];
    try { const parsed = JSON.parse(b.text); return parsed.region ? [parsed] : []; } catch { return []; }
  }));
}
export function responder(patch: unknown = noChange): (request: ModelRequest) => Promise<AssistantMessage> {
  return async request => answer(patch, request.model);
}
