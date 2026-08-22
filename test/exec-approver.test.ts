// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprover,
  type ExecAuditSink,
  getPendingExecApproval,
  HeadlessGateApprover,
  InteractiveApprover,
  OPERATOR_APPROVED_REASON,
  parseExecUnrestricted,
  settleExecApproval,
} from "../src/coding/exec-approver";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { grant, recordDemonstration } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

/** A stub approver with a fixed decision — the simplest ExecApprover. */
function stubApprover(decision: ExecApprovalDecision): ExecApprover {
  return { requestApproval: async () => decision };
}

describe("LocalWorkspace arbitrary-exec chokepoint", () => {
  let root: string;
  let workspace: LocalWorkspace;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "marina-exec-approver-")));
    workspace = new LocalWorkspace(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("with NO approver attached rejects arbitrary commands (byte-identical allowlist error)", async () => {
    for (const cmd of [["pytest"], ["curl", "https://example.com"], ["rm", "-rf", "/"]]) {
      await expect(workspace.run(cmd)).rejects.toThrow(/Command is not allowed/);
    }
  });

  it("still runs allowlisted commands unchanged when an approver is attached", async () => {
    // A deny-everything approver must never be consulted for an allowlisted command.
    let consulted = false;
    workspace.attachExecApprover(
      {
        requestApproval: async () => {
          consulted = true;
          return { approved: false };
        },
      },
      "e_alice",
    );
    const result = await workspace.run(["git", "status", "--short"]);
    expect(result.command).toEqual(["git", "status", "--short"]);
    expect(consulted).toBe(false);
  });

  it("throws the allowlist error when the approver denies", async () => {
    workspace.attachExecApprover(stubApprover({ approved: false, reason: "no" }), "e_alice");
    await expect(workspace.run(["pytest"])).rejects.toThrow(/Command is not allowed/);
  });

  it("runs an approved arbitrary command under the residual guards", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const seen: ExecApprovalRequest[] = [];
      workspace.attachExecApprover(
        {
          requestApproval: async (req) => {
            seen.push(req);
            return { approved: true };
          },
        },
        "e_alice",
      );
      // `bun -e` is off the allowlist → routed through the approver → run raw.
      const script =
        "console.log(JSON.stringify({home:process.env.HOME,anth:process.env.ANTHROPIC_API_KEY??null,cwd:process.cwd(),cwdreal:require('fs').realpathSync(process.cwd())}))";
      const result = await workspace.run(["bun", "-e", script]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.output.trim());
      // Residual guard: scrubbed env has NO secrets.
      expect(parsed.anth).toBeNull();
      expect(parsed.home).toContain("marina-code-home");
      // Residual guard: cwd pinned to the workspace root.
      expect(parsed.cwdreal).toBe(root);
      // The approver saw the full request (argv + cwd + entity).
      expect(seen[0]?.argv).toEqual(["bun", "-e", script]);
      expect(seen[0]?.cwd).toBe(root);
      expect(seen[0]?.entityId).toBe("e_alice");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("enforces the 64KB output cap on an approved arbitrary command", async () => {
    workspace.attachExecApprover(stubApprover({ approved: true }), "e_alice");
    const result = await workspace.run(
      ["bun", "-e", "process.stdout.write('x'.repeat(5000))"],
      120_000,
      100,
    );
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(100);
  });

  it("does not consult the approver for an empty argv (allowlist error)", async () => {
    let consulted = false;
    workspace.attachExecApprover(
      {
        requestApproval: async () => {
          consulted = true;
          return { approved: true };
        },
      },
      "e_alice",
    );
    await expect(workspace.run([""])).rejects.toThrow();
    expect(consulted).toBe(false);
  });
});

