// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exec approver seam — the security core of gated *arbitrary* (non-allowlisted)
 * host command execution in a code workspace.
 *
 * The workspace exec chokepoint (`LocalWorkspace.run`) tries the existing
 * allowlist first. Only when a command falls off the allowlist does it consult
 * an attached `ExecApprover`. An approver is optional, attached per-call /
 * per-workspace — never global. With no approver attached (the default), the
 * arbitrary-exec branch is unreachable and behavior is byte-identical to the
 * allowlist-only past.
 *
 * Two concrete approvers live here:
 *  - `InteractiveApprover` — asks a human (the session creator) to approve via a
 *    perception + `code exec-approve/deny` reply; supports an `auto` mode and a
 *    per-session allow-set keyed by argv.
 *  - `HeadlessGateApprover` — a synchronous four-condition chain for
 *    non-interactive automation, gated on `MARINA_CODE_EXEC_UNRESTRICTED` +
 *    `code.exec.unrestricted` competence + a trustworthy identity.
 *
 * Every arbitrary exec *attempt* (approved or denied, interactive or headless)
 * is routed through an injected `ExecAuditSink` so the caller can persist a
 * durable audit record.
 */

import { checkGate } from "../engine/safety-gates";
import type { MarinaDB } from "../persistence/database";

/** A request to run a specific argv in a specific workspace on behalf of an entity. */
export interface ExecApprovalRequest {
  argv: string[];
  cwd: string;
  entityId: string;
}

/**
 * The verdict for one arbitrary-exec request. `scope: "session"` tells the
 * interactive approver to admit the same argv again with no further prompt.
 */
export type ExecApprovalDecision = {
  approved: boolean;
  scope?: "once" | "session";
  reason?: string;
};

/** The seam the workspace chokepoint consults for non-allowlisted commands. */
export interface ExecApprover {
  requestApproval(req: ExecApprovalRequest): Promise<ExecApprovalDecision>;
}

/**
 * Called for EVERY arbitrary exec attempt so the caller can write a durable
 * audit trail (a coding artifact/event). Never throws in the approver path.
 *
 * `humanApproved` is TRUE only when a real human made an explicit, per-command
 * prompt decision that approved this exact argv (i.e. `settleExecApproval` was
 * reached via `code exec-approve`). It is FALSE for auto-mode approvals and for
 * session-allow-set replays — those must NOT mint competence toward
 * `code.exec.unrestricted`, since no genuine human decision happened per call.
 */
export type ExecAuditSink = (
  req: ExecApprovalRequest,
  decision: ExecApprovalDecision,
  meta: { mode: string; interactive: boolean; humanApproved: boolean },
) => void;

/**
 * Provenance stamp a human `code exec-approve` places on the settled decision.
 * The audit sink keys demonstration-recording on this exact reason so that only
 * a genuine per-command human approval counts as a witnessed demonstration.
 */
export const OPERATOR_APPROVED_REASON = "operator-approved";

/** Default interactive-approval timeout; overridable per approver. */
export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 120_000;

/** Human-readable rendering of an argv for prompts and audit titles. */
export function renderArgv(argv: string[]): string {
  return argv
    .map((part) => (/\s/.test(part) || part === "" ? JSON.stringify(part) : part))
    .join(" ");
}

function argvKey(argv: string[]): string {
  return JSON.stringify(argv);
}

// ─── Interactive approver ────────────────────────────────────────────────────

interface PendingApproval {
  token: string;
  sessionId: string;
  creatorName: string;
  argv: string[];
  settle: (decision: ExecApprovalDecision) => void;
}

// In-memory only — never persisted. A restart clears pending prompts (they
// re-prompt) and the per-session allow-set (arbitrary exec re-prompts).
const pendingApprovals = new Map<string, PendingApproval>();
const sessionAllowSets = new Map<string, Set<string>>();

