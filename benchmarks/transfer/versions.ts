// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test the right versions: which Marina code produced each source of a
 * transfer suite, and whether the comparison is allowed to count.
 *
 * A capability comparison changes ONE thing between the arms (the env-knob
 * overlay), so by default every source of both arms must come from the same
 * clean commit. A suite whose sources are mixed is `version-mismatch`; one
 * with an unstamped or dirty source is `version-unknown`. Either is reported
 * and never counted toward the verdict. A commit behind `origin/main` is a
 * warning (the default is newest main). A spec may instead declare
 * `versions: { baseline, candidate }` (a release-vs-release or regression
 * test): then each arm must be at its declared commit and the suite is a
 * version comparison. `allowUnversioned` (`--allow-unversioned`) ingests
 * unstamped sources on purpose, labelled loudly in the report.
 *
 * Stamps are written by `benchmarks/run-version.ts` (`marina` on a result
 * document or on each record) and read here; ledger runs carry them in
 * `config_json.marina` or, for in-world runs, `target_json.source`. Git is
 * injected (`GitInfo`) so tests never spawn anything; `localGit` reads the
 * local repository only, never the network.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  asMarinaVersion,
  type GitCommand,
  type MarinaVersion,
  sameCommit,
  spawnGit,
  versionLabel,
} from "../../src/engine/run-version";

export type { MarinaVersion } from "../../src/engine/run-version";

/** What one source says about the code behind it. */
export interface VersionScan {
  /** Distinct stamps found (by commit and dirty flag). */
  stamps: MarinaVersion[];
  /** Runs, files or records with no stamp. */
  unstamped: number;
}

export interface SourceVersions extends VersionScan {
  path: string;
  arm?: string;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Add a stamp to a list unless an equal one (same commit, same dirty flag) is there. */
export function addStamp(list: MarinaVersion[], v: MarinaVersion): void {
  if (!list.some((x) => x.dirty === v.dirty && sameCommit(x.commit, v.commit))) list.push(v);
}

export function mergeScans(scans: readonly VersionScan[]): VersionScan {
  const stamps: MarinaVersion[] = [];
  let unstamped = 0;
  for (const s of scans) {
    for (const v of s.stamps) addStamp(stamps, v);
    unstamped += s.unstamped;
  }
  return { stamps, unstamped };
}

/**
 * Stamps in one parsed document: a top-level `marina`, else one per record of
 * an array / `{items}` / JSONL (records without one count as unstamped only
 * when some record has one; a document with none is one unstamped unit).
 */
export function stampsIn(doc: unknown): VersionScan {
  const top = isRecord(doc) ? asMarinaVersion(doc.marina) : undefined;
  if (top) return { stamps: [top], unstamped: 0 };
  const records = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc.items)
      ? doc.items
      : undefined;
  if (!records) return { stamps: [], unstamped: 1 };
  const stamps: MarinaVersion[] = [];
  let missing = 0;
  for (const r of records) {
    const v = isRecord(r) ? asMarinaVersion(r.marina) : undefined;
    if (v) addStamp(stamps, v);
    else missing++;
  }
  return stamps.length ? { stamps, unstamped: missing } : { stamps: [], unstamped: 1 };
}

function parseDoc(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return undefined;
        }
      });
  }
}

/**
 * Stamps of a result file, or of every JSON/JSONL file directly in a
 * directory (each file one unit). An unreadable path is one unstamped unit.
 */
export function fileVersions(path: string, pick?: (name: string) => boolean): VersionScan {
  try {
    if (!statSync(path).isDirectory()) return stampsIn(parseDoc(readFileSync(path, "utf8")));
    const files = readdirSync(path)
      .filter((f) => /\.jsonl?$/.test(f) && (!pick || pick(f)))
      .sort();
    if (files.length === 0) return { stamps: [], unstamped: 1 };
    return mergeScans(files.map((f) => stampsIn(parseDoc(readFileSync(join(path, f), "utf8")))));
  } catch {
    return { stamps: [], unstamped: 1 };
  }
}

