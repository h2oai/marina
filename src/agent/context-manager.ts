// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Context Manager — Manages LLM conversation context window.
 * Provides a transformContext callback for pi-agent-core's Agent.
 * Prunes, summarizes, and truncates messages to stay within budget.
 */

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  Model,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { maxToolResultTokensForWindow } from "../engine/constants";
import { Logger } from "../engine/logger";

import { withMemoryAbort } from "../sdk/memory-abort";
import { clearContextUsageAnchors, collapseContextExcerpts } from "./context-excerpts";

/** Module logger. */
const logger = new Logger();

// ─── Token Estimation ───────────────────────────────────────────────────────

// Characters per token for the CHARACTER heuristic. ~4 holds for English prose
// (and is what pi-ai's own `estimateTextTokens` assumes), but agent transcripts
// are dominated by code, JSON tool arguments, and structured reasoning, which
// BPE tokenizers split far more finely (~3 chars/token or less). The old
// chars/4 + 10% (~3.64 chars/token) under-counted real tokens by 20-30% on
// production traffic, so the compactor under-budgeted and the local server
// SILENTLY rejected the oversized prompt — a zero-token "wedged" turn. Estimate
// conservatively: over-counting only compacts slightly early; under-counting
// overflows the context window. Operators with real tokenizer data can tune
// this via MARINA_TOKEN_CHARS_PER_TOKEN.
//
// The heuristic is the FALLBACK. Whenever the transcript carries a real usage
// block from the most recent applicable assistant turn, `estimateContextTokens`
// (pi-ai) anchors the total on the provider-reported token count — which already
// includes the system prompt and tool schemas — and only the messages after that
// anchor are estimated by characters.
const CHARS_PER_TOKEN = (() => {
  const raw = Number.parseFloat(process.env.MARINA_TOKEN_CHARS_PER_TOKEN ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Characters the heuristic allows for `tokens` — the inverse of `estimateTokens`,
 *  so a truncation cut lands where the estimate says the budget ends. */
function charsForTokens(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

/**
 * Tokens the serialized tool schemas cost on every request. Providers send
 * `{name, description, parameters}` per tool as JSON, so that is what we
 * measure. Cached per tool object (WeakMap) — schemas are immutable once built.
 */
const toolTokenCache = new WeakMap<object, number>();
export function estimateToolSchemaTokens(tools: readonly (Tool | AgentTool)[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  let total = 0;
  for (const tool of tools) {
    let tokens = toolTokenCache.get(tool);
    if (tokens === undefined) {
      let serialized = "";
      try {
        serialized = JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        });
      } catch {
        serialized = `${tool.name}${tool.description}`;
      }
      // +8: per-tool framing (type/function wrapper) the wire format adds.
      tokens = estimateTokens(serialized) + 8;
      toolTokenCache.set(tool, tokens);
    }
    total += tokens;
  }
  return total;
}

/**
 * The prompt window the compactor actually budgets against: the model's
 * context window minus the output reservation (`reservedTokens`), the latter
 * capped at half the window so a large output budget can't starve the prompt
 * on a small server. Exported so tests and the adapter's diagnostics agree
 * with the transform on what "fits".
 */
export function effectivePromptWindow(
  model: Pick<Model<string>, "contextWindow" | "maxTokens">,
): number {
  const rawWindow = model.contextWindow;
  if (!rawWindow || rawWindow <= 0 || !Number.isFinite(rawWindow)) return 0;
  const reserved = Math.min(Math.floor(rawWindow / 2), reservedTokens(model, rawWindow));
  return Math.max(1, rawWindow - reserved);
}

export interface ContextBudget {
  /** Effective prompt window (context window minus the output reservation). */
  contextWindow: number;
  systemTokens: number;
  toolTokens: number;
  /** system + tools — the per-request fixed prefix. */
  fixedTokens: number;
  messageTokens: number;
  /** fixed + messages; usage-anchored when the transcript carries real usage. */
  totalTokens: number;
  usageRatio: number;
  /** True when `totalTokens` came from a provider-reported usage block. */
  usageAnchored: boolean;
  /** Tokens left for messages at `targetRatio` after the fixed prefix. */
  budgetForMessages: number;
}

/**
 * One place that decides how full the context is. Fixed prefix = system prompt
 * + tool schemas (the schemas were never counted before, so a 36 KB `full`
 * tool set silently ate a third of a 32k window). Total = provider usage anchor
 * + character estimate of the trailing messages when available, else the
 * character estimate of everything.
 */
export function computeContextBudget(input: {
  model: Model<string>;
  systemPrompt: string;
  tools?: readonly (Tool | AgentTool)[];
  messages: readonly AgentMessage[];
  targetRatio: number;
}): ContextBudget {
  const contextWindow = effectivePromptWindow(input.model);
  const systemTokens = estimateTokens(input.systemPrompt || "");
  const toolTokens = estimateToolSchemaTokens(input.tools);
  const fixedTokens = systemTokens + toolTokens;
  const messageTokens = input.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

  let totalTokens = fixedTokens + messageTokens;
  let usageAnchored = false;
  try {
    const anchored = estimateContextTokens(input.messages as Message[]);
    if (anchored.lastUsageIndex !== null && anchored.usageTokens > 0) {
      // The usage block already counts system prompt + tools + every message up
      // to and including that assistant turn; add our (conservative) estimate
      // of what came after it instead of pi-ai's 4-chars/token trailing guess.
      const trailing = input.messages
        .slice(anchored.lastUsageIndex + 1)
        .reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      totalTokens = anchored.usageTokens + trailing;
      usageAnchored = true;
    }
  } catch {
    // Non-standard message shapes — keep the character estimate.
  }

  const window = Math.max(1, contextWindow);
  return {
    contextWindow,
    systemTokens,
    toolTokens,
    fixedTokens,
    messageTokens,
    totalTokens,
    usageRatio: totalTokens / window,
    usageAnchored,
    budgetForMessages: window * input.targetRatio - fixedTokens,
  };
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface ContextManagerOptions {
  getModel: () => Model<string>;
  getSystemPrompt: () => string;
  /** Tools whose schemas ride on every request — counted in the fixed prefix.
   *  Read live so a deferred-tool load is reflected on the next transform. */
  getTools?: () => readonly (Tool | AgentTool)[];
  pruneThreshold?: number;
  pruneTarget?: number;
  /** Absolute conversation-size cap (`conversationTokenCap`). Read live; when
   *  it returns a cap and the conversation (character estimate, system prompt
   *  and tool schemas excluded) reaches `capTokens`, the conversation is
   *  compacted to `targetTokens` even far below the window-ratio threshold. */
  getTokenCap?: (messages: readonly AgentMessage[]) => ConversationTokenCap | undefined;
  maxToolResultTokens?: number;
  minRecentMessages?: number;
  onBeforeCompact?: (
    originalMessages: AgentMessage[],
    summary: string,
    signal?: AbortSignal,
  ) => void | Promise<void>;
  summarizeWithLLM?: (
    messages: AgentMessage[],
    ruleBasedFallback: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}

/**
 * Tokens the compactor holds back from the context window so the model's
 * completion (output) and per-request framing overhead have room. Without this,
 * compaction targets a ratio of the FULL window and the output tokens push the
 * real request over the edge — exactly the small-context-server failure mode.
 * Reserve = the model's output budget + a 2% (min 256-token) safety margin.
 */
function reservedTokens(model: Pick<Model<string>, "maxTokens">, contextWindow: number): number {
  const output = Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 0;
  const margin = Math.max(256, Math.floor(contextWindow * 0.02));
  return output + margin;
}

export class ContextPersistenceError extends Error {}

export interface ConversationTokenCap {
  capTokens: number;
  targetTokens: number;
  /** True when the operator set `MARINA_AGENT_CONTEXT_CAP_TOKENS`; false for
   *  the built-in default (which a bound coder is exempt from). */
  explicit: boolean;
}

/** The built-in conversation cap when `MARINA_AGENT_CONTEXT_CAP_TOKENS` is unset. */
export const DEFAULT_CONVERSATION_CAP_TOKENS = 48_000;
/** No cap compacts a conversation smaller than this, whatever is configured. */
export const MIN_CONVERSATION_CAP_TOKENS = 8_000;

/**
 * The absolute conversation cap (`MARINA_AGENT_CONTEXT_CAP_TOKENS`, target
 * `MARINA_AGENT_CONTEXT_TARGET_TOKENS`, default a third of the cap). Unset or
 * junk ⇒ the built-in default; `0`/`off`/`false` ⇒ no cap (only the
 * window-ratio threshold compacts); a positive value wins, floored at
 * `MIN_CONVERSATION_CAP_TOKENS`.
 */
export function conversationTokenCap(
  env: Record<string, string | undefined> = process.env,
): ConversationTokenCap | undefined {
  const raw = env.MARINA_AGENT_CONTEXT_CAP_TOKENS?.trim().toLowerCase() ?? "";
  if (raw === "0" || raw === "off" || raw === "false") return undefined;
  const parsed = Number(raw);
  const explicit = raw !== "" && Number.isFinite(parsed) && parsed > 0;
  const capTokens = explicit
    ? Math.max(MIN_CONVERSATION_CAP_TOKENS, Math.floor(parsed))
    : DEFAULT_CONVERSATION_CAP_TOKENS;
  const rawTarget = Number(env.MARINA_AGENT_CONTEXT_TARGET_TOKENS);
  const targetTokens =
    Number.isFinite(rawTarget) && rawTarget > 0 && rawTarget < capTokens
      ? Math.floor(rawTarget)
      : Math.floor(capTokens / 3);
  return { capTokens, targetTokens, explicit };
}

/**
 * True once the conversation holds a completed earlier run: an assistant turn
 * before the latest user prompt. The cap never compacts an agent's first run.
 */
export function hasCompletedRun(messages: readonly AgentMessage[]): boolean {
  let lastPrompt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastPrompt = i;
      break;
    }
  }
  for (let i = 0; i < lastPrompt; i++) if (messages[i]?.role === "assistant") return true;
  return false;
}

/** Character-estimated conversation size; the usage anchor is deliberately not
 *  used — after a compaction the surviving assistant turns still carry the
 *  pre-compaction usage, which would re-trigger the cap on every request. */
export function conversationTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce(
    (sum, msg) => (msg.role === "system" ? sum : sum + estimateMessageTokens(msg)),
    0,
  );
}

// ─── Context Manager Factory ────────────────────────────────────────────────

export function createContextManager(options: ContextManagerOptions) {
  const {
    getModel,
    getSystemPrompt,
    getTools,
    pruneThreshold = 0.8,
    pruneTarget = 0.6,
    getTokenCap,
    maxToolResultTokens: configuredToolResultTokens,
    minRecentMessages = 10,
    onBeforeCompact,
    summarizeWithLLM,
  } = options;

  const transformConversation = async (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> => {
    signal?.throwIfAborted();
    const original = messages;
    messages = collapseContextExcerpts(messages);
    if (messages.some((message, i) => message !== original[i]))
      messages = clearContextUsageAnchors(messages);
    const finish = async (result: AgentMessage[]) => {
      // Rehydrate any excerpt whose retained original was removed by compaction.
      result = truncateOversizedToolResults(
        collapseContextExcerpts(result),
        configuredToolResultTokens ??
          maxToolResultTokensForWindow(effectivePromptWindow(getModel())),
      );
      const changed =
        result.length !== original.length || result.some((message, i) => message !== original[i]);
      signal?.throwIfAborted();
      if (onBeforeCompact && changed) {
        try {
          await withMemoryAbort(
            () =>
              Promise.resolve(
                onBeforeCompact(original, summarizeMessages(original as Message[]), signal),
              ),
            signal,
          );
          signal?.throwIfAborted();
        } catch (cause) {
          signal?.throwIfAborted();
          throw new ContextPersistenceError("Context archival failed; original messages retained", {
            cause,
          });
        }
      }
      return changed ? clearContextUsageAnchors(result) : original;
    };
    try {
      if (messages.length === 0) return messages;

      const model = getModel();
      const systemPrompt = getSystemPrompt();
      const tools = getTools?.();

      // Budget the PROMPT against the window minus what the completion + framing
      // will consume (`effectivePromptWindow`). The fixed prefix is the system
      // prompt PLUS the serialized tool schemas — both ride on every request.
      const contextWindow = effectivePromptWindow(model);
      if (contextWindow <= 0) return await finish(messages);
      const maxToolResultTokens =
        configuredToolResultTokens ?? maxToolResultTokensForWindow(contextWindow);

      // Tier selection needs the ratio first; the message budget is recomputed
      // below once the tier's target ratio is known.
      const gauge = computeContextBudget({
        model,
        systemPrompt,
        tools,
        messages,
        targetRatio: pruneTarget,
      });
      const systemTokens = gauge.fixedTokens;
      const usageRatio = gauge.usageRatio;

      const tokenCap = usageRatio < pruneThreshold ? getTokenCap?.(messages) : undefined;
      const capped = tokenCap !== undefined && gauge.messageTokens >= tokenCap.capTokens;
      if (usageRatio < pruneThreshold && !capped) {
        return await finish(truncateOversizedToolResults(messages, maxToolResultTokens));
      }

      // Tiered compaction
      let targetRatio: number;
      let keepRecent: number;
      let maxSummaryRatio: number;

      if (capped) {
        // Conversation-only budget: the cap excludes the fixed prefix.
        targetRatio = tokenCap.targetTokens / Math.max(1, contextWindow);
        keepRecent = minRecentMessages;
        maxSummaryRatio = (tokenCap.targetTokens * 0.1) / Math.max(1, contextWindow);
      } else if (usageRatio >= 0.95) {
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

      const budgetForMessages = capped
        ? tokenCap.targetTokens
        : contextWindow * targetRatio - systemTokens;

      if (budgetForMessages <= 0) {
        return await finish(
          stripOrphanedToolResults(
            truncateOversizedToolResults(messages.slice(-keepRecent), maxToolResultTokens),
          ),
        );
      }

      const first = messages[0]!;
      const firstTokens = estimateMessageTokens(first);

      // The first message is always kept separately below, so the recent window
      // must never reach back to it — otherwise a short history (length <=
      // keepRecent) would emit the first message twice.
      let recentCount = Math.min(keepRecent, Math.max(0, messages.length - 1));
      let recentMessages = recentCount > 0 ? messages.slice(-recentCount) : [];
      let recentTokens = recentMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

      while (recentCount > 4 && firstTokens + recentTokens > budgetForMessages) {
        recentCount--;
        recentMessages = recentCount > 0 ? messages.slice(-recentCount) : [];
        recentTokens = recentMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      }

      const middleEnd = messages.length - recentCount;
      const middleMessages = middleEnd > 1 ? messages.slice(1, middleEnd) : [];

      const result: AgentMessage[] = [first];

      if (middleMessages.length > 0 && maxSummaryRatio > 0) {
        const ruleBasedSummary = summarizeMessages(middleMessages as Message[]);
        let summary: string;
        if (summarizeWithLLM) {
          try {
            summary = await withMemoryAbort(
              () => summarizeWithLLM(middleMessages, ruleBasedSummary, signal),
              signal,
            );
          } catch {
            signal?.throwIfAborted();
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
      return await finish(stripOrphanedToolResults(finalResult));
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ContextPersistenceError) throw error;
      logger.error("agents", "Error during context transform, passing through", { error });
      // Even on the error path, don't pass through a corrupted history.
      return await finish(stripOrphanedToolResults(messages));
    }
  };

  // pi-agent-core ≥ 0.86 carries the system prompt and tool declarations as
  // `system` messages INSIDE the transcript. They are never compacted,
  // summarized, archived or dropped: only the conversation is transformed, and
  // the system messages lead the result. When nothing changed the original
  // array (and message order) is returned untouched, so the request prefix stays
  // byte-stable for the provider's prompt cache.
  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    if (!messages.some((m) => m.role === "system")) return transformConversation(messages, signal);
    const system = messages.filter((m) => m.role === "system");
    const conversation = messages.filter((m) => m.role !== "system");
    const result = await transformConversation(conversation, signal);
    const unchanged =
      result.length === conversation.length && result.every((m, i) => m === conversation[i]);
    return unchanged ? messages : [...system, ...result];
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

      const notice =
        "\n\n[...truncated; incomplete output. Request narrower results to retrieve omitted content.]";
      const overhead = 4 + estimateTokens(toolResult.toolName ?? "");
      const allowance = Math.max(0, Math.floor(maxTokens) - overhead);
      const suffix =
        estimateTokens(notice) <= allowance
          ? notice
          : estimateTokens("[truncated]") <= allowance
            ? "[truncated]"
            : "";
      let remaining = allowance - estimateTokens(suffix);
      const truncatedContent: ToolResultMessage["content"] = [];
      for (const block of toolResult.content) {
        if (block.type === "text") {
          const text = block.text.slice(0, charsForTokens(remaining));
          if (text) truncatedContent.push({ ...block, text });
          remaining -= estimateTokens(text);
        } else if (remaining >= 300) {
          truncatedContent.push(block);
          remaining -= 300;
        }
      }
      const last = truncatedContent.at(-1);
      if (last?.type === "text") last.text += suffix;
      else if (suffix) truncatedContent.push({ type: "text", text: suffix });
      if (JSON.stringify(truncatedContent) === JSON.stringify(toolResult.content)) return msg;
      return { ...toolResult, content: truncatedContent } as AgentMessage;
    });
  } catch {
    return messages;
  }
}

function truncateText(text: string, maxTokens: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;
  const maxChars = charsForTokens(maxTokens);
  return `${text.slice(0, maxChars)}\n[...summary truncated]`;
}
