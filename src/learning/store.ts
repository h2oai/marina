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
 *
 * Retirement (`retire`) is a `revise` that closes the record's validity and
 * records the reason, curator and replacement in metadata — the same tombstone
 * shape `note delete` uses. The durable `search` excludes ended records before
 * ranking, so a retired lesson is never recalled and never takes a slot; recall
 * re-checks validity anyway. Nothing is erased: `get` (with `version`) reads
 * every earlier version.
 */

import type { MemoryOperationRequest } from "../sdk/memory-operations";
import {
  LESSON_SCOPES,
  type Lesson,
  type LessonScope,
  type LessonSink,
  type LessonTrust,
  lessonMatches,
  lessonTokens,
  type OutcomeDomain,
  selectServed,
} from "./outcomes";

export const LESSON_RECORD_SUBJECT = "lesson";

type MemoryRun = (request: MemoryOperationRequest) => Promise<{ ok: true; result: unknown }>;

interface RecordLike {
  id?: string;
  version?: number;
  content?: string;
  metadata?: Record<string, unknown>;
  valid_time?: { from: number | null; until: number | null } | null;
}

/** A record whose validity has not ended at `now` (a retired lesson's has). */
export function currentLessonRecord(r: RecordLike, now = Date.now()): boolean {
  const until = r.valid_time?.until;
  return until === null || until === undefined || until > now;
}

const TRUSTS = new Set<LessonTrust>(["trusted", "unverified", "rejected"]);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

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
    ...(LESSON_SCOPES.includes(m.scope as LessonScope) ? { scope: m.scope as LessonScope } : {}),
    ...(strings(m.families).length ? { families: strings(m.families) } : {}),
    ...(strings(m.subjects).length ? { subjects: strings(m.subjects) } : {}),
    ...(m.provenance && typeof m.provenance === "object" && !Array.isArray(m.provenance)
      ? {
          provenance: Object.fromEntries(
            Object.entries(m.provenance as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          ),
        }
      : {}),
  };
}

export interface RetryOptions {
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `rawRun` retried on a busy store (HTTP 503 / 429) with the same request key,
 * after the delay the store asks for. The one retry helper for memory-service
 * callers that may meet another writer holding the database.
 */
export function retryingMemoryRun(rawRun: MemoryRun, opts: RetryOptions = {}): MemoryRun {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (request) => {
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
}

/**
 * A durable sink. `spaceFor(domain)` returns the shared space id for a domain
 * (created on first use by the caller's resolver, or `undefined` when a
 * recall-only resolver finds none — recall is then empty). A busy store
 * (HTTP 503 / 429) is retried with the same request key.
 */
export function durableLessonSink(
  rawRun: MemoryRun,
  spaceFor: (domain: OutcomeDomain) => Promise<string | undefined>,
  opts: RetryOptions = {},
): LessonSink {
  const run = retryingMemoryRun(rawRun, opts);
  const space = async (domain: OutcomeDomain) => {
    const id = await spaceFor(domain);
    return id ? { space_id: id } : {};
  };
  return {
    async write(lesson, writeOpts) {
      const reply = await run({
        operation: "remember",
        ...(writeOpts?.key ? { key: writeOpts.key } : {}),
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
            ...(lesson.scope ? { scope: lesson.scope } : {}),
            ...(lesson.families?.length ? { families: lesson.families } : {}),
            ...(lesson.subjects?.length ? { subjects: lesson.subjects } : {}),
            ...(lesson.provenance ? { provenance: lesson.provenance } : {}),
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
      const families = new Set(recallOpts?.families ?? []);
      if (!words && families.size === 0) return [];
      const sp = await space(domain);
      if (!sp.space_id) return [];
      const now = Date.now();
      const records: RecordLike[] = [];
      if (words) {
        const reply = await run({
          operation: "search",
          ...sp,
          input: { query: words, mode: "lexical", subject: LESSON_RECORD_SUBJECT, limit: 50 },
        });
        records.push(...((reply.result as { results?: RecordLike[] } | undefined)?.results ?? []));
      }
      // Key match on the work's families when the lexical match is thin: one
      // bounded symbolic page of current lessons, kept only on a shared tag.
      if (families.size > 0 && records.length < (recallOpts?.limit ?? 5)) {
        const reply = await run({
          operation: "query",
          ...sp,
          input: { subject: LESSON_RECORD_SUBJECT, valid_at: now, limit: 100 },
        });
        const seen = new Set(records.map((r) => r.id));
        for (const r of (reply.result as { results?: RecordLike[] } | undefined)?.results ?? []) {
          if (seen.has(r.id)) continue;
          if (strings(r.metadata?.families).some((f) => families.has(f))) records.push(r);
        }
      }
      const lessons = records
        .filter((r) => currentLessonRecord(r, now))
        .map(lessonFromRecord)
        .filter((l): l is Lesson => l !== undefined && l.domain === domain);
      return selectServed(lessons, asOf, recallOpts);
    },
    async find(domain, selector, limit) {
      const sp = await space(domain);
      if (!sp.space_id) return [];
      const now = Date.now();
      const out: Lesson[] = [];
      let cursor: string | undefined;
      // Exact symbolic reads at `now`: only current lessons, paged.
      for (let page = 0; page < 100 && out.length < limit; page++) {
        const reply = await run({
          operation: "query",
          ...sp,
          input: {
            subject: LESSON_RECORD_SUBJECT,
            valid_at: now,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
        });
        const r = (reply.result ?? {}) as { results?: RecordLike[]; next_cursor?: string | null };
        for (const record of r.results ?? []) {
          const l = lessonFromRecord(record);
          if (l && l.domain === domain && lessonMatches(l, selector)) out.push(l);
        }
        if (!r.next_cursor) break;
        cursor = r.next_cursor;
      }
      return out.slice(0, limit);
    },
    async retire(domain, id, retirement) {
      const sp = await space(domain);
      if (!sp.space_id) throw new Error(`no lessons space for ${domain}`);
      const record = (await run({ operation: "get", ...sp, id })).result as RecordLike;
      if (record.metadata?.kind !== LESSON_RECORD_SUBJECT || typeof record.content !== "string")
        throw new Error(`${id} is not a lesson`);
      const now = Date.now();
      if (!currentLessonRecord(record, now)) throw new Error(`lesson ${id} is already retired`);
      const version = record.version;
      if (typeof version !== "number") throw new Error(`lesson ${id} has no version`);
      await run({
        operation: "revise",
        ...sp,
        id,
        // Deterministic: a retried retirement of the same version is one revision.
        key: `lesson-retire:${id}:${version}`,
        input: {
          expected_version: version,
          content: record.content,
          metadata: {
            ...record.metadata,
            retired_reason: retirement.reason,
            retired_at: new Date(now).toISOString(),
            retired_by: retirement.by,
            ...(retirement.supersededBy ? { superseded_by: retirement.supersededBy } : {}),
          },
          valid_time: { from: record.valid_time?.from ?? null, until: now },
        },
      });
    },
  };
}
