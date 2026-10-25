// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The learned bootstrap (src/learned/distill.ts, bootstrap.ts): a legacy world
 * database distilled READ-ONLY into a bundle that carries only the export
 * allow-list, the manifest's `excludes` and the overreach refusal, unsigned
 * bundles behind an explicit flag, the boot-time import before agents wake
 * (idempotent on a second boot), archiving that refuses a held database, and
 * the upstream-seed layer of `resolveDefault`. No model provider anywhere.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRoleBundle, exportRoleBundle } from "../src/agent/role-bundle";
import type { AdoptionOffer } from "../src/engine/commands/evolve";
import { resolveDefault } from "../src/engine/default-resolution";
import { grant } from "../src/engine/safety-gates";
import {
  bootstrapAccept,
  bootstrapBundlePaths,
  importBootstrapBundles,
} from "../src/learned/bootstrap";
import { verifyBundle } from "../src/learned/bundle";
import { archiveDatabase, distillDatabase } from "../src/learned/distill";
import { ownBundleGrant } from "../src/learned/entitlement";
import {
  BUNDLE_EXCLUDES,
  contentHash,
  type LearnedItem,
  type Manifest,
} from "../src/learned/format";
import { importLearnedBundle, UPSTREAM_ACCOUNT } from "../src/learned/import";
import { generateLearnedKeyPair, type PinnedKey, signLearned } from "../src/learned/sign";
import type { Lesson } from "../src/learning/outcomes";
import { lessonSinkFor } from "../src/learning/service";
import { ratifyPoolNote } from "../src/memory/institutional";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { keyIdOfPublicKey } from "../src/net/federation-crypto";
import { MarinaDB } from "../src/persistence/database";
import { acquireDatabaseLease } from "../src/persistence/database-lease";
import { sha256Hex } from "../src/security/hash";
import type { Entity } from "../src/types";
import { approveAdoption, requestAdoption } from "../src/world/adoption";
import { scopeProcessState } from "./process-state";

