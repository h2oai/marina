// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sharded aggregation (sharding / crash tolerance).
 *
 * ~200–260 synthetic records `id region status qty` in numbered shards, dealt
 * privately to members (pool listings truncate notes to 60 characters, so bulk
 * material travels as Operator tells). Distractors: stale `VOID` shard copies
 * with altered quantities, and records outside the filter. With `crash`, every
 * shard goes to two members (so records repeat and must be de-duplicated by
 * id) and the runner stops one member mid-task; the replicas keep the task
 * solvable. The answer is an exact count and sum.
 */

import {
  DEFAULT_POOL,
  deliverableRe,
  depositClause,
  type GenerateOptions,
  makeRng,
  type NativeGenerator,
  type NativeInstance,
  type NativeScore,
  parseFields,
  parseIntStrict,
  privateMap,
  resolveMembers,
  type SetupStep,
} from "./shared";

export const REGIONS = ["north", "south", "east", "west"] as const;
export const STATUSES = ["shipped", "returned", "pending"] as const;

export interface AggRecord {
  id: string;
  region: string;
  status: string;
  qty: number;
}

export interface AggOracle {
  tag: string;
  region: string;
  status: string;
  count: number;
  sum: number;
  records: number;
  shards: number;
  /** Shard index → members holding it. */
  holders: Record<string, string[]>;
}

const SHARD_SIZE = 25;

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export function renderRecord(r: AggRecord): string {
  return `${r.id} ${r.region} ${r.status} ${r.qty}`;
}

export function generateAggregation(
  seed: number,
  opts?: GenerateOptions,
): NativeInstance<AggOracle> {
  const members = resolveMembers(opts);
  const pool = opts?.pool ?? DEFAULT_POOL;
  const crash = opts?.crash === true && members.length > 1;
  const tag = `AGG${seed}`;
  const rng = makeRng(seed, "aggregation");
  const n = rng.int(200, 260);
  const region = rng.pick(REGIONS);
  const status = "shipped";
  // Unique ids: a shuffled sample of 4-digit numbers.
  const idPool = rng.shuffle(Array.from({ length: 9000 }, (_, i) => i + 1000)).slice(0, n);
  const records: AggRecord[] = idPool.map((id) => ({
    id: `r${id}`,
    region: rng.pick(REGIONS),
    status: rng.next() < 0.5 ? "shipped" : rng.pick(STATUSES),
    qty: rng.int(1, 20),
  }));
  const shardCount = Math.ceil(n / SHARD_SIZE);
  const shards = Array.from({ length: shardCount }, (_, k) =>
    records.slice(k * SHARD_SIZE, (k + 1) * SHARD_SIZE),
  );
  const shardLabel = (k: number) => `${pad(k + 1, 2)}/${pad(shardCount, 2)}`;
  const holders: Record<string, string[]> = {};
  const setup: SetupStep[] = [];
  const order = rng.shuffle(shards.map((_, k) => k));
  order.forEach((k, j) => {
    const owners = [members[j % members.length]!];
    if (crash) owners.push(members[(j + 1) % members.length]!);
    holders[String(k + 1)] = owners;
    for (const member of owners)
      setup.push({
        kind: "private",
        member,
        text: `PRIVATE ${tag} SHARD ${shardLabel(k)} (id region status qty): ${shards[k]!.map(renderRecord).join(", ")}.`,
      });
  });
  // Distractors: two stale VOID copies of real shards with perturbed quantities.
  for (let d = 0; d < 2; d++) {
    const k = rng.int(0, shardCount - 1);
    const stale = shards[k]!.map((r) => ({ ...r, qty: Math.max(1, r.qty + rng.int(-3, 6)) }));
    setup.push({
      kind: "private",
      member: rng.pick(members),
      text: `PRIVATE ${tag} VOID ${shardLabel(k)} (stale copy, superseded): ${stale.map(renderRecord).join(", ")}.`,
    });
  }
  const hits = records.filter((r) => r.region === region && r.status === status);
  const count = hits.length;
  const sum = hits.reduce((a, r) => a + r.qty, 0);
  const format = `${tag} RESULT: count=<n>; sum=<s>.`;
  const text =
    `TASK ${tag} (sharded aggregation): ${n} records (id region status qty) are split into shards ${tag} SHARD 01–${pad(shardCount, 2)}, ` +
    `dealt to crew members by private Operator tells headed PRIVATE ${tag}.${crash ? " Each shard is held by two members; a member may go offline mid-task." : ""} ` +
    `Ignore every ${tag} VOID shard. Over distinct record ids, compute count and sum of qty for region=${region} and status=${status}. ${depositClause(pool, format)}`;
  // The crash spares the first member (the crew lead receives the dispatch).
  const fault = crash ? { member: rng.pick(members.slice(1)), afterSeconds: 45 } : undefined;
  return {
    task: "aggregation",
    seed,
    tag,
    shape: crash ? "sharding with a crash" : "sharding",
    text,
    privateMaterial: privateMap(setup),
    setup,
    pool,
    deliverableRe: deliverableRe(tag, "RESULT"),
    answer: `${tag} RESULT: count=${count}; sum=${sum}`,
    ...(fault ? { fault } : {}),
    oracle: { tag, region, status, count, sum, records: n, shards: shardCount, holders },
  };
}

export function scoreAggregation(deliverable: string, o: AggOracle): NativeScore {
  const fields = parseFields(deliverable, o.tag, "RESULT");
  if (!fields) return { correct: false, score: 0, details: { error: "no RESULT line" } };
  const count = parseIntStrict(fields.get("count"));
  const sum = parseIntStrict(fields.get("sum"));
  const countOk = count === o.count;
  const sumOk = sum === o.sum;
  const rel = (got: number | null, want: number) =>
    got === null ? null : want === 0 ? Math.abs(got) : Math.abs(got - want) / want;
  return {
    correct: countOk && sumOk,
    score: ((countOk ? 1 : 0) + (sumOk ? 1 : 0)) / 2,
    details: {
      count,
      sum,
      expected: { count: o.count, sum: o.sum },
      relativeError: { count: rel(count, o.count), sum: rel(sum, o.sum) },
    },
  };
}

export const aggregationGenerator: NativeGenerator<AggOracle> = {
  id: "aggregation",
  title: "Sharded aggregation with a crash",
  shape: "sharding",
  generate: generateAggregation,
  score: scoreAggregation,
};
