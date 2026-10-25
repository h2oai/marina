// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestration surfaces on the outcome path: a person's verdict on a
 * project run under an orchestration pattern, a free-text `pattern run`
 * whose own review step gave a verdict, and a room formation round that
 * closed with a mechanical result. Each is one resolved outcome
 * (`recordResolved`) tagged in the `family:` / `method:` convention of
 * `./work-refs.ts`, so the competence map can say which way of working
 * succeeds at which kind of work.
 *
 * Nothing is recorded without a verdict, and none of it needs a model:
 * the verdict comes from a person, from the run's own trace, or from the
 * room's speech grammar. Labels and ids only — never the task, the goal,
 * the evidence a person wrote or any output.
 */

import type { RoomRoundResult } from "../coordination/room-formations";
import { canonicalFormationName } from "../orchestration/formations/catalogue";
import { type PatternRunResult, parseReview } from "../orchestration/text-patterns";
import type { MarinaDB } from "../persistence/database";
import { participantOf, workRefsFor } from "./live";
import { recordResolved } from "./record";

const SAFE_LABEL = /^[A-Za-z0-9:._/+@-]{1,120}$/;

/**
 * A person's verdict on a project (`project <name> outcome <0..1> | …`) as
 * one task-like outcome: `family:work:project`, `method:orchestration:<pattern>`
 * and the recorder's scope. A person's verdict is the ground truth of the
 * work, recorded `mechanical` with metric `person-verdict` exactly as a task
 * creator's verdict is (`judged` is reserved for a judge's opinion, which no
 * consumer acts on until that judge has earned it). Settled once per project.
 */
export function recordProjectOutcome(
  db: MarinaDB,
  input: { projectId: string; pattern: string; recorder: string; score: number; at?: number },
): { id: number; created: boolean } | undefined {
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) return undefined;
  const pattern = SAFE_LABEL.test(input.pattern)
    ? canonicalFormationName(input.pattern)
    : "freeform";
  const at = input.at ?? Date.now();
  return recordResolved(db, {
    subject: `project:${input.projectId}`,
    kind: "task",
    source: "project:outcome",
    domain: "tools",
    owner: input.recorder,
    succeeded: input.score >= 0.5,
    quality: input.score,
    metric: "person-verdict",
    detail: `project outcome ${input.score.toFixed(2)} recorded by a person`,
    basis: "mechanical",
    participants: [participantOf(db, input.recorder)],
    refs: [
      `project:${input.projectId}`,
      ...workRefsFor(db, "project", input.recorder, [`orchestration:${pattern}`]),
    ],
    resolvedAt: at,
  });
}

/**
 * The verdict a pattern run gave itself: its own review step's
 * `approve` / `revise` on the draft (today only `verification` reviews).
 * A run with no review, a failed review or an unreadable one has no
 * verdict — never one invented from a pick or a stop.
 */
export function patternRunVerdict(
  result: Pick<PatternRunResult, "trace">,
): { approved: boolean; judge: string } | undefined {
  const review = result.trace.steps.find((s) => s.stage === "review");
  if (review?.status !== "ok" || !review.text) return undefined;
  const parsed = parseReview(review.text);
  if (!parsed) return undefined;
  return { approved: parsed.verdict === "approve", judge: review.member };
}

/**
 * A `pattern run` / `POST /v1/patterns/run` with a verdict from its own
 * review as one request outcome tagged `method:pattern:<name>` (and
 * `method:model:<m>` when one model did the work). The reviewer is a model,
 * so the outcome is a JUDGED one (`judge` = `pattern-review:<checker>`):
 * evidence an earned-judge reader may use, never a lesson or a score on its
 * own. No verdict ⇒ nothing is recorded.
 */
export function recordPatternRun(
  db: MarinaDB,
  input: {
    result: Pick<PatternRunResult, "trace" | "pattern">;
    /** A unique id for the run (the request id on the API). */
    runId: string;
    /** Who asked for the run (an entity name), when known. */
    owner?: string;
    at?: number;
  },
): { id: number; created: boolean } | undefined {
  const verdict = patternRunVerdict(input.result);
  if (!verdict) return undefined;
  const workers = new Set(
    input.result.trace.steps
      .filter((s) => s.stage !== "review" && s.status === "ok")
      .map((s) => s.member),
  );
  const model = workers.size === 1 ? [...workers][0] : undefined;
  const at = input.at ?? Date.now();
  const approach = [`pattern:${input.result.pattern}`];
  const refs = input.owner
    ? workRefsFor(db, "request", input.owner, approach)
    : [`family:work:request`, `method:${approach[0]}`, "scope:unscoped"];
  // The model that did the work, not the owner's configured one.
  const withModel = [
    ...refs.filter((r) => !r.startsWith("method:model:")),
    ...(model && SAFE_LABEL.test(model) ? [`method:model:${model}`] : []),
  ];
  return recordResolved(db, {
    subject: `judged:pattern:${input.runId}`,
    kind: "request",
    source: `pattern:${input.result.pattern}`,
    domain: "tools",
    ...(input.owner ? { owner: input.owner } : {}),
    succeeded: verdict.approved,
    quality: verdict.approved ? 1 : 0,
    metric: "review-verdict",
    detail: verdict.approved
      ? "the run's review approved the draft"
      : "the run's review sent the draft back for revision",
    basis: "judged",
    judge: `pattern-review:${verdict.judge}`,
    participants: [...workers].map((m) => ({ model: m })),
    refs: [`pattern-run:${input.runId}`, ...withModel],
    resolvedAt: at,
  });
}

/**
 * A room formation round that closed on its own closing move with a
 * mechanical result, as one request outcome tagged
 * `method:room-formation:<formation>`. Only `verification` has one today: its
 * checkers' `aspect: <aspect> pass|fail` lines. Succeeded = no check failed;
 * quality = the share that passed. A round with no parsed check records
 * nothing.
 */
export function recordRoomFormationRound(
  db: MarinaDB,
  input: { room: string; ref: string; result: RoomRoundResult; at?: number },
): { id: number; created: boolean } | undefined {
  const { result } = input;
  const total = result.pass + result.fail;
  if (total <= 0) return undefined;
  const at = input.at ?? Date.now();
  return recordResolved(db, {
    subject: `room-formation:${input.room}:${input.ref}`,
    kind: "request",
    source: `room-formation:${result.formation}`,
    domain: "tools",
    owner: result.owner,
    succeeded: result.fail === 0,
    quality: result.pass / total,
    metric: "aspect-checks",
    detail: `${result.pass} of ${total} aspect check(s) passed`,
    basis: "mechanical",
    participants: [
      participantOf(db, result.owner),
      ...result.checkers.map((c) => participantOf(db, c)),
    ],
    refs: [
      `room:${input.room}`,
      ...workRefsFor(db, "request", result.owner, [`room-formation:${result.formation}`]),
    ],
    resolvedAt: at,
  });
}
