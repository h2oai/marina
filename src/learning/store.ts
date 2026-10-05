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

import { searchNeighbourRecords } from "../memory/admission";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import {
  LESSON_SCOPES,
  type Lesson,
  type LessonAdmissionStamp,
  type LessonMergeEntry,
  type LessonRank,
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
  claim?: { subject: string; predicate: string; object: unknown } | null;
}

/** The claim predicate an admission resolve case is opened under (keyed by the contradicted lesson). */
export const conflictPredicate = (against: string) => `admission-conflict:${against}`;

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
    ...(typeof r.version === "number" ? { version: r.version } : {}),
    ...(typeof m.support === "number" && m.support >= 1 ? { support: m.support } : {}),
    ...(Array.isArray(m.merged) ? { merged: m.merged as LessonMergeEntry[] } : {}),
    ...(isObject(m.rank) && typeof m.rank.score === "number" ? { rank: m.rank as LessonRank } : {}),
    ...(isObject(m.admission) && typeof m.admission.action === "string"
      ? { admission: m.admission as unknown as LessonAdmissionStamp }
      : {}),
    // Pessimistic: a contested lesson is held until the store checks its targets.
    ...(isObject(m.admission) && m.admission.state === "contested" ? { contested: true } : {}),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Most merged-duplicate provenance entries kept on one lesson. */
export const MAX_MERGED_ENTRIES = 20;

/** The record metadata a lesson is stored with (no text; `id`, `version`, `contested` are never written). */
export function lessonMetadata(lesson: Lesson): Record<string, unknown> {
  return {
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
    ...(lesson.support !== undefined ? { support: lesson.support } : {}),
    ...(lesson.merged?.length ? { merged: lesson.merged.slice(-MAX_MERGED_ENTRIES) } : {}),
    ...(lesson.rank ? { rank: lesson.rank } : {}),
    ...(lesson.admission ? { admission: lesson.admission } : {}),
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
  const getRecord = async (spaceId: string, id: string) =>
    (await run({ operation: "get", space_id: spaceId, id })).result as RecordLike;
  /**
   * A contested lesson is held only while a lesson it contests is current: a
   * case resolved for it (or the other lesson retired) releases it.
   */
  const releaseContested = async (lessons: Lesson[], spaceId: string): Promise<Lesson[]> => {
    const now = Date.now();
    const known = new Map<string, boolean>();
    const isCurrent = async (id: string) => {
      let v = known.get(id);
      if (v === undefined) {
        try {
          v = currentLessonRecord(await getRecord(spaceId, id), now);
        } catch {
          v = false; // gone or erased: nothing left to contest
        }
        known.set(id, v);
      }
      return v;
    };
    const out: Lesson[] = [];
    for (const l of lessons) {
      if (!l.contested) {
        out.push(l);
        continue;
      }
      let held = false;
      for (const id of l.admission?.contests ?? []) if (await isCurrent(id)) held = true;
      out.push(held ? l : { ...l, contested: false });
    }
    return out;
  };
  /** Revise a current record keeping its text and validity (metadata and/or claim change). */
  const reviseKeeping = async (
    spaceId: string,
    record: RecordLike,
    change: { metadata?: Record<string, unknown>; claim?: RecordLike["claim"] },
    key: string,
  ) => {
    if (typeof record.version !== "number" || !record.id) throw new Error("record has no version");
    await run({
      operation: "revise",
      space_id: spaceId,
      id: record.id,
      key,
      input: {
        expected_version: record.version,
        content: record.content,
        metadata: change.metadata ?? record.metadata,
        ...(change.claim ? { claim: change.claim } : {}),
      },
    });
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
          metadata: lessonMetadata(lesson),
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
      return selectServed(await releaseContested(lessons, sp.space_id), asOf, recallOpts);
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
    async neighbours(domain, text, opts) {
      const words = [...lessonTokens(text)].slice(0, 16).join(" ");
      const sp = await space(domain);
      if (!words || !sp.space_id) return { lessons: [], mode: "lexical", degraded: [] };
      const found = await searchNeighbourRecords<RecordLike>(run, sp.space_id, words, {
        limit: opts.limit,
        subject: LESSON_RECORD_SUBJECT,
        ...(opts.hybrid ? { hybrid: true } : {}),
      });
      const now = Date.now();
      const lessons = found.records
        .filter((r) => currentLessonRecord(r, now))
        .map(lessonFromRecord)
        .filter((l): l is Lesson => l !== undefined && l.domain === domain);
      return {
        lessons,
        ...(found.generation === undefined ? {} : { generation: found.generation }),
        mode: found.mode,
        degraded: found.degraded,
      };
    },
    async update(domain, id, change) {
      const sp = await space(domain);
      if (!sp.space_id) throw new Error(`no lessons space for ${domain}`);
      const record = await getRecord(sp.space_id, id);
      const before = lessonFromRecord(record);
      if (!before || !currentLessonRecord(record)) throw new Error(`${id} is not a current lesson`);
      const next = change(before);
      const metadata = {
        ...record.metadata,
        ...lessonMetadata({ ...next, text: before.text, resolvedAt: before.resolvedAt }),
      };
      const digest = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(metadata))
        .digest("hex")
        .slice(0, 16);
      await reviseKeeping(
        sp.space_id,
        record,
        { metadata },
        `lesson-update:${id}:${record.version}:${digest}`,
      );
    },
    async contest(domain, id, against, opts) {
      const sp = await space(domain);
      if (!sp.space_id) throw new Error(`no lessons space for ${domain}`);
      const spaceId = sp.space_id;
      const predicate = conflictPredicate(against);
      const claimFor = (text: string | undefined) => ({
        subject: LESSON_RECORD_SUBJECT,
        predicate,
        object: { kind: "literal", value: (text ?? "").slice(0, 2_000) },
      });
      const other = await getRecord(spaceId, against);
      if (!currentLessonRecord(other)) throw new Error(`lesson ${against} is not current`);
      // The resolve operator compares records asserting one subject/predicate:
      // both lessons carry the case's claim. The contradicted lesson first, so
      // the new lesson is the most recent write (last_writer_wins picks it).
      // A lesson already in another case keeps that case: the new one is held
      // without a second case.
      if (other.claim && other.claim.predicate !== predicate) return { resolved: false };
      if (!other.claim)
        await reviseKeeping(
          spaceId,
          other,
          { claim: claimFor(other.content) },
          `lesson-claim:${against}:${other.version}`,
        );
      const mine = await getRecord(spaceId, id);
      await reviseKeeping(
        spaceId,
        mine,
        { claim: claimFor(mine.content) },
        `lesson-claim:${id}:${mine.version}`,
      );
      const reply = await run({
        operation: "resolve",
        space_id: spaceId,
        id,
        key: `lesson-contest:${id}:${against}`,
        input: {
          policy: opts.autoResolve ? "last_writer_wins" : "await_confirmation",
          competing: [against],
          rationale: opts.rationale.slice(0, 4_000),
        },
      });
      const r = (reply.result ?? {}) as { id?: unknown };
      return {
        ...(typeof r.id === "string" ? { caseId: r.id } : {}),
        resolved: opts.autoResolve,
      };
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
