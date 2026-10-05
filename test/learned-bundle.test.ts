// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina.learned.v1` (src/learned/): signing against pinned keys, tamper and
 * unpinned-key refusal, the export allow-list, secret / instance / name /
 * benchmark-text scans (drop, never redact), the `imported` trust level,
 * empty-slot-only default seeding, priors that are never ledger rows,
 * prefixed create-only roles, revocations, diffs, lineage and downgrades.
 */

import { afterAll, afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRoleBundle, exportRoleBundle } from "../src/agent/role-bundle";
import type { AdoptionOffer } from "../src/engine/commands/evolve";
import { learnedCommand } from "../src/engine/commands/learned";
import { RETENTION_POLICIES } from "../src/engine/retention";
import { signRevocations, verifyBundle } from "../src/learned/bundle";
import { ownBundleGrant } from "../src/learned/entitlement";
import { exportLearnedBundle } from "../src/learned/export";
import {
  diffItems,
  type LearnedItem,
  type Manifest,
  OPEN_LICENSE,
  REVOCATIONS_SCHEMA,
  sha256Hex,
} from "../src/learned/format";
import {
  confirmImportedLesson,
  IMPORTED_TRUST,
  importLearnedBundle,
  PRIOR_WEIGHT,
  UPSTREAM_ACCOUNT,
} from "../src/learned/import";
import { BenchmarkTextIndex, Scanner } from "../src/learned/scan";
import { generateLearnedKeyPair, type PinnedKey, parsePinnedKeys } from "../src/learned/sign";
import { upstreamSeedFor } from "../src/learned/upstream-seed";
import type { Lesson } from "../src/learning/outcomes";
import {
  findLessons,
  LESSONS_ACCOUNT,
  lessonSinkFor,
  recallLessons,
  retireLessons,
} from "../src/learning/service";
import { ratifyPoolNote } from "../src/memory/institutional";
import { keyIdOfPublicKey } from "../src/net/federation-crypto";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { approveAdoption, requestAdoption } from "../src/world/adoption";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const dbs: MarinaDB[] = [];
function freshDb(): MarinaDB {
  const db = new MarinaDB(join(tmp("learned-db-"), "m.db"));
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// Every fixture writes through the canonical memory service: give slow CI room.
setDefaultTimeout(30_000);

const KEY = generateLearnedKeyPair();
const OTHER = generateLearnedKeyPair();
const pin = (k: { publicKey: string }): PinnedKey[] => [
  { label: "test", publicKey: k.publicKey, keyId: keyIdOfPublicKey(k.publicKey) },
];
const ON = { MARINA_UPSTREAM: "on" } as NodeJS.ProcessEnv;
/** These tests move the publisher's own private pack between its worlds (internal profile). */
const OWN = ownBundleGrant("operator");

const lesson = (domain: Lesson["domain"], text: string, over: Partial<Lesson> = {}): Lesson => ({
  domain,
  text,
  kind: "failure",
  trust: "trusted",
  score: 0.8,
  judge: "typesafe/jev-1.13",
  resolvedAt: "2026-09-01T00:00:00.000Z",
  source: `${domain}:test`,
  refs: ["bench:run-1"],
  ...over,
});

function ledgerRun(db: MarinaDB, id: string, items: number, correct: number) {
  db.recordBenchmarkLedgerRun(
    {
      id,
      benchmark: "synthetic",
      config_hash: id,
      config_json: "{}",
      started_at: 0,
      completed_at: 1,
      duration_ms: 1,
      score: correct / items,
      answered: items,
      total: items,
      cost_usd: null,
      n: items,
      ci_low: 0,
      ci_high: 1,
      seed: null,
      slice_hash: `slice-${id}`,
      judge: null,
      target_kind: "model",
      target_json: JSON.stringify({ model: `vendor/model-${id.length}` }),
      label: null,
      source: "import",
      content_hash: `hash-${id}`,
    },
    Array.from({ length: items }, (_, i) => ({
      item_id: `${id}-item-${i}`,
      correct: i < correct,
      score: null,
      latency_ms: null,
      cost_usd: 0.001,
      trace_id: null,
      participants_json: null,
      judge_verdict: null,
    })),
  );
}

/** A curator world with one of every exportable class plus things that must never leave. */
async function curatorDb(): Promise<MarinaDB> {
  const db = freshDb();
  const sink = lessonSinkFor(db);
  await sink.write(lesson("forecast", "late deciders break turnout models; widen the interval"));
  await sink.write(lesson("code", "run the project's own test runner before claiming success"));
  await sink.write(lesson("code", "an unverified lesson stays home", { trust: "unverified" }));
  await sink.write(lesson("tools", "a rejected candidate never ships", { trust: "rejected" }));
  await sink.write(lesson("arena", "arena strategy is internal only"));
  // Private memory and a plain pool note: never on the allow-list.
  db.createUser({ id: "u-priv", name: "privateperson" });
  db.createNote("privateperson", "my private diary entry about the launch", undefined, {
    tier: "fact",
  });
  db.createMemoryPool("pool-x", "scratch", "privateperson");
  db.addPoolNote("pool-x", "privateperson", "a shared but non-institutional pool note", 5);
  // A ratified institutional convention (the note's author never travels).
  db.createUser({ id: "u-sov", name: "sovereignsue", rank: 9 });
  db.createMemoryPool("pool-guide", "guide", "seed");
  const noteId = db.addPoolNote(
    "pool-guide",
    "privateperson",
    "state the plan before the first tool call",
    5,
  );
  const ratified = ratifyPoolNote(db, "guide", noteId, { name: "sovereignsue", rank: 9 });
  if (!ratified.ok) throw new Error(ratified.reason);
  // A promoted default backed by a valid run.
  ledgerRun(db, "run-a", 30, 24);
  ledgerRun(db, "run-small", 5, 5); // a cell below k = 20
  db.recordBenchmarkPromotion({
    slot: "forecast-config:board",
    outcome: "seeded",
    challenger_run_id: "run-a",
    incumbent_run_id: null,
    value_json: JSON.stringify({ formation: "delphi" }),
    actor: "u-op",
    stats_json: null,
    reason: "first incumbent",
    created_at: 1,
  });
  // An adopted role.
  db.saveTrait({ name: "careful", category: "style", prompt: "Check twice.", createdBy: "seed" });
  db.saveRole({ name: "checker-v2", traits: ["careful"], createdBy: "seed" });
  const bundle = exportRoleBundle(db, "checker-v2");
  db.deleteRole("checker-v2");
  const offer = { v: 1, bundle: encodeRoleBundle(bundle!) } as unknown as AdoptionOffer;
  const req = requestAdoption(db, {
    child: "child",
    role: "checker-v2",
    requestedBy: "alice",
    offer,
  });
  if ("reason" in req) throw new Error(req.reason);
  const applied = approveAdoption(db, req.id, { name: "bob" } as Entity, []);
  if ("reason" in applied) throw new Error(applied.reason);
  return db;
}

/** One read-only curator world shared by the tests that never change it. */
let shared: { db: MarinaDB; dir: string } | undefined;
async function sharedCurator(): Promise<MarinaDB> {
  if (!shared) {
    const db = await curatorDb();
    // Built outside the per-test cleanup lists: closed once, after the file.
    dbs.splice(dbs.indexOf(db), 1);
    shared = { db, dir: dirs.pop() as string };
  }
  return shared.db;
}
afterAll(() => {
  if (!shared) return;
  shared.db.close();
  rmSync(shared.dir, { recursive: true, force: true });
});

function exportTo(db: MarinaDB, over: Partial<Parameters<typeof exportLearnedBundle>[1]> = {}) {
  const outDir = join(tmp("learned-out-"), "bundle");
  const result = exportLearnedBundle(db, {
    outDir,
    name: "curated",
    publisher: { name: "Test Publisher" },
    signingKey: KEY.privateKey,
    marinaVersion: "0.7.0",
    ...over,
  });
  return { outDir, result };
}

const fileText = (dir: string) =>
  ["lessons.jsonl", "conventions.jsonl", "defaults.jsonl", "evidence.jsonl", "roles.jsonl"]
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

describe("signature", () => {
  it("round-trips: an exported bundle verifies against its pinned key", async () => {
    const db = await sharedCurator();
    const { outDir, result } = exportTo(db);
    const v = verifyBundle(outDir, pin(KEY));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.bundle.manifest.artifact_id).toBe(result.manifest.artifact_id);
    expect(v.bundle.items.map((i) => i.item_key).sort()).toEqual(
      result.items.map((i) => i.item_key).sort(),
    );
    expect(result.manifest.publisher.key_id).toBe(keyIdOfPublicKey(KEY.publicKey));
  });

  it("refuses a tampered item file, a tampered manifest and a re-signed forgery", async () => {
    const db = await sharedCurator();
    const { outDir } = exportTo(db);
    const lessons = join(outDir, "lessons.jsonl");
    const original = readFileSync(lessons, "utf8");
    writeFileSync(lessons, original.replace("widen the interval", "narrow the interval"));
    const tampered = verifyBundle(outDir, pin(KEY));
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.error).toContain("digest mismatch");
    writeFileSync(lessons, original);

    const manifestPath = join(outDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, license: "CC0-1.0" }));
    const edited = verifyBundle(outDir, pin(KEY));
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error).toContain("signature refused");

    // Edited content with a recomputed digest still fails: the manifest is signed.
    const forgedBody = original.replace("widen the interval", "narrow the interval");
    writeFileSync(lessons, forgedBody);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        files: { ...manifest.files, "lessons.jsonl": sha256Hex(forgedBody) },
      }),
    );
    expect(verifyBundle(outDir, pin(KEY)).ok).toBe(false);
  });

  it("refuses an unpinned key, including a bundle re-signed by an attacker's own key", async () => {
    const db = await sharedCurator();
    const { outDir } = exportTo(db);
    const none = verifyBundle(outDir, []);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain("not pinned");
    const other = verifyBundle(outDir, pin(OTHER));
    expect(other.ok).toBe(false);
    // The attacker's own export verifies only where the attacker's key is pinned.
    const { outDir: forged } = exportTo(db, { signingKey: OTHER.privateKey });
    expect(verifyBundle(forged, pin(KEY)).ok).toBe(false);
    expect(verifyBundle(forged, pin(OTHER)).ok).toBe(true);
  });

  it("parses pinned keys with and without labels", () => {
    const keys = parsePinnedKeys(`h2o=${KEY.publicKey}, ${OTHER.publicKey}`);
    expect(keys.map((k) => k.keyId)).toEqual([
      keyIdOfPublicKey(KEY.publicKey),
      keyIdOfPublicKey(OTHER.publicKey),
    ]);
    expect(keys[0]?.label).toBe("h2o");
    expect(parsePinnedKeys("not-a-key")).toEqual([]);
  });
});

