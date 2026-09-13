// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, object, textValue } from "../memory/service-types";
import { isMemoryVariable, memoryJoin, memoryRule } from "../memory/symbolic";
import type {
  MemoryBinding,
  MemoryJoinResult,
  MemoryMatch,
  MemoryPattern,
  MemoryRuleResult,
} from "../sdk/memory-symbolic";
import type { MemoryClaim, MemoryRecord, MemoryTerm } from "../sdk/memory-types";
import {
  authorizeMemorySpace,
  canonical,
  hash,
  mutation,
  readMemoryRecord,
  rememberRecord,
  reviseRecord,
} from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

function resolve(
  value: MemoryPattern[keyof MemoryPattern],
  bindings: Record<string, MemoryBinding>,
  position: keyof MemoryPattern,
): MemoryBinding | undefined {
  if (isMemoryVariable(value)) return bindings[value.variable];
  if (typeof value !== "string") return value;
  return position === "subject" ? { kind: "entity", id: value } : { kind: "symbol", value };
}
function valueType(value: MemoryBinding) {
  return value.kind === "literal"
    ? value.value === null
      ? "null"
      : typeof value.value
    : value.kind;
}
const exhausted = (): never => {
  throw new MemoryError(
    422,
    "symbolic_budget_exceeded",
    "Join exceeded its candidate/comparison budget; bind more subjects or predicates",
  );
};

