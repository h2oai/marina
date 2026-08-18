// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Persists a Sample as a note and emits a feed event for closure-relevant
// statuses. Filter-at-source: no-change and error samples never reach the
// feed — they would drown out signal. They still write notes (process tier,
// evictable) so the watcher can compute change detection on the next tick.

import type { MarinaDB } from "../persistence/database";
import type { EngineEvent, EntityId } from "../types";
import { runCalibration } from "./calibration";
import type { Sample, SampleStatus } from "./types";

// Tier mapping. Resolved/changed are generational (fact); no-change/error
// are transient (process, capped at 500 per entity, evictable on overflow).
const TIER_BY_STATUS: Record<SampleStatus, "fact" | "process"> = {
  resolved: "fact",
  changed: "fact",
  "no-change": "process",
  error: "process",
};

// Importance weights — drive sort order in `recall` and feed surfacing.
const IMPORTANCE_BY_STATUS: Record<SampleStatus, number> = {
  resolved: 8,
  changed: 6,
  "no-change": 3,
  error: 2,
};

export type WriteSampleParams = {
  db: MarinaDB;
  sample: Sample;
  /** Entity that owns the sample. Defaults to "system" if not provided
   *  (e.g. for HTTP-triggered probes with no calling agent). */
  authorName?: string;
  /** When set, link the new sample note to this watch spec note via
   *  relationship=derived_from. Provenance: this sample answers that watch. */
  watchSpecNoteId?: number;
  /** When set, link the new sample to the previous sample for the same
   *  (kind, id) via relationship=supersedes. Forms the time-series chain. */
  previousSampleNoteId?: number;
  /** Engine event sink. Sample writes emit feed_event for closure-relevant
   *  statuses; pass undefined in tests that don't care. */
  emitEvent?: (event: EngineEvent) => void;
};

export type WriteSampleResult = {
  noteId: number;
  /** True iff a feed_event was emitted (resolved or changed status). */
  emittedFeedEvent: boolean;
};

/** Format Sample as a recall-friendly note body. The first line is the
 *  canonical tag for FTS5 retrieval; subsequent lines render the result
 *  for human and agent reading. The trailing JSON line is parseable for
 *  programmatic consumers. */
export function renderSampleContent(sample: Sample): string {
  const tag = `[sample:${sample.kind} ${sample.id} ${new Date(sample.ts).toISOString()}]`;
  const headline = renderHeadline(sample);
  const body = `source: ${sample.source}`;
  const json = `sample: ${JSON.stringify(sampleForJson(sample))}`;
  return [tag, "", headline, body, json].join("\n");
}