describe("export allow-list and scans", () => {
  it("exports only served lessons, ratified classes, promoted defaults, k ≥ 20 cells and adopted roles", async () => {
    const db = await sharedCurator();
    const { outDir, result } = exportTo(db);
    const kinds = result.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === "lesson")).toHaveLength(3); // forecast, code, arena (internal)
    expect(kinds).toContain("default");
    expect(kinds).toContain("evidence");
    expect(kinds).toContain("role");
    const convention = result.items.find((i) => i.kind === "convention");
    expect(convention).toMatchObject({
      pool: "guide",
      text: "state the plan before the first tool call",
      ratified: { basis: "sovereign", by: "ratifier" },
    });
    const text = fileText(outDir);
    expect(text).not.toContain("an unverified lesson stays home");
    expect(text).not.toContain("a rejected candidate never ships");
    expect(text).not.toContain("private diary");
    expect(text).not.toContain("non-institutional pool note");
    expect(text).not.toContain("privateperson");
    expect(text).not.toContain("sovereignsue");
    expect(text).not.toContain("run-a"); // run ids only as salted hashes
    expect(text).not.toContain("answer_hash");
    const evidence = result.items.filter((i) => i.kind === "evidence");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ n: 30, successes: 24 });
    expect(result.dropped.some((d) => d.reason === "below-k")).toBe(true);
    for (const l of result.items.filter((i) => i.kind === "lesson"))
      expect(l).toMatchObject({ trust_at_source: "trusted" });
    // Proprietary unless explicitly opened.
    expect(result.manifest.license).toBe("LicenseRef-Test-Publisher-proprietary");
    expect(result.manifest.redistribution).toBe("none");
    expect(result.manifest.access.model).toBe("private");
  });

  it("public profile holds back arena lessons and per-benchmark cells", async () => {
    const db = await sharedCurator();
    const { result } = exportTo(db, { profile: "public" });
    expect(result.items.some((i) => i.kind === "lesson" && i.domain === "arena")).toBe(false);
    expect(result.items.some((i) => i.kind === "evidence")).toBe(false);
    expect(result.dropped.some((d) => d.reason === "no-family")).toBe(true);
    const fam = exportTo(db, { profile: "public", families: { reasoning: ["synthetic"] } }).result;
    const cell = fam.items.find((i) => i.kind === "evidence");
    expect(cell).toMatchObject({ family: "reasoning" });
    expect(cell && "benchmark" in cell).toBe(false);
  });

  it("drops items with secrets, instance ids, human names or benchmark text — never redacts", async () => {
    const db = freshDb();
    db.createUser({ id: "u-j", name: "jeffrey" });
    const sink = lessonSinkFor(db);
    const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUV123456";
    await sink.write(lesson("code", `rotate the key ${secret} before running`));
    await sink.write(lesson("code", "mail ops@example.com when the deploy fails"));
    await sink.write(lesson("code", "logs live under /home/someone/marina/logs"));
    await sink.write(lesson("code", "ask jeffrey before merging the release branch"));
    await sink.write(
      lesson("benchmark", "remember that the capital city of the fictional land is zorbania today"),
    );
    await sink.write(lesson("code", "a clean general lesson about verifying before merging"));
    const index = new BenchmarkTextIndex();
    index.add("Question: what is the capital city of the fictional land of zorbania? Answer: Zorb");
    const { outDir, result } = exportTo(db, { benchmarkIndex: index });
    const reasons = result.dropped.map((d) => d.reason).sort();
    expect(reasons).toEqual(["benchmark-text", "human-name", "instance", "instance", "secret"]);
    expect(result.items.filter((i) => i.kind === "lesson")).toHaveLength(1);
    const text = fileText(outDir) + readFileSync(join(outDir, "spec.json"), "utf8");
    for (const leak of [secret, "ops@example.com", "/home/someone", "jeffrey", "zorbania"])
      expect(text).not.toContain(leak);
    expect(text).not.toContain("[REDACTED]");
    expect(result.spec.scan).toMatchObject({ dropped: 5, exported: 1 });
  });

  it("scans for this process's own secret env values verbatim", () => {
    const scanner = new Scanner({ secretValues: ["hunter2-but-longer"] });
    expect(scanner.scan(["password is hunter2-but-longer ok"])).toBe("secret");
    expect(scanner.scan(["nothing to see"])).toBeUndefined();
  });
});

