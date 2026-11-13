// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitCandidate } from "../src/coding/candidate";
import {
  CANDIDATE_GRACE_MS,
  CANDIDATE_MAX_AGE_MS,
  CANDIDATE_RETAIN_CAP,
  type CandidateRef,
  type CandidateRetentionDb,
  listCandidateRefs,
  planCandidateRetirement,
  retireCandidateRefs,
} from "../src/coding/candidate-retention";
import { git as gitIn } from "./git-helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13);
let counter = 0;
const ref = (ageMs: number, marina = true): CandidateRef => ({
  ref: `refs/marina/candidates/00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  commit: "a".repeat(40),
  createdAt: NOW - ageMs,
  marina,
});

/** A database with candidates bound to attempts. */
function fakeDb(
  bindings: Array<{ ref: CandidateRef; runId: string; seq?: number }>,
  runs: Record<string, { status: string; taskId: number; candidateId?: string }>,
  tasks: Record<number, string>,
): CandidateRetentionDb {
  return {
    listCodingCandidatesByRef: (refs) =>
      bindings
        .filter((b) => refs.includes(b.ref.ref))
        .map((b, index) => ({
          id: `candidate_${b.ref.ref.slice(-4)}`,
          metadata_json: JSON.stringify({ ref: b.ref.ref, runId: b.runId }),
          seq: b.seq ?? index + 1,
        })),
    getCodingArtifact: (id) =>
      runs[id]
        ? {
            status: runs[id]!.status,
            metadata_json: JSON.stringify({
              taskId: runs[id]!.taskId,
              candidateId: runs[id]!.candidateId,
            }),
          }
        : null,
    getTask: (id) => (tasks[id] ? { status: tasks[id]! } : null),
  };
}

describe("candidate ref retirement plan", () => {
  it("retires ended and superseded attempts' candidates, keeps an open task's latest evidence", () => {
    const ended = ref(DAY);
    const older = ref(3 * DAY);
    const latest = ref(20 * DAY - 1); // older than the age bound, but cited: kept
    const newer = ref(2 * DAY);
    const db = fakeDb(
      [
        { ref: ended, runId: "run_done" },
        { ref: latest, runId: "run_open" },
        { ref: older, runId: "run_open2" },
        { ref: newer, runId: "run_open2" },
      ],
      {
        run_done: { status: "submitted", taskId: 1 },
        run_open: { status: "submitted", taskId: 2 },
        run_open2: { status: "active", taskId: 3 },
      },
      { 1: "completed", 2: "submitted", 3: "claimed" },
    );
    const plan = planCandidateRetirement(db, [ended, latest, older, newer], NOW);
    const reason = (r: CandidateRef) => plan.retire.find((x) => x.ref === r.ref)?.reason;
    expect(reason(ended)).toBe("attempt-ended");
    expect(reason(older)).toBe("superseded");
    expect(reason(latest)).toBeUndefined();
    expect(reason(newer)).toBeUndefined();
    expect(plan.keep.find((x) => x.ref === latest.ref)?.why).toContain("cited by open task");
  });

  it("[G] orders an attempt's candidates by Marina's capture record, and keeps what it cites", () => {
    // Same commit second: only the capture order tells which is newest.
    const first = ref(DAY);
    const second = { ...ref(DAY), createdAt: first.createdAt };
    const cited = { ...ref(DAY), createdAt: first.createdAt };
    const db = fakeDb(
      [
        { ref: second, runId: "run", seq: 20 },
        { ref: first, runId: "run", seq: 10 },
        { ref: cited, runId: "run", seq: 5 },
      ],
      { run: { status: "active", taskId: 1, candidateId: `candidate_${cited.ref.slice(-4)}` } },
      { 1: "claimed" },
    );
    const plan = planCandidateRetirement(db, [first, second, cited], NOW);
    expect(plan.retire.map((x) => [x.ref, x.reason])).toEqual([[first.ref, "superseded"]]);
    expect(plan.keep.map((x) => x.ref).sort()).toEqual([second.ref, cited.ref].sort());
  });

  it("retires by age, never touches a recent ref or one Marina did not create", () => {
    const old = ref(CANDIDATE_MAX_AGE_MS + DAY);
    const recent = ref(CANDIDATE_GRACE_MS / 2);
    const foreign = ref(CANDIDATE_MAX_AGE_MS * 3, false);
    const plan = planCandidateRetirement(undefined, [old, recent, foreign], NOW);
    expect(plan.retire.map((x) => [x.ref, x.reason])).toEqual([[old.ref, "age"]]);
    expect(plan.keep.map((x) => x.ref).sort()).toEqual([recent.ref, foreign.ref].sort());
  });

  it("holds a hard cap, retiring the oldest unreferenced first", () => {
    const refs = Array.from({ length: 70 }, (_, i) => ref(DAY + i * 60_000));
    const plan = planCandidateRetirement(undefined, refs, NOW);
    expect(plan.retire).toHaveLength(70 - CANDIDATE_RETAIN_CAP);
    expect(plan.retire.every((x) => x.reason === "cap")).toBe(true);
    const oldestKept = Math.min(...plan.keep.map((x) => NOW - x.createdAt));
    const youngestRetired = Math.min(...plan.retire.map((x) => NOW - x.createdAt));
    expect(youngestRetired).toBeGreaterThan(oldestKept);
  });
});

describe("candidate ref retirement in a repository", () => {
  let root: string;
  const git = (...args: string[]) => gitIn(root, ...args);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marina-retention-"));
    git("init", "--quiet", "--template=");
    writeFileSync(join(root, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A ref exactly like a capture's, dated `ageMs` ago. */
  const pin = (ageMs: number, identity = "Marina candidate", n = ++counter) => {
    const date = `${Math.floor((Date.now() - ageMs) / 1000)} +0000`;
    const commit = Bun.spawnSync(
      [
        "git",
        "commit-tree",
        git("rev-parse", "HEAD^{tree}").trim(),
        "-m",
        "Marina source candidate (not an operator branch)",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: identity,
          GIT_AUTHOR_EMAIL: "candidate@marina.invalid",
          GIT_COMMITTER_NAME: identity,
          GIT_COMMITTER_EMAIL: "candidate@marina.invalid",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    )
      .stdout.toString()
      .trim();
    const name = `refs/marina/candidates/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    git("update-ref", name, commit);
    return name;
  };

  it("recognises a real capture's ref as Marina's, and retires it once old", async () => {
    const captured = await captureGitCandidate(root);
    await captured.dispose();
    const refs = listCandidateRefs(root);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.marina).toBe(true);
    const { retired } = retireCandidateRefs(
      root,
      undefined,
      Date.now() + CANDIDATE_MAX_AGE_MS + DAY,
    );
    expect(retired).toEqual([captured.candidate.ref]);
    expect(listCandidateRefs(root)).toHaveLength(0);
  });

  it("never deletes a candidate-named ref with another identity", () => {
    const foreign = pin(CANDIDATE_MAX_AGE_MS * 2, "Someone Else");
    expect(retireCandidateRefs(root, undefined).retired).toEqual([]);
    expect(git("rev-parse", "--verify", foreign).trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("at the 64-pin limit capture refuses; retirement frees room and capture works again", async () => {
    for (let i = 0; i < 64; i++) pin(DAY + i * 60_000);
    await expect(captureGitCandidate(root)).rejects.toThrow("Retire reviewed candidate refs");
    const { retired } = retireCandidateRefs(root, undefined);
    expect(retired).toHaveLength(64 - CANDIDATE_RETAIN_CAP);
    const captured = await captureGitCandidate(root);
    await captured.dispose();
    expect(listCandidateRefs(root)).toHaveLength(CANDIDATE_RETAIN_CAP + 1);
  });
});