describe("InteractiveApprover", () => {
  const notifications: Array<{ entityId: string; metadata?: Record<string, unknown> }> = [];
  const audits: Array<{ decision: ExecApprovalDecision; mode: string; interactive: boolean }> = [];
  const notify = (entityId: string, _msg: string, metadata?: Record<string, unknown>): void => {
    notifications.push({ entityId, metadata });
  };
  const audit: ExecAuditSink = (_req, decision, meta) => {
    audits.push({ decision, mode: meta.mode, interactive: meta.interactive });
  };

  beforeEach(() => {
    notifications.length = 0;
    audits.length = 0;
  });

  function make(
    mode: "prompt" | "auto",
    sessionId: string,
    timeoutMs?: number,
  ): InteractiveApprover {
    return new InteractiveApprover({
      sessionId,
      creatorEntityId: "e_creator",
      creatorName: "Creator",
      mode,
      notify,
      audit,
      timeoutMs,
    });
  }

  const req = (argv: string[]): ExecApprovalRequest => ({ argv, cwd: "/w", entityId: "e_agent" });

  it("prompts the creator and resolves approved on exec-approve", async () => {
    const approver = make("prompt", "s1");
    const pending = approver.requestApproval(req(["pytest"]));
    // The perception carried the token + argv to the creator.
    await Promise.resolve();
    const prompt = notifications.at(-1);
    expect(prompt?.entityId).toBe("e_creator");
    const token = (prompt?.metadata?.execApproval as { token: string }).token;
    expect(getPendingExecApproval(token)?.creatorName).toBe("Creator");
    expect(settleExecApproval(token, { approved: true, scope: "session" })).toBe(true);
    const decision = await pending;
    expect(decision.approved).toBe(true);
    // Audit written on approve.
    expect(audits.at(-1)?.decision.approved).toBe(true);
  });

  it("admits the same argv again without a prompt after a session-scope approval", async () => {
    const approver = make("prompt", "s2");
    const first = approver.requestApproval(req(["ruff", "check"]));
    await Promise.resolve();
    const token = (notifications.at(-1)?.metadata?.execApproval as { token: string }).token;
    settleExecApproval(token, { approved: true, scope: "session" });
    await first;
    const before = notifications.length;
    // Same argv → no new prompt.
    const second = await approver.requestApproval(req(["ruff", "check"]));
    expect(second.approved).toBe(true);
    expect(notifications.length).toBe(before);
    // A different argv re-prompts.
    const third = approver.requestApproval(req(["ruff", "format"]));
    await Promise.resolve();
    expect(notifications.length).toBe(before + 1);
    const t3 = (notifications.at(-1)?.metadata?.execApproval as { token: string }).token;
    settleExecApproval(t3, { approved: false, reason: "no" });
    expect((await third).approved).toBe(false);
  });

  it("denies (and audits) on exec-deny", async () => {
    const approver = make("prompt", "s3");
    const pending = approver.requestApproval(req(["rm", "-rf", "x"]));
    await Promise.resolve();
    const token = (notifications.at(-1)?.metadata?.execApproval as { token: string }).token;
    settleExecApproval(token, { approved: false, reason: "nope" });
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("nope");
    expect(audits.at(-1)?.decision.approved).toBe(false);
  });

  it("times out to a deny", async () => {
    const approver = make("prompt", "s4", 20);
    const decision = await approver.requestApproval(req(["sleep", "999"]));
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/timed out/);
    expect(audits.at(-1)?.decision.approved).toBe(false);
  });

  it("auto mode approves immediately without a prompt but still audits", async () => {
    const approver = make("auto", "s5");
    const decision = await approver.requestApproval(req(["make", "build"]));
    expect(decision.approved).toBe(true);
    expect(notifications.length).toBe(0);
    expect(audits.at(-1)?.mode).toBe("auto");
    expect(audits.at(-1)?.decision.approved).toBe(true);
  });
});

