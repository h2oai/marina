// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test the right versions: results record the Marina commit that produced
 * them, and the transfer report refuses comparisons across mixed, unknown or
 * dirty code unless a version comparison is declared. Git is always injected;
 * nothing here spends money.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ledgerFileBody } from "../benchmarks/ledger-file";
import { resultForDisk } from "../benchmarks/result-file";
import { setRunVersionForTests, stamped } from "../benchmarks/run-version";
import { browsecompAdapter, ledgerAdapter, sourceVersions } from "../benchmarks/transfer/adapters";
import { renderMarkdown, type SuiteData, transferVerdict } from "../benchmarks/transfer/core";
import { buildInventory, renderInventory } from "../benchmarks/transfer/inventory";
import { listLedgerRuns, openReadOnly } from "../benchmarks/transfer/ledger";
import { loadSuites, parseSpec, type TransferSpec } from "../benchmarks/transfer/spec";
import {
  checkVersions,
  fileVersions,
  type GitInfo,
  localGit,
  type SourceVersions,
  stampsIn,
} from "../benchmarks/transfer/versions";
import type { BenchmarkResult } from "../benchmarks/types";
import { ledgerFromHarnessResult, stableResultHash } from "../src/engine/benchmark-ledger";
import {
  type MarinaVersion,
  readGitVersion,
  sameCommit,
  versionFromSourceRevision,
} from "../src/engine/run-version";

