// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  JourneyEventRow,
  JourneyLinkKind,
  JourneyRow,
  MarinaDB,
} from "../persistence/database";

export interface JourneyProgressItem {
  kind: JourneyEventRow["kind"];
  summary: string;
  contributor: string;
  changedAt: number;
  evidence: string;
}

export interface JourneyResultCandidate {
  summary: string;
  contributor: string;
  createdAt: number;
  evidence: string[];
  partial: boolean;
  canonical?: JourneyCanonicalRecord;
}

export interface JourneyCanonicalRecord {
  kind: JourneyLinkKind;
  ref: string;
  title: string;
  detail: string;
  contributor?: string;
  status?: string;
  createdAt?: number;
}

export interface JourneyResultProjection {
  current?: JourneyResultCandidate;
  alternatives: JourneyResultCandidate[];
  uncertainty: string[];
  contributors: string[];
  continuation?: string;
}

/**
 * Project meaningful change from journey evidence. Routine engine activity is
 * absent by construction: only explicitly correlated journey events enter this
 * view, while their canonical refs remain inspectable.
 */
export function projectJourneyProgress(events: readonly JourneyEventRow[]): JourneyProgressItem[] {
  const seen = new Set<string>();
  const items: JourneyProgressItem[] = [];
  for (const event of events) {
    const evidence = journeyEventRef(event);
    const key = `${event.kind}\u0000${event.summary}\u0000${event.ref_kind ?? ""}\u0000${event.ref ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kind: event.kind,
      summary: event.summary,
      contributor: event.actor_name,
      changedAt: event.created_at,
      evidence,
    });
  }
  return items;
}

/** Project the best current result without creating a replacement artifact. */
export function projectJourneyResults(
  db: MarinaDB,
  journey: JourneyRow,
  links = db.listJourneyLinks(journey.id),
  events = db.listJourneyEvents(journey.id),
): JourneyResultProjection {
  const candidates: JourneyResultCandidate[] = [];

  for (const event of events) {
    if (event.kind !== "result") continue;
    const canonical =
      event.ref_kind && event.ref ? resolveJourneyRecord(db, event.ref_kind, event.ref) : undefined;
    candidates.push({
      summary: event.summary,
      contributor: event.actor_name,
      createdAt: event.created_at,
      evidence: [
        journeyEventRef(event),
        ...(canonical ? [`${canonical.kind}:${canonical.ref}`] : []),
      ],
      partial: eventIsPartial(event),
      canonical,
    });
  }

  for (const link of links) {
    if (link.kind !== "task" || !/^\d+$/.test(link.ref)) continue;
    const task = db.getTask(Number(link.ref));
    if (!task) continue;
    const submissions = db
      .getTaskClaims(task.id)
      .filter((claim) => claim.submission_text?.trim())
      .sort((a, b) => (b.submitted_at ?? 0) - (a.submitted_at ?? 0));
    const submission = submissions[0];
    if (!submission) continue;
    const evidence = `task:${task.id}`;
    if (candidates.some((candidate) => candidate.evidence.includes(evidence))) continue;
    candidates.push({
      summary: submission.submission_text!,
      contributor: submission.entity_name,
      createdAt: submission.submitted_at ?? task.updated_at,
      evidence: [evidence],
      partial: !["approved", "completed"].includes(task.status),
      canonical: resolveJourneyRecord(db, "task", String(task.id)),
    });
  }

  candidates.sort(compareResults);
  const current = candidates[0];
  const uncertainty = events
    .filter(
      (event) =>
        (event.kind === "challenge" || event.kind === "waiting") &&
        (!current || event.created_at >= current.createdAt),
    )
    .map((event) => `${event.summary} (${journeyEventRef(event)})`);
  const continuation = [...events]
    .reverse()
    .find((event) => event.kind === "continuation")?.summary;
  const contributors = new Set<string>();
  for (const event of events) contributors.add(event.actor_name);
  for (const candidate of candidates) contributors.add(candidate.contributor);
  for (const link of links) contributors.add(link.actor_name);

  return {
    current,
    alternatives: candidates.slice(1),
    uncertainty,
    contributors: [...contributors].sort((a, b) => a.localeCompare(b)),
    continuation,
  };
}

function eventIsPartial(event: JourneyEventRow): boolean {
  try {
    const data = JSON.parse(event.data_json) as Record<string, unknown>;
    return data.partial === true;
  } catch {
    return false;
  }
}

export function resolveJourneyRecord(
  db: MarinaDB,
  kind: JourneyLinkKind,
  ref: string,
): JourneyCanonicalRecord | undefined {
  if (kind === "task" && /^\d+$/.test(ref)) {
    const task = db.getTask(Number(ref));
    if (!task) return undefined;
    return {
      kind,
      ref,
      title: task.title,
      detail: task.description || task.deliverables || task.title,
      contributor: task.creator_name,
      status: task.status,
      createdAt: task.created_at,
    };
  }
  if (kind === "note" && /^\d+$/.test(ref)) {
    const note = db.getNote(Number(ref));
    if (!note) return undefined;
    return {
      kind,
      ref,
      title: truncate(note.content, 100),
      detail: note.content,
      contributor: note.entity_name,
      status: note.verification_status ?? "unverified",
      createdAt: note.created_at,
    };
  }
  if (kind === "board_post" && /^\d+$/.test(ref)) {
    const post = db.getBoardPost(Number(ref));
    if (!post) return undefined;
    return {
      kind,
      ref,
      title: post.title,
      detail: post.body,
      contributor: post.author_name,
      status: post.archived ? "archived" : "published",
      createdAt: post.created_at,
    };
  }
  if (kind === "chronicle" && /^\d+$/.test(ref)) {
    const entry = db.getChronicleEntry(Number(ref));
    if (!entry) return undefined;
    return {
      kind,
      ref,
      title: entry.title,
      detail: entry.body,
      contributor: entry.source,
      status: entry.kind,
      createdAt: entry.created_at,
    };
  }
  if (kind === "artifact") {
    const artifact = db.getCodingArtifact(ref);
    if (!artifact) return undefined;
    return {
      kind,
      ref,
      title: artifact.title,
      detail: artifact.content_text,
      contributor: artifact.created_by,
      status: artifact.status,
      createdAt: artifact.created_at,
    };
  }
  if (kind === "canvas_node") {
    const node = db.getNode(ref);
    if (!node) return undefined;
    return {
      kind,
      ref,
      title: `${node.type} canvas node`,
      detail: summarizeCanvasData(node.data),
      contributor: node.creator_name,
      status: "published",
      createdAt: node.created_at,
    };
  }
  return undefined;
}

function compareResults(a: JourneyResultCandidate, b: JourneyResultCandidate): number {
  if (a.partial !== b.partial) return a.partial ? 1 : -1;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.evidence.join(":").localeCompare(b.evidence.join(":"));
}

function journeyEventRef(event: JourneyEventRow): string {
  return `journey_event:${event.id}`;
}

function summarizeCanvasData(raw: string): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["text", "content", "result", "title"]) {
      if (typeof value[key] === "string" && value[key]) return value[key];
    }
  } catch {
    // Legacy canvas data can be plain text.
  }
  return raw;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