/** A FutureX run directory (or its score.json): the stamp on `score.json`. */
export function futurexVersions(path: string): VersionScan {
  try {
    const score = statSync(path).isDirectory() ? join(path, "score.json") : path;
    return existsSync(score) ? fileVersions(score) : { stamps: [], unstamped: 1 };
  } catch {
    return { stamps: [], unstamped: 1 };
  }
}

/** Local git, read-only: resolve refs and count commits behind the main ref. */
export interface GitInfo {
  /** The ref "newest main" means (default `origin/main`). */
  mainRef: string;
  /** Full sha of a ref (sha, tag, branch), or undefined when unknown locally. */
  resolve(ref: string): string | undefined;
  /** Commits on `mainRef` not contained in `commit`; undefined when either is unknown locally. */
  behind(commit: string): number | undefined;
}

export function localGit(
  cwd = join(import.meta.dir, "..", ".."),
  opts: { mainRef?: string; git?: GitCommand } = {},
): GitInfo {
  const git = opts.git ?? spawnGit;
  const mainRef = opts.mainRef ?? "origin/main";
  const resolved = new Map<string, string | undefined>();
  const resolve = (ref: string) => {
    if (!resolved.has(ref))
      resolved.set(ref, git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd));
    return resolved.get(ref);
  };
  return {
    mainRef,
    resolve,
    behind(commit) {
      const full = resolve(commit);
      if (!full || !resolve(mainRef)) return undefined;
      const n = git(["rev-list", "--count", `${full}..${mainRef}`], cwd);
      return n !== undefined && /^\d+$/.test(n) ? Number(n) : undefined;
    },
  };
}

/** Declared versions for a deliberate version comparison. */
export interface DeclaredVersions {
  baseline: string;
  candidate: string;
}

export type VersionStatus =
  /** Every source of both arms is at one clean commit. */
  | "same-commit"
  /** A declared version comparison; each arm at its declared commit. */
  | "version-comparison"
  /** Some or all sources are unstamped and were let in with `--allow-unversioned`. */
  | "unversioned"
  /** Sources on different commits (or not at a declared version). Not counted. */
  | "version-mismatch"
  /** An unstamped or dirty source, or a declared ref that does not resolve. Not counted. */
  | "version-unknown";

export interface VersionCheck {
  status: VersionStatus;
  /** Whether the suite may count toward the verdict. */
  counted: boolean;
  reason: string;
  /** Per arm: commit labels (`abc123def456`, `…+dirty`) and `unstamped×N`. */
  commits: { baseline: string[]; candidate: string[] };
  /** Declared comparison, with what each ref resolved to. */
  declared?: {
    baseline: string;
    candidate: string;
    baselineCommit?: string;
    candidateCommit?: string;
  };
  /** Not exclusions: e.g. the commit is behind the main ref. */
  warnings: string[];
}

export interface CheckOptions {
  declared?: DeclaredVersions;
  allowUnversioned?: boolean;
  git?: GitInfo;
}

const short = (c: string) => c.slice(0, 12);

function armLabels(sources: readonly SourceVersions[]): string[] {
  const merged = mergeScans(sources);
  return [
    ...merged.stamps.map(versionLabel),
    ...(merged.unstamped ? [`unstamped×${merged.unstamped}`] : []),
  ];
}

const sourceName = (s: SourceVersions) =>
  `${s.path.split(/[/\\]/).slice(-2).join("/")}${s.arm ? ` [${s.arm}]` : ""}`;

/** Does a stamp match a declared ref (resolved sha, sha prefix, or its describe/tag)? */
function matchesRef(v: MarinaVersion, ref: string, resolved: string | undefined): boolean {
  if (resolved) return sameCommit(v.commit, resolved);
  if (/^[0-9a-f]{7,40}$/.test(ref)) return sameCommit(v.commit, ref);
  return v.describe === ref;
}

