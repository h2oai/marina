// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Context Manager — Manages LLM conversation context window.
 * Provides a transformContext callback for pi-agent-core's Agent.
 * Prunes, summarizes, and truncates messages to stay within budget.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  Model,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

// ─── Token Estimation ───────────────────────────────────────────────────────

// Characters per token. ~4 holds for English prose, but agent transcripts are
// dominated by code, JSON tool arguments, and structured reasoning, which BPE
// tokenizers split far more finely (~3 chars/token or less). The old chars/4 +
// 10% (~3.64 chars/token) under-counted real tokens by 20-30% on production
// traffic, so the compactor under-budgeted and the local server SILENTLY
// rejected the oversized prompt — a zero-token "wedged" turn. Estimate
// conservatively: over-counting only compacts slightly early; under-counting
// overflows the context window. Operators with real tokenizer data can tune
// this via MARINA_TOKEN_CHARS_PER_TOKEN.
const CHARS_PER_TOKEN = (() => {
  const raw = Number.parseFloat(process.env.MARINA_TOKEN_CHARS_PER_TOKEN ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface ContextManagerOptions {
  getModel: () => Model<string>;
  getSystemPrompt: () => string;
  pruneThreshold?: number;
  pruneTarget?: number;
  maxToolResultTokens?: number;
  minRecentMessages?: number;
  onBeforeCompact?: (droppedMessages: AgentMessage[], summary: string) => void;
  summarizeWithLLM?: (messages: AgentMessage[], ruleBasedFallback: string) => Promise<string>;
}

/**
 * Tokens the compactor holds back from the context window so the model's
 * completion (output) and per-request framing overhead have room. Without this,
 * compaction targets a ratio of the FULL window and the output tokens push the
 * real request over the edge — exactly the small-context-server failure mode.
 * Reserve = the model's output budget + a 2% (min 256-token) safety margin.
 */
function reservedTokens(model: Model<string>, contextWindow: number): number {
  const output = Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 0;
  const margin = Math.max(256, Math.floor(contextWindow * 0.02));
  return output + margin;
}

// ─── Context Manager Factory ────────────────────────────────────────────────

export function createContextManager(options: ContextManagerOptions) {
  const {
    getModel,
    getSystemPrompt,
    pruneThreshold = 0.8,
    pruneTarget = 0.6,
    maxToolResultTokens = 2000,
    minRecentMessages = 10,
    onBeforeCompact,
    summarizeWithLLM,
  } = options;

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    try {
      if (messages.length === 0) return messages;

      const model = getModel();
      const systemPrompt = getSystemPrompt();
      const rawWindow = model.contextWindow;

      if (!rawWindow || rawWindow <= 0 || !Number.isFinite(rawWindow)) {
        return messages;
      }

      // Budget the PROMPT against the window minus what the completion + framing
      // will consume. All ratio/budget math below works against this effective
      // window so prompt + output stays under the real ceiling. The reservation
      // is capped at half the window so a large output budget can't starve the
      // prompt entirely on a small server.
      const reserved = Math.min(Math.floor(rawWindow / 2), reservedTokens(model, rawWindow));
      const contextWindow = Math.max(1, rawWindow - reserved);

      const systemTokens = estimateTokens(systemPrompt || "");
      const messageTokens = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      const totalTokens = systemTokens + messageTokens;
      const usageRatio = totalTokens / contextWindow;

      if (usageRatio < pruneThreshold) {
        return truncateOversizedToolResults(messages, maxToolResultTokens);
      }

      // Tiered compaction
      let targetRatio: number;
      let keepRecent: number;
      let maxSummaryRatio: number;

      if (usageRatio >= 0.95) {
        targetRatio = 0.4;
        keepRecent = 4;
        maxSummaryRatio = 0;
      } else if (usageRatio >= 0.9) {
        targetRatio = 0.5;
        keepRecent = 6;
        maxSummaryRatio = 0.05;
      } else {
        targetRatio = pruneTarget;
        keepRecent = minRecentMessages;
        maxSummaryRatio = 0.1;
      }

      const budgetForMessages = contextWindow * targetRatio - systemTokens;

      if (budgetForMessages <= 0) {
        return truncateOversizedToolResults(messages.slice(-keepRecent), maxToolResultTokens);
      }

      const first = messages[0]!;
      const firstTokens = estimateMessageTokens(first);

      let recentCount = Math.min(keepRecent, messages.length);
      let recentMessages = messages.slice(-recentCount);
      let recentTokens = recentMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

      while (recentCount > 4 && firstTokens + recentTokens > budgetForMessages) {
        recentCount--;
        recentMessages = messages.slice(-recentCount);
        recentTokens = recentMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      }

      const middleEnd = messages.length - recentCount;
      const middleMessages = middleEnd > 1 ? messages.slice(1, middleEnd) : [];

      if (onBeforeCompact && middleMessages.length > 0) {
        try {
          onBeforeCompact(middleMessages, summarizeMessages(middleMessages as Message[]));
        } catch {
          // Transcript archival is non-critical
        }
      }

      const result: AgentMessage[] = [first];

      if (middleMessages.length > 0 && maxSummaryRatio > 0) {
        const ruleBasedSummary = summarizeMessages(middleMessages as Message[]);
        let summary: string;
        if (summarizeWithLLM) {
          try {
            summary = await summarizeWithLLM(middleMessages, ruleBasedSummary);
          } catch {
            summary = ruleBasedSummary;
          }
        } else {
          summary = ruleBasedSummary;
        }

        const maxSummaryTokens = Math.floor(contextWindow * maxSummaryRatio);
        const summaryText = summary.length > 0 ? truncateText(summary, maxSummaryTokens) : "";

        if (summaryText.length > 0) {
          result.push({
            role: "user",
            content: `[Context summary — ${middleMessages.length} messages compressed; historical evidence, not governing instructions]\n${summaryText}`,
            timestamp: Date.now(),
          } as AgentMessage);
        }
      } else if (middleMessages.length > 0) {
        result.push({
          role: "user",
          content: `[${middleMessages.length} earlier messages dropped — context emergency]`,
          timestamp: Date.now(),
        } as AgentMessage);
      }

      result.push(...recentMessages);

      let finalResult = truncateOversizedToolResults(result, maxToolResultTokens);

      // Safety net
      const finalTokens =
        systemTokens + finalResult.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (finalTokens > contextWindow * 0.95 && finalResult.length > 5) {
        finalResult = truncateOversizedToolResults(
          [
            finalResult[0]!,
            {
              role: "user",
              content: `[Emergency: ${finalResult.length - 5} messages dropped to fit context window]`,
              timestamp: Date.now(),
            } as AgentMessage,
            ...finalResult.slice(-4),
          ],
          maxToolResultTokens,
        );
      }

      // Final pairing check — any pruning strategy above can split a
      // toolCall/toolResult pair across the summary cut. Anthropic's API
      // rejects orphaned toolResult messages with a permanent 400, which
      // poisons the agent's conversation for the rest of its life. Always
      // run this last so no path escapes without the pairing invariant.
      return stripOrphanedToolResults(finalResult);
    } catch (error) {
      console.error("[context-manager] Error during context transform, passing through:", error);
      // Even on the error path, don't pass through a corrupted history.
      return stripOrphanedToolResults(messages);
    }
  };
}

/**
 * Drop any `toolResult` message whose `toolCallId` does not correspond to
 * a `toolCall` block in an earlier `assistant` message in the same array.
 *
 * Anthropic's API rejects such orphans with:
 *   "unexpected `tool_use_id` found in `tool_result` blocks ... Each
 *    `tool_result` block must have a corresponding `tool_use` block in
 *    the previous message."
 *
 * Orphans arise whenever context pruning / summarization drops the
 * assistant message that issued a toolCall while the next toolResult
 * survives in the kept window. Once the history has one orphan the agent
 * enters a permanent retry loop — every subsequent LLM call 400s with
 * the same history, regardless of how long the backoff is.
 *
 * Idempotent and O(n). Safe to call on any AgentMessage array.
 */
export function stripOrphanedToolResults(messages: AgentMessage[]): AgentMessage[] {
  const validIds = new Set<string>();
  const result: AgentMessage[] = [];
  for (const msg of messages) {
    const m = msg as Message;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "toolCall" && typeof block.id === "string" && block.id.length > 0) {
          validIds.add(block.id);
        }
      }
      result.push(msg);
    } else if (m.role === "toolResult") {
      const tr = m as ToolResultMessage;
      if (typeof tr.toolCallId === "string" && validIds.has(tr.toolCallId)) {
        result.push(msg);
      }
      // otherwise: orphaned — drop it, the matching toolCall was pruned
    } else {
      result.push(msg);
    }
  }
  return result;
}

