// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Review with authority: `code review request` / `code review verdict`, and a
 * person's `code review approve|reject <review_id>` that closes it.
 *
 * A review is one `review_request` coding artifact. Each round snapshots the
 * author's changes as a `review_snapshot` artifact (the author's coding
 * session diff, or the worktree diff a local supervisor captured for a
 * supervised resident) and reaches the reviewer as an ordinary `tell`, so it
 * is owed like any other request. The reviewer's verdict is `approve` or
 * `rework` (with findings, which reopen the work for the author). The author
 * can never give a verdict or close the review; a person (the author's owner,
 * the person who asked, or an operator) closes it, and a decision against
 * the reviewer's verdict is recorded as an override.
 *
 * Standing follows the existing verified-code rule: an approval credits the
 * author only when the review covers a Code Mode attempt whose recorded
 * checks passed (`creditVerifiedCode`, once per attempt). A verdict with no
 * passing checks behind it earns nothing.
 */

import { reviewJudgeLines } from "../../../agent/attention-judge";
import { dim, header } from "../../../net/ansi";
import { creditVerifiedCode } from "../../../outcomes/live";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../../../persistence/database";
import {
  assembleSnapshot,
  REVIEW_SNAPSHOT_KIND,
  REVIEW_SNAPSHOT_MAX_PARTS,
  type ReviewSnapshot,
} from "../../../routing/review-snapshot";
import type { Entity, EntityId, RoomContext } from "../../../types";
import {
  agentPrincipalReason,
  isOperatorPrincipal,
  personOwner,
  principalKind,
} from "../../challenges";
import { failCommandResponse } from "../../command-response";
import { parseModifiers, splitOnTerminator } from "../../parse-input";
import { deliverTell } from "../tell";
import {
  type CodeDeps,
  canAdoptCodingSession,
  getActiveSessionId,
  sameEntityName,
  sendCode,
  TELNET_HOST_EXEC_DENY,
} from "./shared";
import { workspaceForSession } from "./workspace";

const REVIEW_KIND = "review_request";
const SNAPSHOT_KIND = "review_snapshot";
const FINDINGS_KIND = "review_findings";
const REVIEW_ID = /^review_[a-z0-9]{12}$/i;
const MAX_CLAIMS = 4000;
const MAX_FINDINGS = 16_000;

export const REVIEW_REQUEST_USAGE =
  "Usage: code review request <name|auto|review_id> [author:<name>] [-- claims]";
export const REVIEW_VERDICT_USAGE =
  "Usage: code review verdict <review_id> approve|rework [-- findings]";

interface ReviewVerdictRecord {
  round: number;
  verdict: "approve" | "rework";
  by: string;
  at: number;
  findingsId?: string;
}

interface ReviewMeta {
  author: string;
  authorKey: string;
  reviewer: string;
  reviewerKey: string;
  requestedBy: string;
  basis: string;
  round: number;
  snapshots: string[];
  /** The Code Mode attempt the work belongs to, when the author's session has one. */
  runId?: string;
  verdicts: ReviewVerdictRecord[];
  closed?: {
    by: string;
    at: number;
    outcome: "merged" | "rejected";
    override: boolean;
    priorVerdict?: "approve" | "rework";
  };
}

type Deps = CodeDeps & { db: MarinaDB };

/** Whether `code review <args>` is one of this module's forms. */
export function isReviewRequestForm(args: string[]): boolean {
  const first = args[0]?.toLowerCase();
  if (first === "request" || first === "verdict") return true;
  if ((first === "approve" || first === "reject") && REVIEW_ID.test(args[1] ?? "")) return true;
  return REVIEW_ID.test(args[0] ?? "");
}