/** A single authorized read snapshot. Explicit budgets refuse incomplete intermediate joins. */
export function joinMemory(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
): MemoryJoinResult {
  const input = memoryJoin(raw);
  return db.transaction(() => {
    const current = authorizeMemorySpace(db, actor, space);
    let matches: MemoryMatch[] = [
      { bindings: Object.create(null), witnesses: [], valid_time: { from: null, until: null } },
    ];
    const trace: MemoryJoinResult["trace"] = [];
    const cache = new Map<
      string,
      Pick<MemoryRecord, "id" | "version" | "claim" | "valid_time">[]
    >();
    let comparisons = 0,
      fetched = 0,
      fetchedBytes = 0;
    for (const [index, pattern] of input.patterns.entries()) {
      const next: MemoryMatch[] = [];
      let candidates = 0,
        matchBytes = 0;
      for (const match of matches) {
        const subject = resolve(pattern.subject, match.bindings, "subject"),
          predicate = resolve(pattern.predicate, match.bindings, "predicate"),
          object = resolve(pattern.object, match.bindings, "object");
        const filter = {
          subject: subject?.kind === "entity" ? subject.id : undefined,
          predicate: predicate?.kind === "symbol" ? predicate.value : undefined,
          object: object as MemoryTerm | undefined,
          valid_at: input.valid_at,
          limit: 2000,
        };
        const key = canonical(filter);
        let rows = cache.get(key);
        if (!rows) {
          if (cache.size >= 256) exhausted();
          const clauses = [
              "c.space_id=?",
              "r.status='active'",
              "r.stale=0",
              "n.verification_status!='superseded'",
            ],
            args: (string | number)[] = [space];
          if (filter.subject !== undefined) {
            clauses.push("c.subject=?");
            args.push(filter.subject);
          }
          if (filter.predicate !== undefined) {
            clauses.push("c.predicate=?");
            args.push(filter.predicate);
          }
          if (filter.object !== undefined) {
            clauses.push("c.object_json=?");
            args.push(canonical(filter.object));
          }
          if (input.valid_at !== undefined) {
            clauses.push(
              "(r.valid_from IS NULL OR r.valid_from<=?) AND (r.valid_until IS NULL OR r.valid_until>?)",
            );
            args.push(input.valid_at, input.valid_at);
          }
          const selected = db
            .query(
              `SELECT r.id,r.version,r.valid_from,r.valid_until,c.subject,c.predicate,c.object_json FROM memory_claims c JOIN memory_records r ON r.id=c.record_id JOIN notes n ON n.id=r.current_note_id WHERE ${clauses.join(" AND ")} ORDER BY r.id LIMIT 2001`,
            )
            .all(...args) as {
            id: string;
            version: number;
            valid_from: number | null;
            valid_until: number | null;
            subject: string;
            predicate: string;
            object_json: string;
          }[];
          fetched += selected.length;
          fetchedBytes += selected.reduce(
            (size, r) =>
              size +
              Buffer.byteLength(r.object_json) +
              Buffer.byteLength(r.subject) +
              Buffer.byteLength(r.predicate) +
              128,
            0,
          );
          if (selected.length > 2000 || fetched > 8000 || fetchedBytes > 4194304) exhausted();
          rows = selected.map((r) => ({
            id: r.id,
            version: r.version,
            valid_time: { from: r.valid_from, until: r.valid_until },
            claim: {
              subject: r.subject,
              predicate: r.predicate,
              object: JSON.parse(r.object_json),
            },
          }));
          cache.set(key, rows);
        }
        for (const record of rows) {
          if (++comparisons > 20000) exhausted();
          if (!record.claim) continue;
          candidates++;
          const bindings = Object.assign(Object.create(null), match.bindings) as Record<
            string,
            MemoryBinding
          >;
          const values = {
            subject: { kind: "entity", id: record.claim.subject },
            predicate: { kind: "symbol", value: record.claim.predicate },
            object: record.claim.object,
          } as const;
          let accepted = true;
          for (const position of ["subject", "predicate", "object"] as const) {
            const term = pattern[position],
              actual = values[position];
            if (isMemoryVariable(term)) {
              if (
                valueType(actual) !== term.type ||
                (Object.hasOwn(bindings, term.variable) &&
                  canonical(bindings[term.variable]) !== canonical(actual))
              ) {
                accepted = false;
                break;
              }
              bindings[term.variable] = actual;
            } else if (canonical(resolve(term, bindings, position)) !== canonical(actual)) {
              accepted = false;
              break;
            }
          }
          if (!accepted) continue;
          const from = Math.max(
              match.valid_time.from ?? -Infinity,
              record.valid_time?.from ?? -Infinity,
            ),
            until = Math.min(
              match.valid_time.until ?? Infinity,
              record.valid_time?.until ?? Infinity,
            );
          if (from >= until) continue;
          next.push({
            bindings,
            witnesses: [...match.witnesses, { id: record.id, version: record.version }],
            valid_time: {
              from: Number.isFinite(from) ? from : null,
              until: Number.isFinite(until) ? until : null,
            },
          });
          matchBytes += Buffer.byteLength(JSON.stringify(next.at(-1)));
          if (next.length > 2000 || matchBytes > 4194304) exhausted();
        }
      }
      matches = next;
      trace.push({ pattern: index, candidates, matches: matches.length });
    }
    return {
      space_id: space,
      generation: current.generation,
      semantics: "asserted-nonrecursive" as const,
      results: matches.slice(0, input.limit).map((match) => ({
        ...match,
        bindings: Object.fromEntries(input.select!.map((name) => [name, match.bindings[name]!])),
      })),
      truncated: matches.length > input.limit!,
      trace,
    };
  })();
}

