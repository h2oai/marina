// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

/** Replace exact repeated instruction excerpts only while an identical full
 * copy survives earlier in this very transcript. The original stays in details
 * (not serialized to the model), so compaction/restart can rehydrate it. No
 * process-wide 'already delivered' cache can suppress a lost instruction. */
export function collapseContextExcerpts(messages: AgentMessage[]): AgentMessage[] {
  const seen = new Map<string, string>();
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const result = message as ToolResultMessage;
    const blocks = (result.details as { contextBlocks?: unknown } | undefined)?.contextBlocks;
    if (!Array.isArray(blocks)) return message;
    let content = result.content;
    for (const block of blocks) {
      if (!block || typeof block.key !== "string" || typeof block.text !== "string" || !block.text)
        continue;
      const reference = `[Project instruction excerpt unchanged; full text retained earlier: ${block.key}]`;
      const repeated = seen.get(block.key) === block.text && reference.length < block.text.length;
      const to = repeated ? reference : block.text;
      let present = false;
      content = content.map((part) => {
        if (part.type !== "text") return part;
        // Only whole exact excerpts produced by the tool are eligible.
        if (part.text.includes(block.text) || part.text.includes(reference)) present = true;
        // The tool appends conventions AFTER file contents. Preserve source
        // that itself happens to quote an identical instruction block.
        const fullOffset = part.text.lastIndexOf(block.text);
        const referenceOffset = part.text.lastIndexOf(reference);
        const offset = Math.max(fullOffset, referenceOffset);
        const from = fullOffset > referenceOffset ? block.text : reference;
        return offset < 0 || from === to
          ? part
          : {
              ...part,
              text: part.text.slice(0, offset) + to + part.text.slice(offset + from.length),
            };
      });
      if (present) seen.set(block.key, block.text);
    }
    return content.every((part, i) => part === result.content[i])
      ? message
      : { ...result, content };
  });
}

/** Provider usage describes the ORIGINAL request prefix. After editing that
 * prefix it is no longer an anchor for the next request's context estimate.
 * Accounting has already consumed the original; durable archival preserves it. */
export function clearContextUsageAnchors(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.usage?.totalTokens) return message;
    return {
      ...message,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  });
}
