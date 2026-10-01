// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Planted-bug verification.
 *
 * A generated TypeScript module of small documented functions, K of them
 * seeded with a defect. Visible tests (in the workspace) cover only some of
 * the defects; hidden cases stay with the oracle. A shared pool holds short
 * claims about the module, most of them false ("already fixed").
 *
 * Oracle: the module the crew leaves in the workspace is copied into a fresh
 * temp directory and the hidden cases run there in a separate `bun` process
 * owned by the HARNESS (never by agents, never in the server). This is a
 * local fallback, not a sandbox: Marina's `code` exec / Flywheel is the
 * agents' execution path, and the oracle does not route through it. Score =
 * share of hidden cases passing; the claim verdicts are a secondary score.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  privateMap,
  type Rng,
  type SetupStep,
} from "./shared";

type Arg = number | string | number[];

interface Template {
  name: string;
  /** Seeded constants. */
  consts(rng: Rng): Record<string, number>;
  doc(c: Record<string, number>): string;
  signature: string;
  body(c: Record<string, number>, buggy: boolean): string;
  impl(c: Record<string, number>): (...args: never[]) => unknown;
  /** Seeded hidden inputs (four per function). */
  inputs(rng: Rng, c: Record<string, number>): Arg[][];
  /** Index of the input that exposes the planted defect, by construction. */
  reveal: number;
}