const dir = mkdtempSync(join(tmpdir(), "eval-versions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setRunVersionForTests(undefined));

const A = "a".repeat(40);
const B = "b".repeat(40);
const MAIN = "c".repeat(40);
const v = (commit: string, dirty = false, describe = commit.slice(0, 7)): MarinaVersion => ({
  commit,
  dirty,
  describe,
});

/** Fake local git: tags resolve to shas; `behind` from a table (undefined = unknown). */
function fakeGit(tags: Record<string, string> = {}, behind: Record<string, number> = {}): GitInfo {
  return {
    mainRef: "origin/main",
    resolve: (ref) => tags[ref] ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : undefined),
    behind: (c) => behind[c],
  };
}

const src = (path: string, ...stamps: MarinaVersion[]): SourceVersions => ({
  path,
  stamps,
  unstamped: stamps.length ? 0 : 1,
});

describe("stamping results", () => {
  test("resultForDisk stamps the run's version and keeps an existing stamp", () => {
    setRunVersionForTests(v(A));
    const result = {
      config: { name: "x", apiKey: "secret" },
      items: [],
    } as unknown as BenchmarkResult;
    const disk = resultForDisk(result);
    expect(disk.marina).toEqual(v(A));
    expect((disk.config as { apiKey?: string }).apiKey).toBeUndefined();
    expect(resultForDisk({ ...result, marina: v(B) }).marina).toEqual(v(B));
    // The ledger filing body carries the stamp.
    const body = ledgerFileBody(result, { fileTo: "http://x", targetKind: "model", target: "m" });
    expect(body.result.marina).toEqual(v(A));
  });

  test("outside a git checkout nothing is stamped", () => {
    setRunVersionForTests(null);
    expect(stamped({ a: 1 })).toEqual({ a: 1 });
    expect(stamped({ a: 1 }, v(A))).toEqual({ a: 1, marina: v(A) });
  });

  test("readGitVersion reads commit, dirty and describe from injected git", () => {
    const calls: string[][] = [];
    const git = (out: Record<string, string | undefined>) => (args: string[]) => {
      calls.push(args);
      return out[args[0]!];
    };
    expect(readGitVersion("/x", git({ "rev-parse": A, status: "", describe: "v1.2.0" }))).toEqual({
      commit: A,
      dirty: false,
      describe: "v1.2.0",
    });
    expect(readGitVersion("/x", git({ "rev-parse": A, status: " M src/x.ts" }))).toEqual({
      commit: A,
      dirty: true,
      describe: `${A.slice(0, 12)}-dirty`,
    });
    expect(readGitVersion("/x", git({}))).toBeUndefined();
    // Untracked files (results a run writes) never make a checkout dirty.
    expect(calls.find((a) => a[0] === "status")).toContain("--untracked-files=no");
  });

  test("in-world source revisions and abbreviated shas compare as commits", () => {
    expect(versionFromSourceRevision("aaaaaaaaaaaa-dirty")).toEqual({
      commit: "aaaaaaaaaaaa",
      dirty: true,
      describe: "aaaaaaaaaaaa-dirty",
    });
    expect(versionFromSourceRevision("nope")).toBeUndefined();
    expect(sameCommit(A, "aaaaaaa")).toBe(true);
    expect(sameCommit(A, "aaaaaa")).toBe(false);
    expect(sameCommit(A, B)).toBe(false);
  });
});

describe("reading stamps", () => {
  test("top-level, per-record and missing stamps", () => {
    expect(stampsIn({ marina: v(A), items: [] })).toEqual({ stamps: [v(A)], unstamped: 0 });
    expect(stampsIn([{ id: 1, marina: v(A) }, { id: 2, marina: v(B) }, { id: 3 }])).toEqual({
      stamps: [v(A), v(B)],
      unstamped: 1,
    });
    expect(stampsIn([{ id: 1 }, { id: 2 }])).toEqual({ stamps: [], unstamped: 1 });
    expect(stampsIn({ marina: { commit: "zz", dirty: false } })).toEqual({
      stamps: [],
      unstamped: 1,
    });
  });

  test("a BrowseComp evals directory is stamped per query file", () => {
    const evals = join(dir, "bc", "evals");
    mkdirSync(evals, { recursive: true });
    writeFileSync(join(evals, "run_1_eval.json"), JSON.stringify({ query_id: "1", marina: v(A) }));
    writeFileSync(join(evals, "run_2_eval.json"), JSON.stringify({ query_id: "2", marina: v(B) }));
    writeFileSync(join(evals, "notes.json"), JSON.stringify({ other: true }));
    expect(sourceVersions(browsecompAdapter, { path: evals })).toEqual({
      stamps: [v(A), v(B)],
      unstamped: 0,
    });
    expect(fileVersions(evals).unstamped).toBe(1);
    expect(fileVersions(join(dir, "missing.json"))).toEqual({ stamps: [], unstamped: 1 });
  });

  test("ledger runs: config_json.marina, else the in-world source revision", () => {
    const path = join(dir, "ledger.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE benchmark_runs (id TEXT PRIMARY KEY, benchmark TEXT NOT NULL, config_json TEXT NOT NULL,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, label TEXT,
      source TEXT, replicate_group TEXT, target_json TEXT);
      CREATE TABLE benchmark_items (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, item_id TEXT NOT NULL,
      correct INTEGER NOT NULL, score REAL);`);
    const run = db.prepare(
      "INSERT INTO benchmark_runs (id, benchmark, config_json, status, started_at, label, target_json) VALUES (?, 'fb', ?, 'completed', ?, ?, ?)",
    );
    run.run("s1", JSON.stringify({ model: "m", marina: v(A) }), 1, "arm r1", null);
    run.run("s2", JSON.stringify({ model: "m" }), 2, "arm r2", JSON.stringify({ source: B }));
    run.run("s3", JSON.stringify({ model: "m" }), 3, "old r1", JSON.stringify({ model: "m" }));
    db.close();
    const h = openReadOnly(path);
    const runs = listLedgerRuns(h.db);
    h.close();
    expect(runs.find((r) => r.id === "s1")!.version).toEqual(v(A));
    expect(runs.find((r) => r.id === "s2")!.version!.commit).toBe(B);
    expect(runs.find((r) => r.id === "s3")!.version).toBeUndefined();
    expect(sourceVersions(ledgerAdapter, { path, arm: "arm" })).toEqual({
      stamps: [v(A), versionFromSourceRevision(B)!],
      unstamped: 0,
    });
    expect(sourceVersions(ledgerAdapter, { path, arm: "old" }).unstamped).toBe(1);
  });

  test("filing a stamped result keeps the stamp in config_json, out of both hashes", () => {
    const file = {
      config: { dataset: "fb", model: "m" },
      timestamp: 5,
      items: [{ id: "q1", correct: true, latencyMs: 3 }],
    };
    const opts = { targetKind: "model" as const, target: "m", id: "r", now: 9 };
    const plain = ledgerFromHarnessResult(file, { ...opts, raw: JSON.stringify(file) });
    const withStamp = { ...file, marina: v(A) };
    const filed = ledgerFromHarnessResult(withStamp, { ...opts, raw: JSON.stringify(withStamp) });
    expect(JSON.parse(filed.run.config_json).marina).toEqual(v(A));
    expect(JSON.parse(plain.run.config_json).marina).toBeUndefined();
    expect(filed.run.config_hash).toBe(plain.run.config_hash);
    expect(stableResultHash(JSON.stringify(withStamp))).toBe(
      stableResultHash(JSON.stringify(file)),
    );
    // A malformed stamp is dropped, never stored.
    const junk = { ...file, marina: { commit: "x" } };
    const dropped = ledgerFromHarnessResult(junk, { ...opts, raw: JSON.stringify(junk) });
    expect(JSON.parse(dropped.run.config_json).marina).toBeUndefined();
  });
});

describe("the version rule", () => {
  const git = fakeGit({ "v1.0.0": A, "v1.1.0": B }, { [A]: 3, [MAIN]: 0 });

  test("one clean commit counts; behind main is a warning, not an exclusion", () => {
    const ok = checkVersions(
      { baseline: [src("b.json", v(MAIN))], candidate: [src("c.json", v(MAIN))] },
      { git },
    );
    expect(ok.status).toBe("same-commit");
    expect(ok.counted).toBe(true);
    expect(ok.warnings).toEqual([]);
    const stale = checkVersions(
      { baseline: [src("b.json", v(A))], candidate: [src("c.json", v("aaaaaaaaaaaa"))] },
      { git },
    );
    expect(stale.status).toBe("same-commit");
    expect(stale.warnings[0]).toMatch(/3 commit\(s\) behind origin\/main/);
    const unknown = checkVersions(
      { baseline: [src("b.json", v(B))], candidate: [src("c.json", v(B))] },
      { git: fakeGit() },
    );
    expect(unknown.warnings[0]).toMatch(/not in the local repository/);
  });

  test("mixed commits are a version-mismatch; unstamped or dirty are version-unknown", () => {
    const mixed = checkVersions({
      baseline: [src("b.json", v(A))],
      candidate: [src("c1.json", v(B)), src("c2.json", v(B))],
    });
    expect(mixed.status).toBe("version-mismatch");
    expect(mixed.counted).toBe(false);
    expect(mixed.commits).toEqual({ baseline: [A.slice(0, 12)], candidate: [B.slice(0, 12)] });
    // One arm's replicates on two commits is mixed too.
    expect(
      checkVersions({
        baseline: [src("b1.json", v(A)), src("b2.json", v(B))],
        candidate: [src("c.json", v(A))],
      }).status,
    ).toBe("version-mismatch");
    const unstamped = checkVersions({
      baseline: [src("b.json")],
      candidate: [src("c.json", v(A))],
    });
    expect(unstamped.status).toBe("version-unknown");
    expect(unstamped.reason).toMatch(/--allow-unversioned/);
    expect(unstamped.commits.baseline).toEqual(["unstamped×1"]);
    const dirty = checkVersions({
      baseline: [src("b.json", v(A, true))],
      candidate: [src("c.json", v(A, true))],
    });
    expect(dirty.status).toBe("version-unknown");
    expect(dirty.reason).toMatch(/uncommitted/);
  });

  test("--allow-unversioned lets unstamped sources count, labelled", () => {
    const r = checkVersions(
      { baseline: [src("b.json")], candidate: [src("c.json", v(MAIN))] },
      { allowUnversioned: true, git },
    );
    expect(r.status).toBe("unversioned");
    expect(r.counted).toBe(true);
    // It never hides mixed commits among the stamped ones.
    expect(
      checkVersions(
        {
          baseline: [src("b.json"), src("b2.json", v(A))],
          candidate: [src("c.json", v(B))],
        },
        { allowUnversioned: true },
      ).status,
    ).toBe("version-mismatch");
  });

  test("a declared version comparison checks each arm against its own ref", () => {
    const declared = { baseline: "v1.0.0", candidate: "v1.1.0" };
    const ok = checkVersions(
      { baseline: [src("b.json", v(A))], candidate: [src("c.json", v(B))] },
      { declared, git },
    );
    expect(ok.status).toBe("version-comparison");
    expect(ok.counted).toBe(true);
    expect(ok.declared).toEqual({ ...declared, baselineCommit: A, candidateCommit: B });
    expect(ok.warnings).toEqual([]);
    const swapped = checkVersions(
      { baseline: [src("b.json", v(B))], candidate: [src("c.json", v(B))] },
      { declared, git },
    );
    expect(swapped.status).toBe("version-mismatch");
    expect(swapped.reason).toMatch(/baseline source .* not the declared baseline version v1\.0\.0/);
    // A sha prefix needs no git; an unknown tag matches only a stamp's own describe.
    expect(
      checkVersions(
        { baseline: [src("b.json", v(A))], candidate: [src("c.json", v(B))] },
        { declared: { baseline: "aaaaaaa", candidate: "bbbbbbb" } },
      ).status,
    ).toBe("version-comparison");
    expect(
      checkVersions(
        {
          baseline: [src("b.json", v(A, false, "v0.9"))],
          candidate: [src("c.json", v(B, false, "v0.9.1"))],
        },
        { declared: { baseline: "v0.9", candidate: "v0.9.1" }, git: fakeGit() },
      ).status,
    ).toBe("version-comparison");
    expect(
      checkVersions(
        { baseline: [src("b.json", v(A))], candidate: [src("c.json", v(B))] },
        { declared: { baseline: "v9", candidate: "v1.1.0" }, git },
      ).status,
    ).toBe("version-unknown");
  });
});

/** Items files for a suite whose candidate is clearly better. */
function writeArm(path: string, shift: number, marina?: MarinaVersion) {
  const items = Array.from({ length: 40 }, (_, i) => ({
    id: `q${i}`,
    score: (i % 10) / 10 + shift,
  }));
  writeFileSync(path, JSON.stringify(marina ? { marina, items } : items));
}

describe("the transfer report under the version guard", () => {
  const sub = join(dir, "spec");
  mkdirSync(sub, { recursive: true });
  const suite = (name: string) => ({
    name,
    adapter: "items",
    baseline: [`${name}-b.json`],
    candidate: [`${name}-c.json`],
  });
  const spec = (extra: Partial<TransferSpec> = {}): TransferSpec => ({
    baseline: { label: "off" },
    candidate: { label: "on" },
    split: "all",
    stats: { resamples: 500 },
    suites: [suite("s1"), suite("s2"), suite("s3")],
    ...extra,
  });
  const git = fakeGit({ "v1.0.0": A, "v1.1.0": B }, { [MAIN]: 0, [A]: 5 });

  test("a mixed-commit suite is reported, not counted, and can sink the verdict", () => {
    for (const n of ["s1", "s2"]) {
      writeArm(join(sub, `${n}-b.json`), 0, v(MAIN));
      writeArm(join(sub, `${n}-c.json`), 0.2, v(MAIN));
    }
    // s3: the baseline arm came from an older commit (an old file reused).
    writeArm(join(sub, "s3-b.json"), 0, v(A));
    writeArm(join(sub, "s3-c.json"), 0.2, v(MAIN));
    const suites = loadSuites(spec(), { baseDir: sub, git });
    expect(suites.map((s) => s.version!.status)).toEqual([
      "same-commit",
      "same-commit",
      "version-mismatch",
    ]);
    const r = transferVerdict(suites, { resamples: 500 });
    expect(r.verdict).toBe("transfers");
    expect(r.versionExcluded).toEqual(["s3"]);
    const s3 = r.suites.find((s) => s.name === "s3")!;
    expect(s3.outcome).toBe("version-mismatch");
    expect(s3.statisticalOutcome).toBe("improves");
    expect(r.reason).toMatch(/not counted by the version guard \(s3\)/);
    const md = renderMarkdown(r, { baseline: { label: "off" }, candidate: { label: "on" } });
    expect(md).toContain("Versions: strict");
    expect(md).toContain("Not counted (version guard): s3");
    expect(md).toContain(`${A.slice(0, 12)} / ${MAIN.slice(0, 12)}`);

    // With only one good group left the verdict is insufficient, never "transfers".
    writeArm(join(sub, "s2-b.json"), 0, v(B));
    const two = transferVerdict(loadSuites(spec(), { baseDir: sub, git }), { resamples: 500 });
    expect(two.versionExcluded).toEqual(["s2", "s3"]);
    expect(two.verdict).toBe("insufficient");
  });

  test("a regression on mixed code is not counted either", () => {
    writeArm(join(sub, "s1-b.json"), 0.3, v(A));
    writeArm(join(sub, "s1-c.json"), 0, v(B));
    const [s1] = loadSuites(spec({ suites: [suite("s1")] }), { baseDir: sub, git });
    const r = transferVerdict([s1!], { resamples: 500 });
    expect(r.regressedSuites).toEqual([]);
    expect(r.suites[0]!.statisticalOutcome).toBe("regresses");
    expect(r.verdict).toBe("insufficient");
  });

  test("a declared release comparison counts and is labelled; a wrong arm is refused", () => {
    writeArm(join(sub, "s1-b.json"), 0, v(A));
    writeArm(join(sub, "s1-c.json"), 0.2, v(B));
    const versions = { baseline: "v1.0.0", candidate: "v1.1.0" };
    const [s1] = loadSuites(spec({ versions, suites: [suite("s1")] }), { baseDir: sub, git });
    expect(s1!.version!.status).toBe("version-comparison");
    // A declared comparison is on purpose: no behind-main warning.
    expect(s1!.version!.warnings).toEqual([]);
    const r = transferVerdict([s1!], { resamples: 500, minGroups: 1 });
    expect(r.suites[0]!.outcome).toBe("improves");
    const md = renderMarkdown(r, {
      baseline: { label: "off" },
      candidate: { label: "on" },
      versions,
    });
    expect(md).toContain("**Version comparison** (declared)");
    expect(md).toContain("(version-comparison)");
    const [bad] = loadSuites(
      spec({ versions: { baseline: "v1.1.0", candidate: "v1.1.0" }, suites: [suite("s1")] }),
      { baseDir: sub, git },
    );
    expect(bad!.version!.status).toBe("version-mismatch");
  });

  test("unstamped files are version-unknown unless allowed, then labelled", () => {
    writeArm(join(sub, "s1-b.json"), 0);
    writeArm(join(sub, "s1-c.json"), 0.2);
    const strict = loadSuites(spec({ suites: [suite("s1")] }), { baseDir: sub, git });
    expect(strict[0]!.version!.status).toBe("version-unknown");
    const allowed = loadSuites(spec({ suites: [suite("s1")] }), {
      baseDir: sub,
      git,
      allowUnversioned: true,
    });
    const r = transferVerdict(allowed, { resamples: 500, minGroups: 1 });
    expect(r.suites[0]!.outcome).toBe("improves");
    const md = renderMarkdown(r, {
      baseline: { label: "off" },
      candidate: { label: "on" },
      allowUnversioned: true,
    });
    expect(md).toContain("WARNING: --allow-unversioned");
    expect(md).toContain("(unversioned)");
    expect(md).toContain("unstamped×1 / unstamped×1");
  });

  test("specs validate declared versions", () => {
    const base = { baseline: { label: "a" }, candidate: { label: "b" }, suites: [suite("s1")] };
    expect(() => parseSpec({ ...base, versions: { baseline: "v1" } })).toThrow(/versions/);
    expect(() =>
      parseSpec({
        ...base,
        suites: [{ ...suite("s1"), versions: { baseline: "", candidate: "x" } }],
      }),
    ).toThrow(/suite s1 versions/);
    expect(parseSpec({ ...base, versions: { baseline: "v1", candidate: "v2" } }).versions).toEqual({
      baseline: "v1",
      candidate: "v2",
    });
  });

  test("a suite with no version info (core used directly) is judged as before", () => {
    const plain: SuiteData = {
      name: "p",
      group: "p",
      split: "all",
      baseline: [Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, score: 0 }))],
      candidate: [Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, score: 1 }))],
    };
    const r = transferVerdict([plain], { resamples: 200, minGroups: 1 });
    expect(r.suites[0]!.outcome).toBe("improves");
    expect(r.versionExcluded).toEqual([]);
  });
});

describe("local git (injected command)", () => {
  test("resolves refs and counts commits behind the main ref without the network", () => {
    const seen: string[][] = [];
    const git = localGit("/repo", {
      git: (args) => {
        seen.push(args);
        if (args[0] === "rev-parse") {
          const ref = args[3]!.replace("^{commit}", "");
          return ref === "origin/main" ? MAIN : ref === "v1" ? A : undefined;
        }
        if (args[0] === "rev-list") return args[2] === `${A}..origin/main` ? "7" : undefined;
        return undefined;
      },
    });
    expect(git.resolve("v1")).toBe(A);
    expect(git.behind("v1")).toBe(7);
    expect(git.behind("nope")).toBeUndefined();
    expect(seen.every((a) => ["rev-parse", "rev-list"].includes(a[0]!))).toBe(true);
  });
});

describe("inventory and CLI", () => {
  test("the inventory lists each variant's commits and each pair's version status", () => {
    const root = join(dir, "inv");
    mkdirSync(join(root, "h"), { recursive: true });
    const harness = (model: string, shift: number, marina?: MarinaVersion) =>
      JSON.stringify({
        config: { dataset: "zz-board", model },
        ...(marina ? { marina } : {}),
        items: Array.from({ length: 12 }, (_, i) => ({
          id: `q${i}`,
          correct: true,
          score: i / 20 + shift,
        })),
      });
    writeFileSync(join(root, "h", "a.json"), harness("base", 0, v(A)));
    writeFileSync(join(root, "h", "b.json"), harness("cand", 0.1, v(A)));
    writeFileSync(join(root, "h", "c.json"), harness("next", 0.2, v(B)));
    writeFileSync(join(root, "h", "d.json"), harness("old", 0.3));
    const inv = buildInventory({ roots: [root] });
    const zz = inv.suites.find((s) => s.suite === "zz-board")!;
    expect(zz.variants.find((x) => x.label === "base")!.commits).toEqual([A.slice(0, 12)]);
    expect(zz.variants.find((x) => x.label === "old")!.commits).toEqual(["unstamped×1"]);
    const pair = (a: string, b: string) =>
      zz.pairs.find((p) => [p.baseline, p.candidate].sort().join() === [a, b].sort().join())!;
    expect(pair("base", "cand").versions).toBe("same-commit");
    expect(pair("base", "next").versions).toBe("mixed");
    expect(pair("base", "old").versions).toBe("unknown");
    const md = renderInventory(inv);
    expect(md).toContain("| Commits |");
    expect(md).toContain("MIXED commits");
  });

  test("eval:transfer exits 2 on unstamped files and labels --allow-unversioned", () => {
    const sub = join(dir, "cli");
    mkdirSync(sub, { recursive: true });
    for (const n of ["a", "b"]) {
      writeArm(join(sub, `${n}-b.json`), 0);
      writeArm(join(sub, `${n}-c.json`), 0.2);
    }
    writeFileSync(
      join(sub, "spec.json"),
      JSON.stringify({
        baseline: { label: "off" },
        candidate: { label: "on" },
        split: "all",
        stats: { resamples: 500 },
        suites: ["a", "b"].map((n) => ({
          name: n,
          adapter: "items",
          baseline: [`${n}-b.json`],
          candidate: [`${n}-c.json`],
        })),
      }),
    );
    const out = join(sub, "report");
    const run = (extra: string[]) =>
      Bun.spawnSync(
        [
          "bun",
          "run",
          resolve(import.meta.dir, "../scripts/eval-transfer.ts"),
          "--spec",
          join(sub, "spec.json"),
          "--out",
          out,
          ...extra,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    const strict = run([]);
    expect(strict.exitCode).toBe(2);
    expect(strict.stderr.toString()).toMatch(/version guard: a version-unknown/);
    const json = JSON.parse(readFileSync(`${out}.json`, "utf8"));
    expect(json.verdict).toBe("insufficient");
    expect(json.versionExcluded).toEqual(["a", "b"]);
    const allowed = run(["--allow-unversioned"]);
    expect(allowed.exitCode).toBe(0);
    expect(readFileSync(`${out}.md`, "utf8")).toContain("WARNING: --allow-unversioned");
  });
});
