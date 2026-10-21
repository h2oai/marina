// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The claim on a single-target agents-mode request: which member of the
// endpoint channel holds it, and when that hold lapses. Imports nothing from
// `./model-api/*`.
//
// The route addresses each `model_request` to ONE member (`target`). Only the
// addressee owes it (`assessPerception`, src/agent/attention.ts), so a request
// whose holder never starts on it (wedged, disconnected, stuck behind other
// work) would wait for the deadline. The claim is a lease: the holder's traced
// work on the request renews it; with no sign of work for the lease, the
// request is re-offered to another eligible member, and the old holder,
// seeing the re-offer addressed elsewhere, drops it.

import type { EngineEvent } from "../../types";

/** Default claim lease: no sign of work on a request for this long re-offers it. */
export const DEFAULT_CLAIM_LEASE_MS = 120_000;

/**
 * `MARINA_REQUEST_CLAIM_LEASE_MS`: how long a member may hold a routed request
 * without any traced work on it before it is re-offered. `0`/`off` = never
 * re-offer; unset or junk ⇒ {@link DEFAULT_CLAIM_LEASE_MS}.
 */
export function claimLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_REQUEST_CLAIM_LEASE_MS?.trim().toLowerCase();
  if (!raw) return DEFAULT_CLAIM_LEASE_MS;
  if (raw === "off") return 0;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : DEFAULT_CLAIM_LEASE_MS;
}

const AGENT_WORK_EVENTS = new Set<EngineEvent["type"]>([
  "agent_turn_start",
  "agent_turn_end",
  "agent_tool_call",
  "agent_tool_result",
  "agent_text_delta",
  "agent_thinking_delta",
]);

/**
 * An agent event that is `agentName`'s work on request `requestId`: one of its
 * turn, tool or text events under the request's trace, or a span that links it.
 */
export function isWorkOnRequest(event: EngineEvent, agentName: string, requestId: string): boolean {
  if (!AGENT_WORK_EVENTS.has(event.type)) return false;
  const e = event as {
    name?: string;
    traceId?: string;
    links?: Array<{ traceId: string }>;
  };
  if (e.name !== agentName) return false;
  return e.traceId === requestId || !!e.links?.some((link) => link.traceId === requestId);
}

export interface RequestClaimOptions {
  /** The member the request was first routed to. */
  holder: string;
  /** No sign of work for this long re-offers the request; 0 = never. */
  leaseMs: number;
  /** The members eligible to hold it now (online, outward-facing), in order. */
  candidates: () => readonly string[];
  /** Fewer in-flight requests is preferred among untried members. */
  load?: (member: string) => number;
  /** Re-address the request to `next` (post the re-offer, move the load). */
  reoffer: (next: string, previous: string) => void;
}

/**
 * One request's claim. `renew()` on the holder's work; `stop()` once settled.
 * At expiry the request goes to the next eligible member: one that has not
 * held it yet (fewest in flight, then channel order), else the one that held
 * it longest ago. With no other eligible member the holder keeps it and the
 * lease restarts, so a lone member is never re-offered its own request.
 */
export class RequestClaim {
  private current: string;
  private readonly heldAt = new Map<string, number>();
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private offers = 0;

  constructor(private readonly options: RequestClaimOptions) {
    this.current = options.holder;
    this.heldAt.set(options.holder, this.sequence++);
  }

  /** The member that holds the request now. */
  get holder(): string {
    return this.current;
  }

  /** How many times the request has been re-offered. */
  get reoffers(): number {
    return this.offers;
  }

  start(): void {
    this.arm();
  }

  /** The holder showed work on the request: the lease starts over. */
  renew(): void {
    if (!this.stopped) this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Lapse the lease now (what the timer does at expiry). */
  expire(): void {
    if (this.stopped) return;
    const next = this.nextHolder();
    if (next) {
      const previous = this.current;
      this.current = next;
      this.heldAt.set(next, this.sequence++);
      this.offers++;
      this.options.reoffer(next, previous);
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.options.leaseMs <= 0) return;
    this.timer = setTimeout(() => this.expire(), this.options.leaseMs);
  }

  private nextHolder(): string | undefined {
    const others = this.options.candidates().filter((m) => m !== this.current);
    if (others.length === 0) return undefined;
    const untried = others.filter((m) => !this.heldAt.has(m));
    if (untried.length > 0) {
      const load = this.options.load ?? (() => 0);
      return untried.reduce((best, m) => (load(m) < load(best) ? m : best));
    }
    return others.reduce((oldest, m) =>
      (this.heldAt.get(m) ?? 0) < (this.heldAt.get(oldest) ?? 0) ? m : oldest,
    );
  }
}