/** The version rule for one suite. Pure apart from the injected git. */
export function checkVersions(
  arms: { baseline: readonly SourceVersions[]; candidate: readonly SourceVersions[] },
  opts: CheckOptions = {},
): VersionCheck {
  const commits = { baseline: armLabels(arms.baseline), candidate: armLabels(arms.candidate) };
  const all = [...arms.baseline, ...arms.candidate];
  const warnings: string[] = [];
  const result = (status: VersionStatus, reason: string, extra: Partial<VersionCheck> = {}) => ({
    status,
    counted: status !== "version-mismatch" && status !== "version-unknown",
    reason,
    commits,
    warnings,
    ...extra,
  });

  const unstamped = all.filter((s) => s.unstamped > 0);
  if (unstamped.length && !opts.allowUnversioned)
    return result(
      "version-unknown",
      `${unstamped.length} source(s) carry no Marina commit stamp (${unstamped.slice(0, 3).map(sourceName).join(", ")}${unstamped.length > 3 ? ", …" : ""}); rerun on the code under test, or pass --allow-unversioned to ingest them on purpose`,
    );
  const dirty = all.filter((s) => s.stamps.some((v) => v.dirty));
  if (dirty.length)
    return result(
      "version-unknown",
      `${dirty.length} source(s) ran with uncommitted changes (${dirty.slice(0, 3).map(sourceName).join(", ")}): the code they measured is not a commit; rerun from a clean checkout`,
    );

  if (opts.declared) {
    const baselineCommit = opts.git?.resolve(opts.declared.baseline);
    const candidateCommit = opts.git?.resolve(opts.declared.candidate);
    const declared = {
      baseline: opts.declared.baseline,
      candidate: opts.declared.candidate,
      ...(baselineCommit ? { baselineCommit } : {}),
      ...(candidateCommit ? { candidateCommit } : {}),
    };
    for (const arm of ["baseline", "candidate"] as const) {
      const ref = declared[arm];
      const resolved = arm === "baseline" ? declared.baselineCommit : declared.candidateCommit;
      // An unresolvable tag can still match a stamp's own describe (`v1.2.0`).
      if (
        !resolved &&
        !/^[0-9a-f]{7,40}$/.test(ref) &&
        arms[arm].some((s) => s.stamps.some((v) => v.describe !== ref))
      )
        return result(
          "version-unknown",
          `${arm} version "${ref}" does not resolve in the local repository (fetch its tag) and the stamps do not name it`,
          { declared },
        );
      for (const s of arms[arm]) {
        const off = s.stamps.find((v) => !matchesRef(v, ref, resolved));
        if (off)
          return result(
            "version-mismatch",
            `${arm} source ${sourceName(s)} ran on ${versionLabel(off)}, not the declared ${arm} version ${ref}${resolved ? ` (${short(resolved)})` : ""}`,
            { declared },
          );
      }
    }
    if (unstamped.length)
      return result(
        "unversioned",
        `version comparison ${declared.baseline} vs ${declared.candidate}; ${unstamped.length} unstamped source(s) let in by --allow-unversioned could not be checked`,
        { declared },
      );
    return result(
      "version-comparison",
      `version comparison: baseline at ${declared.baseline}, candidate at ${declared.candidate}`,
      { declared },
    );
  }

  const distinct: MarinaVersion[] = [];
  for (const s of all) for (const v of s.stamps) addStamp(distinct, v);
  if (distinct.length > 1)
    return result(
      "version-mismatch",
      `the arms ran on ${distinct.length} different commits (baseline ${commits.baseline.join(", ") || "—"}; candidate ${commits.candidate.join(", ") || "—"}): a capability comparison must hold the code fixed — rerun both arms on one commit, or declare "versions" to compare releases on purpose`,
    );
  const only = distinct[0];
  if (only && opts.git) {
    const behind = opts.git.behind(only.commit);
    if (behind === undefined)
      warnings.push(
        `commit ${short(only.commit)} is not in the local repository or ${opts.git.mainRef} is unknown (fetch to check it is current)`,
      );
    else if (behind > 0)
      warnings.push(
        `commit ${short(only.commit)} is ${behind} commit(s) behind ${opts.git.mainRef}: the default is to test newest main — rerun, or declare "versions" to test a prior release on purpose`,
      );
  }
  if (unstamped.length)
    return result(
      "unversioned",
      `${unstamped.length} unstamped source(s) let in by --allow-unversioned: their code version is unknown${only ? `; stamped sources are at ${versionLabel(only)}` : ""}`,
    );
  if (!only) return result("version-unknown", "no source names its code");
  return result("same-commit", `every source is at ${versionLabel(only)}`);
}
