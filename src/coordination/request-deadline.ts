// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Crew request deadlines (budget-terminal answering for `marina:<crew>`
 * requests, `src/agent/budget-terminal.ts`): a routed request that reaches its
 * deadline returns the best draft the crew has produced so far — never a bare
 * timeout when a draft exists — and a request whose lead hits a non-retryable
 * upstream refusal fails fast instead of waiting out the deadline.
 *
 * Drafts, in preference order:
 *   1. the lead's latest explicit draft — `{"type":"model_draft","id":…}` on
 *      the request channel;
 *   2. the most-agreed explicit draft among the other members;
 *   3. the lead's latest model text under the request's trace;
 *   4. the most-agreed member text under the request's trace (consultants'
 *      turns carry the request trace through their tells).
 *
 * Pure apart from what the caller feeds it: no timers, no I/O.
 */

import { mostAgreedDraft } from "../agent/budget-terminal";
import type { EngineEvent } from "../types";

/** Longest draft kept per member (characters). */
const MAX_DRAFT_CHARS = 8_000;

/** Seconds kept back from a client's deadline so the reply arrives before it gives up. */
export const CLIENT_DEADLINE_MARGIN_MS = 15_000;
/** Shortest server deadline a client header can ask for. */
export const MIN_REQUEST_DEADLINE_MS = 1_000;

/**
 * The server-side deadline for one request: the route's own timeout, or the
 * client's (`x-marina-deadline-ms`, less a margin) when that is sooner.
 */
export function requestDeadlineMs(defaultMs: number, clientDeadlineMs?: number): number {
  if (!(clientDeadlineMs && clientDeadlineMs > 0)) return defaultMs;
  const margin = Math.min(CLIENT_DEADLINE_MARGIN_MS, clientDeadlineMs * 0.1);
  return Math.max(MIN_REQUEST_DEADLINE_MS, Math.min(defaultMs, clientDeadlineMs - margin));
}

/** A client deadline header value in milliseconds, or undefined when absent or junk. */
export function parseDeadlineHeader(raw: string | null | undefined): number | undefined {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 4xx statuses that retrying the same request never fixes. 408/409/425/429 are transient. */
const NON_RETRYABLE_4XX = new Set([400, 401, 402, 403, 404, 405, 410, 413, 415, 422]);

/**
 * The status of a non-retryable upstream refusal in an agent error line
 * (`LLM error (attempt N) [model]: 400 {…}`), or undefined.
 */
export function upstreamRefusalStatus(error: string): number | undefined {
  const m = /LLM error[^:]*:\s*(?:HTTP\s*|status(?:\s*code)?\s*:?\s*|error\s*)?(\d{3})\b/i.exec(
    error,
  );
  const status = m ? Number(m[1]) : Number.NaN;
  return NON_RETRYABLE_4XX.has(status) ? status : undefined;
}

export interface BestDraft {
  text: string;
  /** `lead-draft` | `member-plurality` | `lead-text` | `member-text` */
  source: string;
}

/** Collects the drafts one routed request's crew produces (see the file header). */
export class RequestDraftCollector {
  private readonly explicit = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly partial = new Map<string, string>();

  constructor(
    private readonly traceId: string,
    private readonly leadName: string | undefined,
  ) {}

  /** An explicit `model_draft` from a member on the request channel. */
  addExplicit(memberName: string, text: string): void {
    const t = text.trim();
    if (t) this.explicit.set(memberName, t.slice(0, MAX_DRAFT_CHARS));
  }

  /** Feed every engine event; only this request's trace is read. */
  onEvent(event: EngineEvent): void {
    if (event.type === "agent_text_delta" && event.traceId === this.traceId) {
      const had = this.partial.get(event.name) ?? "";
      if (had.length < MAX_DRAFT_CHARS) this.partial.set(event.name, had + event.delta);
      return;
    }
    if (event.type === "agent_turn_end" && event.traceId === this.traceId) {
      const text = (this.partial.get(event.name) ?? "").trim();
      this.partial.delete(event.name);
      if (text) this.texts.set(event.name, text.slice(0, MAX_DRAFT_CHARS));
    }
  }

  /** Whether any draft has been seen. */
  get empty(): boolean {
    return this.explicit.size === 0 && this.texts.size === 0 && this.pendingText().length === 0;
  }

  private pendingText(): string[] {
    return [...this.partial.values()].map((t) => t.trim()).filter(Boolean);
  }

  /** The best draft so far, or undefined when the crew produced none. */
  best(): BestDraft | undefined {
    const lead = this.leadName;
    if (lead && this.explicit.has(lead)) {
      return { text: this.explicit.get(lead)!, source: "lead-draft" };
    }
    const agreed = mostAgreedDraft([...this.explicit.values()]);
    if (agreed) return { text: agreed.text, source: "member-plurality" };
    const leadText = lead ? (this.texts.get(lead) ?? this.partial.get(lead)?.trim()) : undefined;
    if (leadText) return { text: leadText, source: "lead-text" };
    const members = mostAgreedDraft([...this.texts.values(), ...this.pendingText()]);
    return members ? { text: members.text, source: "member-text" } : undefined;
  }
}
