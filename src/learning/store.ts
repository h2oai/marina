// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lessons as canonical memory records (reflection tier, subject `lesson`),
 * one shared space per domain (`lessons:<domain>`), through a memory-service
 * `run` (`residentMemoryOperation` bound to the lessons account, or a
 * `DurableMemoryAPI.run`). Rejected candidates are stored too — as audit
 * records with `trust: "rejected"` that recall never serves. Recall
 * over-fetches lexical matches and applies `visibleAt` itself, so the leakage
 * rule never depends on the store's own temporal filters.
 */

import type { MemoryOperationRequest } from "../sdk/memory-operations";
import {
  type Lesson,
  type LessonSink,
  type LessonTrust,
  lessonTokens,
  type OutcomeDomain,
  selectServed,
} from "./outcomes";

export const LESSON_RECORD_SUBJECT = "lesson";

type MemoryRun = (request: MemoryOperationRequest) => Promise<{ ok: true; result: unknown }>;

interface RecordLike {
  id?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  valid_time?: { from: number | null; until: number | null } | null;
}

const TRUSTS = new Set<LessonTrust>(["trusted", "unverified", "rejected"]);

export function lessonFromRecord(r: RecordLike): Lesson | undefined {
  const m = r.metadata ?? {};
  if (m.kind !== LESSON_RECORD_SUBJECT || typeof r.content !== "string") return undefined;
  const resolvedAt =
    typeof m.resolved_at === "string"
      ? m.resolved_at
      : typeof r.valid_time?.from === "number"
        ? new Date(r.valid_time.from).toISOString()
        : undefined;
  if (!resolvedAt || typeof m.domain !== "string") return undefined;
  const trust = TRUSTS.has(m.trust as LessonTrust) ? (m.trust as LessonTrust) : "unverified";
  return {
    ...(r.id ? { id: r.id } : {}),
    domain: m.domain as OutcomeDomain,
    text: r.content,
    kind: m.lesson_kind === "success" ? "success" : "failure",
    ...(typeof m.category === "string" ? { category: m.category } : {}),
    ...(typeof m.rule === "string" ? { rule: m.rule } : {}),
    ...(typeof m.score === "number" ? { score: m.score } : {}),
    trust,
    ...(m.judgement && typeof m.judgement === "object"
      ? { judgement: m.judgement as Record<string, number> }
      : {}),
    ...(typeof m.judge === "string" ? { judge: m.judge } : {}),
    resolvedAt,
    source: typeof m.source === "string" ? m.source : "",
    ...(Array.isArray(m.refs) ? { refs: m.refs.filter((x) => typeof x === "string") } : {}),
  };
}

/**
 * A durable sink. `spaceFor(domain)` returns the shared space id for a domain
 * (created on first use by the caller's resolver). A busy store (HTTP 503 /
 * 429) is retried with the same request key.
 */
export function durableLessonSink(
  rawRun: MemoryRun,
  spaceFor: (domain: OutcomeDomain) => Promise<string | undefined>,
  opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): LessonSink {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run: MemoryRun = async (request) => {
    const keyed = request.key ? request : { ...request, key: crypto.randomUUID() };
    for (let attempt = 0; ; attempt++) {
      try {
        return await rawRun(keyed);
      } catch (err) {
        const e = err as { status?: number; retryAfterMs?: number };
        const busy = e?.status === 503 || e?.status === 429;
        if (!busy || attempt >= (opts.retries ?? 6)) throw err;
        await sleep(Math.min(10_000, (e.retryAfterMs ?? 500) * (attempt + 1)));
      }
    }
  };
  const space = async (domain: OutcomeDomain) => {
    const id = await spaceFor(domain);
    return id ? { space_id: id } : {};
  };
  return {
    async write(lesson) {
      const reply = await run({
        operation: "remember",
        ...(await space(lesson.domain)),
        input: {
          content: lesson.text,
          type: "inference",
          tier: "reflection",
          subject: LESSON_RECORD_SUBJECT,
          metadata: {
            kind: LESSON_RECORD_SUBJECT,
            domain: lesson.domain,
            trust: lesson.trust,
            lesson_kind: lesson.kind,
            resolved_at: lesson.resolvedAt,
            source: lesson.source,
            ...(lesson.category ? { category: lesson.category } : {}),
            ...(lesson.rule ? { rule: lesson.rule } : {}),
            ...(lesson.score !== undefined ? { score: lesson.score } : {}),
            ...(lesson.judgement ? { judgement: lesson.judgement } : {}),
            ...(lesson.judge ? { judge: lesson.judge } : {}),
            ...(lesson.refs?.length ? { refs: lesson.refs } : {}),
          },
          valid_time: { from: Date.parse(lesson.resolvedAt), until: null },
        },
      });
      const r = (reply.result as { id?: unknown; record?: { id?: unknown } } | undefined) ?? {};
      const id =
        typeof r.id === "string"
          ? r.id
          : typeof r.record?.id === "string"
            ? r.record.id
            : undefined;
      return id ? { id } : {};
    },
    async recall(domain, query, asOf, recallOpts) {
      const words = [...lessonTokens(query)].slice(0, 12).join(" ");
      if (!words) return [];
      const reply = await run({
        operation: "search",
        ...(await space(domain)),
        input: { query: words, mode: "lexical", subject: LESSON_RECORD_SUBJECT, limit: 50 },
      });
      const lessons = ((reply.result as { results?: RecordLike[] } | undefined)?.results ?? [])
        .map(lessonFromRecord)
        .filter((l): l is Lesson => l !== undefined && l.domain === domain);
      return selectServed(lessons, asOf, recallOpts);
    },
  };
}
