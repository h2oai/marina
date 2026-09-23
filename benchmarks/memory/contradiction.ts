#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * contradiction — the multi-writer contradiction benchmark (HISTORY.md §7.5
 * "not measured": the unresolved-contradiction rate against a known floor).
 *
 * genbench asks "does memory help one agent?", successor asks "does knowledge
 * survive hand-over?". This harness asks the SHARED-space question the
 * contradiction operators (Phase 2.5) and the Sybil rule (Phase 3.6) exist for:
 *
 *   When several writers of different standing assert competing values for the
 *   same subject/predicate in one shared space — some honestly wrong, some
 *   Sybil rings corroborating a wrong value with copied sources — how many
 *   contradictions does each `resolve` policy actually close, how often does
 *   it pick the TRUE value, does the Sybil rule hold, and can a reader still be
 *   served a superseded value afterwards?
 *
 * Everything runs against the REAL durable service (`MarinaMemoryClient` over
 * `handleMemoryServiceApi(worldMemoryService(db))`, bound to world accounts
 * exactly the way `residentMemoryOperation` binds them: `users.id` = the human
 * principal id, standing in `entity_standing_cache` under that id). One fresh
 * `MarinaDB` per (seed, arm). The scenario generator is seed-deterministic and
 * the four policies are deterministic, so the whole benchmark is OFFLINE — no
 * model is ever called, and the same seed yields byte-identical results apart
 * from timestamps, runtimes and paths (`stripVolatile`).
 *
 * The contradiction counts use `COMPETING_RECORD_PREDICATE` — the same SQL
 * `review kind:competing` and the dashboard hygiene ratios use — and every run
 * also records `computeHygieneRatios` before/after so the dashboard number and
 * the benchmark cannot disagree without it showing here.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RateLimiter } from "../../src/auth/rate-limiter";
import { computeHygieneRatios } from "../../src/memory/hygiene-ratios";
import { worldMemoryService } from "../../src/memory/world-service";
import type { MemoryRatio } from "../../src/net/memory-observability-types";
import { handleMemoryServiceApi } from "../../src/net/memory-service-api";
import { MarinaDB } from "../../src/persistence/database";
import {
  RELIABILITY_FLOOR,
  SYBIL_POOL_CAP,
  SYBIL_STANDING_FLOOR,
} from "../../src/persistence/db-memory-resolve";
import { COMPETING_RECORD_PREDICATE } from "../../src/persistence/db-memory-review";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";
import type { MemoryRecord } from "../../src/sdk/memory-types";
import { type Interval, stableHash, wilson95 } from "./genbench";

// ─── Public constants ───────────────────────────────────────────────────────

export const CONTRADICTION_RESULT_SCHEMA = "marina.memory.contradiction.v1" as const;
export const CONTRADICTION_KIND = "contradiction" as const;
export const CONTRADICTION_ARMS = [
  "last_writer_wins",
  "evidence_weighted",
  "await_confirmation",
  "keep_both",
] as const;
export type ContradictionArm = (typeof CONTRADICTION_ARMS)[number];
export const ASSERTION_ORDERS = ["random", "gold-first", "wrong-first"] as const;
export type AssertionOrder = (typeof ASSERTION_ORDERS)[number];

export const STEWARD_NAME = "Steward";
export const READER_NAME = "Reader";
export const SHARED_SPACE_NAME = "shared-facts";
/** Standing the steward (space owner) and the reader carry; neither writes assertions. */
export const STEWARD_STANDING = 50;
/** Established writers draw their standing from this pool — every value clears
 * `SYBIL_STANDING_FLOOR` and, at the floor of the pool, beats the whole Sybil
 * pool cap (0.05 + 0.95 · 0.15 = 0.1925 > 0.15). */
export const ESTABLISHED_STANDINGS = [15, 25, 40, 60] as const;
/** Bumped whenever the scenario generator or the measurement changes. */
export const CONTRADICTION_PROTOCOL_VERSION = "contradiction-v1:shared-space+4-policies";
/** How the harness reaches the service. The per-principal HTTP request budget
 * (100 burst / 25 s⁻¹) is a transport guard, not an operator semantic; the
 * steward's settle loop bursts past it, so the run adopts the `local` trust
 * posture `main.ts` applies for a loopback operator — `RateLimiter.bypass` —
 * and restores the prior value afterwards. */
export const CONTRADICTION_TRANSPORT =
  "MarinaMemoryClient→handleMemoryServiceApi(worldMemoryService(db)); RateLimiter.bypass=true (local posture)";

/** Assertion `valid_time.from` values are laid out on this virtual timeline;
 * readers ask "what is true now" at `READER_VALID_AT`, after every assertion. */
const VALID_FROM_BASE = 1_000_000;
const VALID_FROM_STEP = 1_000;
export const READER_VALID_AT = VALID_FROM_BASE + 1_000_000_000;

const SUBJECT_WORDS = [
  "harbor",
  "lantern",
  "orchard",
  "quarry",
  "meadow",
  "beacon",
  "cistern",
  "granary",
  "foundry",
  "atelier",
  "bastion",
  "causeway",
];
const PREDICATES = ["location", "owner", "codename", "maintainer", "port", "status"];
const VALUES = [
  "amber",
  "basalt",
  "cobalt",
  "damson",
  "ember",
  "fennel",
  "garnet",
  "heather",
  "indigo",
  "juniper",
  "kestrel",
  "lichen",
  "marigold",
  "nettle",
  "ochre",
  "pewter",
  "quince",
  "russet",
  "saffron",
  "teal",
  "umber",
  "vermilion",
  "willow",
  "zephyr",
];

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContradictionOptions {
  /** Number of seeds (≥1). Default 5. */
  seeds: number;
  seedStart?: number;
  /** Established writer accounts (≥2). Default 4. */
  writers?: number;
  /** Facts per seed (≥1). Default 40. */
  facts?: number;
  /** Share of facts that receive a conflicting wrong value. Default 0.5. */
  conflict?: number;
  /** Fresh (standing 0) accounts available to corroborate a wrong value. Default 3. */
  sybils?: number;
  /** Share of conflict facts that are Sybil attacks (rest: honest disagreement). Default 0.5. */
  sybilShare?: number;
  /** Established writers attach independent captured sources to the gold value. Default true. */
  sources?: boolean;
  /** An honestly-wrong established writer captures its OWN source for the wrong value. Default false. */
  wrongSources?: boolean;
  /** Write order of the gold and wrong assertions. Default `random`. */
  order?: AssertionOrder;
  /** Probability a third writer corroborates the gold value with its own assertion. Default 0.3. */
  corroboration?: number;
  /** Arms to run. Default: all four policies. */
  arms?: readonly ContradictionArm[];
  /** `""` disables writing result files. */
  resultsDir?: string;
  quiet?: boolean;
}

