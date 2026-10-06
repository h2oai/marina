// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The argument check for one of Marina's own agent loops. `MARINA_ARGCHECK`
 * (read live) decides:
 *
 *   off      nothing is checked, no call is made (the default);
 *   observe  `mutate` / `consequential` calls are checked; counts are logged;
 *            every call runs;
 *   on       an unsupported call is refused once with the values named (a
 *            tool-gate refusal); the same call issued again runs.
 *
 * The caller passes the transcript the model saw; this class never reads
 * tool-call arguments as evidence. Session state only.
 */

import type { DecisionProvider } from "../decisions/types";
import {
  type ArgcheckMemo,
  type ArgcheckOutcome,
  checkCall,
  EvidenceIndex,
  type EvidenceText,
  newArgcheckMemo,
} from "./argcheck";
import type { CompleteText } from "./extract";
import { argcheckMode, type ObligationsMode } from "./mode";

export interface AgentArgcheckOptions {
  /** One completion on the agent's own model (the judge when no decision layer is configured). */
  complete: CompleteText;
  provider?: () => DecisionProvider | undefined;
  mode?: () => ObligationsMode;
  /** Stated requests (the obligations ledger's lines) for the judge, when it runs too. */
  stated?: () => string[];
  now?: () => number;
}

type Block = { type?: string; text?: unknown };

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * A pi transcript as evidence: user and tool-result text, the assistant's
 * TEXT blocks (never its tool calls or thinking), and system messages.
 */
export function transcriptEvidence(messages: readonly unknown[]): EvidenceText[] {
  const out: EvidenceText[] = [];
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown };
    const text = blocksText(m?.content);
    if (!text) continue;
    if (m.role === "user") out.push({ channel: "user", text });
    else if (m.role === "toolResult" || m.role === "tool") out.push({ channel: "tool", text });
    else if (m.role === "assistant") out.push({ channel: "assistant", text });
    else if (m.role === "system") out.push({ channel: "system", text });
  }
  return out;
}

export class AgentArgcheck {
  private readonly memo: ArgcheckMemo;

  constructor(private readonly opts: AgentArgcheckOptions) {
    this.memo = newArgcheckMemo("agent", opts.now?.() ?? Date.now());
  }

  mode(): ObligationsMode {
    return (this.opts.mode ?? argcheckMode)();
  }

  /**
   * Check one state-changing call against the transcript. Returns the outcome
   * (undefined when off) and, in `on` for an unsupported call never refused
   * before, the refusal reason. Never throws.
   */
  async check(
    name: string,
    args: unknown,
    transcript: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<{ outcome?: ArgcheckOutcome; refusal?: string }> {
    const mode = this.mode();
    if (mode === "off") return {};
    try {
      const provider = this.opts.provider?.();
      const stated = this.opts.stated?.() ?? [];
      const outcome = await checkCall(
        { name, args },
        new EvidenceIndex(transcriptEvidence(transcript)),
        {
          memo: this.memo,
          mode,
          judge: { ...(provider ? { provider } : {}), complete: this.opts.complete },
          ...(stated.length ? { stated } : {}),
          ...(signal ? { signal } : {}),
        },
      );
      if (outcome.judgement?.costUsd) this.memo.costUsd += outcome.judgement.costUsd;
      this.memo.updatedAt = this.opts.now?.() ?? Date.now();
      return { outcome, ...(outcome.nudge ? { refusal: outcome.nudge } : {}) };
    } catch {
      return {};
    }
  }

  /** Counters (no content). */
  summary(): Omit<ArgcheckMemo, "key" | "nudged" | "updatedAt"> {
    const { key: _k, nudged: _n, updatedAt: _u, ...counts } = this.memo;
    return counts;
  }
}
