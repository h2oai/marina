#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * check-overrides — audit the root `overrides` table against the dependency graph.
 *
 *   bun run check:overrides            # report only (exit 0)
 *   bun run check:overrides --strict   # exit 1 when an override is no longer needed
 *   bun run check:overrides --offline  # skip the registry; lockfile-only heuristics
 *   bun run check:overrides --json
 *
 * An override in this repository is a security FLOOR: it exists to keep a
 * transitive dependency at or above a patched version. For every override the
 * script answers "what would the graph pick WITHOUT it?" by reading every
 * dependent's declared range from bun.lock and — when the registry is reachable
 * (`bun info <pkg> versions --json`) — computing the highest published version
 * each range would select today.
 *
 *   still needed       some dependent would naturally land BELOW the floor
 *   no longer needed   every dependent already lands at/above the floor
 *                      (or nothing in the graph depends on the package at all)
 *   unknown            the registry was unreachable and the lockfile alone
 *                      cannot decide
 *
 * An override written as an EXACT version (no range operator, e.g. `zod: 4.6.4`)
 * is a dedup PIN rather than a floor: its job is one shared copy so types line
 * up across dependents. A pin is "still needed" while the dependents' natural
 * picks would disagree with each other (or the pin's own dependents span ranges
 * that cannot all meet), and "no longer needed" once every dependent would pick
 * the same version anyway.
 *
 * The `note` column flags the harmful case: an override whose range excludes a
 * version a dependent explicitly requires (e.g. a `^6` floor forcing a package
 * that declares `^8` down to 6.x). Overrides declared in workspace-member
 * manifests are listed as IGNORED — Bun honours only the root table.
 *
 * "security note" cross-references SECURITY.md, README.md and docs/**\/*.md: an
 * override counts as documented when a line names the package alongside one
 * of override / CVE / GHSA / advisory / vulnerab / security. The rationale table
 * lives in docs/guides/deployment.md ("Workspace tooling").
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const args = new Set(Bun.argv.slice(2));
const STRICT = args.has("--strict");
const OFFLINE = args.has("--offline");
const JSON_OUT = args.has("--json");

type Verdict = "still needed" | "no longer needed" | "unknown";

interface Dependent {
  name: string;
  range: string;
  kind: "dependencies" | "optionalDependencies" | "peerDependencies";
  naturalPick?: string;
}

interface OverrideReport {
  pkg: string;
  override: string;
  kind: "floor" | "pin";
  floor: string;
  resolved: string[];
  dependents: Dependent[];
  verdict: Verdict;
  note: string[];
  securityNote: string[];
}

// ── lockfile ───────────────────────────────────────────────────────────────

type LockPkg = [
  string,
  string,
  Record<string, Record<string, string> | string[] | undefined>,
  string?,
];
interface Lockfile {
  workspaces: Record<string, Record<string, unknown>>;
  overrides?: Record<string, string>;
  packages: Record<string, LockPkg>;
}

function readLockfile(): Lockfile {
  const raw = readFileSync(join(ROOT, "bun.lock"), "utf8");
  // bun.lock is JSONC with trailing commas; nothing in it contains ",}" inside a string.
  return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1")) as Lockfile;
}

/** Split "name@1.2.3" (scoped names included) into [name, version]. */
function splitNameVersion(spec: string): [string, string] {
  const at = spec.lastIndexOf("@");
  return at <= 0 ? [spec, ""] : [spec.slice(0, at), spec.slice(at + 1)];
}

function depsOf(meta: LockPkg[2] | undefined, kind: Dependent["kind"]): Record<string, string> {
  const v = meta?.[kind];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
}

// ── semver helpers ─────────────────────────────────────────────────────────

const isStable = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

