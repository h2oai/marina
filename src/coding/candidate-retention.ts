// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retirement of retained candidate refs (`refs/marina/candidates/*`). Every candidate
 * verification pins its snapshot under such a ref so its evidence can be re-checked; at
 * `MAX_PINS` capture refuses, which would stop every verification in the repository. Before
 * each capture Marina retires the refs nobody needs any more:
 *
 * - a candidate whose task attempt ended (approved, rejected, cancelled, failed, interrupted)
 *   or was superseded by a newer candidate of the same attempt;
 * - any candidate older than `CANDIDATE_MAX_AGE_MS`;
 * - past `CANDIDATE_RETAIN_CAP`, the oldest of the rest.
 *
 * It keeps a ref cited by an open task's latest evidence (the newest candidate of an active
 * or submitted attempt whose task is still open), never touches a ref younger than
 * `CANDIDATE_GRACE_MS` (a capture or check may be using it), and never deletes a ref Marina
 * did not create: the name must be `refs/marina/candidates/<uuid>` and the commit must carry
 * Marina's fixed candidate identity and message. Deletion is compare-and-swap on the commit.
 */
import { hostGitArgv, hostGitEnv } from "./host-git";

export const CANDIDATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const CANDIDATE_GRACE_MS = 10 * 60 * 1000;
/** Kept below the capture limit (64), so a run of verifications never reaches it. */
export const CANDIDATE_RETAIN_CAP = 48;

const REF =
  /^refs\/marina\/candidates\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTITY = "Marina candidate <candidate@marina.invalid>";
const MESSAGE = "Marina source candidate (not an operator branch)";

export interface CandidateRef {
  ref: string;
  commit: string;
  /** Commit time, epoch ms. */
  createdAt: number;
  /** Committed by Marina's candidate capture (identity and message). */
  marina: boolean;
}

/** What retirement reads from a world's database. */
export interface CandidateRetentionDb {
  listCodingCandidatesByRef(refs: readonly string[]): Array<{
    id: string;
    metadata_json: string;
  }>;
  getCodingArtifact(id: string): { status: string; metadata_json: string } | null | undefined;
  getTask(id: number): { status: string } | null | undefined;
}

export type RetireReason = "attempt-ended" | "superseded" | "age" | "cap";

export interface RetentionPlan {
  retire: Array<CandidateRef & { reason: RetireReason }>;
  keep: Array<CandidateRef & { why: string }>;
}

/** Read the candidate refs of a repository (only those Marina could have created). */
export function listCandidateRefs(repository: string): CandidateRef[] {
  const out = Bun.spawnSync(
    hostGitArgv(
      [
        "git",
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(committername) <%(committeremail:trim)>%00%(authorname) <%(authoremail:trim)>%00%(contents:subject)",
        "refs/marina/candidates/",
      ],
      repository,
    ),
    { cwd: repository, env: hostGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  if (out.exitCode !== 0) throw new Error("candidate refs could not be listed");
  return out.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", commit = "", time = "0", committer, author, subject] = line.split("\0");
      return {
        ref,
        commit,
        createdAt: Number(time) * 1000,
        marina:
          REF.test(ref) &&
          /^[0-9a-f]{40,64}$/.test(commit) &&
          committer === IDENTITY &&
          author === IDENTITY &&
          subject === MESSAGE,
      };
    });
}

const ENDED_TASK = new Set(["completed", "cancelled", "rejected", "failed"]);

/** Decide, without touching anything, which refs to retire. Pure given its inputs. */
export function planCandidateRetirement(
  db: CandidateRetentionDb | undefined,
  refs: readonly CandidateRef[],
  now: number,
  cap = CANDIDATE_RETAIN_CAP,
): RetentionPlan {
  const plan: RetentionPlan = { retire: [], keep: [] };
  const marina = refs.filter((ref) => {
    if (!ref.marina) plan.keep.push({ ...ref, why: "not created by Marina" });
    return ref.marina;
  });
  const artifacts = new Map<string, { id: string; meta: Record<string, unknown> }>();
  for (const row of db?.listCodingCandidatesByRef(marina.map((ref) => ref.ref)) ?? []) {
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    if (typeof meta.ref === "string" && !artifacts.has(meta.ref))
      artifacts.set(meta.ref, { id: row.id, meta });
  }
  // The newest candidate of each attempt, by commit time.
  const newestOfRun = new Map<string, CandidateRef>();
  for (const ref of marina) {
    const runId = artifacts.get(ref.ref)?.meta.runId;
    if (typeof runId !== "string") continue;
    const best = newestOfRun.get(runId);
    if (!best || ref.createdAt > best.createdAt) newestOfRun.set(runId, ref);
  }
  const rest: CandidateRef[] = [];
  for (const ref of marina) {
    if (now - ref.createdAt < CANDIDATE_GRACE_MS) {
      plan.keep.push({ ...ref, why: "recent: a capture or check may be using it" });
      continue;
    }
    const known = artifacts.get(ref.ref);
    const runId = typeof known?.meta.runId === "string" ? known.meta.runId : undefined;
    const run = runId ? db?.getCodingArtifact(runId) : undefined;
    if (run && known) {
      const meta = JSON.parse(run.metadata_json) as { taskId?: number; candidateId?: string };
      const task = typeof meta.taskId === "number" ? db?.getTask(meta.taskId) : undefined;
      const open =
        (run.status === "active" || run.status === "submitted") &&
        !(task && ENDED_TASK.has(task.status));
      if (!open) {
        plan.retire.push({ ...ref, reason: "attempt-ended" });
        continue;
      }
      if (newestOfRun.get(runId!)?.ref !== ref.ref) {
        plan.retire.push({ ...ref, reason: "superseded" });
        continue;
      }
      // The open attempt's latest evidence: kept whatever its age.
      plan.keep.push({ ...ref, why: `cited by open task attempt ${runId}` });
      continue;
    }
    if (now - ref.createdAt > CANDIDATE_MAX_AGE_MS) {
      plan.retire.push({ ...ref, reason: "age" });
      continue;
    }
    rest.push(ref);
  }
  // A hard cap: the oldest of the unreferenced remainder go first.
  const kept = plan.keep.filter((ref) => ref.why !== "not created by Marina").length;
  const over = kept + rest.length - cap;
  rest.sort((a, b) => a.createdAt - b.createdAt);
  rest.forEach((ref, index) => {
    if (index < over) plan.retire.push({ ...ref, reason: "cap" });
    else plan.keep.push({ ...ref, why: "unreferenced, within age and cap" });
  });
  return plan;
}

/**
 * Retire what the plan says, each ref only if it still points at the planned commit. Returns
 * the refs actually retired. Errors on one ref never stop the others.
 */
export function retireCandidateRefs(
  repository: string,
  db: CandidateRetentionDb | undefined,
  now = Date.now(),
): { retired: string[]; plan: RetentionPlan } {
  const plan = planCandidateRetirement(db, listCandidateRefs(repository), now);
  const retired: string[] = [];
  for (const ref of plan.retire) {
    const result = Bun.spawnSync(
      hostGitArgv(["git", "update-ref", "-d", ref.ref, ref.commit], repository),
      { cwd: repository, env: hostGitEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    if (result.exitCode === 0) retired.push(ref.ref);
  }
  return { retired, plan };
}
