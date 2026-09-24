// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Human approval for decision-gate `ask` verdicts. The gate holds an agent's
 * tool call and asks the agent's OWNER (the principal that spawned it) to
 * `decision approve <token>` or `decision deny <token>`. The call waits — the
 * agent's loop is paused on it — and FAILS CLOSED: a timeout, a deny, or an
 * agent with no approvable owner blocks the call.
 *
 * Only the owner may settle, and an agent can never settle its own request
 * (self-attestation is always refused). There is deliberately no rank
 * override: an operator who wants a say spawns the agent themselves.
 *
 * In-process only (agents and the engine share the process); a restart drops
 * pending requests, which the waiting calls see as a timeout.
 */

import { sanitizeEntityName } from "../engine/entity-name";

export interface ApprovalRequest {
  token: string;
  agentName: string;
  ownerName: string;
  toolName: string;
  /** Redacted, truncated rendering of the call for the approver. */
  summary: string;
  reason: string;
  signals: Record<string, number>;
  createdAt: number;
  expiresAt: number;
}

export type ApprovalOutcome = "approved" | "denied" | "timeout";

interface Pending {
  request: ApprovalRequest;
  settle: (outcome: ApprovalOutcome, by?: string, note?: string) => void;
}

const pending = new Map<string, Pending>();
let notifier: ((request: ApprovalRequest) => boolean) | undefined;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PENDING = 200;

/** Engine side: deliver a request to its owner. Return false when the owner can't be reached. */
export function setApprovalNotifier(fn: ((request: ApprovalRequest) => boolean) | undefined): void {
  notifier = fn;
}

/** Owners that can never approve: no spawner recorded, or the system. */
export function isApprovableOwner(owner: string | undefined): owner is string {
  return !!owner && owner.trim() !== "" && owner.trim().toLowerCase() !== "system";
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `ap_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Ask the owner and wait. Resolves `timeout` immediately when there is no
 * approvable owner, no notifier, the owner is unreachable, or the queue is full.
 */
export function requestApproval(
  input: Omit<ApprovalRequest, "token" | "createdAt" | "expiresAt">,
  timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
): Promise<{ outcome: ApprovalOutcome; token?: string; by?: string; note?: string }> {
  if (!isApprovableOwner(input.ownerName) || !notifier || pending.size >= MAX_PENDING) {
    return Promise.resolve({ outcome: "timeout" });
  }
  const now = Date.now();
  const request: ApprovalRequest = {
    ...input,
    token: newToken(),
    createdAt: now,
    expiresAt: now + timeoutMs,
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const finish = (outcome: ApprovalOutcome, by?: string, note?: string) => {
      if (!pending.delete(request.token)) return;
      clearTimeout(timer);
      resolve({ outcome, token: request.token, ...(by ? { by } : {}), ...(note ? { note } : {}) });
    };
    pending.set(request.token, { request, settle: finish });
    let delivered = false;
    try {
      delivered = notifier?.(request) ?? false;
    } catch {
      delivered = false;
    }
    if (!delivered) finish("timeout");
  });
}

/** Pending requests an entity may settle (it owns the agent). */
export function listApprovals(approverName: string): ApprovalRequest[] {
  const me = sanitizeEntityName(approverName).toLowerCase();
  return [...pending.values()]
    .map((p) => p.request)
    .filter((r) => sanitizeEntityName(r.ownerName).toLowerCase() === me)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export type SettleResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: "not_found" | "not_owner" | "self" };

/** Settle a request. Only the owner, never the agent itself. */
export function settleApproval(
  token: string,
  approverName: string,
  decision: "approved" | "denied",
  note?: string,
): SettleResult {
  const entry = pending.get(token.trim());
  if (!entry) return { ok: false, error: "not_found" };
  const me = sanitizeEntityName(approverName).toLowerCase();
  if (sanitizeEntityName(entry.request.agentName).toLowerCase() === me) {
    return { ok: false, error: "self" };
  }
  if (sanitizeEntityName(entry.request.ownerName).toLowerCase() !== me) {
    return { ok: false, error: "not_owner" };
  }
  const { request } = entry;
  entry.settle(decision, approverName, note);
  return { ok: true, request };
}

/** Test seam. */
export function resetApprovalsForTests(): void {
  for (const entry of [...pending.values()]) entry.settle("timeout");
  pending.clear();
  notifier = undefined;
}
