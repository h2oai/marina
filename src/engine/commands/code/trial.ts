// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `code trial benchmark:<name> cap:<usd> …`: measure this session's change to
 * Marina's own source against the build it branched from (src/coding/code-trial.ts).
 * The trial runs in the background; its result is a `code_trial` artifact and a
 * notice to whoever started it.
 */
import { resolve } from "node:path";
import { type CodeTrialResult, runCodeTrial } from "../../../coding/code-trial";
import { isLiveMarinaCheckout } from "../../../coding/self-checkout";
import { scratchRoot } from "../../../config/data-dir";
import { localHttpBase } from "../../../net/listen-ports";
import type { MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { refuseCommand } from "../../command-response";
import { getErrorMessage } from "../../errors";
import { parseModifiers } from "../../parse-input";
import { dailyCapRefusal } from "../../spend-ledger";
import { sandboxStagedTree } from "./runner";
import { type CodeDeps, resolveSession, sendCode } from "./shared";

export const CODE_TRIAL_ARTIFACT_KIND = "code_trial";
export const CODE_TRIAL_USAGE =
  "Usage: code trial benchmark:<name> cap:<usd> [limit:<n>] [replicates:<n>] [model:<id>] [upstream:<provider/model>] [seed:<n>]";
const MAX_REPLICATES = 5;
const MAX_LIMIT = 500;

/** One line per trial verdict, for the notice and the artifact title. */
export function trialSummary(r: CodeTrialResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const interval =
    r.delta === null
      ? "no paired estimate"
      : `Δ ${r.delta >= 0 ? "+" : ""}${pct(r.delta)} [${pct(r.low!)}, ${pct(r.high!)}] on ${r.items} items, margin ${pct(r.margin)}`;
  return `${r.verdict}: ${r.benchmark} base ${pct(r.base.accuracy)} → candidate ${pct(r.candidate.accuracy)} (${interval})`;
}

export async function trialCode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const parsed = parseModifiers(args, {
    benchmark: { type: "string" },
    cap: { type: "number" },
    limit: { type: "int" },
    replicates: { type: "int" },
    model: { type: "string" },
    upstream: { type: "string" },
    seed: { type: "int" },
  });
  const v = parsed.values as {
    benchmark?: string;
    cap?: number;
    limit?: number;
    replicates?: number;
    model?: string;
    upstream?: string;
    seed?: number;
  };
  if (parsed.errors.length || parsed.rest.length || !v.benchmark || v.cap === undefined) {
    refuseCommand(ctx, eid, parsed.errors[0] ?? CODE_TRIAL_USAGE);
    return;
  }
  if (!(v.cap > 0)) {
    refuseCommand(ctx, eid, "cap must be above $0.");
    return;
  }
  const replicates = v.replicates ?? 2;
  const limit = v.limit ?? 50;
  if (replicates < 1 || replicates > MAX_REPLICATES || limit < 1 || limit > MAX_LIMIT) {
    refuseCommand(ctx, eid, `replicates must be 1–${MAX_REPLICATES} and limit 1–${MAX_LIMIT}.`);
    return;
  }
  if (!deps.marinaRoot || !isLiveMarinaCheckout(session.workspace_root, deps.marinaRoot)) {
    refuseCommand(
      ctx,
      eid,
      `code trial measures a change to this Marina's own source; this session works on ${session.workspace_root}.`,
    );
    return;
  }
  if (!session.worktree_path) {
    refuseCommand(
      ctx,
      eid,
      "Nothing to trial yet: this session has no changes (it gets its own worktree at its first edit).",
    );
    return;
  }
  const runner = deps.benchmarkRunner;
  if (!runner) {
    refuseCommand(ctx, eid, "Benchmarks are unavailable in this world.");
    return;
  }
  if (!runner.list().some((b) => b.name === v.benchmark)) {
    refuseCommand(ctx, eid, `Unknown benchmark "${v.benchmark}". See benchmark list.`);
    return;
  }
  if (!runner.datasetReady(v.benchmark)) {
    refuseCommand(
      ctx,
      eid,
      `Dataset not downloaded for ${v.benchmark}. Run benchmark fetch ${v.benchmark}.`,
    );
    return;
  }
  // The builds hold no provider key: this server answers their model calls,
  // with a concrete model that passes straight through whatever its endpoint mode.
  const upstream = v.upstream ?? deps.defaultUpstream?.();
  if (!upstream?.includes("/")) {
    refuseCommand(
      ctx,
      eid,
      "No model provider to serve the builds. Configure one, or name upstream:<provider/model>.",
    );
    return;
  }
  const spendRefusal = dailyCapRefusal();
  if (spendRefusal) {
    refuseCommand(ctx, eid, spendRefusal);
    return;
  }

  const id = `trial_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // A sandboxed session with content filters stages its change inside its sandbox.
  let candidateTreeId: string | undefined;
  try {
    candidateTreeId = await sandboxStagedTree(deps.db, session, deps.hostExecForbidden === true);
  } catch (error) {
    refuseCommand(ctx, eid, `Could not stage the change: ${getErrorMessage(error)}`);
    return;
  }
  const spec = {
    id,
    repoRoot: session.workspace_root,
    candidateTree: session.worktree_path,
    benchmark: v.benchmark,
    limit,
    seed: v.seed ?? 42,
    replicates,
    model: v.model ?? "marina",
    upstreamModel: upstream,
    capUsd: v.cap,
    ...(candidateTreeId ? { candidateTreeId } : {}),
  };
  const tell = (line: string) => {
    if (deps.notify) deps.notify(eid, line);
  };
  const work = runCodeTrial(
    {
      db: deps.db,
      runner,
      modelEndpoint: localHttpBase(),
      trialsRoot: resolve(scratchRoot(), "trials"),
      progress: tell,
    },
    spec,
  ).then(
    (result) => {
      const summary = trialSummary(result);
      const artifact = deps.db.createCodingArtifact({
        sessionId: session.id,
        kind: CODE_TRIAL_ARTIFACT_KIND,
        title: `Trial ${id}: ${result.verdict}`,
        status: result.verdict,
        contentText: [summary, ...result.warnings.map((w) => `warning: ${w}`)].join("\n"),
        metadata: { ...result },
        createdBy: entity.name,
      });
      deps.db.createCodingEvent({
        sessionId: session.id,
        actor: entity.name,
        kind: "code_trial_finished",
        payload: { id, artifactId: artifact.id, verdict: result.verdict },
      });
      tell(`trial ${id} ${summary}. Details: code show ${artifact.id}`);
    },
    (error: unknown) => {
      deps.db.createCodingEvent({
        sessionId: session.id,
        actor: entity.name,
        kind: "code_trial_failed",
        payload: { id, error: getErrorMessage(error).slice(0, 500) },
      });
      tell(`trial ${id} failed: ${getErrorMessage(error)}`);
    },
  );
  deps.trackBackground?.(work);
  sendCode(
    ctx,
    eid,
    [
      `Trial ${id} started: ${v.benchmark} × ${replicates} replicate(s) of ${limit} items, base vs this session's changes, cap $${v.cap}.`,
      "Both builds run as child Marinas; the result arrives here when it finishes.",
    ].join("\n"),
    {
      event: "code_trial_started",
      sessionId: session.id,
      status: "running",
      title: id,
      type: "session",
    },
  );
}