describe("import", () => {
  it("is refused while MARINA_UPSTREAM is off and writes nothing", async () => {
    const { outDir } = exportTo(await sharedCurator());
    const target = freshDb();
    const out = await importLearnedBundle(target, outDir, {
      pinned: pin(KEY),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(out.ok).toBe(false);
    expect(target.listUpstreamEvents()).toHaveLength(0);
    expect(target.getUserByName(UPSTREAM_ACCOUNT)).toBeUndefined();
  });

  it("refuses an unpinned or tampered bundle loudly, with an audit row", async () => {
    const { outDir } = exportTo(await sharedCurator());
    const target = freshDb();
    const out = await importLearnedBundle(target, outDir, {
      pinned: pin(OTHER),
      env: ON,
      entitlement: OWN,
    });
    expect(out.ok).toBe(false);
    expect(target.listUpstreamEvents()[0]).toMatchObject({ action: "import", outcome: "refused" });
    expect(target.listLearnedItems()).toHaveLength(0);
  });

  it("lands lessons in upstream spaces with trust `imported`, never in local lessons", async () => {
    const { outDir, result } = exportTo(await sharedCurator());
    const target = freshDb();
    const out = await importLearnedBundle(target, outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.skipped).toEqual([]);
    expect(out.report.added).toBe(result.items.length);
    const records = target.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:lessons:");
    expect(records).toHaveLength(3);
    const conventions = target.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:conventions");
    expect(conventions.map((r) => r.content)).toEqual([
      "state the plan before the first tool call",
    ]);
    expect(JSON.parse(conventions[0]?.metadata ?? "{}").trust).toBe(IMPORTED_TRUST);
    for (const r of records) {
      const meta = JSON.parse(r.metadata) as Record<string, unknown>;
      expect(meta.trust).toBe(IMPORTED_TRUST);
      expect(meta.resolved_at).toBe("2026-09-01T00:00:00.000Z");
      expect(meta.publisher_rank).toBe(0.8);
    }
    // Nothing reaches local served lessons: no lessons account, nothing recalled.
    expect(target.getUserByName(LESSONS_ACCOUNT)).toBeUndefined();
    const recalled = await recallLessons(target, "forecast", "turnout late deciders", {
      asOf: "2026-10-01T00:00:00Z",
      env: { MARINA_LESSONS: "on" } as NodeJS.ProcessEnv,
    });
    expect(recalled.recalled).toHaveLength(0);
    // Re-importing the same generation is a no-op.
    const again = await importLearnedBundle(target, outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
    });
    expect(again.ok && again.report.added).toBe(0);
    expect(again.ok && again.report.unchanged).toBe(result.items.length);
  });

  it("seeds defaults only into empty slots", async () => {
    const source = await curatorDb();
    source.recordBenchmarkPromotion({
      slot: "verify:checker",
      outcome: "seeded",
      challenger_run_id: "run-a",
      incumbent_run_id: null,
      value_json: JSON.stringify("strong"),
      actor: "u-op",
      stats_json: null,
      reason: "first incumbent",
      created_at: 2,
    });
    const { outDir } = exportTo(source);
    const target = freshDb();
    ledgerRun(target, "local-run", 25, 20);
    target.recordBenchmarkPromotion({
      slot: "forecast-config:board",
      outcome: "seeded",
      challenger_run_id: "local-run",
      incumbent_run_id: null,
      value_json: JSON.stringify({ formation: "local-choice" }),
      actor: "u-local",
      stats_json: null,
      reason: "first incumbent",
      created_at: 1,
    });
    const out = await importLearnedBundle(target, outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.seeded).toEqual(["verify:checker"]);
    expect(out.report.skipped.some((s) => s.reason.includes("forecast-config:board"))).toBe(true);
    expect(upstreamSeedFor(target, "forecast-config:board")).toBeUndefined();
    expect(target.getBenchmarkDefault("forecast-config:board")?.value_json).toContain(
      "local-choice",
    );
    expect(upstreamSeedFor(target, "verify:checker")).toMatchObject({
      value: "strong",
      source: expect.stringContaining("upstream:marina-memory:"),
    });
    // Never a benchmark_defaults row; a later local default shadows the seed.
    expect(target.getBenchmarkDefault("verify:checker")).toBeUndefined();
    target.recordBenchmarkPromotion({
      slot: "verify:checker",
      outcome: "seeded",
      challenger_run_id: "local-run",
      incumbent_run_id: null,
      value_json: JSON.stringify("local"),
      actor: "u-local",
      stats_json: null,
      reason: "first incumbent",
      created_at: 3,
    });
    expect(upstreamSeedFor(target, "verify:checker")).toBeUndefined();
  });

  it("stores ledger aggregates as down-weighted priors, never as ledger rows", async () => {
    const { outDir } = exportTo(await sharedCurator());
    const target = freshDb();
    await importLearnedBundle(target, outDir, { pinned: pin(KEY), env: ON, entitlement: OWN });
    const priors = target.listEvidencePriors();
    expect(priors).toHaveLength(1);
    expect(priors[0]).toMatchObject({ n: 30, successes: 24, weight: PRIOR_WEIGHT });
    expect(priors[0]?.prior_n).toBeCloseTo(30 * PRIOR_WEIGHT);
    expect(target.queryBenchmarkRuns({})).toHaveLength(0);
  });

  it("creates roles under the upstream. prefix, create-only and unbound", async () => {
    const { outDir } = exportTo(await sharedCurator());
    const target = freshDb();
    const out = await importLearnedBundle(target, outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
    });
    expect(out.ok && out.report.rolesCreated).toEqual(["upstream.checker-v2"]);
    expect(target.getRole("checker-v2")).toBeUndefined();
    expect(target.getRole("upstream.checker-v2")?.traits).toContain("upstream.careful");
    expect(target.getTrait("upstream.careful")?.prompt).toBe("Check twice.");
  });

  it("confirms an imported lesson only through a trusted local lesson that cites it", async () => {
    const { outDir } = exportTo(await sharedCurator());
    const target = freshDb();
    const out = await importLearnedBundle(target, outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
    });
    if (!out.ok) throw new Error(out.error);
    const item = target.listLearnedItems().find((i) => i.kind === "lesson")!;
    const sink = lessonSinkFor(target);
    const uncited = await sink.write(lesson("code", "a local lesson that cites nothing"));
    const refused = await confirmImportedLesson(target, {
      artifactId: item.artifact_id,
      itemKey: item.item_key,
      localLessonId: uncited.id!,
    });
    expect(refused.ok).toBe(false);
    const unverified = await sink.write(
      lesson("code", "an unjudged local lesson", {
        trust: "unverified",
        refs: [`upstream:${item.item_key}`],
      }),
    );
    expect(
      (
        await confirmImportedLesson(target, {
          artifactId: item.artifact_id,
          itemKey: item.item_key,
          localLessonId: unverified.id!,
        })
      ).ok,
    ).toBe(false);
    const cited = await sink.write(
      lesson("code", "local outcomes agree with the imported rule", {
        refs: [`upstream:${item.item_key}`],
      }),
    );
    const ok = await confirmImportedLesson(target, {
      artifactId: item.artifact_id,
      itemKey: item.item_key,
      localLessonId: cited.id!,
    });
    expect(ok.ok).toBe(true);
    expect(target.getLearnedItem(item.artifact_id, item.item_key)?.confirmed_by).toBe(cited.id!);
    // The imported record keeps trust `imported`; provenance names the confirmation.
    const record = target
      .listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:lessons:")
      .find((r) => item.local_ref?.endsWith(r.id))!;
    const meta = JSON.parse(record.metadata) as Record<string, unknown>;
    expect(meta.trust).toBe(IMPORTED_TRUST);
    expect(meta.confirmed_locally_by).toBe(cited.id!);
  });
});