export interface WriterSpec {
  name: string;
  standing: number;
}

export interface SourceSpec {
  /** Account that captures the source. */
  by: string;
  text: string;
}

export interface AssertionSpec {
  writer: string;
  value: string;
  role: "gold" | "wrong" | "corroboration";
  sources: SourceSpec[];
}

export interface FactSpec {
  index: number;
  subject: string;
  predicate: string;
  gold: string;
  wrong: string | null;
  conflict: boolean;
  /** The wrong value is authored by a fresh account and corroborated by the other fresh accounts. */
  sybil: boolean;
  /** In write order. */
  assertions: AssertionSpec[];
}

export interface ContradictionScenario {
  seed: number;
  writers: WriterSpec[];
  sybils: string[];
  facts: FactSpec[];
}

export interface HygieneSnapshot {
  contradictionRate: MemoryRatio;
  unresolvedContradictionRate: MemoryRatio;
}

export interface FactOutcome {
  seed: number;
  arm: ContradictionArm;
  fact: number;
  subject: string;
  predicate: string;
  conflict: boolean;
  sybil: boolean;
  /** Distinct assertions written for the fact. */
  assertions: number;
  /** Value chosen by the policy; `null` for keep_both (no winner by design). */
  winner: string | null;
  winnerCorrect: boolean | null;
  /** Members whose current metadata carries `qualified_by` (keep_both). */
  peersMarked: number;
  /** Values the reader's temporal query (`valid_at: READER_VALID_AT`) returns, sorted. */
  servedValues: string[];
  servedWrong: boolean;
  servedAmbiguous: boolean;
  /** The temporal query returned a record that an applied resolution superseded. */
  unsafeServed: boolean;
  /** Lexical `search` for the fact returned a superseded record among its hits. */
  searchServesSuperseded: boolean;
}

export interface ContradictionSeedSummary {
  seed: number;
  arm: ContradictionArm;
  facts: number;
  conflictFacts: number;
  sybilFacts: number;
  records: number;
  /** Records satisfying COMPETING_RECORD_PREDICATE before / after the curator loop. */
  competingBefore: number;
  competingAfter: number;
  /** await_confirmation only: competing records after the gold-side `reaffirm`, before the settling resolve. */
  competingAfterConfirm: number | null;
  unresolvedRate: number | null;
  winnerCorrect: number;
  winnerJudged: number;
  sybilGoldWins: number;
  peersMarked: number;
  peersExpected: number;
  servedWrong: number;
  servedAmbiguous: number;
  unsafeServed: number;
  searchServesSuperseded: number;
  hygiene: { before: HygieneSnapshot; after: HygieneSnapshot };
  runtimeMs: number;
}

export interface RateMetric {
  numerator: number;
  denominator: number;
  pooled: number | null;
  wilson95: Interval;
  perSeed: (number | null)[];
  seedMean: number | null;
  /** 1.96 · sd / √k over seeds with a defined value; null with < 2 such seeds. */
  seedCi95: number | null;
}

export interface ContradictionArmMetrics {
  arm: ContradictionArm;
  seeds: number;
  facts: number;
  conflictFacts: number;
  sybilFacts: number;
  records: number;
  contradictions: { before: number; after: number; afterConfirm: number | null };
  unresolvedRate: RateMetric;
  winnerAccuracy: RateMetric;
  sybilGoldWinRate: RateMetric;
  servedWrong: RateMetric;
  servedAmbiguous: RateMetric;
  unsafeServed: RateMetric;
  searchServesSuperseded: RateMetric;
  peersMarked: RateMetric;
  hygiene: {
    before: { contradictionRate: number | null; unresolvedContradictionRate: number | null };
    after: { contradictionRate: number | null; unresolvedContradictionRate: number | null };
    /** Every seed's hygiene `unresolvedContradictionRate` after equals the benchmark's own count. */
    agrees: boolean;
  };
  runtimeMs: number;
}