/** Entry for every review-request form; `rawAfterSub` is the text after `review`. */
export async function reviewRequestCommand(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: Deps,
  args: string[],
  rawAfterSub: string,
): Promise<void> {
  const first = args[0]?.toLowerCase();
  const afterVerb = rawAfterSub.replace(/^\S+\s*/, "");
  if (first === "request") return requestReview(ctx, eid, entity, deps, afterVerb);
  if (first === "verdict") return giveVerdict(ctx, eid, entity, deps, afterVerb);
  if (first === "approve" || first === "reject")
    return closeReview(ctx, eid, entity, deps, args[1]!, first);
  return showReview(ctx, eid, entity, deps, args[0]!);
}

function refuse(ctx: RoomContext, eid: EntityId, message: string): void {
  failCommandResponse(message);
  ctx.send(eid, message);
}

function reviewMeta(row: CodingArtifactRow): ReviewMeta {
  return JSON.parse(row.metadata_json) as ReviewMeta;
}

function loadReview(deps: Deps, id: string): CodingArtifactRow | undefined {
  const row = REVIEW_ID.test(id) ? deps.db.getCodingArtifact(id) : null;
  return row?.kind === REVIEW_KIND ? row : undefined;
}

function latestVerdict(meta: ReviewMeta): ReviewVerdictRecord | undefined {
  return meta.verdicts.at(-1);
}

/** Who may read a review: its author, reviewer, requester, the author's owner, operators. */
function mayRead(deps: Deps, entity: Entity, meta: ReviewMeta): boolean {
  const key = deps.db.durableEntityKey(entity.id);
  return (
    key === meta.authorKey ||
    key === meta.reviewerKey ||
    sameEntityName(entity.name, meta.requestedBy) ||
    sameEntityName(entity.name, personOwner({ name: meta.author }) ?? "") ||
    isOperatorPrincipal(entity)
  );
}

/** A live entity with exactly this name (never a prefix match). */
function liveExact(deps: Deps, name: string): Entity | undefined {
  const exact = deps.findEntityExact?.(name);
  if (exact) return exact;
  const found = deps.tellDeps?.findEntityGlobal(name);
  return found && sameEntityName(found.name, name) ? deps.getEntity(found.id) : undefined;
}

function vendorOf(deps: Deps, name: string): { vendor: string; model: string } {
  const config = deps.db.getAgentConfig(name);
  return {
    vendor: config?.vendor ?? (config ? "marina" : "person"),
    model: config?.model ?? "",
  };
}

/**
 * `auto`: an online agent other than the author, preferring a different
 * vendor, then a different model, then anyone. Returns the choice with an
 * honest label of which tier it came from.
 */