const T: Template[] = [
  {
    name: "clamp",
    reveal: 0,
    consts: () => ({}),
    doc: () => "Return x limited to the closed range [lo, hi] (lo <= hi).",
    signature: "export function clamp(x: number, lo: number, hi: number): number",
    body: (_c, b) =>
      b ? "return x < lo ? lo : x > hi ? lo : x;" : "return x < lo ? lo : x > hi ? hi : x;",
    impl: () => ((x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))) as never,
    inputs: (r) => [
      [r.int(20, 40), 0, 10],
      [r.int(-9, -1), 0, 10],
      [5, 0, 10],
      [r.int(60, 99), 10, 50],
    ],
  },
  {
    name: "sumTo",
    reveal: 1,
    consts: () => ({}),
    doc: () => "Return 1 + 2 + … + n for integer n >= 0 (0 for n = 0).",
    signature: "export function sumTo(n: number): number",
    body: (_c, b) =>
      `let s = 0;\n  for (let i = 1; i ${b ? "<" : "<="} n; i++) s += i;\n  return s;`,
    impl: () => ((n: number) => (n * (n + 1)) / 2) as never,
    inputs: (r) => [[0], [1], [r.int(5, 30)], [r.int(31, 90)]],
  },
  {
    name: "wrapIndex",
    reveal: 2,
    consts: () => ({}),
    doc: () => "Return i wrapped into [0, n) for any integer i and n > 0 (e.g. -1 → n-1).",
    signature: "export function wrapIndex(i: number, n: number): number",
    body: (_c, b) => (b ? "return i % n;" : "return ((i % n) + n) % n;"),
    impl: () => ((i: number, n: number) => ((i % n) + n) % n) as never,
    inputs: (r) => [
      [r.int(1, 6), 7],
      [r.int(20, 40), 7],
      [-r.int(1, 6), 7],
      [-r.int(20, 40), 9],
    ],
  },
  {
    name: "isLeap",
    reveal: 2,
    consts: () => ({}),
    doc: () => "Gregorian leap year: divisible by 4, except centuries not divisible by 400.",
    signature: "export function isLeap(y: number): boolean",
    body: (_c, b) =>
      b
        ? "return y % 4 === 0 && y % 100 !== 0;"
        : "return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;",
    impl: () => ((y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) as never,
    inputs: (r) => [
      [r.pick([2024, 2028, 2032])],
      [r.pick([1900, 2100, 2200])],
      [2000],
      [r.pick([2023, 2025, 2027])],
    ],
  },
  {
    name: "median",
    reveal: 2,
    consts: () => ({}),
    doc: () =>
      "Median of a non-empty numeric array (mean of the two middle values when even). Must not mutate xs.",
    signature: "export function median(xs: number[]): number",
    body: (_c, b) =>
      `const s = ${b ? "[...xs].sort()" : "[...xs].sort((a, b) => a - b)"};\n  const m = Math.floor(s.length / 2);\n  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;`,
    impl: () =>
      ((xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
      }) as never,
    inputs: (r) => [
      [[3, 1, 2]],
      [[r.int(2, 9), r.int(10, 99), r.int(100, 999)]],
      [[r.int(10, 30), 5, r.int(100, 200), 9]],
      [[r.int(1, 9), r.int(1, 9)]],
    ],
  },
  {
    name: "countChar",
    reveal: 1,
    consts: () => ({}),
    doc: () => "Number of occurrences of the single character c in s.",
    signature: "export function countChar(s: string, c: string): number",
    body: (_c, b) =>
      `let k = 0;\n  for (let i = ${b ? 1 : 0}; i < s.length; i++) if (s[i] === c) k++;\n  return k;`,
    impl: () => ((s: string, c: string) => [...s].filter((x) => x === c).length) as never,
    inputs: (r) => {
      const ch = r.pick(["a", "x", "q"]);
      return [
        [`b${ch}${ch}b`, ch],
        [`${ch}bb${ch}`, ch],
        [`${ch}${ch}${ch}`, ch],
        ["bbb", ch],
      ];
    },
  },
  {
    name: "affine",
    reveal: 0,
    consts: (r) => ({ k: r.int(2, 9), b: r.int(1, 30) }),
    doc: (c) => `Return x * ${c.k} + ${c.b}.`,
    signature: "export function affine(x: number): number",
    body: (c, b) => (b ? `return (x + ${c.b}) * ${c.k};` : `return x * ${c.k} + ${c.b};`),
    impl: (c) => ((x: number) => x * c.k! + c.b!) as never,
    inputs: (r) => [[0], [1], [r.int(2, 50)], [-r.int(1, 20)]],
  },
  {
    name: "dedupe",
    reveal: 1,
    consts: () => ({}),
    doc: () => "Remove repeated values, keeping each value's FIRST occurrence, in original order.",
    signature: "export function dedupe(xs: number[]): number[]",
    body: (_c, b) =>
      b
        ? "const out: number[] = [];\n  for (let i = xs.length - 1; i >= 0; i--) if (!out.includes(xs[i]!)) out.unshift(xs[i]!);\n  return out;"
        : "const out: number[] = [];\n  for (const x of xs) if (!out.includes(x)) out.push(x);\n  return out;",
    impl: () => ((xs: number[]) => [...new Set(xs)]) as never,
    inputs: (r) => [[[1, 2, 3]], [[1, 2, 1, 3]], [[r.int(4, 9), 1, r.int(10, 20), 1, 2]], [[]]],
  },
  {
    name: "bucket",
    reveal: 1,
    consts: (r) => ({ w: r.int(3, 12) }),
    doc: (c) => `Index of the width-${c.w} bucket holding x >= 0: floor(x / ${c.w}).`,
    signature: "export function bucket(x: number): number",
    body: (c, b) => (b ? `return Math.round(x / ${c.w});` : `return Math.floor(x / ${c.w});`),
    impl: (c) => ((x: number) => Math.floor(x / c.w!)) as never,
    inputs: (r, c) => [[0], [c.w! - 1], [c.w! * r.int(2, 6) + c.w! - 1], [c.w! * r.int(2, 6)]],
  },
  {
    name: "pctChange",
    reveal: 1,
    consts: () => ({}),
    doc: () =>
      "Percent change from a to b (a != 0), rounded to the nearest integer: round((b - a) / a * 100).",
    signature: "export function pctChange(a: number, b: number): number",
    body: (_c, b) =>
      b ? "return Math.round(((b - a) / b) * 100);" : "return Math.round(((b - a) / a) * 100);",
    impl: () => ((a: number, b: number) => Math.round(((b - a) / a) * 100)) as never,
    inputs: (r) => [
      [100, 100],
      [r.int(20, 80), r.int(100, 200)],
      [r.int(150, 300), r.int(10, 90)],
      [50, 75],
    ],
  },
];

export interface BugCase {
  fn: string;
  args: Arg[];
  expected: unknown;
}

export interface BugClaim {
  id: string;
  fn: string;
  /** True when the claim is false at setup time (claims a defect is already fixed). */
  isFalse: boolean;
  text: string;
}

export interface BugsOracle {
  tag: string;
  dir: string;
  modulePath: string;
  functions: string[];
  buggy: string[];
  /** Bugged functions the visible tests catch. */
  visiblyCaught: string[];
  hidden: BugCase[];
  claims: BugClaim[];
  /** The correct module, for known-good tests. */
  correctSource: string;
  /** The module as planted. */
  plantedSource: string;
}

