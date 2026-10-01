/**
 * Transcript hygiene applied to an agent's working history between runs (on by
 * default; `MARINA_DROP_OLD_THINKING_SIGNATURES=off` disables it).
 *
 * `dropOldThinking` removes reasoning blocks (thinking text plus its opaque
 * provider signature) from assistant messages of completed runs. Providers
 * need a reasoning block only on the turn being continued (Anthropic: the
 * final assistant turn of an in-progress tool loop; OpenAI-compatible chat
 * reasoning details: the same); older blocks are replay weight. The current
 * run — every message after the last user prompt — is never touched, and a
 * message that would be left with no content keeps its blocks.
 *
 * OpenAI Responses-API messages are skipped: their function-call and message
 * items carry ids that the API pairs with the reasoning item, so dropping the
 * reasoning item alone is rejected.
 *
 * The originals are already in the continuity journal (each completed message
 * is journaled before the loop advances), so nothing is lost.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** `dropOldThinking` is on unless `MARINA_DROP_OLD_THINKING_SIGNATURES` is `off`/`false`/`0`. */
export function dropOldThinkingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.MARINA_DROP_OLD_THINKING_SIGNATURES?.trim().toLowerCase();
  return !(raw === "off" || raw === "false" || raw === "0");
}

/** APIs whose assistant items are paired with their reasoning item by id. */
const PAIRED_REASONING_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

interface ContentBlock {
  type: string;
}

/**
 * Return `messages` with reasoning blocks removed from assistant messages
 * before the current run, or the SAME array when nothing changed (so the
 * caller can skip the state write and the provider prefix stays stable).
 */
export function dropOldThinking(messages: AgentMessage[]): AgentMessage[] {
  let lastPrompt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastPrompt = i;
      break;
    }
  }
  if (lastPrompt <= 0) return messages;
  let changed = false;
  const result = messages.map((message, index) => {
    if (index >= lastPrompt || message.role !== "assistant") return message;
    const assistant = message as AgentMessage & { api?: string; content?: unknown };
    if (assistant.api && PAIRED_REASONING_APIS.has(assistant.api)) return message;
    if (!Array.isArray(assistant.content)) return message;
    const blocks = assistant.content as ContentBlock[];
    if (!blocks.some((block) => block.type === "thinking")) return message;
    const kept = blocks.filter((block) => block.type !== "thinking");
    if (kept.length === 0) return message;
    changed = true;
    return { ...assistant, content: kept } as AgentMessage;
  });
  return changed ? result : messages;
}