setDefaultTimeout(30_000);

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const dbs: MarinaDB[] = [];
function freshDb(): MarinaDB {
  const db = new MarinaDB(join(tmp("boot-db-"), "m.db"));
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = generateLearnedKeyPair();
const pinned: PinnedKey[] = [
  { label: "test", publicKey: KEY.publicKey, keyId: keyIdOfPublicKey(KEY.publicKey) },
];
const ON = { MARINA_UPSTREAM: "on" } as NodeJS.ProcessEnv;
const OWN = ownBundleGrant("operator");
/** Every provider credential unset: distill, import and bootstrap need no model. */
const NO_PROVIDER = Object.fromEntries(
  [
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "HF_TOKEN",
    "OLLAMA_BASE_URL",
    "LLAMA_BASE_URL",
  ].map((k) => [k, undefined]),
);

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

// Fake credentials for the scanner, assembled at runtime so no secret-shaped
// literal lands in history (the merge-queue secret scan sees every commit).
const SECRET = ["sk", "proj", "ABCDEFGHIJKLMNOPQRSTUV123456"].join("-");
const MEM_KEY_SECRET = ["memkey", "secret", "value", "0123456789abcdef"].join("-");
const HOLD_SUMMARY = "held: code exec rm -rf build by holdholder";

/**
 * A legacy world on disk with one of every exportable class AND one of every
 * layer that must never leave: rejected/unverified lessons, private notes, a
 * pool note, standing, a gate grant, a challenge hold and a secret.
 */
async function legacyWorld(): Promise<string> {
  const path = join(tmp("legacy-"), "legacy.db");
  const db = new MarinaDB(path);
  try {
    const sink = lessonSinkFor(db);
    await sink.write(lesson("forecast", "late deciders break turnout models; widen the interval"));
    await sink.write(lesson("code", "run the project's own test runner before claiming success"));
    await sink.write(lesson("code", "an unverified lesson stays home", { trust: "unverified" }));
    await sink.write(lesson("tools", "a rejected candidate never ships", { trust: "rejected" }));
    await sink.write(lesson("code", `rotate the key ${SECRET} before running`));
    db.createUser({ id: "u-priv", name: "privateperson" });
    db.createNote("privateperson", "my private diary entry about the launch", undefined, {
      tier: "fact",
    });
    db.createMemoryPool("pool-x", "scratch", "privateperson");
    db.addPoolNote("pool-x", "privateperson", "a shared but non-institutional pool note", 5);
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
    ledgerRun(db, "run-a", 30, 24);
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
    db.saveTrait({ name: "careful", category: "style", prompt: "Check twice.", createdBy: "seed" });
    db.saveRole({ name: "checker-v2", traits: ["careful"], createdBy: "seed" });
    const role = exportRoleBundle(db, "checker-v2");
    db.deleteRole("checker-v2");
    const offer = { v: 1, bundle: encodeRoleBundle(role!) } as unknown as AdoptionOffer;
    const req = requestAdoption(db, {
      child: "child",
      role: "checker-v2",
      requestedBy: "alice",
      offer,
    });
    if ("reason" in req) throw new Error(req.reason);
    const applied = approveAdoption(db, req.id, { name: "bob" } as Entity, []);
    if ("reason" in applied) throw new Error(applied.reason);
    // Identity-layer state that must never travel.
    db.createUser({ id: "u-stand", name: "standingsam" });
    db.appendStandingEvent({
      entityId: "u-stand",
      entityName: "standingsam",
      kind: "task_complete",
      ref: "task:1",
      amount: 7,
    });
    grant(db, "u-stand", "agent.spawn");
    db.saveChallengeHold({
      token: "hold-token-abc123",
      kind: "gate",
      requesterId: "u-stand",
      requesterName: "holdholder",
      gateId: "code.exec",
      summary: HOLD_SUMMARY,
      reason: "gate",
      createdAt: 1,
      expiresAt: Date.now() + 3_600_000,
    });
    db.createMemApiKey("k1", MEM_KEY_SECRET, "standingsam");
  } finally {
    db.close();
  }
  return path;
}

function fingerprint(path: string): string {
  return ["", "-wal", "-shm"]
    .map((s) => (existsSync(`${path}${s}`) ? sha256Hex(readFileSync(`${path}${s}`)) : "-"))
    .join("/");
}

function bundleText(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

function distillTo(source: string, signingKey: string | null = null) {
  const outDir = join(tmp("bundle-"), "distilled");
  const result = distillDatabase({
    sourcePath: source,
    outDir,
    name: "distilled",
    publisher: { name: "Test Publisher" },
    signingKey,
    marinaVersion: "0.9.0",
  });
  return { outDir, result };
}

/** Re-sign a bundle after editing its manifest or files (an attacker holding the key). */
function resign(dir: string, edit: (m: Manifest) => Manifest): void {
  const path = join(dir, "manifest.json");
  const m = edit(JSON.parse(readFileSync(path, "utf8")) as Manifest);
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(
    join(dir, "signature.json"),
    JSON.stringify(signLearned(m as unknown as Record<string, unknown>, KEY.privateKey)),
  );
}

describe("distill", () => {
  it("carries the allow-list only, layer by layer, and never touches the source", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const source = await legacyWorld();
    const before = fingerprint(source);
    const { outDir, result } = distillTo(source, KEY.privateKey);
    expect(fingerprint(source)).toBe(before);
    // No snapshot is left beside the bundle.
    expect(readdirSync(join(outDir, "..")).filter((f) => f.startsWith(".marina-distill"))).toEqual(
      [],
    );

    const by = (kind: LearnedItem["kind"]) => result.items.filter((i) => i.kind === kind);
    // lessons: trusted only; unverified, rejected and secret-bearing ones never leave.
    const lessonTexts = by("lesson").map((i) => (i.kind === "lesson" ? i.text : ""));
    expect(lessonTexts.sort()).toEqual([
      "late deciders break turnout models; widen the interval",
      "run the project's own test runner before claiming success",
    ]);
    expect(result.dropped.map((d) => d.reason)).toContain("secret");
    // conventions: the ratified institutional record.
    expect(by("convention")).toHaveLength(1);
    // defaults: the promoted slot.
    expect(by("default").map((i) => (i.kind === "default" ? i.slot : ""))).toEqual([
      "forecast-config:board",
    ]);
    // evidence: the k ≥ 20 aggregate, not ledger rows.
    expect(by("evidence")).toHaveLength(1);
    expect(by("evidence")[0]).toMatchObject({ n: 30, successes: 24 });
    // roles: the adopted one.
    expect(by("role")).toHaveLength(1);

    const text = bundleText(outDir);
    for (const never of [
      "an unverified lesson stays home",
      "a rejected candidate never ships",
      "private diary",
      "non-institutional pool note",
      SECRET,
      MEM_KEY_SECRET,
      HOLD_SUMMARY,
      "hold-token-abc123",
      "privateperson",
      "sovereignsue",
      "standingsam",
      "holdholder",
      "run-a-item-",
    ])
      expect(text).not.toContain(never);

    const m = result.manifest;
    expect(m.excludes).toEqual([...BUNDLE_EXCLUDES]);
    expect(m.unsigned).toBeUndefined();
    expect(Object.keys(m.files).sort()).toEqual(
      [
        "conventions.jsonl",
        "defaults.jsonl",
        "diff.jsonl",
        "evidence.jsonl",
        "lessons.jsonl",
        "roles.jsonl",
        "room-sources.jsonl",
        "spec.json",
        "world.jsonl",
      ].sort(),
    );
    expect(verifyBundle(outDir, pinned).ok).toBe(true);
  });

  it("reads a database a server still holds open, without writing to it", async () => {
    const source = await legacyWorld();
    const live = new MarinaDB(source);
    try {
      const before = fingerprint(source);
      const { result } = distillTo(source);
      expect(result.items.some((i) => i.kind === "lesson")).toBe(true);
      expect(fingerprint(source)).toBe(before);
    } finally {
      live.close();
    }
  });

  it("with no key writes an UNSIGNED bundle that verifies only with the explicit flag", async () => {
    const { outDir, result } = distillTo(await legacyWorld());
    expect(result.unsigned).toBe(true);
    expect(result.manifest).toMatchObject({ unsigned: true, publisher: { key_id: "unsigned" } });
    expect(result.manifest.artifact_id).toStartWith("marina-memory:unsigned-");
    expect(existsSync(join(outDir, "signature.json"))).toBe(false);
    const refused = verifyBundle(outDir, pinned);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("--allow-unsigned");
    const ok = verifyBundle(outDir, pinned, { allowUnsigned: true });
    expect(ok.ok && ok.bundle.publisherLabel).toBe("UNSIGNED");
  });

  it("refuses a missing source and an output that already holds a bundle", async () => {
    expect(() => distillTo(join(tmp("none-"), "missing.db"))).toThrow(/no database/);
    const source = await legacyWorld();
    const { outDir } = distillTo(source);
    expect(() =>
      distillDatabase({
        sourcePath: source,
        outDir,
        name: "distilled",
        publisher: { name: "p" },
        signingKey: null,
        marinaVersion: "0.9.0",
      }),
    ).toThrow(/already holds a bundle/);
  });
});

describe("round trip into a fresh world", () => {
  it("lands lessons as `imported` in upstream:* spaces, recalled with that label", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const { outDir } = distillTo(await legacyWorld());
    const target = freshDb();
    const refused = await importLearnedBundle(target, outDir, {
      pinned,
      env: ON,
      entitlement: OWN,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("unsigned");

    const out = await importLearnedBundle(target, outDir, {
      pinned,
      env: ON,
      entitlement: OWN,
      allowUnsigned: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.added).toBeGreaterThan(0);
    const records = target.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:lessons:");
    expect(records).toHaveLength(2);
    for (const r of records) {
      const meta = JSON.parse(r.metadata) as Record<string, unknown>;
      expect(meta).toMatchObject({
        trust: "imported",
        unsigned: true,
        publisher_key_id: "unsigned",
      });
      expect(String(meta.source)).toStartWith("upstream:marina-memory:unsigned-");
    }
    // Nothing reaches the local lessons pool, accounts or standing.
    expect(target.getUserByName("standingsam")).toBeUndefined();
    expect(target.getUserByName("privateperson")).toBeUndefined();

    // Recall through the canonical memory service: the lesson comes back labelled `imported`.
    const run = (request: Parameters<typeof residentMemoryOperation>[2]) =>
      residentMemoryOperation(target, UPSTREAM_ACCOUNT, request);
    const spaces = (
      (await run({ operation: "spaces" })) as {
        result: { spaces: Array<{ id: string; name: string }> };
      }
    ).result.spaces;
    const space = spaces.find((s) => s.name === "upstream:lessons:forecast");
    expect(space).toBeDefined();
    const found = (await run({
      operation: "search",
      space_id: space!.id,
      input: { query: "turnout", mode: "lexical" },
    })) as { result: unknown };
    const hits = JSON.stringify(found.result);
    expect(hits).toContain("late deciders break turnout models");
    expect(hits).toContain('"trust":"imported"');
  });
});

describe("manifest excludes and overreach", () => {
  it("refuses a manifest that drops an exclude, an extra file, or an item from an excluded layer", async () => {
    const source = await legacyWorld();
    const verifyAfter = (edit: (dir: string) => void) => {
      const { outDir } = distillTo(source, KEY.privateKey);
      edit(outDir);
      return verifyBundle(outDir, pinned);
    };
    const dropped = verifyAfter((dir) =>
      resign(dir, (m) => ({ ...m, excludes: m.excludes?.filter((e) => e !== "standing") })),
    );
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.error).toContain("does not exclude standing");

    const extraFile = verifyAfter((dir) => {
      const body = '{"name":"someone"}\n';
      writeFileSync(join(dir, "users.jsonl"), body);
      resign(dir, (m) => ({ ...m, files: { ...m.files, "users.jsonl": sha256Hex(body) } }));
    });
    expect(extraFile.ok).toBe(false);
    if (!extraFile.ok) expect(extraFile.error).toContain("users.jsonl is not part of the format");

    const smuggled = verifyAfter((dir) => {
      const path = join(dir, "lessons.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const item = JSON.parse(lines[0]!) as Record<string, unknown>;
      const { content_hash: _h, ...rest } = item;
      const forged = { ...rest, standing: { standingsam: 7 } };
      lines[0] = JSON.stringify({ ...forged, content_hash: contentHash(forged as never) });
      const body = `${lines.join("\n")}\n`;
      writeFileSync(path, body);
      resign(dir, (m) => ({ ...m, files: { ...m.files, "lessons.jsonl": sha256Hex(body) } }));
    });
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.error).toContain("excluded layer");

    const overclaimed = verifyAfter((dir) =>
      resign(dir, (m) => ({
        ...m,
        export_policy: {
          ...m.export_policy,
          allow_list: [...m.export_policy.allow_list, "standing:all"],
        },
      })),
    );
    expect(overclaimed.ok).toBe(false);
  });

  it("an older bundle without `excludes` still verifies and imports", async () => {
    const { outDir } = distillTo(await legacyWorld(), KEY.privateKey);
    resign(outDir, (m) => {
      const { excludes: _e, ...old } = m;
      return old as Manifest;
    });
    const target = freshDb();
    const out = await importLearnedBundle(target, outDir, { pinned, env: ON, entitlement: OWN });
    expect(out.ok).toBe(true);
  });
});

describe("bootstrap import at boot", () => {
  it("imports what MARINA_BOOTSTRAP_BUNDLES names, and a second boot is a no-op", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const { outDir } = distillTo(await legacyWorld(), KEY.privateKey);
    const env = {
      MARINA_BOOTSTRAP_BUNDLES: outDir,
      MARINA_BOOTSTRAP_ACCEPT: "own",
      MARINA_LEARNED_PUBLISHER_KEYS: KEY.publicKey,
    } as NodeJS.ProcessEnv;
    const target = freshDb();
    const first = await importBootstrapBundles(target, env);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ outcome: "imported" });
    expect(target.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:lessons:")).toHaveLength(2);
    const events = target.listUpstreamEvents().length;
    const items = target.listLearnedItems().length;

    const second = await importBootstrapBundles(target, env);
    expect(second[0]).toMatchObject({ outcome: "unchanged" });
    expect(target.listUpstreamEvents()).toHaveLength(events);
    expect(target.listLearnedItems()).toHaveLength(items);
  });

  it("unset: nothing runs and nothing is written", async () => {
    const target = freshDb();
    expect(await importBootstrapBundles(target, {} as NodeJS.ProcessEnv)).toEqual([]);
    expect(target.getUserByName(UPSTREAM_ACCOUNT)).toBeUndefined();
    expect(target.listUpstreamEvents()).toHaveLength(0);
  });

  it("an unsigned bundle needs MARINA_BOOTSTRAP_ACCEPT=unsigned; a refusal is audited", async () => {
    const { outDir } = distillTo(await legacyWorld());
    const target = freshDb();
    const refused = await importBootstrapBundles(target, {
      MARINA_BOOTSTRAP_BUNDLES: outDir,
      MARINA_BOOTSTRAP_ACCEPT: "own",
    } as NodeJS.ProcessEnv);
    expect(refused[0]).toMatchObject({ outcome: "refused" });
    expect(target.listUpstreamEvents()[0]).toMatchObject({ outcome: "refused" });
    const ok = await importBootstrapBundles(target, {
      MARINA_BOOTSTRAP_BUNDLES: outDir,
      MARINA_BOOTSTRAP_ACCEPT: "own,unsigned",
    } as NodeJS.ProcessEnv);
    expect(ok[0]).toMatchObject({ outcome: "imported" });
  });

  it("expands a directory of bundles in name order and rejects unknown accept values", async () => {
    const parent = tmp("bundles-");
    mkdirSync(join(parent, "b-second"));
    writeFileSync(join(parent, "b-second", "manifest.json"), "{}");
    mkdirSync(join(parent, "a-first"));
    writeFileSync(join(parent, "a-first", "manifest.json"), "{}");
    mkdirSync(join(parent, "not-a-bundle"));
    expect(
      bootstrapBundlePaths({ MARINA_BOOTSTRAP_BUNDLES: ` ${parent} ,` } as NodeJS.ProcessEnv),
    ).toEqual([join(parent, "a-first"), join(parent, "b-second")]);
    expect(() =>
      bootstrapAccept({ MARINA_BOOTSTRAP_ACCEPT: "own,everything" } as NodeJS.ProcessEnv),
    ).toThrow(/unknown value/);
  });

  it("runs in main.ts after the world seed and before any agent wakes", () => {
    const main = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    const seed = main.indexOf("world.seed(db)");
    const boot = main.indexOf("importBootstrapBundles(db)");
    const agents = main.indexOf("engine.initAgents(");
    expect(seed).toBeGreaterThan(0);
    expect(boot).toBeGreaterThan(seed);
    expect(agents).toBeGreaterThan(boot);
  });
});