describe("InteractiveApprover demonstration provenance (humanApproved)", () => {
  // BYPASS 5: only a genuine per-command human approval may mint competence
  // toward code.exec.unrestricted. The approver stamps meta.humanApproved so the
  // audit sink can distinguish it from auto-mode and session-allow replays.
  const metas: Array<{ humanApproved: boolean; mode: string }> = [];
  const notifications: Array<{ metadata?: Record<string, unknown> }> = [];
  const notify = (_e: string, _m: string, metadata?: Record<string, unknown>): void => {
    notifications.push({ metadata });
  };
  const audit: ExecAuditSink = (_req, _decision, meta) => {
    metas.push({ humanApproved: meta.humanApproved, mode: meta.mode });
  };

  beforeEach(() => {
    metas.length = 0;
    notifications.length = 0;
  });

  function make(mode: "prompt" | "auto", sessionId: string): InteractiveApprover {
    return new InteractiveApprover({
      sessionId,
      creatorEntityId: "e_creator",
      creatorName: "Creator",
      mode,
      notify,
      audit,
    });
  }

  const req = (argv: string[]): ExecApprovalRequest => ({ argv, cwd: "/w", entityId: "e_agent" });

  it("auto mode never marks humanApproved", async () => {
    await make("auto", "hp-auto").requestApproval(req(["pytest"]));
    expect(metas.at(-1)).toEqual({ humanApproved: false, mode: "auto" });
  });

  it("a genuine operator-approved prompt marks humanApproved; a session-allow replay does NOT", async () => {
    const approver = make("prompt", "hp-prompt");
    const first = approver.requestApproval(req(["ruff", "check"]));
    await Promise.resolve();
    const token = (notifications.at(-1)?.metadata?.execApproval as { token: string }).token;
    // Genuine human approval carries the operator-approved provenance stamp.
    settleExecApproval(token, {
      approved: true,
      scope: "session",
      reason: OPERATOR_APPROVED_REASON,
    });
    await first;
    expect(metas.at(-1)).toEqual({ humanApproved: true, mode: "prompt" });

    // Same argv again → replay from the session allow-set, NOT a fresh decision.
    metas.length = 0;
    const second = await approver.requestApproval(req(["ruff", "check"]));
    expect(second.approved).toBe(true);
    expect(metas.at(-1)?.humanApproved).toBe(false);
  });

  it("an approval WITHOUT the operator-approved stamp is not treated as human (defense in depth)", async () => {
    const approver = make("prompt", "hp-nostamp");
    const pending = approver.requestApproval(req(["make", "x"]));
    await Promise.resolve();
    const token = (notifications.at(-1)?.metadata?.execApproval as { token: string }).token;
    // Approved, but missing the provenance stamp → must not mint a demonstration.
    settleExecApproval(token, { approved: true, scope: "once" });
    await pending;
    expect(metas.at(-1)?.humanApproved).toBe(false);
  });

  it("a denied or timed-out prompt never marks humanApproved", async () => {
    const approver = make("prompt", "hp-deny");
    const pending = approver.requestApproval(req(["rm", "-rf", "x"]));
    await Promise.resolve();
    const token = (notifications.at(-1)?.metadata?.execApproval as { token: string }).token;
    settleExecApproval(token, { approved: false, reason: "no" });
    await pending;
    expect(metas.at(-1)?.humanApproved).toBe(false);
  });
});