function renderHeadline(sample: Sample): string {
  switch (sample.status) {
    case "resolved":
      return `resolved: ${sample.id} → ${formatValue(sample.value)}`;
    case "changed":
      return `changed: ${sample.id} → ${formatValue(sample.value)}`;
    case "no-change":
      return `no-change: ${sample.id}`;
    case "error":
      return `error: ${sample.id} — ${sample.reason ?? "unknown"}`;
  }
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "(none)";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function sampleForJson(sample: Sample): Record<string, unknown> {
  // Keep order stable for diffability; omit undefined fields.
  const out: Record<string, unknown> = {
    status: sample.status,
    ts: sample.ts,
  };
  if (sample.value !== undefined) out.value = sample.value;
  if (sample.rawHash) out.rawHash = sample.rawHash;
  if (sample.reason) out.reason = sample.reason;
  return out;
}

export function writeSample(params: WriteSampleParams): WriteSampleResult {
  const { db, sample, watchSpecNoteId, previousSampleNoteId, emitEvent } = params;
  const authorName = params.authorName ?? "system";

  const tier = TIER_BY_STATUS[sample.status];
  const importance = IMPORTANCE_BY_STATUS[sample.status];
  const content = renderSampleContent(sample);

  // Samples are observation records — every probe call writes one even if
  // the content is identical to a prior call (timestamps and dedup at the
  // sample level would corrupt the time-series). Skip the createNote dedup
  // entirely for this note_type.
  const noteId = db.createNote(authorName, content, undefined, {
    importance,
    noteType: "sample",
    tier,
    skipDedup: true,
  });

  if (watchSpecNoteId !== undefined) {
    tryLink(db, noteId, watchSpecNoteId, "derived_from");
  }
  if (previousSampleNoteId !== undefined) {
    tryLink(db, noteId, previousSampleNoteId, "supersedes");
  }

  // Filter at source: only closure-relevant statuses reach the feed. The
  // watching agent and downstream consumers (calibration, regression) read
  // the feed for signal — drowning it in no-change ticks would defeat that.
  // Insert into feed_events directly so timeline queries see the event even
  // when no FeedPublisher is attached (tests, headless engines). Same shape
  // as FeedPublisher.recordFeedEvent.
  let emittedFeedEvent = false;
  if (sample.status === "resolved" || sample.status === "changed") {
    const kind = `sample.${sample.status}`;
    const ref = `sample:${sample.kind}/${sample.id}`;
    const summary = renderHeadline(sample);
    const payload = {
      kind: sample.kind,
      id: sample.id,
      status: sample.status,
      value: sample.value,
      source: sample.source,
      noteId,
    };
    db.insertFeedEvent({ kind, entity: authorName, ref, summary, payload });
    emitEvent?.({
      type: "feed_event",
      kind,
      entity: authorName as EntityId,
      ref,
      summary,
      payload,
      timestamp: sample.ts,
    });
    emittedFeedEvent = true;
  }

  // Calibration loop — pairs resolved samples with forecast / position notes
  // and writes outcome notes that close generational learning. No-op for
  // changed / no-change / error statuses; finders run only on resolved.
  if (sample.status === "resolved") {
    runCalibration(db, sample, emitEvent);
  }

  return { noteId, emittedFeedEvent };
}

/** Look up the most recent sample note for this (kind, id), or undefined.
 *  Returns the note id + parsed Sample. Used by the probe command to pass
 *  previousSample into ResolverInput for change-detection.
 *
 *  Implementation: searchAllNotes orders by FTS5 relevance (not recency),
 *  so we filter by the canonical tag prefix and pick the highest note id —
 *  that's the latest sample for this (kind, id). */
export function findLatestSample(
  db: MarinaDB,
  kind: string,
  id: string,
): { noteId: number; sample: Sample } | undefined {
  const prefix = `[sample:${kind} ${id} `;
  const matches = db.searchAllNotes(`sample ${kind} ${id}`, 50);
  let best: { noteId: number; sample: Sample } | undefined;
  for (const note of matches) {
    if (!note.content.startsWith(prefix)) continue;
    if (best && note.id < best.noteId) continue;
    const parsed = parseSampleFromContent(note.content);
    if (!parsed) continue;
    best = { noteId: note.id, sample: parsed };
  }
  return best;
}

/** Parse a Sample from a note body produced by renderSampleContent.
 *  Returns undefined if the body is malformed. Tolerant — we'd rather
 *  miss a stale sample than crash the resolver loop. */
export function parseSampleFromContent(content: string): Sample | undefined {
  // Tag line is line 0: [sample:<kind> <id> <iso-ts>]
  const lines = content.split("\n");
  const tagMatch = lines[0]?.match(/^\[sample:(\S+)\s+(\S+)\s+([^\]]+)\]$/);
  if (!tagMatch) return undefined;
  const [, kind, id, iso] = tagMatch;
  if (!kind || !id || !iso) return undefined;

  // JSON line: "sample: {...}"
  const jsonLine = lines.find((l) => l.startsWith("sample: "));
  if (!jsonLine) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonLine.slice("sample: ".length)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const status = parsed.status;
  if (
    status !== "resolved" &&
    status !== "changed" &&
    status !== "no-change" &&
    status !== "error"
  ) {
    return undefined;
  }
  const ts = typeof parsed.ts === "number" ? parsed.ts : Date.parse(iso);
  if (Number.isNaN(ts)) return undefined;

  // source line: "source: <url>"
  const sourceLine = lines.find((l) => l.startsWith("source: "));
  const source = sourceLine ? sourceLine.slice("source: ".length) : "";

  return {
    kind,
    id,
    ts,
    status,
    value: parsed.value,
    source,
    rawHash: typeof parsed.rawHash === "string" ? parsed.rawHash : undefined,
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
  };
}

function tryLink(db: MarinaDB, source: number, target: number, relationship: string): void {
  try {
    db.createNoteLink(source, target, relationship);
  } catch {
    // Duplicate link or FK mismatch — non-fatal, sample is already filed.
  }
}