/** Lowest concrete version a range names: the floor of a caret/tilde/>= range. */
function rangeFloor(range: string): string | undefined {
  const m = range.match(/(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  if (!m) return undefined;
  const num = (s: string | undefined) => (s === undefined || s === "x" || s === "*" ? "0" : s);
  return `${m[1]}.${num(m[2])}.${num(m[3])}`;
}

function maxSatisfying(versions: string[], range: string): string | undefined {
  let best: string | undefined;
  for (const v of versions) {
    if (!Bun.semver.satisfies(v, range)) continue;
    if (best === undefined || Bun.semver.order(v, best) > 0) best = v;
  }
  return best;
}

const registryCache = new Map<string, string[] | null>();
async function publishedVersions(pkg: string): Promise<string[] | null> {
  if (OFFLINE) return null;
  const cached = registryCache.get(pkg);
  if (cached !== undefined) return cached;
  let result: string[] | null = null;
  try {
    const proc = Bun.spawn(["bun", "info", pkg, "versions", "--json"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const timeout = setTimeout(() => proc.kill(), 20_000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timeout);
    // `bun info` may prefix a "[0.05ms] .env" line; the JSON array is the last balanced block.
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    if (proc.exitCode === 0 && start >= 0 && end > start) {
      const parsed = JSON.parse(out.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed))
        result = parsed.filter((v): v is string => typeof v === "string" && isStable(v));
    }
  } catch {
    result = null;
  }
  registryCache.set(pkg, result);
  return result;
}

// ── documentation cross-reference ──────────────────────────────────────────

const SECURITY_WORDS = /override|cve-|ghsa-|advisor|vulnerab|security/i;

function* markdownFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* markdownFiles(full);
    else if (entry.endsWith(".md")) yield full;
  }
}

function loadDocLines(): Array<{ file: string; line: number; text: string }> {
  const files = [
    join(ROOT, "SECURITY.md"),
    join(ROOT, "README.md"),
    ...markdownFiles(join(ROOT, "docs")),
  ].filter(existsSync);
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) out.push({ file: rel, line: i + 1, text: lines[i] ?? "" });
  }
  return out;
}

function securityNotesFor(pkg: string, lines: ReturnType<typeof loadDocLines>): string[] {
  const needle = `\`${pkg}\``;
  return lines
    .filter(
      (l) =>
        (l.text.includes(needle) || l.text.includes(` ${pkg} `) || l.text.includes(`| ${pkg} |`)) &&
        SECURITY_WORDS.test(l.text),
    )
    .map((l) => `${l.file}:${l.line}`)
    .slice(0, 3);
}

// ── member manifests with their own overrides (ignored by Bun) ─────────────

function memberOverrides(rootPkg: {
  workspaces?: string[];
}): Array<{ member: string; overrides: Record<string, string> }> {
  const out: Array<{ member: string; overrides: Record<string, string> }> = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    const dirs = pattern.endsWith("/*")
      ? readdirSync(join(ROOT, pattern.slice(0, -2))).map((d) => join(pattern.slice(0, -2), d))
      : [pattern];
    for (const dir of dirs) {
      const file = join(ROOT, dir, "package.json");
      if (!existsSync(file)) continue;
      const json = JSON.parse(readFileSync(file, "utf8")) as { overrides?: Record<string, string> };
      if (json.overrides && Object.keys(json.overrides).length > 0)
        out.push({ member: dir, overrides: json.overrides });
    }
  }
  return out;
}

// ── audit ──────────────────────────────────────────────────────────────────