export interface ContradictionConfig {
  kind: typeof CONTRADICTION_KIND;
  protocolVersion: string;
  transport: string;
  seeds: number[];
  writers: number;
  facts: number;
  conflict: number;
  sybils: number;
  sybilShare: number;
  sources: boolean;
  wrongSources: boolean;
  order: AssertionOrder;
  corroboration: number;
  arms: ContradictionArm[];
  policy: { reliabilityFloor: number; sybilStandingFloor: number; sybilPoolCap: number };
  establishedStandings: number[];
  harnessGitSha: string;
  offline: true;
  networkAttempts: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface ContradictionResult {
  schema: typeof CONTRADICTION_RESULT_SCHEMA;
  config: ContradictionConfig;
  arms: Partial<Record<ContradictionArm, ContradictionArmMetrics>>;
  perSeed: ContradictionSeedSummary[];
  facts: FactOutcome[];
}

export interface ContradictionReport {
  result: ContradictionResult;
  file: string | null;
  summaryPath: string | null;
  summaryMarkdown: string;
}

// ─── Deterministic scenario generator ───────────────────────────────────────

/** Counter-mode PRNG over genbench's `stableHash` — the same seed yields the same stream anywhere. */
export class SeededRng {
  private counter = 0;
  constructor(
    private readonly seed: number,
    private readonly salt: string,
  ) {}
  /** Uniform in [0, 1). */
  next(): number {
    return stableHash(`${this.seed}:${this.salt}:${this.counter++}`) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  /** Pick from `items` minus `exclude`; undefined when nothing remains. */
  pickExcluding<T>(items: readonly T[], exclude: readonly T[]): T | undefined {
    const pool = items.filter((item) => !exclude.includes(item));
    return pool.length ? this.pick(pool) : undefined;
  }
}

interface ResolvedOptions {
  seeds: number[];
  writers: number;
  facts: number;
  conflict: number;
  sybils: number;
  sybilShare: number;
  sources: boolean;
  wrongSources: boolean;
  order: AssertionOrder;
  corroboration: number;
  arms: ContradictionArm[];
  resultsDir: string;
  quiet: boolean;
}

const DEFAULT_RESULTS_DIR = join(import.meta.dir, "..", "results", "memory");

function resolveOptions(options: ContradictionOptions): ResolvedOptions {
  const share = (value: number | undefined, fallback: number, name: string) => {
    const v = value ?? fallback;
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`${name} must be within [0, 1]`);
    return v;
  };
  const writers = Math.floor(options.writers ?? 4);
  if (writers < 2) throw new Error("--writers must be at least 2 (a conflict needs two writers)");
  const facts = Math.floor(options.facts ?? 40);
  if (facts < 1) throw new Error("--facts must be at least 1");
  const sybils = Math.floor(options.sybils ?? 3);
  if (sybils < 0) throw new Error("--sybils must be >= 0");
  const order = options.order ?? "random";
  if (!ASSERTION_ORDERS.includes(order)) throw new Error(`unknown --order ${order}`);
  const arms = [...(options.arms ?? CONTRADICTION_ARMS)];
  for (const arm of arms)
    if (!CONTRADICTION_ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`);
  if (arms.length === 0) throw new Error("at least one arm is required");
  return {
    seeds: Array.from(
      { length: Math.max(1, Math.floor(options.seeds)) },
      (_, i) => (options.seedStart ?? 1) + i,
    ),
    writers,
    facts,
    conflict: share(options.conflict, 0.5, "--conflict"),
    sybils,
    sybilShare: share(options.sybilShare, 0.5, "--sybil-share"),
    sources: options.sources ?? true,
    wrongSources: options.wrongSources ?? false,
    order,
    corroboration: share(options.corroboration, 0.3, "--corroboration"),
    arms,
    resultsDir: options.resultsDir ?? DEFAULT_RESULTS_DIR,
    quiet: options.quiet ?? false,
  };
}

/**
 * Build one seed's scenario. Pure: no database, no clock. Each fact gets a gold
 * assertion from an established writer; a `conflict` share also gets a wrong
 * value from a DIFFERENT writer — either another established writer (honest
 * disagreement: an unsourced assertion, or one self-captured source when
 * `wrongSources` is on) or, for the
 * `sybilShare` of conflicts, a fresh account whose wrong record is corroborated
 * by copies of the same text captured by every other fresh account (the Sybil
 * attack). With `sources` on, the gold value carries 1–2 sources captured by
 * OTHER established writers — independent provenance, which is what
 * `evidence_weighted` is designed to weigh. A `corroboration` share adds a third
 * writer's own gold assertion (same value: never a contradiction with gold).
 */
export function generateScenario(
  seed: number,
  options: Pick<
    ResolvedOptions,
    | "writers"
    | "facts"
    | "conflict"
    | "sybils"
    | "sybilShare"
    | "sources"
    | "wrongSources"
    | "order"
    | "corroboration"
  >,
): ContradictionScenario {
  const rng = new SeededRng(seed, "scenario");
  const writers: WriterSpec[] = Array.from({ length: options.writers }, (_, i) => ({
    name: `Writer${i + 1}`,
    standing: ESTABLISHED_STANDINGS[(i + rng.int(ESTABLISHED_STANDINGS.length)) % 4]!,
  }));
  const writerNames = writers.map((w) => w.name);
  const sybils = Array.from({ length: options.sybils }, (_, i) => `Fresh${i + 1}`);
  const facts: FactSpec[] = [];
  for (let k = 0; k < options.facts; k++) {
    const subject = `${rng.pick(SUBJECT_WORDS)}${k + 1}`;
    const predicate = rng.pick(PREDICATES);
    const gold = rng.pick(VALUES);
    const goldWriter = rng.pick(writerNames);
    const conflict = rng.next() < options.conflict;
    const sybil = conflict && sybils.length > 0 && rng.next() < options.sybilShare;
    const wrong = conflict ? rng.pickExcluding(VALUES, [gold])! : null;
    const wrongWriter = !conflict
      ? null
      : sybil
        ? sybils[0]!
        : rng.pickExcluding(writerNames, [goldWriter])!;
    const source = (by: string, value: string, n: number): SourceSpec => ({
      by,
      text: `${subject} ${predicate} attested ${value} (${by} attestation ${n})`,
    });
    // Gold provenance: other established writers (never the wrong writer) capture
    // independent sources; with nobody else available the author captures its own.
    const goldSources: SourceSpec[] = [];
    if (options.sources) {
      const others = writerNames.filter((w) => w !== goldWriter && w !== wrongWriter);
      const wanted = Math.min(others.length, 1 + rng.int(2));
      for (let i = 0; i < wanted; i++) {
        const by = rng.pickExcluding(
          others,
          goldSources.map((s) => s.by),
        )!;
        goldSources.push(source(by, gold, i + 1));
      }
      if (goldSources.length === 0) goldSources.push(source(goldWriter, gold, 1));
    }
    const goldAssertion: AssertionSpec = {
      writer: goldWriter,
      value: gold,
      role: "gold",
      sources: goldSources,
    };
    const assertions: AssertionSpec[] = [goldAssertion];
    if (conflict && wrong && wrongWriter) {
      const wrongSources: SourceSpec[] = sybil
        ? // Copies: identical text (one content hash) captured by every other fresh account.
          sybils
            .filter((s) => s !== wrongWriter)
            .map((by) => ({ by, text: `${subject} ${predicate} is ${wrong} (forwarded)` }))
        : options.wrongSources
          ? [source(wrongWriter, wrong, 1)]
          : [];
      assertions.push({ writer: wrongWriter, value: wrong, role: "wrong", sources: wrongSources });
    }
    const corroborator =
      rng.next() < options.corroboration
        ? rng.pickExcluding(writerNames, [goldWriter, ...(wrongWriter ? [wrongWriter] : [])])
        : undefined;
    const corroboration: AssertionSpec | undefined = corroborator
      ? {
          writer: corroborator,
          value: gold,
          role: "corroboration",
          sources: options.sources ? [source(corroborator, gold, 9)] : [],
        }
      : undefined;
    facts.push({
      index: k,
      subject,
      predicate,
      gold,
      wrong,
      conflict,
      sybil,
      assertions: orderAssertions(assertions, corroboration, options.order, rng),
    });
  }
  return { seed, writers, sybils, facts };
}

/** `gold-first` puts the wrong value strictly last; `wrong-first` strictly first; `random` shuffles. */
function orderAssertions(
  base: AssertionSpec[],
  corroboration: AssertionSpec | undefined,
  order: AssertionOrder,
  rng: SeededRng,
): AssertionSpec[] {
  const gold = base.find((a) => a.role === "gold")!;
  const wrong = base.find((a) => a.role === "wrong");
  if (!wrong) return corroboration ? [gold, corroboration] : [gold];
  if (order === "gold-first") return corroboration ? [gold, corroboration, wrong] : [gold, wrong];
  if (order === "wrong-first") return corroboration ? [wrong, gold, corroboration] : [wrong, gold];
  const pair = rng.next() < 0.5 ? [gold, wrong] : [wrong, gold];
  if (!corroboration) return pair;
  const at = rng.int(3);
  return [...pair.slice(0, at), corroboration, ...pair.slice(at)];
}

// ─── Fixture over the real durable service ──────────────────────────────────

interface Account {
  name: string;
  principalId: string;
  client: MarinaMemoryClient;
}

interface WrittenRecord {
  id: string;
  fact: number;
  value: string;
  role: AssertionSpec["role"];
  writer: string;
}

interface Fixture {
  db: MarinaDB;
  dir: string;
  space: string;
  steward: Account;
  reader: Account;
  records: WrittenRecord[];
  close(): void;
}

/** World account bound the way `residentMemoryOperation` binds: `users.id` is the
 * human principal id, standing lives under that id, the credential is the
 * service's own. */
function makeAccount(db: MarinaDB, name: string, standing: number): Account {
  const principalId = `u_${name.toLowerCase()}`;
  db.createUser({ id: principalId, name });
  if (standing > 0) db.setStandingCache(principalId, standing, Date.now());
  const credential = db.issueMemoryCredential(principalId);
  const service = worldMemoryService(db, {});
  const client = new MarinaMemoryClient("http://marina.internal", credential.token, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  return { name, principalId, client };
}

async function buildFixture(scenario: ContradictionScenario, label: string): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), `contradiction-${label}-`));
  const db = new MarinaDB(join(dir, "world.db"));
  const close = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const steward = makeAccount(db, STEWARD_NAME, STEWARD_STANDING);
    const reader = makeAccount(db, READER_NAME, 0);
    const accounts = new Map<string, Account>();
    for (const writer of scenario.writers)
      accounts.set(writer.name, makeAccount(db, writer.name, writer.standing));
    for (const name of scenario.sybils) accounts.set(name, makeAccount(db, name, 0));
    const space = (await steward.client.createSpace(SHARED_SPACE_NAME, "space-shared")).id;
    for (const [name, account] of accounts)
      await steward.client.grant(space, account.principalId, "writer", `grant-${name}`);
    await steward.client.grant(space, reader.principalId, "reader", "grant-reader");

    const records: WrittenRecord[] = [];
    let tick = 0;
    for (const fact of scenario.facts) {
      for (const assertion of fact.assertions) {
        const sourceIds: string[] = [];
        for (const [i, source] of assertion.sources.entries()) {
          const capturer = accounts.get(source.by)!;
          const receipt = await capturer.client.capture(
            space,
            { doc: source.text },
            undefined,
            `src-${fact.index}-${assertion.role}-${i}`,
          );
          sourceIds.push(receipt.id);
        }
        const writer = accounts.get(assertion.writer)!;
        const from = VALID_FROM_BASE + tick++ * VALID_FROM_STEP;
        const receipt = await writer.client.remember(
          space,
          {
            content: `${fact.subject} ${fact.predicate} is ${assertion.value}`,
            type: "fact",
            subject: fact.subject,
            claim: {
              subject: fact.subject,
              predicate: fact.predicate,
              object: { kind: "literal", value: assertion.value },
            },
            valid_time: { from, until: null },
            ...(sourceIds.length ? { source_ids: sourceIds } : {}),
          },
          `rec-${fact.index}-${assertion.role}`,
        );
        records.push({
          id: receipt.id,
          fact: fact.index,
          value: assertion.value,
          role: assertion.role,
          writer: assertion.writer,
        });
      }
    }
    return { db, dir, space, steward, reader, records, close };
  } catch (error) {
    close();
    throw error;
  }
}

// ─── Measurement ────────────────────────────────────────────────────────────

const COMPETING_COUNT_SQL = `SELECT count(*) AS n FROM memory_records r
  WHERE r.space_id=? AND r.status='active' AND ${COMPETING_RECORD_PREDICATE}`;
const SUPERSEDED_MEMBER_SQL = `SELECT 1 FROM memory_resolution_members m
  JOIN memory_resolutions x ON x.id=m.resolution_id
  WHERE m.record_id=? AND m.role='superseded' AND m.retired_at IS NULL AND x.status='applied' LIMIT 1`;

/** Records in `space` that currently satisfy `review kind:competing`'s predicate. */
export function countCompeting(db: MarinaDB, space: string): number {
  const raw = db.memoryRepository().raw;
  return (raw.query(COMPETING_COUNT_SQL).get(space) as { n: number }).n;
}

function isSupersededMember(db: MarinaDB, recordId: string): boolean {
  return db.memoryRepository().raw.query(SUPERSEDED_MEMBER_SQL).get(recordId) !== null;
}

export function hygieneSnapshot(db: MarinaDB): HygieneSnapshot {
  const ratios = computeHygieneRatios(
    db.memoryRepository().raw,
    { privileged: true },
    { receipts: [], cache: { hits: 0, misses: 0 }, leakage: { crossScopeAttempts: 0 } },
  );
  return {
    contradictionRate: ratios.contradictionRate,
    unresolvedContradictionRate: ratios.unresolvedContradictionRate,
  };
}

const claimValue = (record: MemoryRecord): string | null => {
  const object = record.claim?.object;
  return object && object.kind === "literal" ? String(object.value) : null;
};

/** The set the steward resolves for one fact: head = the fact's first gold-valued
 * record (the policies never look at which member is the head), competing = the rest. */
function resolutionSet(fact: FactSpec, members: WrittenRecord[]) {
  const head = members.find((m) => m.role === "gold") ?? members[0]!;
  return {
    head,
    competing: members.filter((m) => m.id !== head.id).map((m) => m.id),
    key: (step: string) => `resolve-${fact.index}-${step}`,
    rationale: (arm: string) => `benchmark ${arm} on ${fact.subject}/${fact.predicate}`,
  };
}

/** One definitive policy call as the steward; returns the winner record id (null for keep_both). */
async function settle(
  fixture: Fixture,
  policy: "last_writer_wins" | "evidence_weighted" | "keep_both",
  fact: FactSpec,
  members: WrittenRecord[],
  step: string = policy,
): Promise<string | null> {
  const set = resolutionSet(fact, members);
  const result = await fixture.steward.client.resolve(
    fixture.space,
    set.head.id,
    { policy, competing: set.competing, rationale: set.rationale(step) },
    set.key(step),
  );
  return result.winner;
}

/**
 * `await_confirmation`, first half of the review → reaffirm → resolve loop: the
 * steward defers the set, then confirms the gold side with `reaffirm` — a
 * reviewed revision that lifts the pending set AND makes that assertion the
 * most recently revised. Confirmation alone does not close the contradiction in
 * the review index (the caller measures that), so the loop is finished by
 * `settle(..., "last_writer_wins")`, which the confirmation has just steered.
 */
async function deferAndConfirm(
  fixture: Fixture,
  fact: FactSpec,
  members: WrittenRecord[],
): Promise<void> {
  const set = resolutionSet(fact, members);
  await fixture.steward.client.resolve(
    fixture.space,
    set.head.id,
    {
      policy: "await_confirmation",
      competing: set.competing,
      rationale: set.rationale("await_confirmation"),
    },
    set.key("await"),
  );
  const current = await fixture.steward.client.get(fixture.space, set.head.id);
  await fixture.steward.client.reaffirm(
    fixture.space,
    set.head.id,
    current.version,
    {},
    undefined,
    set.key("confirm"),
  );
}

async function runArm(
  scenario: ContradictionScenario,
  arm: ContradictionArm,
): Promise<{ summary: ContradictionSeedSummary; outcomes: FactOutcome[] }> {
  const t0 = performance.now();
  const fixture = await buildFixture(scenario, `${arm}-${scenario.seed}`);
  try {
    const byFact = new Map<number, WrittenRecord[]>();
    for (const record of fixture.records) {
      const list = byFact.get(record.fact) ?? [];
      list.push(record);
      byFact.set(record.fact, list);
    }
    const byId = new Map(fixture.records.map((r) => [r.id, r]));

    // Phase 1 — before: contradictions exist by construction.
    const competingBefore = countCompeting(fixture.db, fixture.space);
    const hygieneBefore = hygieneSnapshot(fixture.db);

    // Phase 2 — deterministic curator loop over every conflicted fact.
    const conflictedFacts = scenario.facts.filter((fact) => fact.conflict);
    const winners = new Map<number, string | null>();
    let competingAfterConfirm: number | null = null;
    if (arm === "await_confirmation") {
      // Two passes so the "after confirmation, before settling" count is one
      // clean measurement over the whole space rather than a per-fact snapshot.
      for (const fact of conflictedFacts)
        await deferAndConfirm(fixture, fact, byFact.get(fact.index)!);
      competingAfterConfirm = countCompeting(fixture.db, fixture.space);
      for (const fact of conflictedFacts)
        winners.set(
          fact.index,
          await settle(fixture, "last_writer_wins", fact, byFact.get(fact.index)!, "settle"),
        );
    } else {
      for (const fact of conflictedFacts)
        winners.set(fact.index, await settle(fixture, arm, fact, byFact.get(fact.index)!));
    }
    const competingAfter = countCompeting(fixture.db, fixture.space);
    const hygieneAfter = hygieneSnapshot(fixture.db);

    // Phase 3 — what a reader is served.
    const outcomes: FactOutcome[] = [];
    for (const fact of scenario.facts) {
      const members = byFact.get(fact.index)!;
      const winnerId = winners.get(fact.index) ?? null;
      const winner = winnerId ? (byId.get(winnerId)?.value ?? null) : null;
      let peersMarked = 0;
      if (arm === "keep_both" && fact.conflict) {
        for (const member of members) {
          const record = await fixture.steward.client.get(fixture.space, member.id);
          if (record.metadata.qualified_by !== undefined) peersMarked++;
        }
      }
      const served = await fixture.reader.client.query(fixture.space, {
        subject: fact.subject,
        predicate: fact.predicate,
        valid_at: READER_VALID_AT,
        limit: 50,
      });
      const servedValues = [
        ...new Set(served.results.map(claimValue).filter((v): v is string => !!v)),
      ].sort();
      const unsafeServed = served.results.some((r) => isSupersededMember(fixture.db, r.id));
      const hits = await fixture.reader.client.search(fixture.space, {
        query: `${fact.subject} ${fact.predicate}`,
        subject: fact.subject,
        limit: 10,
      });
      const searchServesSuperseded = hits.results.some((r) => isSupersededMember(fixture.db, r.id));
      outcomes.push({
        seed: scenario.seed,
        arm,
        fact: fact.index,
        subject: fact.subject,
        predicate: fact.predicate,
        conflict: fact.conflict,
        sybil: fact.sybil,
        assertions: fact.assertions.length,
        winner,
        winnerCorrect: fact.conflict && arm !== "keep_both" ? winner === fact.gold : null,
        peersMarked,
        servedValues,
        servedWrong: servedValues.some((v) => v !== fact.gold),
        servedAmbiguous: servedValues.length > 1,
        unsafeServed,
        searchServesSuperseded,
      });
    }
    const conflicted = outcomes.filter((o) => o.conflict);
    const judged = conflicted.filter((o) => o.winnerCorrect !== null);
    const sybilFacts = conflicted.filter((o) => o.sybil);
    const summary: ContradictionSeedSummary = {
      seed: scenario.seed,
      arm,
      facts: scenario.facts.length,
      conflictFacts: conflicted.length,
      sybilFacts: sybilFacts.length,
      records: fixture.records.length,
      competingBefore,
      competingAfter,
      competingAfterConfirm,
      unresolvedRate: competingBefore > 0 ? competingAfter / competingBefore : null,
      winnerCorrect: judged.filter((o) => o.winnerCorrect === true).length,
      winnerJudged: judged.length,
      sybilGoldWins: sybilFacts.filter((o) => o.winnerCorrect === true).length,
      peersMarked: conflicted.reduce((n, o) => n + o.peersMarked, 0),
      peersExpected:
        arm === "keep_both" ? conflicted.reduce((n, o) => n + byFact.get(o.fact)!.length, 0) : 0,
      servedWrong: outcomes.filter((o) => o.servedWrong).length,
      servedAmbiguous: outcomes.filter((o) => o.servedAmbiguous).length,
      unsafeServed: outcomes.filter((o) => o.unsafeServed).length,
      searchServesSuperseded: outcomes.filter((o) => o.searchServesSuperseded).length,
      hygiene: { before: hygieneBefore, after: hygieneAfter },
      runtimeMs: performance.now() - t0,
    };
    return { summary, outcomes };
  } finally {
    fixture.close();
  }
}

// ─── Aggregation ────────────────────────────────────────────────────────────

function rate(pairs: { numerator: number; denominator: number }[]): RateMetric {
  const numerator = pairs.reduce((n, p) => n + p.numerator, 0);
  const denominator = pairs.reduce((n, p) => n + p.denominator, 0);
  const perSeed = pairs.map((p) => (p.denominator > 0 ? p.numerator / p.denominator : null));
  const defined = perSeed.filter((v): v is number => v !== null);
  const seedMean = defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : null;
  let seedCi95: number | null = null;
  if (seedMean !== null && defined.length >= 2) {
    const variance =
      defined.reduce((sum, v) => sum + (v - seedMean) ** 2, 0) / (defined.length - 1);
    seedCi95 = (1.959963984540054 * Math.sqrt(variance)) / Math.sqrt(defined.length);
  }
  return {
    numerator,
    denominator,
    pooled: denominator > 0 ? numerator / denominator : null,
    wilson95: wilson95(numerator, denominator),
    perSeed,
    seedMean,
    seedCi95,
  };
}

const meanRatio = (ratios: MemoryRatio[]): number | null => {
  const defined = ratios.map((r) => r.value).filter((v): v is number => v !== null);
  return defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : null;
};

export function summarizeArm(
  arm: ContradictionArm,
  seeds: ContradictionSeedSummary[],
): ContradictionArmMetrics {
  const sum = (pick: (s: ContradictionSeedSummary) => number) =>
    seeds.reduce((n, s) => n + pick(s), 0);
  const confirm = seeds.map((s) => s.competingAfterConfirm);
  const agrees = seeds.every((s) => {
    const after = s.hygiene.after.unresolvedContradictionRate;
    const before = s.hygiene.before.unresolvedContradictionRate;
    const beforeOk = s.competingBefore === 0 ? before.value === null : before.value === 1;
    return beforeOk && after.numerator === s.competingAfter && after.value === s.unresolvedRate;
  });
  return {
    arm,
    seeds: seeds.length,
    facts: sum((s) => s.facts),
    conflictFacts: sum((s) => s.conflictFacts),
    sybilFacts: sum((s) => s.sybilFacts),
    records: sum((s) => s.records),
    contradictions: {
      before: sum((s) => s.competingBefore),
      after: sum((s) => s.competingAfter),
      afterConfirm: confirm.every((v) => v === null)
        ? null
        : confirm.reduce<number>((n, v) => n + (v ?? 0), 0),
    },
    unresolvedRate: rate(
      seeds.map((s) => ({ numerator: s.competingAfter, denominator: s.competingBefore })),
    ),
    winnerAccuracy: rate(
      seeds.map((s) => ({ numerator: s.winnerCorrect, denominator: s.winnerJudged })),
    ),
    sybilGoldWinRate: rate(
      seeds.map((s) => ({
        numerator: s.sybilGoldWins,
        denominator: arm === "keep_both" ? 0 : s.sybilFacts,
      })),
    ),
    servedWrong: rate(seeds.map((s) => ({ numerator: s.servedWrong, denominator: s.facts }))),
    servedAmbiguous: rate(
      seeds.map((s) => ({ numerator: s.servedAmbiguous, denominator: s.facts })),
    ),
    unsafeServed: rate(seeds.map((s) => ({ numerator: s.unsafeServed, denominator: s.facts }))),
    searchServesSuperseded: rate(
      seeds.map((s) => ({ numerator: s.searchServesSuperseded, denominator: s.facts })),
    ),
    peersMarked: rate(
      seeds.map((s) => ({ numerator: s.peersMarked, denominator: s.peersExpected })),
    ),
    hygiene: {
      before: {
        contradictionRate: meanRatio(seeds.map((s) => s.hygiene.before.contradictionRate)),
        unresolvedContradictionRate: meanRatio(
          seeds.map((s) => s.hygiene.before.unresolvedContradictionRate),
        ),
      },
      after: {
        contradictionRate: meanRatio(seeds.map((s) => s.hygiene.after.contradictionRate)),
        unresolvedContradictionRate: meanRatio(
          seeds.map((s) => s.hygiene.after.unresolvedContradictionRate),
        ),
      },
      agrees,
    },
    runtimeMs: sum((s) => s.runtimeMs),
  };
}

// ─── Output ─────────────────────────────────────────────────────────────────

const fmtPct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const fmtCi = (ci: Interval) => `[${fmtPct(ci.low)}, ${fmtPct(ci.high)}]`;
const fmtRate = (m: RateMetric) =>
  m.denominator === 0
    ? "n/a"
    : `${fmtPct(m.pooled)} ${fmtCi(m.wilson95)} (${m.numerator}/${m.denominator})`;
const fmtSeed = (m: RateMetric) =>
  m.seedMean === null
    ? "n/a"
    : m.seedCi95 === null
      ? fmtPct(m.seedMean)
      : `${fmtPct(m.seedMean)} ± ${fmtPct(m.seedCi95)}`;

export function renderContradictionMarkdown(result: ContradictionResult): string {
  const c = result.config;
  const lines = [
    "# contradiction — multi-writer contradiction benchmark (offline, deterministic)",
    "",
    `seeds=${c.seeds.join(",")} · writers=${c.writers} · facts/seed=${c.facts} · conflict=${c.conflict} · sybils=${c.sybils} (share ${c.sybilShare}) · sources=${c.sources} · wrong-sources=${c.wrongSources} · order=${c.order} · corroboration=${c.corroboration} · harness=${c.harnessGitSha.slice(0, 12)} · protocol=${c.protocolVersion}`,
    "",
    `Sybil rule in force: reliability floor ${c.policy.reliabilityFloor}, fresh below standing ${c.policy.sybilStandingFloor}, pool cap ${c.policy.sybilPoolCap}. Established writers draw standing from {${c.establishedStandings.join(", ")}}.`,
    "",
    "| Arm | Conflict facts | Contradictions before → after | Unresolved rate | Winner accuracy [Wilson] | seed mean ± CI | Sybil facts: gold wins | Served wrong | Served ambiguous | Unsafe served (temporal query) | Search serves superseded | Hygiene agrees | Runtime |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const arm of CONTRADICTION_ARMS) {
    const m = result.arms[arm];
    if (!m) continue;
    const afterConfirm =
      m.contradictions.afterConfirm === null
        ? ""
        : ` (after confirm ${m.contradictions.afterConfirm})`;
    lines.push(
      `| ${arm} | ${m.conflictFacts}/${m.facts} | ${m.contradictions.before} → ${m.contradictions.after}${afterConfirm} | ${fmtRate(m.unresolvedRate)} | ${fmtRate(m.winnerAccuracy)} | ${fmtSeed(m.winnerAccuracy)} | ${fmtRate(m.sybilGoldWinRate)} | ${fmtRate(m.servedWrong)} | ${fmtRate(m.servedAmbiguous)} | ${fmtRate(m.unsafeServed)} | ${fmtRate(m.searchServesSuperseded)} | ${m.hygiene.agrees ? "yes" : "NO"} | ${(m.runtimeMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push(
    "",
    "## Hygiene ratios (computeHygieneRatios, operator scope, mean over seeds)",
    "",
    "| Arm | contradictionRate before | unresolved before | contradictionRate after | unresolved after |",
    "|---|---|---|---|---|",
  );
  for (const arm of CONTRADICTION_ARMS) {
    const m = result.arms[arm];
    if (!m) continue;
    lines.push(
      `| ${arm} | ${fmtPct(m.hygiene.before.contradictionRate)} | ${fmtPct(m.hygiene.before.unresolvedContradictionRate)} | ${fmtPct(m.hygiene.after.contradictionRate)} | ${fmtPct(m.hygiene.after.unresolvedContradictionRate)} |`,
    );
  }
  const keepBoth = result.arms.keep_both;
  lines.push(
    "",
    "Reading guide. *Unresolved rate* = records still satisfying `review kind:competing` after the loop / before it. *Winner accuracy* is judged on conflicted facts only (keep_both names no winner by design" +
      (keepBoth
        ? `; it marked ${fmtRate(keepBoth.peersMarked)} of the peers \`qualified_by\``
        : "") +
      "). *Served wrong* = the reader's temporal query (`valid_at` after every assertion) still returns a non-gold value as current; *ambiguous* = more than one current value. *Unsafe served* = that query returned a record an applied resolution superseded (the validity-closure invariant; expected 0). *Search serves superseded* = lexical `search` for the fact still lists a superseded record among its hits — `search` is not validity-filtered, so a caller must consult `metadata.resolution` / `valid_time` before citing.",
    "",
    "Policies are deterministic and no model is called: these are measurements of the operators over a synthetic multi-writer scenario, not evidence about any model's curation.",
  );
  return `${lines.join("\n")}\n`;
}

/** Structural validation of a result. Returns a list of problems (empty = valid). */
export function validateContradictionResult(value: unknown): string[] {
  const problems: string[] = [];
  const v = value as Partial<ContradictionResult> | null;
  if (!v || typeof v !== "object") return ["not an object"];
  if (v.schema !== CONTRADICTION_RESULT_SCHEMA)
    problems.push(`schema != ${CONTRADICTION_RESULT_SCHEMA}`);
  const c = v.config;
  if (!c) problems.push("missing config");
  else {
    if (c.kind !== CONTRADICTION_KIND) problems.push(`config.kind != ${CONTRADICTION_KIND}`);
    for (const key of [
      "protocolVersion",
      "transport",
      "harnessGitSha",
      "startedAt",
      "finishedAt",
    ] as const)
      if (typeof c[key] !== "string") problems.push(`config.${key} must be a string`);
    for (const key of [
      "writers",
      "facts",
      "conflict",
      "sybils",
      "sybilShare",
      "corroboration",
      "networkAttempts",
      "durationMs",
    ] as const)
      if (typeof c[key] !== "number") problems.push(`config.${key} must be a number`);
    if (!Array.isArray(c.seeds) || c.seeds.length === 0)
      problems.push("config.seeds must be non-empty");
    if (!Array.isArray(c.arms) || c.arms.length === 0)
      problems.push("config.arms must be non-empty");
    if (c.offline !== true) problems.push("config.offline must be true");
    if (typeof c.sources !== "boolean") problems.push("config.sources must be boolean");
    if (typeof c.wrongSources !== "boolean") problems.push("config.wrongSources must be boolean");
    if (!c.policy || typeof c.policy.sybilPoolCap !== "number")
      problems.push("config.policy missing");
  }
  if (!v.arms || typeof v.arms !== "object") problems.push("missing arms");
  else {
    for (const arm of c?.arms ?? []) {
      const m = v.arms[arm];
      if (!m) {
        problems.push(`missing arms.${arm}`);
        continue;
      }
      for (const key of [
        "unresolvedRate",
        "winnerAccuracy",
        "sybilGoldWinRate",
        "servedWrong",
        "servedAmbiguous",
        "unsafeServed",
        "searchServesSuperseded",
        "peersMarked",
      ] as const) {
        const metric = m[key];
        if (!metric?.wilson95 || !Array.isArray(metric.perSeed))
          problems.push(`arms.${arm}.${key} malformed`);
      }
      if (!m.contradictions || typeof m.contradictions.before !== "number")
        problems.push(`arms.${arm}.contradictions malformed`);
      if (!m.hygiene || typeof m.hygiene.agrees !== "boolean")
        problems.push(`arms.${arm}.hygiene malformed`);
    }
  }
  if (!Array.isArray(v.perSeed)) problems.push("perSeed must be an array");
  if (!Array.isArray(v.facts)) problems.push("facts must be an array");
  return problems;
}

/** The result with every run-specific field removed — identical across runs of one seed set. */
export function stripVolatile(result: ContradictionResult): unknown {
  const {
    startedAt: _s,
    finishedAt: _f,
    durationMs: _d,
    harnessGitSha: _g,
    ...config
  } = result.config;
  const arms = Object.fromEntries(
    Object.entries(result.arms).map(([arm, m]) => {
      const { runtimeMs: _r, ...rest } = m!;
      return [arm, rest];
    }),
  );
  const perSeed = result.perSeed.map(({ runtimeMs: _r, ...rest }) => rest);
  return { schema: result.schema, config, arms, perSeed, facts: result.facts };
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
function freshPath(dir: string, base: string, ext: string): string {
  let candidate = join(dir, `${base}${ext}`);
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${base}-${i}${ext}`);
  return candidate;
}
function gitSha(): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "ignore",
    });
    const sha = proc.stdout.toString().trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}
/** The benchmark never needs the network; refuse it loudly and count attempts. */
function installOfflineGuard(): { attempts: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let attempts = 0;
  const refuse = async (input: RequestInfo | URL) => {
    attempts++;
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`contradiction benchmark is offline; refused network access to ${target}`);
  };
  globalThis.fetch = Object.assign(refuse, { preconnect: original.preconnect }) as typeof fetch;
  return {
    attempts: () => attempts,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

/** Run the whole protocol. Writes one JSON + one markdown summary (never overwriting). */
export async function runContradictionBenchmark(
  options: ContradictionOptions,
): Promise<ContradictionReport> {
  const r = resolveOptions(options);
  const guard = installOfflineGuard();
  const priorBypass = RateLimiter.bypass;
  RateLimiter.bypass = true;
  const log = (line: string) => {
    if (!r.quiet) console.log(line);
  };
  try {
    const startedAt = new Date();
    const t0 = performance.now();
    log(
      `contradiction · seeds=${r.seeds.join(",")} · writers=${r.writers} · facts=${r.facts} · conflict=${r.conflict} · sybils=${r.sybils}/${r.sybilShare} · sources=${r.sources} · wrong-sources=${r.wrongSources} · order=${r.order} · arms=${r.arms.join(",")}`,
    );
    const perSeed: ContradictionSeedSummary[] = [];
    const facts: FactOutcome[] = [];
    for (const seed of r.seeds) {
      const scenario = generateScenario(seed, r);
      for (const arm of r.arms) {
        const out = await runArm(scenario, arm);
        perSeed.push(out.summary);
        facts.push(...out.outcomes);
        const s = out.summary;
        log(
          `  seed ${seed} ${arm.padEnd(18)} competing ${s.competingBefore}→${s.competingAfter} · winner ${s.winnerCorrect}/${s.winnerJudged} · sybil gold ${s.sybilGoldWins}/${s.sybilFacts} · served wrong ${s.servedWrong}/${s.facts} · unsafe ${s.unsafeServed} · search superseded ${s.searchServesSuperseded} · ${(s.runtimeMs / 1000).toFixed(1)}s`,
        );
      }
    }
    const arms = Object.fromEntries(
      r.arms.map((arm) => [
        arm,
        summarizeArm(
          arm,
          perSeed.filter((s) => s.arm === arm),
        ),
      ]),
    ) as Partial<Record<ContradictionArm, ContradictionArmMetrics>>;
    const finishedAt = new Date();
    const result: ContradictionResult = {
      schema: CONTRADICTION_RESULT_SCHEMA,
      config: {
        kind: CONTRADICTION_KIND,
        protocolVersion: CONTRADICTION_PROTOCOL_VERSION,
        transport: CONTRADICTION_TRANSPORT,
        seeds: r.seeds,
        writers: r.writers,
        facts: r.facts,
        conflict: r.conflict,
        sybils: r.sybils,
        sybilShare: r.sybilShare,
        sources: r.sources,
        wrongSources: r.wrongSources,
        order: r.order,
        corroboration: r.corroboration,
        arms: r.arms,
        policy: {
          reliabilityFloor: RELIABILITY_FLOOR,
          sybilStandingFloor: SYBIL_STANDING_FLOOR,
          sybilPoolCap: SYBIL_POOL_CAP,
        },
        establishedStandings: [...ESTABLISHED_STANDINGS],
        harnessGitSha: gitSha(),
        offline: true,
        networkAttempts: guard.attempts(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: performance.now() - t0,
      },
      arms,
      perSeed,
      facts,
    };
    const summaryMarkdown = renderContradictionMarkdown(result);
    let file: string | null = null;
    let summaryPath: string | null = null;
    if (options.resultsDir !== "") {
      mkdirSync(r.resultsDir, { recursive: true });
      const stamp = timestamp(startedAt);
      file = freshPath(r.resultsDir, `${stamp}-contradiction`, ".json");
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      summaryPath = freshPath(r.resultsDir, `${stamp}-contradiction-summary`, ".md");
      writeFileSync(summaryPath, summaryMarkdown);
    }
    log(`\n${summaryMarkdown}`);
    return { result, file, summaryPath, summaryMarkdown };
  } finally {
    RateLimiter.bypass = priorBypass;
    guard.restore();
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `contradiction — Marina multi-writer contradiction benchmark (offline, deterministic)

Usage:
  bun --env-file=/dev/null run benchmarks/memory/contradiction.ts [options]

Options:
  --seeds <n>             number of seeds (default 5)
  --seed-start <n>        first seed (default 1)
  --writers <n>           established writer accounts, standing >= ${SYBIL_STANDING_FLOOR} (default 4, min 2)
  --facts <n>             facts per seed (default 40)
  --conflict <f>          share of facts that get a conflicting wrong value (default 0.5)
  --sybils <n>            fresh standing-0 accounts corroborating wrong values with copied sources (default 3)
  --sybil-share <f>       share of conflicts that are Sybil attacks rather than honest disagreement (default 0.5)
  --no-sources            established writers do NOT attach independent sources to the gold value
  --wrong-sources         an honestly-wrong established writer captures its OWN source for the wrong value
                          (default off: an honest mistake is an unsourced assertion)
  --order <o>             random (default) | gold-first (wrong value written last) | wrong-first
  --corroboration <f>     probability a third writer re-asserts the gold value (default 0.3)
  --arms <list>           comma-separated subset of: ${CONTRADICTION_ARMS.join(", ")}
  --results-dir <dir>     default benchmarks/results/memory (gitignored); "" writes nothing
  --quiet
  --help
`;

export async function runCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      seeds: { type: "string", default: "5" },
      "seed-start": { type: "string", default: "1" },
      writers: { type: "string", default: "4" },
      facts: { type: "string", default: "40" },
      conflict: { type: "string", default: "0.5" },
      sybils: { type: "string", default: "3" },
      "sybil-share": { type: "string", default: "0.5" },
      "no-sources": { type: "boolean", default: false },
      "wrong-sources": { type: "boolean", default: false },
      order: { type: "string", default: "random" },
      corroboration: { type: "string", default: "0.3" },
      arms: { type: "string" },
      "results-dir": { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const report = await runContradictionBenchmark({
    seeds: Number(values.seeds ?? "5"),
    seedStart: Number(values["seed-start"] ?? "1"),
    writers: Number(values.writers ?? "4"),
    facts: Number(values.facts ?? "40"),
    conflict: Number(values.conflict ?? "0.5"),
    sybils: Number(values.sybils ?? "3"),
    sybilShare: Number(values["sybil-share"] ?? "0.5"),
    sources: !values["no-sources"],
    wrongSources: values["wrong-sources"],
    order: values.order as AssertionOrder,
    corroboration: Number(values.corroboration ?? "0.3"),
    arms: values.arms
      ? (values.arms.split(",").map((a) => a.trim()) as ContradictionArm[])
      : undefined,
    resultsDir: values["results-dir"],
    quiet: values.quiet,
  });
  return Object.values(report.result.arms).every((m) => m?.hygiene.agrees) ? 0 : 1;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`contradiction failed: ${error instanceof Error ? error.message : error}`);
      process.exit(2);
    },
  );
}
