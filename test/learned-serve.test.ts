// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Serving imported lessons (src/learned/serve.ts): a world distilled into a
 * bundle and bootstrapped into a fresh world serves the bundle's lessons
 * through the ordinary lesson recall, labelled `imported` (and `unsigned`),
 * below local trusted lessons, under family scoping, the owner scope, leakage
 * rule 2 and the as-of fence. `MARINA_IMPORTED_LESSONS=off` is byte-identical
 * to a world without imports, `observe` records and serves nothing, local
 * outcomes confirm or retire imported lessons, the unset `MARINA_UPSTREAM`
 * imports only open bundles signed by a pinned key, and readiness `learned`
 * reports it all. No model provider anywhere.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionProvider } from "../src/decisions/types";
import { lessonsCommand } from "../src/engine/commands/lessons";
import { learnedCheck } from "../src/engine/readiness";
import { importBootstrapBundles } from "../src/learned/bootstrap";
import { distillDatabase } from "../src/learned/distill";
import { exportLearnedBundle } from "../src/learned/export";
import {
  describeUpstreamMode,
  importLearnedBundle,
  UPSTREAM_ACCOUNT,
  upstreamMode,
} from "../src/learned/import";
import {
  importedLessonLink,
  importedLessonsMode,
  importedLessonsSetting,
} from "../src/learned/serve";
import { generateLearnedKeyPair, type PinnedKey } from "../src/learned/sign";
import { formatLesson, type Lesson, recordOutcome, selectServed } from "../src/learning/outcomes";
import {
  lessonSinkFor,
  lessonsBlock,
  ownerLessonSink,
  recallForWork,
  recallLessons,
} from "../src/learning/service";
import { keyIdOfPublicKey } from "../src/net/federation-crypto";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomContext } from "../src/types";
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
  const db = new MarinaDB(join(tmp("serve-db-"), "m.db"));
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = generateLearnedKeyPair();
const OTHER = generateLearnedKeyPair();
const pin = (k: { publicKey: string }): PinnedKey[] => [
  { label: "test", publicKey: k.publicKey, keyId: keyIdOfPublicKey(k.publicKey) },
];
/** Every provider credential unset: serving needs no model. */
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
    "MARINA_IMPORTED_LESSONS",
    "MARINA_UPSTREAM",
  ].map((k) => [k, undefined]),
);

const NOW = "2026-10-20T00:00:00.000Z";
const lesson = (domain: Lesson["domain"], text: string, over: Partial<Lesson> = {}): Lesson => ({
  domain,
  text,
  rule: text,
  kind: "failure",
  trust: "trusted",
  score: 0.8,
  judge: "typesafe/jev-1.13",
  resolvedAt: "2026-09-01T00:00:00.000Z",
  source: `${domain}:test`,
  ...over,
});

const IMPORTED_CODE = "rerun the flaky integration suite once before you blame the change";
const IMPORTED_PY = "pin the interpreter version before running pytest in a fresh checkout";
const IMPORTED_BOARD = "read the grader tool schema before the first grading call";
const IMPORTED_LATE = "widen the forecast interval when turnout data is stale";
const PRIVATE_OWN = "my private habit is to stash work before rebasing the branch";

/** A world on disk whose shared pool holds lessons of every serving scope, plus a private one. */
async function sourceWorld(): Promise<string> {
  const path = join(tmp("source-"), "source.db");
  const db = new MarinaDB(path);
  try {
    const sink = lessonSinkFor(db);
    await sink.write(lesson("code", IMPORTED_CODE, { families: ["coding"] }));
    await sink.write(lesson("code", IMPORTED_PY, { scopeFamily: "family:python" }));
    await sink.write(lesson("tools", IMPORTED_BOARD, { refs: ["eval:gpqa-diamond"] }));
    await sink.write(lesson("forecast", IMPORTED_LATE, { resolvedAt: "2026-10-01T00:00:00.000Z" }));
    db.createUser({ id: "u_own", name: "ownerperson" });
    await ownerLessonSink(db, "ownerperson").write(lesson("code", PRIVATE_OWN));
  } finally {
    db.close();
  }
  return path;
}

function distill(source: string, signingKey: string | null = KEY.privateKey): string {
  const outDir = join(tmp("bundle-"), "distilled");
  distillDatabase({
    sourcePath: source,
    outDir,
    name: "distilled",
    publisher: { name: "Test Publisher" },
    signingKey,
    marinaVersion: "0.9.0",
  });
  return outDir;
}

/** Bootstrap `bundle` into `db` as the server does at boot. */
async function bootstrap(db: MarinaDB, bundle: string, accept = "own"): Promise<void> {
  const out = await importBootstrapBundles(db, {
    MARINA_BOOTSTRAP_BUNDLES: bundle,
    MARINA_BOOTSTRAP_ACCEPT: accept,
    MARINA_LEARNED_PUBLISHER_KEYS: `test=${KEY.publicKey}`,
  } as NodeJS.ProcessEnv);
  expect(out.map((o) => o.outcome)).toEqual(["imported"]);
}

