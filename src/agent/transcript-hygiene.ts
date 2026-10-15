// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

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

// ─── Image bound ────────────────────────────────────────────────────────────
//
// A native look puts an image (base64, up to a few MB) in a tool result. Left
// alone, every look would ride on every later request and accumulate without
// limit, so only the most recent images stay; older ones become a one-line
// placeholder naming the source, which `marina_see` reopens on demand. The
// journal and compaction archives never store image bytes either
// (`src/agent/durable-memory.ts`).

/** Default number of images kept in an agent's live transcript. */
export const DEFAULT_TRANSCRIPT_IMAGES = 4;

/** `MARINA_AGENT_VISION_MAX_IMAGES` (≥ 1; unset/invalid = 4). */
export function transcriptImageLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.MARINA_AGENT_VISION_MAX_IMAGES);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 32) : DEFAULT_TRANSCRIPT_IMAGES;
}

interface ImageRef {
  ref?: unknown;
  width?: unknown;
  height?: unknown;
}

/** The text an image is replaced with once it leaves the live transcript. */
export function imagePlaceholder(ref?: ImageRef): string {
  const name = typeof ref?.ref === "string" && ref.ref ? ref.ref : "image";
  const dims =
    typeof ref?.width === "number" && typeof ref?.height === "number" && ref.width > 0
      ? ` ${ref.width}x${ref.height}`
      : "";
  return `[${name}${dims} — no longer in view; call marina_see ${name} to view it again]`;
}

/**
 * Keep the newest `keep` images in tool results and user messages; replace
 * every older one with {@link imagePlaceholder}. Returns the SAME array when
 * nothing changed, so an unchanged prefix stays cache-stable.
 */
export function boundTranscriptImages(messages: AgentMessage[], keep: number): AgentMessage[] {
  let budget = Math.max(0, keep);
  let out: AgentMessage[] | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as AgentMessage & { content?: unknown; details?: unknown };
    if (message.role !== "toolResult" && message.role !== "user") continue;
    if (!Array.isArray(message.content)) continue;
    const blocks = message.content as ContentBlock[];
    const count = blocks.filter((block) => block.type === "image").length;
    if (count === 0) continue;
    if (count <= budget) {
      budget -= count;
      continue;
    }
    const details = message.details as { images?: unknown } | undefined;
    const refs = Array.isArray(details?.images) ? (details.images as ImageRef[]) : [];
    // Within one message the LAST images are the newest: keep those.
    let index = count;
    const content: ContentBlock[] = [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]!;
      if (block.type !== "image") {
        content.unshift(block);
        continue;
      }
      index -= 1;
      if (budget > 0) {
        budget -= 1;
        content.unshift(block);
      } else {
        content.unshift({ type: "text", text: imagePlaceholder(refs[index]) } as ContentBlock);
      }
    }
    out ??= messages.slice();
    out[i] = { ...message, content } as AgentMessage;
  }
  return out ?? messages;
}
