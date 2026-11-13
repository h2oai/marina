// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `code ship [merge] [-- <title>]`: open a pull request for this session's
 * measured change to Marina's own source (src/coding/code-ship.ts). A person
 * ships; an agent ships only under MARINA_AUTONOMY=sovereign. Publishing runs
 * in the background and reports here.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  operatorIdentity,
  operatorRunner,
  SHIP_SCRATCH,
  type ShipHost,
  type ShipRunner,
  shipChange,
  shipRefusal,
} from "../../../coding/code-ship";
import { type CodeTrialResult, type GitRunner, snapshotCommit } from "../../../coding/code-trial";
import { HOST_GIT_CONFIG_ARGS } from "../../../coding/host-git";
import { protectedChanges, protectedHold } from "../../../coding/protected-paths";
import { isLiveMarinaCheckout } from "../../../coding/self-checkout";
import { scratchRoot } from "../../../config/data-dir";
import type { MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { refuseCommand } from "../../command-response";
import { getErrorMessage } from "../../errors";
import { principalOf } from "../../gate-context";
import { parseModifiers, splitOnTerminator } from "../../parse-input";
import { isSovereign } from "../../trust-profile";
import { type CodeDeps, resolveSession, sendCode } from "./shared";
import { CODE_TRIAL_ARTIFACT_KIND } from "./trial";

export const CODE_SHIP_ARTIFACT_KIND = "code_ship";
export const CODE_SHIP_USAGE = "Usage: code ship [merge] [-- <title>]";

const hostShip = (): ShipHost => {
  const run = operatorRunner();
  return { git: run, push: run, gh: run, ghAvailable: () => !!Bun.which("gh") };
};

const asGitRunner =
  (run: ShipRunner): GitRunner =>
  (cwd, argv, env) => {
    const r = env
      ? operatorRunner({ ...process.env, ...env })(cwd, ["git", ...HOST_GIT_CONFIG_ARGS, ...argv])
      : run(cwd, ["git", ...HOST_GIT_CONFIG_ARGS, ...argv]);
    return { exitCode: r.exitCode, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  };

/**
 * A change ships only when the repository's own gates verified exactly it: the session's
 * latest verification is a passed repository-gate run on a snapshot whose tree is the
 * change's tree now. Showing a label instead would let a pull request opened by Marina
 * carry a change its own repository's checks fail; the merge queue would catch it later,
 * after review time was spent on it, and "measured" would read as "verified" when it was not.
 */
export function shipVerificationRefusal(
  db: MarinaDB,
  sessionId: string,
  tree: string,
): string | null {
  const how =
    "Run code verify candidate gates:repository and ship once the repository's gates pass.";
  // The latest attempt by when it STARTED: a background request starts when it is admitted
  // (its result lands later), a synchronous check is its own result. A newer request that is
  // still running, or ended without a result, is never hidden behind an older pass, nor is a
  // later synchronous failure hidden behind a background pass that finished after it.
  const recent = db
    .listCodingArtifacts(sessionId, 200)
    .filter(
      (artifact) => artifact.kind === "verification" || artifact.kind === "verification_request",
    );
  const attempt = recent.find(
    (artifact) =>
      artifact.kind === "verification_request" ||
      typeof (JSON.parse(artifact.metadata_json) as Record<string, unknown>).requestId !== "string",
  );
  if (!attempt) return `Not verified: no verification of this change. ${how}`;
  let latest = attempt;
  if (attempt.kind === "verification_request") {
    if (attempt.status === "running")
      return `Not verified: the latest verification (${attempt.id}) is still running. Ship when it has passed.`;
    const receipt = JSON.parse(attempt.metadata_json) as Record<string, unknown>;
    const result =
      typeof receipt.resultArtifactId === "string"
        ? db.getCodingArtifact(receipt.resultArtifactId)
        : undefined;
    if (!result)
      return `Not verified: the latest verification (${attempt.id}) ended without a result${typeof receipt.error === "string" ? ` (${receipt.error})` : ""}. ${how}`;
    latest = result;
  }
  const evidence = JSON.parse(latest.metadata_json) as Record<string, unknown>;
  if (evidence.gates !== "repository")
    return `Not verified: the latest verification (${latest.id}) was not the repository's gates. ${how}`;
  if (evidence.outcome !== "passed" || evidence.preexistingOnly)
    return `Not verified: the repository's gates ${evidence.outcome === "passed" ? "did not pass" : evidence.outcome} (${latest.id}${typeof evidence.outcomeReason === "string" ? `: ${evidence.outcomeReason}` : ""}). ${how}`;
  // The same evidence rule a task submission applies: the checks left the snapshot's source
  // intact, and the snapshot was still the workspace when they finished.
  if (
    typeof evidence.candidateFingerprint !== "string" ||
    evidence.materializedFingerprint !== evidence.candidateFingerprint
  )
    return `Not verified: the checks changed the snapshot's source (${latest.id}), so their pass does not describe this change. ${how}`;
  if (evidence.freshness !== "current")
    return `Not verified: the verification (${latest.id}) is ${String(evidence.freshness ?? "not current")}. ${how}`;
  if (evidence.tree !== tree)
    return `Not verified: the change moved since the repository's gates passed on it (${latest.id}). ${how}`;
  return null;
}

export async function shipCode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  raw: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const [head, titleRaw] = splitOnTerminator(raw);
  const parsed = parseModifiers(head.split(/\s+/).filter(Boolean), { merge: { type: "bool" } });
  const words = parsed.rest.filter((w) => w.toLowerCase() !== "merge");
  const merge =
    parsed.values.merge === true || parsed.rest.some((w) => w.toLowerCase() === "merge");
  if (parsed.errors.length || words.length) {
    refuseCommand(ctx, eid, parsed.errors[0] ?? CODE_SHIP_USAGE);
    return;
  }
  // Person or agent, failing closed to agent (src/engine/gate-context.ts).
  if (principalOf(entity.id) !== "person" && !isSovereign()) {
    refuseCommand(
      ctx,
      eid,
      "Opening a pull request on Marina's own repository is a person's act; under MARINA_AUTONOMY=sovereign an agent may ship.",
    );
    return;
  }
  if (!deps.marinaRoot || !isLiveMarinaCheckout(session.workspace_root, deps.marinaRoot)) {
    refuseCommand(
      ctx,
      eid,
      "code ship opens a pull request for a change to this Marina's own source.",
    );
    return;
  }
  if (!session.worktree_path || !session.worktree_branch) {
    refuseCommand(ctx, eid, "Nothing to ship: this session has no changes.");
    return;
  }
  const host = deps.shipHost ?? hostShip();
  if (!host.ghAvailable()) {
    refuseCommand(ctx, eid, "code ship needs the GitHub CLI (gh) on this server, signed in.");
    return;
  }
  const latest = deps.db.listCodingArtifacts(session.id, 1, CODE_TRIAL_ARTIFACT_KIND)[0];
  if (!latest) {
    refuseCommand(ctx, eid, "Measure the change first: code trial benchmark:<name> cap:<usd>.");
    return;
  }
  const trial = JSON.parse(latest.metadata_json) as CodeTrialResult;
  const scratch = resolve(SHIP_SCRATCH(scratchRoot(), session.id));
  const git = asGitRunner(host.git);
  let refusal: string | null;
  try {
    mkdirSync(scratch, { recursive: true });
    refusal =
      shipRefusal(git, { tree: session.worktree_path, trial, scratch }) ??
      shipVerificationRefusal(
        deps.db,
        session.id,
        git(session.worktree_path, [
          "rev-parse",
          `${snapshotCommit(git, session.worktree_path, scratch)}^{tree}`,
        ]).stdout,
      );
  } catch (error) {
    refusal = `Could not read the change: ${getErrorMessage(error)}`;
  }
  if (refusal) {
    refuseCommand(ctx, eid, refusal);
    return;
  }
  // An agent's change to what decides Marina's authority or its own judging is
  // opened, never queued by Marina (src/coding/protected-paths.ts).
  let protectedFiles: string[];
  try {
    protectedFiles = protectedChanges(
      git,
      session.worktree_path,
      trial.base.sha,
      trial.candidate.sha,
    );
  } catch (error) {
    refuseCommand(ctx, eid, `Could not read the change: ${getErrorMessage(error)}`);
    return;
  }
  const holdForPerson =
    protectedFiles.length > 0 && principalOf(entity.id) !== "person" && protectedHold();
  const baseRef = git(session.workspace_root, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const base = baseRef.exitCode === 0 ? baseRef.stdout.replace(/^origin\//, "") : "main";
  const title = (titleRaw ?? "").trim() || session.title;
  const tell = (line: string) => deps.notify?.(eid, line);
  const work = (async () => {
    const result = shipChange(
      { ...host, identity: operatorIdentity(session.workspace_root, host.git) },
      {
        tree: session.worktree_path!,
        branch: session.worktree_branch!,
        base,
        title,
        trial,
        author: entity.name,
        merge,
        scratch,
        protectedFiles,
        holdForPerson,
      },
    );
    deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: CODE_SHIP_ARTIFACT_KIND,
      title: `Shipped: ${title}`,
      status: result.queued ? "queued" : "open",
      contentText: result.url,
      metadata: { ...result, trialId: trial.id, base, branch: session.worktree_branch },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_shipped",
      payload: { url: result.url, commit: result.commit, queued: result.queued, trialId: trial.id },
    });
    tell(
      `shipped ${result.commit.slice(0, 12)} → ${result.url}${result.queued ? " (queued to merge)" : ""}`,
    );
  })().catch((error: unknown) => {
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_ship_failed",
      payload: { error: getErrorMessage(error).slice(0, 500) },
    });
    tell(`ship failed: ${getErrorMessage(error)}`);
  });
  deps.trackBackground?.(work);
  sendCode(
    ctx,
    eid,
    `Shipping "${title}" on ${session.worktree_branch} against ${base}, with trial ${trial.id} (${trial.verdict}).${
      holdForPerson
        ? ` It touches protected paths (${protectedFiles.length}); a person queues it.`
        : merge
          ? " It will be queued to merge."
          : ""
    }`,
    {
      event: "code_ship_started",
      sessionId: session.id,
      status: "running",
      title,
      type: "session",
    },
  );
}