const texts = (ls: readonly Lesson[]) => ls.map((l) => l.text);
const ON = { MARINA_LESSONS: "on" } as NodeJS.ProcessEnv;

function runLessons(db: MarinaDB, args: string): Promise<string> {
  const out: string[] = [];
  const ctx = { send: (_e: EntityId, msg: string) => out.push(msg) } as unknown as RoomContext;
  return Promise.resolve(
    lessonsCommand({ db }).handler(ctx, {
      entity: "e_1" as EntityId,
      verb: "lessons",
      args,
      tokens: args.split(" ").filter(Boolean),
      raw: `lessons ${args}`,
    } as never),
  ).then(() => out.join("\n"));
}

describe("serving imported lessons", () => {
  it("distill → bootstrap → recall serves the imported lesson, labelled, below a local trusted one", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const bundle = distill(await sourceWorld());
    // The private lesson never left the source world.
    const bundleText = readdirSync(bundle)
      .map((f) => readFileSync(join(bundle, f), "utf8"))
      .join("\n");
    expect(bundleText).not.toContain(PRIVATE_OWN);
    expect(bundleText).toContain(IMPORTED_CODE);

    const db = freshDb();
    const local = "rerun the flaky integration suite twice and read the failing log";
    await lessonSinkFor(db).write(lesson("code", local));
    await bootstrap(db, bundle);
    expect(importedLessonsMode(db, {})).toBe("on");

    const got = await recallForWork(db, ["code", "meta"], "flaky integration suite", {
      env: ON,
      asOf: NOW,
    });
    expect(texts(got.inject)).toEqual([local, IMPORTED_CODE]);
    const imported = got.inject[1]!;
    expect(imported.trust).toBe("imported");
    expect(imported.imported?.itemKey).toMatch(/^lesson:/);
    expect(formatLesson(imported)).toBe(`${IMPORTED_CODE} (imported)`);
    expect(lessonsBlock(got.inject)).toContain(`- ${IMPORTED_CODE} (imported)`);

    // The resident section reads `lessons <topic> for:code`: labelled there too.
    const out = await runLessons(db, "flaky integration suite for:code");
    expect(out).toContain(`${IMPORTED_CODE} (imported)`);
    expect(out.indexOf(local)).toBeLessThan(out.indexOf(IMPORTED_CODE));
    // Served once is recorded once.
    expect(db.countUpstreamEventItems("served")).toBe(1);
  });

  it("labels an unsigned bundle's lessons `unsigned`", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const bundle = distill(await sourceWorld(), null);
    const db = freshDb();
    await bootstrap(db, bundle, "own,unsigned");
    const got = await recallLessons(db, "code", "flaky integration suite", { env: ON, asOf: NOW });
    expect(got.inject.map(formatLesson)).toEqual([`${IMPORTED_CODE} (imported, unsigned)`]);
  });

  it("keeps family scoping, the owner scope, leakage rule 2 and the as-of fence", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const bundle = distill(await sourceWorld());
    const db = freshDb();
    await bootstrap(db, bundle);
    const recall = (domain: Lesson["domain"], q: string, over = {}) =>
      recallLessons(db, domain, q, { env: ON, asOf: NOW, ...over }).then((r) => texts(r.inject));

    // Family scoping: a family-scoped lesson reaches only work naming that family.
    expect(await recall("code", "pin interpreter pytest")).toEqual([]);
    expect(await recall("code", "pin interpreter pytest", { families: ["family:python"] })).toEqual(
      [IMPORTED_PY],
    );

    // Leakage rule 2: tagged for gpqa-diamond, so a measurement of that board never sees it.
    const q = "grader tool schema";
    expect(await recall("tools", q)).toEqual([IMPORTED_BOARD]);
    expect(
      await recall("tools", q, { eval: { benchmark: "gpqa-diamond", mode: "measure" } }),
    ).toEqual([]);
    expect(await recall("tools", q, { eval: { benchmark: "gpqa-diamond", mode: "live" } })).toEqual(
      [IMPORTED_BOARD],
    );
    expect(
      await recall("tools", q, { eval: { benchmark: "other-board", mode: "measure" } }),
    ).toEqual([IMPORTED_BOARD]);

    // The as-of fence: visible only once its outcome was known.
    const late = "forecast interval turnout stale";
    expect(await recall("forecast", late, { asOf: "2026-09-15T00:00:00.000Z" })).toEqual([]);
    expect(await recall("forecast", late, { asOf: "2026-10-02T00:00:00.000Z" })).toEqual([
      IMPORTED_LATE,
    ]);
    // An undated imported lesson is never visible.
    const undated = lesson("code", "x", { trust: "imported", resolvedAt: "" });
    expect(selectServed([undated], NOW)).toEqual([]);

    // Owner scope: a person's own lessons stay theirs; imported ones are shared.
    db.createUser({ id: "u_a", name: "personone" });
    db.createUser({ id: "u_b", name: "persontwo" });
    const mine = "my own flaky integration suite habit is to bisect first";
    await ownerLessonSink(db, "personone").write(lesson("code", mine));
    const query = "flaky integration suite";
    expect(await recall("code", query, { owner: "personone" })).toEqual([mine, IMPORTED_CODE]);
    expect(await recall("code", query, { owner: "persontwo" })).toEqual([IMPORTED_CODE]);
  });

  it("MARINA_IMPORTED_LESSONS=off is byte-identical; observe records and serves nothing", async () => {
    const bundle = distill(await sourceWorld());
    const db = freshDb();
    await lessonSinkFor(db).write(
      lesson("code", "rerun the flaky integration suite twice and read the failing log"),
    );
    const topic = "flaky integration suite";
    let before: string;
    let beforeWork: string;
    {
      using _env = scopeProcessState({ env: NO_PROVIDER });
      before = await runLessons(db, topic);
      beforeWork = await runLessons(db, `${topic} for:code`);
    }
    await bootstrap(db, bundle);
    {
      using _env = scopeProcessState({ env: { ...NO_PROVIDER, MARINA_IMPORTED_LESSONS: "off" } });
      expect(await runLessons(db, topic)).toBe(before);
      expect(await runLessons(db, `${topic} for:code`)).toBe(beforeWork);
      expect(importedLessonLink(db)).toBeUndefined();
    }
    {
      using _env = scopeProcessState({
        env: { ...NO_PROVIDER, MARINA_IMPORTED_LESSONS: "observe" },
      });
      expect(await runLessons(db, topic)).toBe(before);
      expect(await runLessons(db, `${topic} for:code`)).toBe(beforeWork);
      expect(db.countUpstreamEventItems("observed")).toBe(1);
      expect(db.countUpstreamEventItems("served")).toBe(0);
    }
    {
      using _env = scopeProcessState({ env: NO_PROVIDER });
      expect(await runLessons(db, topic)).toContain(`${IMPORTED_CODE} (imported)`);
    }
    expect(importedLessonsSetting({ MARINA_IMPORTED_LESSONS: "junk" })).toBeUndefined();
    expect(importedLessonsMode(freshDb(), {})).toBe("off");
  });
});