export async function auditOverrides(): Promise<{
  reports: OverrideReport[];
  ignored: ReturnType<typeof memberOverrides>;
  registry: boolean;
}> {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    overrides?: Record<string, string>;
    workspaces?: string[];
  };
  const lock = readLockfile();
  const docLines = loadDocLines();
  const overrides = rootPkg.overrides ?? {};
  const reports: OverrideReport[] = [];
  let registry = false;

  for (const [pkg, override] of Object.entries(overrides)) {
    const kind: OverrideReport["kind"] = isStable(override) ? "pin" : "floor";
    const floor = rangeFloor(override) ?? override;
    const resolved = new Set<string>();
    const dependents: Dependent[] = [];

    for (const [key, entry] of Object.entries(lock.packages)) {
      const [name, version] = splitNameVersion(entry[0]);
      if (name === pkg) resolved.add(version);
      for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        const range = depsOf(entry[2], kind)[pkg];
        if (range !== undefined)
          dependents.push({
            name: key.includes("/") && kind !== "peerDependencies" ? name : name,
            range,
            kind,
          });
      }
    }
    for (const [wsPath, ws] of Object.entries(lock.workspaces)) {
      for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        const range = (ws[kind] as Record<string, string> | undefined)?.[pkg];
        if (range !== undefined)
          dependents.push({
            name: wsPath === "" ? "(root workspace)" : `(workspace ${wsPath})`,
            range,
            kind,
          });
      }
    }

    const note: string[] = [];
    let verdict: Verdict;
    const versions = dependents.length > 0 ? await publishedVersions(pkg) : null;
    if (versions) registry = true;

    if (dependents.length === 0) {
      verdict = "no longer needed";
      note.push("nothing in the graph depends on it");
    } else if (versions && kind === "pin") {
      const picks = new Set<string>();
      for (const d of dependents) {
        d.naturalPick = maxSatisfying(versions, d.range);
        if (d.naturalPick) picks.add(d.naturalPick);
        else note.push(`${d.name} range ${d.range} matches no published version`);
      }
      if (picks.size > 1) {
        verdict = "still needed";
        note.push(
          `without the pin dependents would split across ${[...picks].sort(Bun.semver.order).join(", ")}`,
        );
      } else {
        verdict = "no longer needed";
        note.push(`every dependent would agree on ${[...picks][0] ?? "?"} without the pin`);
      }
    } else if (versions) {
      let below = 0;
      for (const d of dependents) {
        d.naturalPick = maxSatisfying(versions, d.range);
        if (d.naturalPick === undefined) {
          note.push(`${d.name} range ${d.range} matches no published version`);
          continue;
        }
        if (Bun.semver.order(d.naturalPick, floor) < 0) {
          below += 1;
          note.push(`${d.name} (${d.range}) would pick ${d.naturalPick} < floor ${floor}`);
        }
      }
      verdict = below > 0 ? "still needed" : "no longer needed";
    } else if (kind === "pin") {
      verdict = "unknown";
      note.push("pin: registry unreachable; cannot tell whether dependents would agree without it");
    } else {
      // Offline heuristic: compare each dependent's own floor with the override's floor.
      let below = 0;
      let undecided = 0;
      for (const d of dependents) {
        const f = rangeFloor(d.range);
        if (!f) {
          undecided += 1;
          continue;
        }
        if (Bun.semver.order(f, floor) < 0 && !Bun.semver.satisfies(floor, d.range)) {
          // Dependent's range cannot even reach the floor without the override.
          below += 1;
          note.push(`${d.name} (${d.range}) cannot reach floor ${floor} on its own`);
        } else if (Bun.semver.order(f, floor) < 0) {
          undecided += 1; // could land above or below the floor depending on what is published
        }
      }
      verdict = below > 0 ? "still needed" : undecided > 0 ? "unknown" : "no longer needed";
      if (verdict === "unknown") note.push("registry unreachable; rerun online to decide");
    }

    // Harmful case: the override forces a version a dependent's declared range rejects.
    for (const d of dependents) {
      if (d.kind === "peerDependencies") continue;
      for (const v of resolved) {
        if (!Bun.semver.satisfies(v, d.range))
          note.push(`forces ${d.name} to ${v}, outside its declared ${d.range}`);
      }
    }

    reports.push({
      pkg,
      override,
      kind,
      floor,
      resolved: [...resolved].sort(Bun.semver.order),
      dependents,
      verdict,
      note: [...new Set(note)],
      securityNote: securityNotesFor(pkg, docLines),
    });
  }

  return { reports, ignored: memberOverrides(rootPkg), registry };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

if (import.meta.main) {
  const { reports, ignored, registry } = await auditOverrides();
  if (JSON_OUT) {
    console.log(JSON.stringify({ registry, reports, ignored }, null, 2));
  } else {
    console.log(
      `override audit (${registry ? "registry consulted" : OFFLINE ? "offline: lockfile heuristics only" : "registry unreachable: lockfile heuristics only"})\n`,
    );
    const w = Math.max(...reports.map((r) => r.pkg.length), 7);
    console.log(
      `${pad("package", w)}  ${pad("override", 10)}  kind   ${pad("resolved", 16)}  ${pad("deps", 4)}  ${pad("verdict", 16)}  documented`,
    );
    console.log(
      `${"-".repeat(w)}  ----------  -----  ----------------  ----  ----------------  ----------`,
    );
    for (const r of reports) {
      const doc = r.securityNote.length > 0 ? r.securityNote[0]! : "NO";
      console.log(
        `${pad(r.pkg, w)}  ${pad(r.override, 10)}  ${pad(r.kind, 5)}  ${pad(r.resolved.join(",") || "-", 16)}  ${pad(String(r.dependents.length), 4)}  ${pad(r.verdict, 16)}  ${doc}`,
      );
      for (const n of r.note) console.log(`${" ".repeat(w + 2)}- ${n}`);
    }
    if (ignored.length > 0) {
      console.log(
        "\nIGNORED: overrides declared in workspace members (Bun honours only the root table):",
      );
      for (const i of ignored)
        console.log(
          `  ${i.member}: ${Object.entries(i.overrides)
            .map(([k, v]) => `${k}@${v}`)
            .join(", ")}`,
        );
    }
    const stale = reports.filter((r) => r.verdict === "no longer needed");
    const undocumented = reports.filter((r) => r.securityNote.length === 0);
    console.log(
      `\n${reports.length} overrides: ${reports.filter((r) => r.verdict === "still needed").length} still needed, ${stale.length} no longer needed, ${reports.filter((r) => r.verdict === "unknown").length} unknown; ${undocumented.length} without a documented security note.`,
    );
  }
  if (STRICT && reports.some((r) => r.verdict === "no longer needed")) process.exit(1);
}