export interface InteractiveApproverDeps {
  sessionId: string;
  /** The human who created the session — receives the approval perception. */
  creatorEntityId: string;
  creatorName: string;
  /** "prompt" asks the creator; "auto" approves immediately (still audited). */
  mode: "prompt" | "auto";
  notify: (entityId: string, message: string, metadata?: Record<string, unknown>) => void;
  audit: ExecAuditSink;
  timeoutMs?: number;
}

export class InteractiveApprover implements ExecApprover {
  constructor(private readonly deps: InteractiveApproverDeps) {}

  async requestApproval(req: ExecApprovalRequest): Promise<ExecApprovalDecision> {
    const key = argvKey(req.argv);

    // Session-scope allow-set: same argv approved earlier this session runs with
    // no prompt. A different argv still re-prompts.
    if (sessionAllowSets.get(this.deps.sessionId)?.has(key)) {
      const decision: ExecApprovalDecision = { approved: true, scope: "session" };
      // Replay of a prior approval — NOT a fresh human decision, so it must not
      // mint a demonstration (humanApproved: false).
      this.deps.audit(
        req,
        { ...decision, reason: "session-allow" },
        { mode: this.deps.mode, interactive: true, humanApproved: false },
      );
      return decision;
    }

    // Auto mode: approve immediately WITHOUT a prompt, but STILL audit. No human
    // per-command decision happened, so this never mints a demonstration.
    if (this.deps.mode === "auto") {
      const decision: ExecApprovalDecision = { approved: true };
      this.deps.audit(
        req,
        { ...decision, reason: "auto-mode" },
        { mode: "auto", interactive: true, humanApproved: false },
      );
      return decision;
    }

    // Prompt mode: mint a token, notify the creator, await a reply or time out.
    const token = crypto.randomUUID().slice(0, 12);
    const rendered = renderArgv(req.argv);
    const decision = await new Promise<ExecApprovalDecision>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (d: ExecApprovalDecision): void => {
        if (timer) clearTimeout(timer);
        pendingApprovals.delete(token);
        resolve(d);
      };
      pendingApprovals.set(token, {
        token,
        sessionId: this.deps.sessionId,
        creatorName: this.deps.creatorName,
        argv: req.argv,
        settle,
      });
      const humanText = [
        `Code exec approval requested (session ${this.deps.sessionId}):`,
        `  ${rendered}`,
        `  cwd: ${req.cwd}`,
        `Approve: code exec-approve ${token}`,
        `Deny:    code exec-deny ${token} [reason]`,
      ].join("\n");
      this.deps.notify(this.deps.creatorEntityId, humanText, {
        execApproval: { token, argv: req.argv, cwd: req.cwd, rendered },
      });
      timer = setTimeout(
        () => settle({ approved: false, reason: "approval timed out" }),
        this.deps.timeoutMs ?? DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
      );
    });

    if (decision.approved && decision.scope === "session") {
      const set = sessionAllowSets.get(this.deps.sessionId) ?? new Set<string>();
      set.add(key);
      sessionAllowSets.set(this.deps.sessionId, set);
    }
    // A demonstration is minted only when a real human approved THIS argv via
    // `code exec-approve` (which stamps OPERATOR_APPROVED_REASON). A timeout or
    // explicit deny never qualifies.
    this.deps.audit(req, decision, {
      mode: "prompt",
      interactive: true,
      humanApproved: decision.approved && decision.reason === OPERATOR_APPROVED_REASON,
    });
    return decision;
  }
}

/** Look up a pending prompt (for the `code exec-approve/deny` identity check). */
export function getPendingExecApproval(
  token: string,
): { creatorName: string; sessionId: string; argv: string[] } | undefined {
  const pending = pendingApprovals.get(token);
  if (!pending) return undefined;
  return { creatorName: pending.creatorName, sessionId: pending.sessionId, argv: pending.argv };
}

/** Resolve a pending prompt. Returns false when the token is unknown/expired. */
export function settleExecApproval(token: string, decision: ExecApprovalDecision): boolean {
  const pending = pendingApprovals.get(token);
  if (!pending) return false;
  pending.settle(decision);
  return true;
}