describe("archive", () => {
  it("refuses a database a server holds, then moves it beside itself without deleting", async () => {
    const source = await legacyWorld();
    const before = sha256Hex(readFileSync(source));
    const release = acquireDatabaseLease(source);
    try {
      expect(() => archiveDatabase(source)).toThrow(/running Marina holds it/);
    } finally {
      release();
    }
    expect(existsSync(source)).toBe(true);
    const r = archiveDatabase(source, { now: Date.UTC(2026, 9, 24, 12, 0, 0) });
    expect(r.archiveDir).toBe(`${source}.archive-20261024T120000Z`);
    expect(existsSync(source)).toBe(false);
    const archived = join(r.archiveDir, "legacy.db");
    expect(sha256Hex(readFileSync(archived))).toBe(before);
    // The archive still opens as the same world.
    const reopened = new MarinaDB(archived);
    expect(reopened.getUserByName("standingsam")).toBeDefined();
    reopened.close();
  });
});

describe("upstream-seed layer of resolveDefault", () => {
  it("a seeded slot resolves from upstream, below a local promotion and env", async () => {
    const { outDir } = distillTo(await legacyWorld(), KEY.privateKey);
    const target = freshDb();
    const out = await importLearnedBundle(target, outDir, { pinned, env: ON, entitlement: OWN });
    expect(out.ok && out.report.seeded).toEqual(["forecast-config:board"]);
    const read = (v: unknown) => {
      const f = (v as { formation?: unknown } | null)?.formation;
      return typeof f === "string" ? f : undefined;
    };
    const spec = (env?: string) => ({
      slot: "forecast-config",
      board: "board",
      env: { name: "MARINA_TEST_FORMATION", value: env },
      read,
      builtIn: "ensemble",
      db: target,
    });
    const seeded = resolveDefault(spec());
    expect(seeded).toMatchObject({ source: "upstream", value: "delphi" });
    expect(seeded.key).toContain("@upstream:marina-memory:");

    // A world that never imported anything: built-in, with no upstream layer in the trace.
    const plain = resolveDefault({ ...spec(), db: freshDb() });
    expect(plain.source).toBe("builtin");
    expect(plain.consulted.some((c) => c.layer === "upstream")).toBe(false);

    // A local promotion beats the seed; env beats both.
    ledgerRun(target, "local-run", 30, 25);
    target.recordBenchmarkPromotion({
      slot: "forecast-config:board",
      outcome: "seeded",
      challenger_run_id: "local-run",
      incumbent_run_id: null,
      value_json: JSON.stringify({ formation: "tournament" }),
      actor: "operator",
      stats_json: null,
      reason: "local",
      created_at: 2,
    });
    expect(resolveDefault(spec())).toMatchObject({ source: "slot", value: "tournament" });
    expect(resolveDefault(spec("skeptic"))).toMatchObject({ source: "env", value: "skeptic" });
  });
});