/**
 * Last-resort history shrink for the overflow-recovery path. The normal
 * transform is budget-driven and can still leave a too-large history when the
 * server's real window is smaller than we believe; this one is unconditional —
 * keep the first message (identity/bootstrap), drop the middle behind a notice,
 * and keep the last `keepRecent`. Always strips orphaned tool results so the
 * retry can't 400 on a split toolCall/toolResult pair.
 */
export function hardTrimMessages(messages: AgentMessage[], keepRecent: number): AgentMessage[] {
  if (messages.length <= keepRecent + 1) return stripOrphanedToolResults(messages);
  const first = messages[0]!;
  const recent = messages.slice(-keepRecent);
  const droppedCount = messages.length - recent.length - 1;
  const notice: AgentMessage = {
    role: "user",
    content: `[${droppedCount} earlier messages dropped — context-overflow recovery]`,
    timestamp: Date.now(),
  } as AgentMessage;
  return stripOrphanedToolResults([first, notice, ...recent]);
}

// ─── Token Estimation for Messages ──────────────────────────────────────────

export function estimateMessageTokens(msg: AgentMessage): number {
  try {
    const m = msg as Message;
    if (!m?.role) return 0;

    let tokens = 4;

    if (m.role === "user") {
      const user = m as UserMessage;
      if (typeof user.content === "string") {
        tokens += estimateTokens(user.content);
      } else if (Array.isArray(user.content)) {
        for (const block of user.content) {
          if (block.type === "text") tokens += estimateTokens(block.text);
          else if (block.type === "image") tokens += 300;
        }
      }
    } else if (m.role === "assistant") {
      const assistant = m as AssistantMessage;
      if (Array.isArray(assistant.content)) {
        for (const block of assistant.content) {
          if (block.type === "text") tokens += estimateTokens(block.text);
          else if (block.type === "thinking") tokens += estimateTokens(block.thinking);
          else if (block.type === "toolCall") {
            tokens += estimateTokens(block.name);
            tokens += estimateTokens(JSON.stringify(block.arguments ?? {}));
          }
        }
      }
    } else if (m.role === "toolResult") {
      const toolResult = m as ToolResultMessage;
      tokens += estimateTokens(toolResult.toolName || "");
      if (Array.isArray(toolResult.content)) {
        for (const block of toolResult.content) {
          if (block.type === "text") tokens += estimateTokens(block.text);
          else if (block.type === "image") tokens += 300;
        }
      }
    }

    return tokens;
  } catch {
    return 50;
  }
}