/** Drop a session's allow-set and deny any of its still-pending prompts. */
export function clearSessionExecState(sessionId: string): void {
  sessionAllowSets.delete(sessionId);
  for (const [token, pending] of [...pendingApprovals.entries()]) {
    if (pending.sessionId === sessionId) {
      pendingApprovals.delete(token);
      pending.settle({ approved: false, reason: "session closed" });
    }
  }
}

// ─── Headless approver ───────────────────────────────────────────────────────

export interface HeadlessGateApproverDeps {
  db: MarinaDB;
  /** Canonical name of the acting entity, matched against the env allow-list. */
  entityName?: string;
  /** Comma-listed ids/names from MARINA_CODE_EXEC_UNRESTRICTED. */
  allowList: string[];
  /**
   * Condition (3a): external identity verification is required for every login
   * (MARINA_AUTH=better-auth). When true, any admitted+competent entity is
   * trusted regardless of its connection origin.
   */
  authRequired: boolean;
  /**
   * Condition (3b): resolved PER acting connection at approval time — true iff
   * the acting entity's own live connection is genuinely local (loopback IP /
   * in-process), NOT derived from a process-wide env like WS_HOST. This closes
   * the "env lies about the bind" hole: trust follows the real socket, so a
   * remote peer reaching an accidentally-0.0.0.0-bound port is never trusted
   * even if WS_HOST claims loopback.
   */
  actingConnectionTrusted: (entityId: string) => boolean;
  audit: ExecAuditSink;
  /** Injectable for tests; defaults to the real safety-gate check. */
  checkGate?: typeof checkGate;
}

/**
 * Synchronous four-condition chain (no perception). Approves iff ALL hold:
 *  (1) MARINA_CODE_EXEC_UNRESTRICTED is set and the resolved entity id/name is
 *      in that comma list;
 *  (2) `code.exec.unrestricted` competence is unsupervised (ok, not supervised);
 *  (3) the identity is trustworthy — authRequired, OR the acting connection is
 *      genuinely local (resolved per-connection, never from a WS_HOST env).
 * Any failure → `{ approved: false }` (the workspace then throws the allowlist
 * error — never a weaker fallback).
 */
export class HeadlessGateApprover implements ExecApprover {
  constructor(private readonly deps: HeadlessGateApproverDeps) {}

  async requestApproval(req: ExecApprovalRequest): Promise<ExecApprovalDecision> {
    const decision = this.decide(req);
    this.deps.audit(req, decision, { mode: "headless", interactive: false, humanApproved: false });
    return decision;
  }

  private decide(req: ExecApprovalRequest): ExecApprovalDecision {
    // (1) env allow-list admits this entity by id or name.
    const allow = new Set(this.deps.allowList.map((entry) => entry.trim()).filter(Boolean));
    const admitted =
      allow.has(req.entityId) || (this.deps.entityName ? allow.has(this.deps.entityName) : false);
    if (allow.size === 0 || !admitted) {
      return { approved: false, reason: "entity not in MARINA_CODE_EXEC_UNRESTRICTED" };
    }

    // (2) unsupervised competence on code.exec.unrestricted.
    const gate = (this.deps.checkGate ?? checkGate)(
      this.deps.db,
      req.entityId,
      "code.exec.unrestricted",
    );
    if (!gate.ok || gate.supervisedOnly) {
      return { approved: false, reason: "code.exec.unrestricted competence not established" };
    }

    // (3) trustworthy identity — PER CONNECTION, not a process-wide env boolean.
    // Trusted iff external auth is required for every login, OR this specific
    // acting connection is genuinely local (loopback / in-process).
    const trusted = this.deps.authRequired || this.deps.actingConnectionTrusted(req.entityId);
    if (!trusted) {
      return {
        approved: false,
        reason: "acting connection is not trusted for headless exec (non-loopback, no auth)",
      };
    }

    return { approved: true, scope: "once" };
  }
}

/** Parse a comma-list env value (MARINA_CODE_EXEC_UNRESTRICTED). */
export function parseExecUnrestricted(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