export function saveMemoryRule(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  const input = object(raw),
    rule = memoryRule(input.rule);
  if (
    Object.keys(input).some((k) => !["rule", "id", "expected_version", "source_ids"].includes(k)) ||
    (input.id === undefined && input.expected_version !== undefined)
  )
    throw new MemoryError(400, "invalid_symbolic", "Unknown rule write field or missing rule id");
  const record = {
    content: JSON.stringify(rule),
    type: "skill" as const,
    metadata: { format: rule.schema },
    source_ids: input.source_ids,
  };
  // Canonical record validation also bounds and authorizes declared original sources.
  const data = { ...record, source_ids: input.source_ids as string[] | undefined };
  if (input.id !== undefined) {
    const id = textValue(input.id, "id", 128),
      previous = readMemoryRecord(db, actor, space, id);
    if (previous.metadata.format !== rule.schema)
      throw new MemoryError(409, "not_a_rule", "Record is not a symbolic rule");
    return reviseRecord(
      db,
      actor,
      space,
      id,
      integer(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER),
      data,
      key,
    );
  }
  return rememberRecord(db, actor, space, data, key);
}
export function runMemoryRule(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
): MemoryRuleResult {
  const input = object(raw),
    id = textValue(input.id, "id", 128),
    version = integer(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER);
  if (Object.keys(input).some((k) => !["id", "expected_version", "valid_at"].includes(k)))
    throw new MemoryError(400, "invalid_symbolic", "Unknown rule execution field");
  return db.transaction(() => {
    const record = readMemoryRecord(db, actor, space, id);
    if (record.version !== version || record.freshness === "stale")
      throw new MemoryError(409, "rule_changed", "Rule changed or needs review");
    if (record.metadata.format !== "marina.memory.rule.v1")
      throw new MemoryError(409, "not_a_rule", "Record is not a symbolic rule");
    let rawRule: unknown;
    try {
      rawRule = JSON.parse(record.content);
    } catch {
      throw new MemoryError(400, "invalid_symbolic", "Rule content is not JSON");
    }
    const rule = memoryRule(rawRule),
      joined = joinMemory(db, actor, space, {
        ...rule.query,
        ...(input.valid_at === undefined ? {} : { valid_at: input.valid_at }),
      });
    return {
      ...joined,
      rule: { id, version },
      results: joined.results.flatMap((match) => {
        const from = Math.max(
            match.valid_time.from ?? -Infinity,
            record.valid_time?.from ?? -Infinity,
          ),
          until = Math.min(
            match.valid_time.until ?? Infinity,
            record.valid_time?.until ?? Infinity,
          );
        const at = input.valid_at ?? rule.query.valid_at;
        if (from >= until || (typeof at === "number" && (at < from || at >= until))) return [];
        const subject = resolve(rule.conclusion.subject, match.bindings, "subject"),
          predicate = resolve(rule.conclusion.predicate, match.bindings, "predicate"),
          object = resolve(rule.conclusion.object, match.bindings, "object");
        if (
          subject?.kind !== "entity" ||
          predicate?.kind !== "symbol" ||
          !object ||
          object.kind === "symbol"
        )
          throw new MemoryError(400, "invalid_symbolic", "Unbound conclusion");
        return [
          {
            ...match,
            valid_time: {
              from: Number.isFinite(from) ? from : null,
              until: Number.isFinite(until) ? until : null,
            },
            claim: { subject: subject.id, predicate: predicate.value, object },
          },
        ];
      }),
    };
  })();
}
export function materializeMemoryRule(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  authorizeMemorySpace(db, actor, space, "memory:write");
  const input = object(raw);
  return mutation(db, actor, space, key, "rule.materialize", input, () => {
    const result = runMemoryRule(db, actor, space, input);
    if (result.truncated) exhausted();
    const receipts = result.results.map((match, index) => {
      const pins = Object.fromEntries(
        [result.rule, ...match.witnesses].map((w) => [w.id, w.version]),
      );
      const claim: MemoryClaim = match.claim;
      return rememberRecord(
        db,
        actor,
        space,
        {
          content: JSON.stringify(claim),
          type: "inference",
          claim,
          depends_on: Object.keys(pins),
          dependency_versions: pins,
          valid_time: match.valid_time,
          metadata: { format: "marina.memory.rule-result.v1", rule: result.rule },
        },
        `rule-derived:${hash([key, index, result.rule.id])}`,
      );
    });
    return {
      id: result.rule.id,
      seq: receipts.at(-1)?.seq,
      records: receipts,
      rule: result.rule,
    };
  });
}