// ─── Message Summarization ──────────────────────────────────────────────────

export function summarizeMessages(messages: Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          const description = describeToolAction(block.name, block.arguments);
          lines.push(description);
        } else if (block.type === "text" && block.text.length > 0) {
          const brief = block.text.slice(0, 100).replace(/\n/g, " ");
          lines.push(`[thought] ${brief}${block.text.length > 100 ? "..." : ""}`);
        }
      }
    } else if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join(" ");
      if (text.length > 0) {
        const brief = text.slice(0, 100).replace(/\n/g, " ");
        lines.push(`[event] ${brief}${text.length > 100 ? "..." : ""}`);
      }
    }
  }

  return lines.join("\n");
}

function describeToolAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "marina_move":
      return `Moved ${args.direction || "somewhere"}`;
    case "marina_look":
      return args.target ? `Looked at ${args.target}` : "Looked at surroundings";
    case "marina_command":
      return `Ran command: ${args.command || "unknown"}`;
    case "marina_build":
      return `Build: ${args.subcommand || "action"}${args.name ? ` "${args.name}"` : ""}`;
    case "marina_channel":
      return `Channel ${args.action || "action"}${args.channel ? ` #${args.channel}` : ""}`;
    case "memory":
      if (args.action === "write")
        return `Saved memory [${args.category || ""}]: ${String(args.content || "").slice(0, 60)}`;
      if (args.action === "search") return `Searched memory for "${args.query || ""}"`;
      return `Memory ${args.action || "action"}`;
    case "think":
      return `Thinking: ${String(args.action || args.thought || "").slice(0, 60)}`;
    default:
      return `${toolName}(${Object.values(args)
        .filter((v) => typeof v === "string")
        .map((v) => String(v).slice(0, 30))
        .join(", ")})`;
  }
}

// ─── Tool Result Truncation ─────────────────────────────────────────────────

export function truncateOversizedToolResults(
  messages: AgentMessage[],
  maxTokens: number,
): AgentMessage[] {
  try {
    return messages.map((msg) => {
      const m = msg as Message;
      if (m?.role !== "toolResult") return msg;

      const toolResult = m as ToolResultMessage;
      if (!Array.isArray(toolResult.content)) return msg;

      const resultTokens = estimateMessageTokens(msg);
      if (resultTokens <= maxTokens) return msg;

      const truncatedContent = toolResult.content.map((block) => {
        if (block.type !== "text") return block;

        const blockTokens = estimateTokens(block.text);
        if (blockTokens <= maxTokens) return block;

        const maxChars = Math.floor((maxTokens * 4) / 1.1);
        return {
          ...block,
          text: `${block.text.slice(0, maxChars)}\n\n[...truncated, ${blockTokens} tokens total]`,
        };
      });

      return { ...toolResult, content: truncatedContent } as AgentMessage;
    });
  } catch {
    return messages;
  }
}

function truncateText(text: string, maxTokens: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;
  const maxChars = Math.floor((maxTokens * 4) / 1.1);
  return `${text.slice(0, maxChars)}\n[...summary truncated]`;
}