describe("lineage, diff, revocation", () => {
  it("chains generations, diffs by item key, retires on import and refuses a downgrade", async () => {
    const db = await curatorDb();
    const v1 = exportTo(db);
    expect(v1.result.manifest).toMatchObject({ version: "1.0.0", generation: 1, parent: null });
    expect(v1.result.diff.every((d) => d.change === "added")).toBe(true);

    // Retire one lesson, add one: minor bump, parent digest and lineage recorded.
    const [gone] = await findLessons(db, ["forecast"], { match: "late deciders" });
    await retireLessons(db, [gone!], { reason: "superseded", by: "curator" });
    await lessonSinkFor(db).write(lesson("tools", "retry idempotent calls with the same key"));
    const v2Dir = join(tmp("learned-v2-"), "bundle");
    const v2 = exportLearnedBundle(db, {
      outDir: v2Dir,
      name: "curated",
      publisher: { name: "Test Publisher" },
      signingKey: KEY.privateKey,
      marinaVersion: "0.7.0",
      parentDir: v1.outDir,
    });
    expect(v2.manifest.version).toBe("1.1.0");
    expect(v2.manifest.generation).toBe(2);
    expect(v2.manifest.parent?.version).toBe("1.0.0");
    expect(v2.manifest.parent?.manifest_digest).toMatch(/^sha256:/);
    expect(v2.manifest.lineage).toHaveLength(1);
    const changes = v2.diff.map((d) => d.change).sort();
    expect(changes).toEqual(["added", "retired"]);
    // The stable keys of unchanged items survive the new version.
    const keys1 = new Set(v1.result.items.map((i) => i.item_key));
    expect(v2.items.filter((i) => keys1.has(i.item_key))).toHaveLength(v1.result.items.length - 1);
    // diff.jsonl ships inside the signed bundle.
    const verified = verifyBundle(v2Dir, pin(KEY));
    expect(verified.ok && verified.bundle.diff).toEqual(v2.diff);

    const target = freshDb();
    await importLearnedBundle(target, v1.outDir, { pinned: pin(KEY), env: ON, entitlement: OWN });
    const second = await importLearnedBundle(target, v2Dir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
    });
    expect(second.ok && second.report).toMatchObject({ added: 1, retired: 1 });
    const retiredKey = v2.diff.find((d) => d.change === "retired")!.item_key;
    expect(target.getLearnedItem(v2.manifest.artifact_id, retiredKey)?.status).toBe("retired");
    expect(
      target.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:lessons:forecast"),
    ).toHaveLength(0);

    const downgrade = await importLearnedBundle(target, v1.outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
    });
    expect(downgrade.ok).toBe(false);
    if (!downgrade.ok) expect(downgrade.error).toContain("downgrade");
  });

  it("refuses a parent signed by another key and a version that does not move forward", async () => {
    const db = await sharedCurator();
    const foreign = exportTo(db, { signingKey: OTHER.privateKey });
    expect(() => exportTo(db, { parentDir: foreign.outDir })).toThrow(/parent bundle refused/);
    const v1 = exportTo(db, { version: "2.0.0" });
    expect(() => exportTo(db, { parentDir: v1.outDir, version: "1.9.0" })).toThrow(/greater/);
  });

  it("applies signed revocations: a revoked version is refused, a revoked item retired", async () => {
    const db = await sharedCurator();
    const { outDir, result } = exportTo(db);
    const target = freshDb();
    await importLearnedBundle(target, outDir, { pinned: pin(KEY), env: ON, entitlement: OWN });
    const lessonKey = result.items.find((i) => i.kind === "lesson")!.item_key;
    const base = {
      schema: REVOCATIONS_SCHEMA,
      publisher_key_id: keyIdOfPublicKey(KEY.publicKey),
      issued_at: "2026-10-04T00:00:00Z",
    } as const;
    const itemRevocation = signRevocations(
      {
        ...base,
        entries: [
          {
            artifact_id: result.manifest.artifact_id,
            item_key: lessonKey,
            reason: "wrong",
            severity: "retire",
          },
        ],
      },
      KEY.privateKey,
    );
    const again = await importLearnedBundle(target, outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
      revocations: [itemRevocation],
    });
    expect(again.ok && again.report.revoked).toBe(1);
    expect(target.getLearnedItem(result.manifest.artifact_id, lessonKey)?.status).toBe("revoked");

    const versionRevocation = signRevocations(
      {
        ...base,
        entries: [
          {
            artifact_id: result.manifest.artifact_id,
            version: "1.0.0",
            reason: "bad pack",
            severity: "critical",
          },
        ],
      },
      KEY.privateKey,
    );
    const fresh = freshDb();
    const refused = await importLearnedBundle(fresh, outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
      revocations: [versionRevocation],
    });
    expect(refused.ok).toBe(false);
    // A revocation list signed by an unpinned key is itself refused.
    const forged = signRevocations(
      { ...base, publisher_key_id: keyIdOfPublicKey(OTHER.publicKey), entries: [] },
      OTHER.privateKey,
    );
    const bad = await importLearnedBundle(freshDb(), outDir, {
      pinned: pin(KEY),
      env: ON,
      entitlement: OWN,
      revocations: [forged],
    });
    expect(bad.ok).toBe(false);
  });

  it("diffs re-ranks separately from content changes", () => {
    const item = (rank: number, text: string) =>
      ({
        item_key: "lesson:k",
        content_hash: `sha256:${sha256Hex(text)}`,
        kind: "lesson",
        domain: "code",
        tier: "core",
        rank,
        provenance: [],
      }) as unknown as LearnedItem;
    expect(diffItems([item(0.5, "a")], [item(0.9, "a")])[0]?.change).toBe("re-ranked");
    expect(diffItems([item(0.5, "a")], [item(0.5, "b")])[0]?.change).toBe("changed");
  });
});

