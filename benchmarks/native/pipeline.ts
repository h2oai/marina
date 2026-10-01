// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Contracted pipeline: parse → transform → report.
 *
 * Each stage has an owner and an interface contract stated in the task. Raw
 * input lines `day:sensor:metric:value` (with malformed lines, a foreign
 * metric and repeated keys) go privately to the parse-stage owner only, so the
 * stages must hand off. The generator computes the exact report; score is
 * per-field partial credit, correct = every field exact and nothing extra.
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
  privateMap,
  resolveMembers,
  type SetupStep,
} from "./shared";

export interface PipelineOracle {
  tag: string;
  lines: string[];
  /** Expected report fields in order: `rejected`, then one per sensor (ascending). */
  expected: Record<string, string>;
  owners: { parse: string; transform: string; report: string };
}

const METRICS = ["temp", "hum"] as const;

interface Rec {
  day: string;
  sensor: string;
  metric: string;
  value: number;
}

/** Stage 1 contract: exactly 4 `:` fields, value an integer, metric temp|hum. */
export function parseLine(line: string): Rec | null {
  const f = line.split(":");
  if (f.length !== 4) return null;
  const [day, sensor, metric, raw] = f as [string, string, string, string];
  if (!/^d\d{2}$/.test(day) || !/^[a-z]\d$/.test(sensor)) return null;
  if (!(METRICS as readonly string[]).includes(metric)) return null;
  if (!/^-?\d+$/.test(raw)) return null;
  return { day, sensor, metric, value: Number.parseInt(raw, 10) };
}

/** The reference implementation of all three stages. */
export function runPipeline(lines: string[]): Record<string, string> {
  let rejected = 0;
  const latest = new Map<string, Rec>();
  for (const line of lines) {
    const r = parseLine(line);
    if (!r) {
      rejected++;
      continue;
    }
    latest.set(`${r.day}:${r.sensor}:${r.metric}`, r); // later line wins
  }
  const stats = new Map<string, number[]>();
  for (const r of latest.values()) {
    if (r.metric !== "temp") continue;
    const s = stats.get(r.sensor) ?? [];
    s.push(r.value);
    stats.set(r.sensor, s);
  }
  const out: Record<string, string> = { rejected: String(rejected) };
  for (const sensor of [...stats.keys()].sort()) {
    const v = stats.get(sensor)!;
    out[sensor] = `${v.length}/${Math.min(...v)}/${Math.max(...v)}/${v.reduce((a, b) => a + b, 0)}`;
  }
  return out;
}

export function generatePipeline(
  seed: number,
  opts?: GenerateOptions,
): NativeInstance<PipelineOracle> {
  const members = resolveMembers(opts);
  const pool = opts?.pool ?? DEFAULT_POOL;
  const tag = `PIPE${seed}`;
  const rng = makeRng(seed, "pipeline");
  const letters = rng.shuffle("abcdefghjkmnpqrstuvwxyz".split(""));
  const sensors = Array.from({ length: rng.int(3, 4) }, (_, i) => `${letters[i]}${rng.int(1, 9)}`);
  const days = rng.int(6, 9);
  const lines: string[] = [];
  for (let d = 1; d <= days; d++)
    for (const s of sensors) {
      if (rng.next() < 0.15) continue;
      const day = `d${String(d).padStart(2, "0")}`;
      lines.push(`${day}:${s}:temp:${rng.int(-5, 35)}`);
      if (rng.next() < 0.4) lines.push(`${day}:${s}:hum:${rng.int(20, 90)}`);
    }
  const dayOf = () => `d${String(rng.int(1, days)).padStart(2, "0")}`;
  // Repeated keys: a later line supersedes an earlier one.
  for (let k = 0; k < 2; k++) lines.push(`${dayOf()}:${rng.pick(sensors)}:temp:${rng.int(-5, 35)}`);
  // Malformed and foreign lines.
  const bad = [
    () => `${dayOf()}:${rng.pick(sensors)}:temp`,
    () => `${dayOf()}:${rng.pick(sensors)}:temp:${rng.int(1, 9)}x${rng.int(1, 9)}`,
    () => `${dayOf()}:${rng.pick(sensors)}:pres:${rng.int(900, 1100)}`,
    () => `${dayOf()}:${rng.pick(sensors)}:temp:${rng.int(1, 30)}:${rng.int(1, 9)}`,
  ];
  const nBad = rng.int(3, 6);
  for (let k = 0; k < nBad; k++) lines.push(rng.pick(bad)());
  // Shuffle while keeping the later-wins order meaningful: shuffle, then the reference
  // implementation defines "later" as later in THIS published order.
  const published = rng.shuffle(lines);
  const expected = runPipeline(published);
  const owners = {
    parse: members[0]!,
    transform: members[1 % members.length]!,
    report: members[2 % members.length]!,
  };
  const setup: SetupStep[] = [
    {
      kind: "private",
      member: owners.parse,
      text: `PRIVATE ${tag} raw input for the parse stage (only you hold it), in order: ${published.join(" ")}`,
    },
  ];
  const format = `${tag} REPORT: rejected=<n>; <sensor>=<count>/<min>/<max>/<sum>; … (sensors ascending).`;
  const text =
    `TASK ${tag} (contracted pipeline): Three stages, each with an owner and a contract. ` +
    `PARSE (${owners.parse}; holds the raw input, private Operator tell headed PRIVATE ${tag}): split each line on ':'; accept only lines with exactly 4 fields day:sensor:metric:value, metric temp or hum, integer value; count the rest as rejected; emit accepted records in input order. ` +
    `TRANSFORM (${owners.transform}): when day+sensor+metric repeats, keep the LAST record; keep metric temp only; per sensor compute count, min, max, sum of value. ` +
    `REPORT (${owners.report}): one line, sensors ascending. Each stage hands its output to the next owner. ${depositClause(pool, format)}`;
  const answer = `${tag} REPORT: ${Object.entries(expected)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")}`;
  return {
    task: "pipeline",
    seed,
    tag,
    shape: "contracted pipeline",
    text,
    privateMaterial: privateMap(setup),
    setup,
    pool,
    deliverableRe: deliverableRe(tag, "REPORT"),
    answer,
    oracle: { tag, lines: published, expected, owners },
  };
}

export function scorePipeline(deliverable: string, o: PipelineOracle): NativeScore {
  const fields = parseFields(deliverable, o.tag, "REPORT");
  if (!fields) return { correct: false, score: 0, details: { error: "no REPORT line" } };
  const norm = (v: string) => v.replace(/\s+/g, "");
  const keys = Object.keys(o.expected);
  const mismatched: string[] = [];
  let hits = 0;
  for (const k of keys) {
    const got = fields.get(k);
    if (got !== undefined && norm(got) === o.expected[k]) hits++;
    else mismatched.push(`${k}: got ${got ?? "missing"}, want ${o.expected[k]}`);
  }
  const extra = [...fields.keys()].filter((k) => !(k in o.expected));
  return {
    correct: hits === keys.length && extra.length === 0,
    score: hits / (keys.length + extra.length),
    details: { hits, fields: keys.length, mismatched, extra },
  };
}

export const pipelineGenerator: NativeGenerator<PipelineOracle> = {
  id: "pipeline",
  title: "Contracted pipeline",
  shape: "contracted pipeline",
  generate: generatePipeline,
  score: scorePipeline,
};
