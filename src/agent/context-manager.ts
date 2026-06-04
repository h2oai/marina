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

function estimateTokens(text: string): number {
  if (!text) return 0;
  const baseTokens = Math.ceil(text.length / 4);
  return baseTokens + Math.ceil(baseTokens * 0.1);
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
      const contextWindow = model.contextWindow;

      if (!contextWindow || contextWindow <= 0 || !Number.isFinite(contextWindow)) {
        return messages;
      }

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
            content: `[Context summary — ${middleMessages.length} messages compressed]\n${summaryText}`,
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