function lit(v: unknown): string {
  return JSON.stringify(v);
}

function renderModule(
  fns: { t: Template; c: Record<string, number>; buggy: boolean }[],
  tag: string,
) {
  const parts = [`// ${tag} module. Each function must match its doc comment exactly.`, ""];
  for (const { t, c, buggy } of fns)
    parts.push(`/** ${t.doc(c)} */`, `${t.signature} {`, `  ${t.body(c, buggy)}`, "}", "");
  return parts.join("\n");
}

export function generateBugs(seed: number, opts?: GenerateOptions): NativeInstance<BugsOracle> {
  const pool = opts?.pool ?? DEFAULT_POOL;
  const tag = `BUG${seed}`;
  const dir = `bug${seed}`;
  const rng = makeRng(seed, "bugs");
  const chosen = rng.shuffle(T).slice(0, 6);
  const k = rng.int(3, 4);
  const buggyIdx = new Set(rng.shuffle(chosen.map((_, i) => i)).slice(0, k));
  const fns = chosen.map((t, i) => ({ t, c: t.consts(rng), buggy: buggyIdx.has(i) }));
  const buggy = fns.filter((f) => f.buggy).map((f) => f.t.name);
  // Visible tests catch about half of the defects; they also cover some correct functions.
  const visiblyCaught = rng.shuffle(buggy).slice(0, Math.ceil(buggy.length / 2));
  const visibleFns = fns.filter((f) => !f.buggy || visiblyCaught.includes(f.t.name));
  const hidden: BugCase[] = [];
  const visibleLines: string[] = [];
  for (const f of fns) {
    const impl = f.t.impl(f.c) as (...a: Arg[]) => unknown;
    const inputs = f.t.inputs(rng, f.c);
    for (const args of inputs) hidden.push({ fn: f.t.name, args, expected: impl(...args) });
    if (visibleFns.includes(f)) {
      // Visible tests: an easy case plus the input that exposes the planted defect.
      const revealing = inputs[f.t.reveal]!;
      for (const args of [inputs[0]!, revealing].filter((a, i, xs) => xs.indexOf(a) === i))
        visibleLines.push(
          `test(${lit(`${f.t.name}(${args.map(lit).join(", ")})`)}, () => expect(m.${f.t.name}(${args.map(lit).join(", ")})).toEqual(${lit(impl(...args))}));`,
        );
    }
  }
  const modulePath = `${dir}/mod.ts`;
  const plantedSource = renderModule(fns, tag);
  const correctSource = renderModule(
    fns.map((f) => ({ ...f, buggy: false })),
    tag,
  );
  const visibleTest = [
    'import { expect, test } from "bun:test";',
    'import * as m from "./mod";',
    "",
    ...visibleLines,
    "",
  ].join("\n");
  // Claims: two false "already fixed" claims on hidden-only defects (or any defects), one true
  // "correct as written" claim on a clean function.
  const hiddenOnly = buggy.filter((b) => !visiblyCaught.includes(b));
  const falseTargets = rng.shuffle(hiddenOnly.length >= 2 ? hiddenOnly : buggy).slice(0, 2);
  const clean = fns.filter((f) => !f.buggy).map((f) => f.t.name);
  const claims: BugClaim[] = rng
    .shuffle([
      ...falseTargets.map((fn) => ({ fn, isFalse: true, kind: "fixed" as const })),
      { fn: rng.pick(clean), isFalse: false, kind: "clean" as const },
    ])
    .map((c, i) => ({
      id: `C${i + 1}`,
      fn: c.fn,
      isFalse: c.isFalse,
      text:
        c.kind === "fixed"
          ? `${tag} C${i + 1}: ${c.fn} already fixed, tests pass`
          : `${tag} C${i + 1}: ${c.fn} correct as written`,
    }));
  const claimPool = `native-${dir}`;
  const setup: SetupStep[] = [
    { kind: "file", path: modulePath, content: plantedSource },
    { kind: "file", path: `${dir}/visible.test.ts`, content: visibleTest },
    { kind: "pool", pool: claimPool },
    ...claims.map((c) => ({ kind: "pool-note" as const, pool: claimPool, text: c.text })),
  ];
  const falseIds = claims.filter((c) => c.isFalse).map((c) => c.id);
  const format = `${tag} REPORT: fixed=<function names, comma-separated>; false=<claim ids, comma-separated, or none>.`;
  const text =
    `TASK ${tag} (planted bugs): In the code workspace, ${modulePath} has defects against its doc comments. ` +
    `${dir}/visible.test.ts covers only some of them. Pool ${claimPool} holds claims ${tag} C1–C${claims.length} about the module; verify each, some are false. ` +
    `Fix ${modulePath} in place so every function matches its doc comment; keep signatures and exports. ${depositClause(pool, format)}`;
  return {
    task: "bugs",
    seed,
    tag,
    shape: "verification",
    text,
    privateMaterial: privateMap(setup),
    setup,
    pool,
    deliverableRe: deliverableRe(tag, "REPORT"),
    answer: `${tag} REPORT: fixed=${buggy.join(",")}; false=${falseIds.join(",") || "none"}`,
    scoreFiles: [modulePath],
    oracle: {
      tag,
      dir,
      modulePath,
      functions: fns.map((f) => f.t.name),
      buggy,
      visiblyCaught,
      hidden,
      claims,
      correctSource,
      plantedSource,
    },
  };
}