export function pickReviewer(
  deps: Deps,
  author: string,
  exclude: string[] = [],
): { name: string; basis: string } | undefined {
  const mine = vendorOf(deps, author);
  const candidates = deps.db
    .getAllAgentConfigs()
    .filter(
      (config) =>
        !sameEntityName(config.name, author) &&
        !exclude.some((name) => sameEntityName(name, config.name)),
    )
    .flatMap((config) => {
      const live = liveExact(deps, config.name);
      if (!live || deps.getConnectionProtocol?.(live.id) === undefined) return [];
      const vendor = config.vendor ?? "marina";
      const tier = vendor !== mine.vendor ? 0 : config.model !== mine.model ? 1 : 2;
      return [{ name: live.name, vendor, tier, supervised: config.runtime === "supervised" }];
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(b.supervised) - Number(a.supervised) ||
        a.name.localeCompare(b.name),
    );
  const pick = candidates[0];
  if (!pick) return undefined;
  const basis =
    pick.tier === 0
      ? `auto: different vendor (${pick.vendor}; author ${mine.vendor})`
      : pick.tier === 1
        ? `auto: same vendor (${pick.vendor}), different model`
        : `auto: same vendor and model (${pick.vendor}); no other reviewer was online`;
  return { name: pick.name, basis };
}

/** The supervisor-attached snapshot of the caller's own supervised run. */
function supervisedSnapshot(
  deps: Deps,
  entity: Entity,
  snapshotId: string,
): ReviewSnapshot | string {
  const config = deps.db.getAgentConfig(entity.name);
  if (config?.runtime !== "supervised" || !config.run_session)
    return "A snapshot comes from a local supervisor; this account is not a supervised resident.";
  const parts = deps.db.listRoutingEventParts(
    config.run_session,
    REVIEW_SNAPSHOT_KIND,
    snapshotId,
    REVIEW_SNAPSHOT_MAX_PARTS,
  );
  return (
    assembleSnapshot(parts, snapshotId) ??
    "The supervisor's snapshot is missing or incomplete; request the review again."
  );
}

/** A Code Mode attempt in this session whose worker is the author, newest first. */
function authorRun(deps: Deps, session: CodingSessionRow, author: string): string | undefined {
  return deps.db.listCodingRuns({ sessionId: session.id, limit: 5 }).find((run) => {
    const meta = JSON.parse(run.metadata_json) as { workerName?: string };
    return !!meta.workerName && sameEntityName(meta.workerName, author);
  })?.id;
}

/** A coding session to hold a review whose author works outside Code Mode. */
function detachedReviewSession(deps: Deps, author: string): CodingSessionRow {
  const id = `code_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // The root is a label, never a path: no workspace can open from it.
  return deps.db.createCodingSession({
    id,
    title: `Review: ${author}`,
    workspaceRoot: `review:${id}`,
    status: "review",
    createdBy: author,
  });
}

function diffStat(snapshot: ReviewSnapshot): string {
  let added = 0;
  let removed = 0;
  for (const line of snapshot.text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  const files = snapshot.files.length;
  return `${files} file${files === 1 ? "" : "s"} +${added} -${removed}${snapshot.truncated ? " (cut)" : ""}`;
}

async function requestReview(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: Deps,
  raw: string,
): Promise<void> {
  // Taking a session snapshot runs `git diff` on the host (LAYER 0).
  if (deps.hostExecForbidden) return refuse(ctx, eid, TELNET_HOST_EXEC_DENY);
  if (!deps.tellDeps) return refuse(ctx, eid, "Review requests are unavailable in this world.");
  const [head, claimsRaw] = splitOnTerminator(raw);
  const parsed = parseModifiers(head.split(/\s+/).filter(Boolean), {
    author: { type: "string" },
    snapshot: { type: "string" },
  });
  const target = parsed.rest[0];
  if (parsed.errors.length || !target || parsed.rest.length > 1)
    return refuse(ctx, eid, parsed.errors[0] ?? REVIEW_REQUEST_USAGE);
  const claims = (claimsRaw ?? "").trim().slice(0, MAX_CLAIMS);

  // An existing review: the next round with the same reviewer.
  const existing = REVIEW_ID.test(target) ? loadReview(deps, target) : undefined;
  if (REVIEW_ID.test(target) && !existing) return refuse(ctx, eid, `No review ${target}.`);
  const previous = existing ? reviewMeta(existing) : undefined;
  if (previous && ["merged", "rejected"].includes(existing!.status))
    return refuse(ctx, eid, `Review ${target} is closed (${existing!.status}).`);

  // The author: the caller, or an agent the calling person owns.
  const authorName = previous?.author ?? (parsed.values.author as string | undefined);
  let author: Entity = entity;
  if (authorName && !sameEntityName(authorName, entity.name)) {
    const owner = personOwner({ name: authorName });
    const mayAct =
      principalKind(entity) === "person" &&
      (sameEntityName(owner ?? "", entity.name) || isOperatorPrincipal(entity));
    if (!mayAct)
      return refuse(ctx, eid, "Only the author, or the person who owns it, requests its review.");
    const live = liveExact(deps, authorName);
    if (!live) return refuse(ctx, eid, `No one named "${authorName}" is online.`);
    author = live;
  }

  // The snapshot: supervisor-captured, else the caller's coding session.
  let snapshot: ReviewSnapshot;
  let session: CodingSessionRow | undefined;
  const snapshotId = parsed.values.snapshot as string | undefined;
  if (snapshotId) {
    const found = supervisedSnapshot(deps, entity, snapshotId);
    if (typeof found === "string") return refuse(ctx, eid, found);
    snapshot = found;
  } else {
    const activeId = getActiveSessionId(entity);
    session = activeId ? (deps.db.getCodingSession(activeId) ?? undefined) : undefined;
    if (!session || !canAdoptCodingSession(session, entity) || session.status === "review")
      return refuse(
        ctx,
        eid,
        "Nothing to snapshot: start a coding session (code start) or run under a local supervisor, whose relay attaches the worktree's changes.",
      );
    const result = await workspaceForSession(deps, session).diff();
    snapshot = {
      text: result.content,
      totalBytes:
        (result as { totalBytes?: number }).totalBytes ?? Buffer.byteLength(result.content),
      truncated: result.truncated,
      files: [...result.content.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!).slice(0, 200),
    };
  }
  if (!snapshot.text.trim())
    return refuse(ctx, eid, "Nothing to review: the workspace has no changes against HEAD.");

  // The reviewer: kept across rounds, named, or chosen.
  let reviewerName: string;
  let basis: string;
  if (previous) {
    reviewerName = previous.reviewer;
    basis = previous.basis;
  } else if (target.toLowerCase() === "auto") {
    const pick = pickReviewer(deps, author.name, [entity.name]);
    if (!pick) return refuse(ctx, eid, "No reviewer is online: name one, or start another agent.");
    reviewerName = pick.name;
    basis = pick.basis;
  } else {
    reviewerName = target;
    basis = "named";
  }
  const reviewer = liveExact(deps, reviewerName);
  if (!reviewer) return refuse(ctx, eid, `No one named "${reviewerName}" is online.`);
  if (sameEntityName(reviewer.name, author.name))
    return refuse(ctx, eid, "The author cannot review its own work.");

  const home = existing
    ? deps.db.getCodingSession(existing.session_id)!
    : (session ?? detachedReviewSession(deps, author.name));
  const runId = previous?.runId ?? (session ? authorRun(deps, session, author.name) : undefined);
  const round = (previous?.round ?? 0) + 1;
  const reviewId = existing?.id ?? `review_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const meta: ReviewMeta = deps.db.transaction(() => {
    const snap = deps.db.createCodingArtifact({
      sessionId: home.id,
      kind: SNAPSHOT_KIND,
      title: `Review ${reviewId} round ${round}`,
      status: "complete",
      contentText: snapshot.text,
      metadata: {
        reviewId,
        round,
        claims,
        files: snapshot.files,
        totalBytes: snapshot.totalBytes,
        truncated: snapshot.truncated,
        source: snapshotId ? "supervisor" : "session",
      },
      createdBy: entity.name,
    });
    const next: ReviewMeta = {
      author: author.name,
      authorKey: previous?.authorKey ?? deps.db.durableEntityKey(author.id),
      reviewer: reviewer.name,
      reviewerKey: previous?.reviewerKey ?? deps.db.durableEntityKey(reviewer.id),
      requestedBy: previous?.requestedBy ?? entity.name,
      basis,
      round,
      snapshots: [...(previous?.snapshots ?? []), snap.id],
      ...(runId ? { runId } : {}),
      verdicts: previous?.verdicts ?? [],
    };
    if (existing) deps.db.updateCodingArtifact(existing.id, { status: "open", metadata: next });
    else
      deps.db.createCodingArtifact({
        id: reviewId,
        sessionId: home.id,
        kind: REVIEW_KIND,
        title: `Review of ${author.name}'s work`,
        status: "open",
        contentText: "",
        metadata: next,
        createdBy: entity.name,
      });
    deps.db.createCodingEvent({
      sessionId: home.id,
      actor: entity.name,
      kind: "review_requested",
      payload: { reviewId, round, author: author.name, reviewer: reviewer.name, basis },
    });
    return next;
  });

  const stat = diffStat(snapshot);
  const message = [
    `Review requested: ${reviewId} round ${round} · author ${author.name} · ${stat}.`,
    `Read: code review ${reviewId}. Answer: code review verdict ${reviewId} approve|rework -- <findings>.`,
    ...(claims ? [`Claims: ${claims.slice(0, 600)}`] : []),
  ].join(" ");
  const tellId = deliverTell(deps.tellDeps, ctx, eid, entity, reviewer.name, message);
  deps.logEvent?.({
    type: "review_requested",
    entity: eid,
    reviewId,
    author: author.name,
    reviewer: reviewer.name,
    round,
    basis,
    timestamp: Date.now(),
  });
  sendCode(
    ctx,
    eid,
    [
      `${header(`Review ${reviewId}`)} round ${round} → ${reviewer.name} (${basis})`,
      `${stat}${tellId ? ` · tell #${tellId}` : ""}${meta.runId ? ` · attempt ${meta.runId}` : ""}`,
      dim(`code review ${reviewId} shows it; the reviewer answers with code review verdict.`),
    ].join("\n"),
    {
      artifactId: reviewId,
      artifactKind: REVIEW_KIND,
      commands: [`code review ${reviewId}`],
      event: "review_requested",
      sessionId: home.id,
      status: "open",
      title: `Review ${reviewId}`,
      type: "artifact",
    },
  );
}

async function giveVerdict(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: Deps,
  raw: string,
): Promise<void> {
  const [head, findingsRaw] = splitOnTerminator(raw);
  const [id, verdictRaw, ...extra] = head.split(/\s+/).filter(Boolean);
  const verdict = verdictRaw?.toLowerCase();
  if (!id || (verdict !== "approve" && verdict !== "rework") || extra.length)
    return refuse(ctx, eid, REVIEW_VERDICT_USAGE);
  const row = loadReview(deps, id);
  if (!row) return refuse(ctx, eid, `No review ${id}.`);
  const meta = reviewMeta(row);
  const key = deps.db.durableEntityKey(eid);
  if (key === meta.authorKey) return refuse(ctx, eid, "The author cannot give its own verdict.");
  if (key !== meta.reviewerKey)
    return refuse(ctx, eid, `Only the reviewer (${meta.reviewer}) gives this review's verdict.`);
  if (row.status !== "open")
    return refuse(
      ctx,
      eid,
      `Review ${id} is ${row.status}; a verdict answers an open request (the author requests the next round).`,
    );
  const findings = (findingsRaw ?? "").trim().slice(0, MAX_FINDINGS);
  if (verdict === "rework" && !findings)
    return refuse(ctx, eid, "Rework needs findings: code review verdict <id> rework -- <findings>");

  const at = Date.now();
  deps.db.transaction(() => {
    const findingsId = findings
      ? deps.db.createCodingArtifact({
          sessionId: row.session_id,
          kind: FINDINGS_KIND,
          title: `Review ${id} round ${meta.round} findings`,
          status: "complete",
          contentText: findings,
          metadata: { reviewId: id, round: meta.round, verdict },
          createdBy: entity.name,
        }).id
      : undefined;
    meta.verdicts = [
      ...meta.verdicts,
      { round: meta.round, verdict, by: entity.name, at, ...(findingsId ? { findingsId } : {}) },
    ];
    deps.db.updateCodingArtifact(id, {
      status: verdict === "approve" ? "approved" : "rework",
      metadata: meta,
    });
    deps.db.createCodingEvent({
      sessionId: row.session_id,
      actor: entity.name,
      kind: "review_verdict",
      payload: { reviewId: id, round: meta.round, verdict, author: meta.author },
    });
  });

  // Grounded only by a Code Mode attempt whose recorded checks passed.
  let standing = "standing: none (no passing checks are recorded for this work)";
  if (verdict === "approve" && meta.runId) {
    const credit = creditGrounded(deps, meta, entity.name);
    if (credit) standing = credit;
  }
  if (verdict === "rework" && deps.tellDeps)
    deliverTell(
      deps.tellDeps,
      ctx,
      eid,
      entity,
      meta.author,
      `Rework on review ${id} round ${meta.round}: ${findings.slice(0, 600)} · code review ${id} has the findings; request the next round with code review request ${id}.`,
    );
  if (verdict === "approve") {
    const notice = `Review ${id} approved by ${entity.name}. A person closes it: code review approve ${id}.`;
    for (const name of new Set([meta.author, personOwner({ name: meta.author }) ?? ""])) {
      const live = name ? liveExact(deps, name) : undefined;
      if (live && live.id !== eid) deps.notify?.(live.id, notice);
    }
  }
  deps.logEvent?.({
    type: "review_verdict",
    entity: eid,
    reviewId: id,
    author: meta.author,
    reviewer: entity.name,
    verdict,
    round: meta.round,
    timestamp: at,
  });
  sendCode(
    ctx,
    eid,
    `${header(`Review ${id}`)} ${verdict === "approve" ? "approved" : "rework"} · round ${meta.round} · ${standing}`,
    {
      artifactId: id,
      artifactKind: REVIEW_KIND,
      commands: [`code review ${id}`],
      event: "review_verdict",
      sessionId: row.session_id,
      status: verdict === "approve" ? "approved" : "rework",
      title: `Review ${id}`,
      type: "artifact",
    },
  );
}

/** Credit the author for an attempt whose checks passed; a readout line, else undefined. */
function creditGrounded(deps: Deps, meta: ReviewMeta, verifier: string): string | undefined {
  const run = meta.runId ? deps.db.getCodingArtifact(meta.runId) : null;
  if (run?.kind !== "task_run") return undefined;
  const runMeta = JSON.parse(run.metadata_json) as { verification?: string };
  if (runMeta.verification !== "passed") return undefined;
  const author = liveExact(deps, meta.author);
  const credit = creditVerifiedCode(deps.db, {
    runId: run.id,
    worker: { name: meta.author, ...(author ? { entityId: author.id } : {}) },
    reviewer: verifier,
  });
  return credit.credited
    ? `standing: ${meta.author} +${credit.amount} (verified code)`
    : `standing: none (${credit.reason ?? "not credited"})`;
}

async function closeReview(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: Deps,
  id: string,
  action: "approve" | "reject",
): Promise<void> {
  const row = loadReview(deps, id);
  if (!row) return refuse(ctx, eid, `No review ${id}.`);
  const meta = reviewMeta(row);
  if (deps.db.durableEntityKey(eid) === meta.authorKey)
    return refuse(ctx, eid, "The author cannot close its own review.");
  const owner = personOwner({ name: meta.author });
  const person = principalKind(entity) === "person";
  const mayClose =
    person &&
    (sameEntityName(entity.name, owner ?? "") ||
      sameEntityName(entity.name, meta.requestedBy) ||
      isOperatorPrincipal(entity));
  if (!mayClose)
    return refuse(
      ctx,
      eid,
      `A person closes a review: the author's owner, the person who asked for it, or an operator.${person ? "" : ` ${agentPrincipalReason(entity)}`}`,
    );
  if (row.status === "merged" || row.status === "rejected")
    return refuse(ctx, eid, `Review ${id} is already ${row.status}.`);
  const prior = latestVerdict(meta)?.verdict;
  const override = action === "approve" ? prior !== "approve" : prior === "approve";
  const outcome = action === "approve" ? "merged" : "rejected";
  const at = Date.now();
  meta.closed = {
    by: entity.name,
    at,
    outcome,
    override,
    ...(prior ? { priorVerdict: prior } : {}),
  };
  deps.db.transaction(() => {
    deps.db.updateCodingArtifact(id, { status: outcome, metadata: meta });
    deps.db.createCodingEvent({
      sessionId: row.session_id,
      actor: entity.name,
      kind: "review_closed",
      payload: {
        reviewId: id,
        outcome,
        override,
        priorVerdict: prior ?? null,
        author: meta.author,
      },
    });
  });
  const standing =
    action === "approve" && meta.runId ? creditGrounded(deps, meta, entity.name) : undefined;
  deps.logEvent?.({
    type: "review_closed",
    entity: eid,
    reviewId: id,
    author: meta.author,
    outcome,
    override,
    timestamp: at,
  });
  sendCode(
    ctx,
    eid,
    [
      `${header(`Review ${id}`)} ${outcome}${override ? ` · override of the reviewer's ${prior ?? "missing"} verdict (recorded)` : ""}`,
      ...(standing ? [standing] : []),
      ...(action === "approve"
        ? [
            dim(
              "The decision is recorded; apply the change through its own path (git, code worktree merge).",
            ),
          ]
        : []),
    ].join("\n"),
    {
      artifactId: id,
      artifactKind: REVIEW_KIND,
      event: "review_closed",
      sessionId: row.session_id,
      status: outcome,
      title: `Review ${id}`,
      type: "artifact",
    },
  );
}

function showReview(ctx: RoomContext, eid: EntityId, entity: Entity, deps: Deps, id: string): void {
  const row = loadReview(deps, id);
  const meta = row ? reviewMeta(row) : undefined;
  if (!row || !meta || !mayRead(deps, entity, meta)) {
    refuse(ctx, eid, `No review ${id}.`);
    return;
  }
  const snapshotId = meta.snapshots.at(-1);
  const snap = snapshotId ? deps.db.getCodingArtifact(snapshotId) : null;
  const snapMeta = snap
    ? (JSON.parse(snap.metadata_json) as { claims?: string; truncated?: boolean })
    : {};
  const verdictLines = meta.verdicts.map((v) => {
    const findings = v.findingsId ? deps.db.getCodingArtifact(v.findingsId)?.content_text : "";
    return `  round ${v.round}: ${v.verdict} by ${v.by}${findings ? `\n    ${findings.replaceAll("\n", "\n    ")}` : ""}`;
  });
  const key = deps.db.durableEntityKey(eid);
  const commands =
    key === meta.reviewerKey && row.status === "open"
      ? [`code review verdict ${id} approve`, `code review verdict ${id} rework -- <findings>`]
      : key === meta.authorKey && row.status === "rework"
        ? [`code review request ${id} -- <what changed>`]
        : principalKind(entity) === "person" && !["merged", "rejected"].includes(row.status)
          ? [`code review approve ${id}`, `code review reject ${id}`]
          : [];
  const text = [
    `${header(`Review ${id}`)} ${row.status} · round ${meta.round}`,
    `author ${meta.author} · reviewer ${meta.reviewer} (${meta.basis}) · asked by ${meta.requestedBy}`,
    ...(meta.runId ? [`attempt ${meta.runId}`] : []),
    ...(snapMeta.claims ? [`claims: ${snapMeta.claims}`] : []),
    ...(verdictLines.length ? ["verdicts:", ...verdictLines] : []),
    ...(meta.closed
      ? [
          `closed: ${meta.closed.outcome} by ${meta.closed.by}${meta.closed.override ? " (override)" : ""}`,
        ]
      : []),
    // Earned review judges only, under MARINA_ATTENTION_JUDGE=on: advice, never a verdict.
    ...reviewJudgeLines(deps.db, id).map((line) => dim(line)),
    "",
    snap?.content_text.trim() || dim("(no snapshot)"),
    ...(snapMeta.truncated ? [dim("[snapshot cut at its size bound]")] : []),
  ].join("\n");
  sendCode(ctx, eid, text, {
    artifactId: id,
    artifactKind: REVIEW_KIND,
    commands,
    content: snap?.content_text ?? "",
    event: "review_shown",
    sessionId: row.session_id,
    status: row.status,
    title: `Review ${id}`,
    type: "diff",
  });
}
