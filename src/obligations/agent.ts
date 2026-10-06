// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The obligations ledger for one of Marina's own agent loops (a resident, a
 * crew member, a Code Mode coder). `MARINA_OBLIGATIONS` (read live) decides:
 *
 *   off      nothing is read, no call is made (the default);
 *   observe  requests are extracted and tool calls tracked; counts are logged;
 *            the model sees nothing;
 *   on       the open obligations are listed in the continuation prompt, and a
 *            run that would end with one open (a turn with no tool call) gets
 *            one follow-up naming it, at most once per obligation.
 *
 * Requests reach it as text (the tracked tells/requests owed a reply, the
 * active coding task); extraction runs at the next prompt build, never inside
 * a tool hook. Session state only: the ledger lives with the agent process.
 */

import type { DecisionProvider } from "../decisions/types";
import {
  type CompleteText,
  extractObligations,
  type NewRequest,
  resolveMatch,
  type ToolInfo,
} from "./extract";
import {
  applyExtraction,
  ledgerSummary,
  MAX_LISTED,
  matchCall,
  newLedger,
  type Obligation,
  type ObligationLedger,
  openObligations,
  settle,
  statedLines,
  type ToolCallRecord,
} from "./ledger";
import { type ObligationsMode, obligationsMode } from "./mode";

/** Requests queued between prompt builds (the oldest are dropped past this). */
const MAX_PENDING_REQUESTS = 8;
/** Ambiguous matches judged per prompt build. */
const MAX_JUDGED_MATCHES = 2;

export interface AgentObligationsOptions {
  /** One completion on the ledger's model (`MARINA_OBLIGATIONS_MODEL` or the agent's own). */
  complete: CompleteText;
  /** The decision layer, when configured (judgements become numbers). */
  provider?: () => DecisionProvider | undefined;
  mode?: () => ObligationsMode;
  now?: () => number;
}

export class AgentObligations {
  private readonly ledger: ObligationLedger;
  private pending: string[] = [];
  private turn = 0;
  private ambiguous: Array<{ call: ToolCallRecord; ids: string[] }> = [];

  constructor(private readonly opts: AgentObligationsOptions) {
    this.ledger = newLedger("agent", this.now());
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  mode(): ObligationsMode {
    return (this.opts.mode ?? obligationsMode)();
  }

  /** A request the agent now owes work on (first-party text only). */
  noteRequest(text: string): void {
    if (this.mode() === "off") return;
    const t = text.trim();
    if (!t) return;
    this.pending.push(t);
    if (this.pending.length > MAX_PENDING_REQUESTS) this.pending.shift();
  }

  /** Read queued requests into obligations and settle ambiguous matches. Never throws. */
  async refresh(tools: ToolInfo[], signal?: AbortSignal): Promise<void> {
    if (this.mode() === "off") return;
    if (this.pending.length > 0) {
      const batch = this.pending.splice(0);
      const requests: NewRequest[] = batch.map((text) => ({ turn: ++this.turn, text }));
      const extraction = await extractObligations(this.opts.complete, {
        tools,
        open: openObligations(this.ledger),
        requests,
      });
      if (extraction) {
        applyExtraction(
          this.ledger,
          this.turn,
          extraction,
          new Set(tools.map((t) => t.name)),
          this.now(),
          requests[0]!.turn,
        );
      } else {
        this.ledger.extractFailures++;
      }
      this.ledger.userTurns = this.turn;
    }
    const provider = this.opts.provider?.();
    for (const { call, ids } of this.ambiguous.splice(0, MAX_JUDGED_MATCHES)) {
      const candidates = this.ledger.obligations.filter(
        (o) => ids.includes(o.id) && o.status === "open",
      );
      const pick = await resolveMatch(
        call,
        candidates,
        { ...(provider ? { provider } : {}), complete: this.opts.complete },
        signal,
      );
      if (pick) settle(this.ledger, pick, "satisfied", `judge:${call.name}`);
    }
    this.ambiguous.length = 0;
  }

  /** A finished tool call (mechanical matching only; ambiguity waits for `refresh`). */
  observeToolResult(
    name: string,
    args: unknown,
    ok: boolean,
    isWrite: (n: string, args: unknown) => boolean,
  ): void {
    if (this.mode() === "off") return;
    const call: ToolCallRecord = { name, args, ok, turn: this.turn };
    this.ledger.callsSeen++;
    const m = matchCall(this.ledger, call, isWrite);
    if (m.ambiguous.length > 0) this.ambiguous.push({ call, ids: m.ambiguous });
  }

  /** The continuation-prompt section (`on` only), or undefined. */
  section(): string | undefined {
    if (this.mode() !== "on") return undefined;
    const open = openObligations(this.ledger);
    if (open.length === 0) return undefined;
    return [
      `[Open obligations — ${open.length}]`,
      ...open.slice(-MAX_LISTED).map(line),
      "Carry each out, or tell the requester why not. Settled by a successful matching action.",
    ].join("\n");
  }

  /**
   * The one-time end-of-run follow-up (`on` only): the open obligations never
   * named in a nudge before, now marked nudged. Undefined when there are none.
   */
  nudge(): string | undefined {
    if (this.mode() !== "on") return undefined;
    const owed = openObligations(this.ledger).filter((o) => !o.nudged);
    if (owed.length === 0) return undefined;
    for (const o of owed) o.nudged = true;
    this.ledger.nudges++;
    return [
      "[Obligations] Your run is ending with these requests not yet carried out:",
      ...owed.slice(0, MAX_LISTED).map(line),
      "If one still needs an action you can take, take it now (a tool call). If it is declined or impossible, tell the requester why.",
    ].join("\n");
  }

  /** The requests as context for the argument check's judge (empty when off). */
  stated(): string[] {
    return this.mode() === "off" ? [] : statedLines(this.ledger);
  }

  summary(): ReturnType<typeof ledgerSummary> & { pending: number } {
    return { ...ledgerSummary(this.ledger), pending: this.pending.length };
  }

  /** Read-only view (tests, diagnostics). */
  obligations(): readonly Obligation[] {
    return this.ledger.obligations;
  }
}

function line(o: Obligation): string {
  return `- ${o.id}: ${o.what}${o.target ? ` (target: ${o.target})` : ""}`;
}