/** A judge answering every question with `answers[k]` (default 0.9). */
function judge(answers: Record<string, number> = {}): DecisionProvider {
  return {
    kind: "test",
    model: "test/jev",
    calibrated: true,
    async ask(request) {
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: answers[k] ?? 0.9 }]),
        ),
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        calibrated: true,
      } as never;
    },
  };
}

describe("local outcomes move imported lessons", () => {
  const outcome = (rule: string) => ({
    domain: "code" as const,
    source: "code:verify",
    succeeded: true,
    resolvedAt: NOW,
    attempted: "integration test run",
    rule,
  });

  it("a matching local trusted lesson confirms it and serves in its place", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const db = freshDb();
    await bootstrap(db, distill(await sourceWorld()));
    const link = importedLessonLink(db, {});
    expect(link).toBeDefined();
    const r = await recordOutcome(
      { sink: lessonSinkFor(db), judge: judge(), imported: link! },
      outcome(IMPORTED_CODE),
    );
    expect(r.trust).toBe("trusted");
    expect(r.lesson.refs?.some((x) => x.startsWith("upstream:lesson:"))).toBe(true);
    const row = db.listLearnedItems().find((i) => i.kind === "lesson" && i.confirmed_by);
    expect(row?.confirmed_by).toBe(r.lessonId!);
    const got = await recallLessons(db, "code", "flaky integration suite", { env: ON, asOf: NOW });
    expect(got.inject.map((l) => l.trust)).toEqual(["trusted"]);
    expect(learnedCheck(db, {}).detail).toContain("1 confirmed locally");
  });

  it("a contradicting local trusted lesson retires it, and re-import keeps it retired", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const db = freshDb();
    const bundle = distill(await sourceWorld());
    await bootstrap(db, bundle);
    const r = await recordOutcome(
      {
        sink: lessonSinkFor(db),
        judge: judge({ consistent: 0.1 }),
        imported: importedLessonLink(db, {})!,
      },
      outcome("never rerun a flaky integration suite; quarantine the test instead"),
    );
    // Written trusted, not held: the imported lesson is lower trust than local evidence.
    expect(r.trust).toBe("trusted");
    expect(r.contests).toBeUndefined();
    expect(db.countUpstreamEventItems("contradicted")).toBe(1);
    const retired = db.listLearnedItems({ status: "retired" }).filter((i) => i.kind === "lesson");
    expect(retired).toHaveLength(1);
    const got = await recallLessons(db, "code", "flaky integration suite", { env: ON, asOf: NOW });
    expect(texts(got.inject)).not.toContain(IMPORTED_CODE);

    const again = await importLearnedBundle(db, bundle, {
      pinned: pin(KEY),
      env: { MARINA_UPSTREAM: "on" } as NodeJS.ProcessEnv,
      entitlement: { verifier: "own", tiers: [], licensee: "operator" },
    });
    expect(again.ok).toBe(true);
    expect(db.getLearnedItem(retired[0]!.artifact_id, retired[0]!.item_key)?.status).toBe(
      "retired",
    );
  });
});

