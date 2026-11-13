// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";

/** Task text is conversation state, never part of the cached system prompt. */
type CodingTaskMessage = UserMessage & { marinaCodingTask: true };

export function isCodingTaskMessage(message: AgentMessage): boolean {
  return message.role === "user" && (message as CodingTaskMessage).marinaCodingTask === true;
}

export function codingTaskMessage(task: string): AgentMessage {
  return {
    role: "user",
    content: `[Active Coding Task]\n${task}`,
    timestamp: Date.now(),
    marinaCodingTask: true,
  } as CodingTaskMessage;
}

/** Static instructions; the exact task is supplied separately in user context. */
export const CODING_COMPACTION_INSTRUCTIONS = `
For a coding task, use these headings: Task, Constraints, Files read, Files modified,
Decisions, Progress, Next step. Preserve the goal and constraints, exact file paths,
important findings, decisions and their reasons, completed edits and verification
results, unresolved failures, and the concrete next action. Distinguish attempted
operations from confirmed changes. Do not infer success. The exact task is retained
separately; reference it rather than spending the summary allowance copying it.`;

/** Deterministic fallback when the summary model is unavailable or out of budget. */
export function summarizeCodingMessages(messages: readonly AgentMessage[]): string {
  const read = new Set<string>();
  const modified = new Set<string>();
  const progress: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) progress.push(block.text);
      if (block.type !== "toolCall") continue;
      if (block.name !== "marina_code" && !block.name.startsWith("marina_code_")) continue;
      const action =
        block.name === "marina_code"
          ? block.arguments.action
          : block.name.replace(/^marina_code_/, "");
      const paths = [block.arguments.path];
      if (Array.isArray(block.arguments.edits))
        for (const edit of block.arguments.edits) paths.push(edit?.path);
      for (const path of paths) {
        if (typeof path !== "string") continue;
        if (action === "read" || action === "read_file") read.add(path);
        if (["edit", "write", "patch"].includes(String(action))) modified.add(path);
      }
      // A patch is proposed, not necessarily applied. Keep its paths without
      // claiming that an apply succeeded (the recent results remain evidence).
      if (action === "patch" && typeof block.arguments.diff === "string") {
        for (const match of block.arguments.diff.matchAll(
          /^(?:---|\+\+\+) (?:[ab]\/)?([^\t\n]+)/gm,
        ))
          if (match[1] !== "/dev/null") modified.add(match[1]!);
      }
      if (["decision", "plan", "handoff"].includes(String(action)))
        if (typeof block.arguments.text === "string")
          progress.push(`${action}: ${block.arguments.text}`);
    }
  }
  return [
    "Task: see the exact [Active Coding Task] message.",
    "Constraints: retain all requirements in the exact task.",
    `Files read (requested): ${[...read].join(", ") || "none recorded"}`,
    `Files modified (attempted; confirm results): ${[...modified].join(", ") || "none recorded"}`,
    "Next step: continue from the latest progress below and the retained recent turns; verify unfinished work before submitting.",
    "Decisions and progress (assistant statements; verify against tool results):",
    ...progress.slice(-8).map((text) => text.slice(0, 2000)),
  ].join("\n");
}
