// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Lessons from a caller's passthru conversation — EXPLICIT opt-in only
// (`x-marina-learn: on`), owner-scoped. A request contributes only when
// MARINA_LESSONS_FROM_WORK is observe/on, it carries the opt-in, it is not a
// measurement run (`x-marina-eval`), it is not Marina's own agent (their loop
// teaches through engine events), and its key is bound to a principal
// (`secret:entity`) — the lessons go to THAT principal's own lesson spaces and
// are served only to its own requests. Without all of that nothing here runs.
// The signals carry tool names and error classes; the failing tool output
// rides as writer context, never stored.

import { EVAL_HEADER } from "../../learning/eval-context";
import { noteWork, softFailureClass } from "../../learning/work";
import type { MarinaDB } from "../../persistence/database";
import { messageText, type OpenAIMessage } from "../passthru-context";
import type { PassthruAuthResult } from "./shared";

/** Request: `on` opts this conversation into lessons from work (owner-scoped). */
export const LEARN_HEADER = "x-marina-learn";

/**
 * The principal a passthru request's work may be learned for, or undefined:
 * explicit opt-in, a bound key, never an internal caller or a measurement run.
 */
export function passthruLearnOwner(
  req: { headers: Headers },
  auth: PassthruAuthResult | undefined,
): string | undefined {
  if (req.headers.get(LEARN_HEADER)?.trim().toLowerCase() !== "on") return undefined;
  if (req.headers.get(EVAL_HEADER)) return undefined;
  if (!auth || auth.internal || auth.openMode) return undefined;
  return auth.boundEntityName || undefined;
}

/** A tool message's failure class, or undefined when it reads as a success. */
export function toolMessageFailure(content: unknown): string | undefined {
  const text = messageText(content);
  const soft = softFailureClass(text);
  if (soft) return soft;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      if (o.error !== undefined && o.error !== null && o.error !== false)
        return (
          softFailureClass(
            `error: ${typeof o.error === "string" ? o.error : JSON.stringify(o.error)}`,
          ) ?? "other"
        );
      if (o.success === false || o.ok === false) return "other";
    }
  } catch {
    // allow-empty-catch: plain text that is not an error
  }
  return undefined;
}

/** One recovery in a conversation: a failed tool call later followed by a success of that tool. */
export interface ConversationRecovery {
  tool: string;
  errorClass: string;
  /** The failing call's id (dedupes a conversation re-sent on every turn). */
  failId: string;
  /** The failing tool output (writer context only). */
  failText: string;
}

interface ToolCallLike {
  id?: string;
  function?: { name?: string };
}

/** Recoveries in an OpenAI-shaped message list (pure). */
export function conversationRecoveries(messages: readonly OpenAIMessage[]): ConversationRecovery[] {
  const nameOf = new Map<string, string>();
  const pending = new Map<string, { cls: string; id: string; text: string }>();
  const out: ConversationRecovery[] = [];
  for (const m of messages) {
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (m.role === "assistant" && Array.isArray(calls)) {
      for (const c of calls as ToolCallLike[]) {
        if (c?.id && c.function?.name) nameOf.set(c.id, c.function.name);
      }
      continue;
    }
    if (m.role !== "tool") continue;
    const id = (m as { tool_call_id?: unknown }).tool_call_id;
    if (typeof id !== "string") continue;
    const tool = nameOf.get(id);
    if (!tool) continue;
    const cls = toolMessageFailure(m.content);
    if (cls) {
      if (!pending.has(tool))
        pending.set(tool, { cls, id, text: messageText(m.content).slice(0, 400) });
      continue;
    }
    const failed = pending.get(tool);
    if (failed) {
      pending.delete(tool);
      out.push({ tool, errorClass: failed.cls, failId: failed.id, failText: failed.text });
    }
  }
  return out;
}

const seen = new Set<string>();
const MAX_SEEN = 5_000;

/** Note the conversation's recoveries for `owner` (each failing call once per process). */
export function notePassthruRecoveries(
  db: MarinaDB | undefined,
  owner: string,
  messages: readonly OpenAIMessage[],
): void {
  for (const r of conversationRecoveries(messages)) {
    const key = `${owner}|${r.failId}`;
    if (seen.has(key)) continue;
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(key);
    noteWork(db, {
      source: "passthru-recovery",
      tool: r.tool,
      errorClass: r.errorClass,
      succeeded: true,
      scope: { kind: "owner", owner },
      at: Date.now(),
      privateText: r.failText,
    });
  }
}

/** Note an argument-check correction (a flagged write call the model changed) for `owner`. */
export function noteArgcheckCorrection(
  db: MarinaDB | undefined,
  owner: string,
  tools: readonly string[],
): void {
  for (const tool of tools)
    noteWork(db, {
      source: "argcheck-correction",
      tool,
      errorClass: "unsupported-value",
      succeeded: true,
      scope: { kind: "owner", owner },
      at: Date.now(),
    });
}

/** Tests: forget the seen failing-call ids. */
export function resetPassthruLearnForTests(): void {
  seen.clear();
}