const HIDDEN_RUNNER = `import * as m from "./mod";
const cases = JSON.parse(await Bun.file(new URL("./cases.json", import.meta.url)).text());
const out = [];
for (const c of cases) {
  let pass = false;
  try {
    const fn = m[c.fn];
    pass = typeof fn === "function" && Bun.deepEquals(await fn(...structuredClone(c.args)), c.expected, true);
  } catch {
    // allow-empty-catch: a throwing case counts as a failure
  }
  out.push(pass);
}
console.log("__ORACLE__" + JSON.stringify(out));
`;

/** Run the hidden cases against `source` in a temp dir, in a separate bun process. */
export async function runHiddenCases(
  source: string,
  cases: BugCase[],
  timeoutMs = 20_000,
): Promise<{ results: boolean[]; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "native-bugs-"));
  try {
    writeFileSync(join(dir, "mod.ts"), source);
    writeFileSync(join(dir, "cases.json"), JSON.stringify(cases));
    writeFileSync(join(dir, "hidden.ts"), HIDDEN_RUNNER);
    const proc = Bun.spawn([process.execPath, "--env-file=/dev/null", "hidden.ts"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: dir },
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    const line = stdout.split("\n").find((l) => l.startsWith("__ORACLE__"));
    if (!line)
      return {
        results: cases.map(() => false),
        error: (stderr || "no oracle output").slice(0, 400),
      };
    const parsed = JSON.parse(line.slice("__ORACLE__".length)) as boolean[];
    return { results: cases.map((_, i) => parsed[i] === true) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function scoreBugs(
  deliverable: string,
  o: BugsOracle,
  ctx?: { files?: Record<string, string> },
): Promise<NativeScore> {
  const source = ctx?.files?.[o.modulePath];
  const fields = parseFields(deliverable, o.tag, "REPORT");
  const listed = (k: string) =>
    (fields?.get(k) ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s && s.toLowerCase() !== "none");
  const flagged = new Set(listed("false").map((s) => s.toUpperCase()));
  const claimHits = o.claims.filter((c) => flagged.has(c.id) === c.isFalse).length;
  const claimScore = o.claims.length ? claimHits / o.claims.length : 1;
  if (source === undefined)
    return {
      correct: false,
      score: 0,
      details: { error: `module ${o.modulePath} not readable`, claimScore, report: !!fields },
    };
  const { results, error } = await runHiddenCases(source, o.hidden);
  const passed = results.filter(Boolean).length;
  const failing = [...new Set(o.hidden.filter((_, i) => !results[i]).map((c) => c.fn))];
  return {
    correct: passed === o.hidden.length,
    score: o.hidden.length ? passed / o.hidden.length : 0,
    details: {
      passed,
      total: o.hidden.length,
      failingFunctions: failing,
      claimScore,
      flaggedFalse: [...flagged],
      expectedFalse: o.claims.filter((c) => c.isFalse).map((c) => c.id),
      reportedFixed: listed("fixed"),
      report: !!fields,
      ...(error ? { error } : {}),
    },
  };
}

export const bugsGenerator: NativeGenerator<BugsOracle> = {
  id: "bugs",
  title: "Planted-bug verification",
  shape: "verification",
  generate: generateBugs,
  score: scoreBugs,
};