describe("HeadlessGateApprover", () => {
  const DB = "test_exec_headless.db";
  let db: MarinaDB;
  const audits: ExecApprovalDecision[] = [];
  const audit: ExecAuditSink = (_req, decision) => audits.push(decision);
  const req: ExecApprovalRequest = { argv: ["pytest"], cwd: "/w", entityId: "e_bot" };

  beforeEach(() => {
    cleanupDb(DB);
    db = new MarinaDB(DB);
    audits.length = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  function make(
    overrides: Partial<{
      allowList: string[];
      // Back-compat sugar: `identityTrusted` maps onto a per-connection predicate
      // that returns the same value for every entity.
      identityTrusted: boolean;
      authRequired: boolean;
      actingConnectionTrusted: (entityId: string) => boolean;
      entityName: string;
    }>,
  ) {
    const connTrusted =
      overrides.actingConnectionTrusted ?? (() => overrides.identityTrusted ?? true);
    return new HeadlessGateApprover({
      db,
      entityName: overrides.entityName ?? "Bot",
      allowList: overrides.allowList ?? ["e_bot"],
      authRequired: overrides.authRequired ?? false,
      actingConnectionTrusted: connTrusted,
      audit,
    });
  }

  it("approves when all four conditions hold (env-listed + competent + trusted)", async () => {
    grant(db, "e_bot", "code.exec.unrestricted"); // unsupervised competence
    const decision = await make({}).requestApproval(req);
    expect(decision.approved).toBe(true);
    expect(audits.at(-1)?.approved).toBe(true);
  });

  it("condition (1): denies when the entity is not in MARINA_CODE_EXEC_UNRESTRICTED", async () => {
    grant(db, "e_bot", "code.exec.unrestricted");
    const decision = await make({ allowList: ["someone-else"], entityName: "Bot" }).requestApproval(
      req,
    );
    expect(decision.approved).toBe(false);
    expect(audits.at(-1)?.approved).toBe(false);
  });

  it("condition (1): denies when the allow-list is empty", async () => {
    grant(db, "e_bot", "code.exec.unrestricted");
    expect((await make({ allowList: [] }).requestApproval(req)).approved).toBe(false);
  });

  it("condition (2): denies when competence is absent", async () => {
    expect((await make({}).requestApproval(req)).approved).toBe(false);
  });

  it("condition (2): denies when competence is only supervised", async () => {
    // Enough standing to attempt, but no unsupervised demonstration flip.
    const taskId = db.createTask({ title: "t", creatorId: "e_bot", creatorName: "Bot" });
    db.recordStandingEarned("e_bot", "Bot", taskId, 300);
    recordDemonstration(db, "e_bot", "code.exec.unrestricted"); // 1 of 5 → still supervised
    expect((await make({}).requestApproval(req)).approved).toBe(false);
  });

  it("condition (3): denies when neither authRequired nor a loopback connection", async () => {
    grant(db, "e_bot", "code.exec.unrestricted");
    expect((await make({ identityTrusted: false }).requestApproval(req)).approved).toBe(false);
  });

  it("condition (3a): authRequired trusts regardless of connection origin", async () => {
    grant(db, "e_bot", "code.exec.unrestricted");
    const decision = await make({
      authRequired: true,
      actingConnectionTrusted: () => false, // non-loopback connection
    }).requestApproval(req);
    expect(decision.approved).toBe(true);
  });

  it("condition (3b): a loopback acting connection is trusted even without authRequired", async () => {
    grant(db, "e_bot", "code.exec.unrestricted");
    const decision = await make({
      authRequired: false,
      actingConnectionTrusted: (id) => id === "e_bot", // this connection is loopback
    }).requestApproval(req);
    expect(decision.approved).toBe(true);
  });

  it("condition (3b): a NON-loopback acting connection is denied (env cannot fake trust)", async () => {
    // Even if a WS_HOST env claims loopback, the per-connection decision governs.
    process.env.WS_HOST = "127.0.0.1";
    try {
      grant(db, "e_bot", "code.exec.unrestricted");
      const decision = await make({
        authRequired: false,
        actingConnectionTrusted: () => false, // remote peer on a 0.0.0.0-bound port
      }).requestApproval(req);
      expect(decision.approved).toBe(false);
    } finally {
      delete process.env.WS_HOST;
    }
  });

  it("matches the allow-list by name as well as id", async () => {
    grant(db, "e_bot", "code.exec.unrestricted");
    const decision = await make({ allowList: ["Bot"], entityName: "Bot" }).requestApproval(req);
    expect(decision.approved).toBe(true);
  });
});

describe("parseExecUnrestricted", () => {
  it("splits and trims a comma list, dropping blanks", () => {
    expect(parseExecUnrestricted(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(parseExecUnrestricted(undefined)).toEqual([]);
    expect(parseExecUnrestricted("")).toEqual([]);
  });
});