describe("artifact fields", () => {
  it("opens the whole bundle or only a slice, explicitly", async () => {
    const db = await sharedCurator();
    const open = exportTo(db, { open: true }).result.manifest;
    expect(open).toMatchObject({
      license: OPEN_LICENSE,
      redistribution: "allowed",
      commercial_use: "allowed",
    });
    expect(open.access.model).toBe("open");
    const core = exportTo(db, { openSlices: ["tier:core"] }).result.manifest;
    expect(core.license).toBe("LicenseRef-Test-Publisher-proprietary");
    const coreSlice = core.slices.find((s) => s.id === "tier:core")!;
    expect(coreSlice).toMatchObject({ open: true, license: OPEN_LICENSE, access: "open" });
    expect(core.slices.find((s) => s.id === "tier:full")).toMatchObject({ open: false });
    expect(core.slices.some((s) => s.id === "domain:code")).toBe(true);
    expect(core.access).toMatchObject({ entitlement: null, encryption: null });
  });

  it("writes a spec sheet with counts, ranks and per-record provenance", async () => {
    const { result } = exportTo(await sharedCurator());
    expect(result.spec.counts.by_kind.lesson).toBe(3);
    expect(result.spec.ranks?.n).toBe(3);
    expect(result.spec.judges[0]).toMatchObject({ calibrated: true });
    expect(result.spec.defaults[0]).toMatchObject({ slot: "forecast-config:board" });
    for (const i of result.items) expect(i.provenance.length).toBeGreaterThan(0);
  });

  it("lists the new append-only tables in the retention policy", () => {
    for (const table of [
      "learned_artifacts",
      "upstream_default_seeds",
      "evidence_priors",
      "upstream_events",
    ])
      expect(RETENTION_POLICIES.find((p) => p.table === table)?.kind).toBe("append-only");
  });
});

describe("learned command", () => {
  it("is read-only inspection of imports", async () => {
    const { outDir } = exportTo(await sharedCurator());
    const target = freshDb();
    await importLearnedBundle(target, outDir, { pinned: pin(KEY), env: ON, entitlement: OWN });
    const cmd = learnedCommand({ db: target });
    const sent: string[] = [];
    const ctx = { send: (_: EntityId, m: string) => sent.push(m) } as unknown as RoomContext;
    for (const tokens of [[], ["artifacts"], ["items"], ["seeds"], ["priors"], ["events"]]) {
      await cmd.handler(ctx, { entity: "e_1" as EntityId, tokens, raw: "" } as never);
    }
    const out = sent.join("\n");
    expect(out).toContain("Learned bundles");
    expect(out).toContain("trust imported");
    expect(out).toContain("marina-memory:");
  });
});