describe("MARINA_UPSTREAM unset imports only open bundles signed by a pinned key", () => {
  async function exported(open: boolean, signingKey: string | null = KEY.privateKey) {
    const source = new MarinaDB(join(tmp("open-src-"), "s.db"));
    dbs.push(source);
    await lessonSinkFor(source).write(lesson("code", IMPORTED_CODE));
    const outDir = join(tmp("open-out-"), "bundle");
    exportLearnedBundle(source, {
      outDir,
      name: "openpack",
      publisher: { name: "Test Publisher" },
      signingKey,
      ...(signingKey === null ? { unsignedIdentity: "test" } : {}),
      open,
      marinaVersion: "0.9.0",
    });
    return outDir;
  }

  it("imports an open bundle signed by a pinned key; explicit off still refuses", async () => {
    const dir = await exported(true);
    expect(upstreamMode({})).toBe("open");
    const off = freshDb();
    const refused = await importLearnedBundle(off, dir, {
      pinned: pin(KEY),
      env: { MARINA_UPSTREAM: "off" } as NodeJS.ProcessEnv,
    });
    expect(refused.ok).toBe(false);
    expect(off.listUpstreamEvents()).toHaveLength(0);

    const db = freshDb();
    const ok = await importLearnedBundle(db, dir, { pinned: pin(KEY), env: {} });
    expect(ok.ok).toBe(true);
    const got = await recallLessons(db, "code", "flaky integration suite", { env: ON, asOf: NOW });
    expect(got.inject.map(formatLesson)).toEqual([`${IMPORTED_CODE} (imported)`]);
  });

  it("refuses, writing nothing, a private, unpinned or unsigned bundle", async () => {
    const cases: Array<[string, PinnedKey[], { allowUnsigned?: boolean }]> = [
      [await exported(false), pin(KEY), {}],
      [await exported(true), pin(OTHER), {}],
      [await exported(true, null), pin(KEY), { allowUnsigned: true }],
    ];
    for (const [dir, pinned, extra] of cases) {
      const db = freshDb();
      const out = await importLearnedBundle(db, dir, {
        pinned,
        env: {},
        entitlement: { verifier: "own", tiers: [], licensee: "operator" },
        ...extra,
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain("MARINA_UPSTREAM unset");
      expect(db.listUpstreamEvents()).toHaveLength(0);
      expect(db.getUserByName(UPSTREAM_ACCOUNT)).toBeUndefined();
    }
  });

  it("describes the unset mode truthfully: with no key pinned, nothing imports", () => {
    expect(describeUpstreamMode("open", 0)).toContain("no key is pinned, so nothing imports");
    expect(describeUpstreamMode("open", 2)).toContain("2 pinned publisher key(s)");
    const db = freshDb();
    expect(learnedCheck(db, {}).detail).toContain("no key is pinned, so nothing imports");
  });
});

describe("readiness learned", () => {
  it("reports bundles, signed or unsigned, lesson counts and the last import", async () => {
    using _env = scopeProcessState({ env: NO_PROVIDER });
    const db = freshDb();
    expect(learnedCheck(db, {})).toMatchObject({ id: "learned", status: "off", optional: true });
    await bootstrap(db, distill(await sourceWorld()));
    await recallLessons(db, "code", "flaky integration suite", { env: ON, asOf: NOW });
    const check = learnedCheck(db, {});
    expect(check).toMatchObject({ id: "learned", status: "ok", optional: true });
    expect(check.detail).toContain("1 bundle(s): distilled gen 1 (signed)");
    expect(check.detail).toContain("4 imported lesson(s) (4 active, 0 retired)");
    expect(check.detail).toContain("serving on: 1 served");
    expect(check.detail).toMatch(/last import \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    const observing = learnedCheck(db, { MARINA_IMPORTED_LESSONS: "observe" });
    expect(observing.status).toBe("degraded");
    expect(observing.remediation).toContain("observe");
  });
});
