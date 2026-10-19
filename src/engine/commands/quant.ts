// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import {
  type Bucket,
  type BucketResult,
  bucketProbabilities,
  type Predictive,
  parseBuckets,
  thresholdBuckets,
} from "../../quant/buckets";
import { type DatedValue, FIT_METHODS, type FitMethod, fitSeries } from "../../quant/series-fit";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { parseModifiers, splitOnTerminator, unknownSubcommand } from "../parse-input";

/**
 * `quant` — rank-0 numeric forecasting helpers next to `calc`, no model call:
 *
 *   quant fit      a series and a horizon → mean, sd, quantiles (`src/quant/series-fit.ts`)
 *   quant buckets  a normal or quantiles and a set of ranges → P(each range),
 *                  the most likely one (`src/quant/buckets.ts`)
 *
 * Pure and fast (milliseconds); every input is parsed and bounded here.
 */

const MAX_POINTS = 5_000;
const MAX_BUCKETS = 100;
const MISSING = new Set(["nan", "na", "n/a", "null", "none", "-", "?", ""]);
const DATE_VALUE = /^(\d{4}-\d{2}(?:-\d{2})?(?:T[\d:.]+Z?)?)[=:](.+)$/i;

export const QUANT_USAGE = `Usage:
  quant fit <values> [steps:N | to:<date>] [method:auto|${FIT_METHODS.join("|")}] [alpha:0.4] [damping:0.9] [trend:12] [-- <buckets>]
  quant buckets mean:<m> sd:<s> -- <buckets>
  quant buckets q:<level>=<value>,<level>=<value>,... -- <buckets>
  quant buckets mean:<m> sd:<s> cuts:<t1>,<t2>,... [closed:lower|upper]

Values: plain numbers (oldest first) or date=value pairs, separated by spaces or commas; NaN/na/null are skipped.
Buckets: comma-separated ranges — <10, 10-20, 20..30, >=30, [a, b], (a, b], 5+, or a bare number; optional label "A: <10".`;

const HELP = `Numeric forecasting helpers — no model call, milliseconds.
${QUANT_USAGE}

Examples:
  quant fit 3.1 3.3 3.6 3.4 3.9 4.0 4.2 4.1 steps:2
  quant fit 2026-01-31=3.1, 2026-02-28=3.3, 2026-03-31=3.6 to:2026-06-30 method:damped
  quant buckets mean:3.4 sd:0.3 -- <3, 3-3.5, 3.5-4, >=4
  quant buckets q:0.1=38,0.5=42,0.9=47 -- A: <40; B: 40-45; C: >=45
  quant fit 41 42 40 43 44 42 45 46 -- <42, 42-46, >=46

fit: methods persistence, ewma, blend (persistence+EWMA)/2, trend (least-squares line), damped (trend damped 0.9/step), combo (mean of persistence, EWMA, damped); auto (default) takes the lowest rolling-origin error that beats persistence by 5%. sd = RMS of the method's own past steps-ahead misses (fallback √steps × RMS of one-step changes). Steps count releases; to:<date> converts at the median spacing.
buckets: P(outcome in each range) and the most likely range; open ends and sd 0 (a point mass) are handled. Use the most likely bucket for a multiple-choice numeric answer.`;

/** Parse series tokens into plain or dated values. Throws on a bad token. */
export function parseSeriesTokens(tokens: readonly string[]): {
  series: number[] | DatedValue[];
  missing: number;
} {
  const plain: number[] = [];
  const dated: DatedValue[] = [];
  let missing = 0;
  for (const tok of tokens) {
    const m = DATE_VALUE.exec(tok);
    const rawValue = m ? m[2]! : tok;
    const lower = rawValue.trim().toLowerCase();
    let value: number;
    if (MISSING.has(lower)) {
      missing++;
      value = Number.NaN;
    } else {
      value = Number(lower.replace(/[$%_]/g, ""));
      if (!Number.isFinite(value)) throw new RangeError(`not a number: "${tok}"`);
    }
    if (m) {
      if (!Number.isFinite(Date.parse(m[1]!))) throw new RangeError(`invalid date "${m[1]}"`);
      dated.push({ date: m[1]!, value });
    } else {
      plain.push(value);
    }
  }
  if (plain.length > 0 && dated.length > 0) {
    throw new RangeError("mix of dated and undated values: date every value or none");
  }
  return { series: dated.length > 0 ? dated : plain, missing };
}

function n(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1e15 || a < 1e-6) return x.toExponential(4);
  return String(Number(x.toPrecision(6)));
}

function pct(p: number): string {
  return `${(p * 100).toFixed(p > 0 && p < 0.001 ? 3 : 1)}%`;
}

function bucketLines(result: BucketResult): string[] {
  const lines: string[] = [`  ${bold("buckets")}:`];
  const width = Math.min(40, Math.max(...result.buckets.map((b) => b.label.length)));
  const partial = Math.abs(result.coverage - 1) > 1e-6;
  result.buckets.forEach((b, i) => {
    const mark = i === result.best ? "  ← most likely" : "";
    const share = partial ? `  ${dim(`share ${pct(b.share)}`)}` : "";
    lines.push(`    ${b.label.slice(0, 40).padEnd(width)}  ${pct(b.p).padStart(6)}${share}${mark}`);
  });
  lines.push(`  ${bold("most likely")}: ${result.buckets[result.best]!.label}`);
  if (partial) lines.push(`  ${dim("coverage")}: ${pct(result.coverage)}`);
  for (const w of result.warnings) lines.push(`  ${dim("note")}: ${w}`);
  return lines;
}

function readBuckets(text: string | undefined): Bucket[] | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const buckets = parseBuckets(text);
  if (buckets.length > MAX_BUCKETS) throw new RangeError(`at most ${MAX_BUCKETS} buckets`);
  return buckets;
}

/** `quant fit …` → reply lines. Throws RangeError on bad input. */
export function runQuantFit(args: string): string[] {
  const [head, tail] = splitOnTerminator(args);
  const mods = parseModifiers(
    head.split(/[\s,;]+/).filter((t) => t.length > 0),
    {
      steps: { type: "int", aliases: ["h", "horizon"] },
      to: { type: "string", aliases: ["target", "at"] },
      method: { type: "string", aliases: ["m"] },
      alpha: { type: "number" },
      damping: { type: "number", aliases: ["phi"] },
      trend: { type: "int", aliases: ["window"] },
    },
  );
  if (mods.errors.length > 0) throw new RangeError(mods.errors.join("; "));
  if (mods.rest.length === 0) throw new RangeError("no values given");
  if (mods.rest.length > MAX_POINTS) throw new RangeError(`at most ${MAX_POINTS} values`);
  const { series, missing } = parseSeriesTokens(mods.rest);
  const method = (mods.values.method as string | undefined)?.toLowerCase() ?? "auto";
  if (method !== "auto" && !FIT_METHODS.includes(method as FitMethod)) {
    throw new RangeError(`unknown method "${method}" (auto|${FIT_METHODS.join("|")})`);
  }
  const buckets = readBuckets(tail);
  const fit = fitSeries(series, {
    ...(mods.values.steps !== undefined ? { steps: mods.values.steps as number } : {}),
    ...(mods.values.to !== undefined ? { target: mods.values.to as string } : {}),
    method: method as FitMethod | "auto",
    ...(mods.values.alpha !== undefined ? { alpha: mods.values.alpha as number } : {}),
    ...(mods.values.damping !== undefined ? { damping: mods.values.damping as number } : {}),
    ...(mods.values.trend !== undefined ? { trendWindow: mods.values.trend as number } : {}),
  });
  if (!fit) throw new RangeError(`no usable values (${missing} missing)`);
  const basis =
    fit.sdBasis === "rolling-origin"
      ? `RMS of its own ${fit.steps}-step misses at ${fit.errorCount} past origins`
      : fit.sdBasis === "step-changes"
        ? `too short for its own misses: √${fit.steps} × RMS of ${fit.errorCount} one-step changes — treat as rough`
        : "one value: no spread";
  const lines = [
    `  ${bold("method")}: ${method === "auto" ? `auto → ${fit.method}` : fit.method}  ${dim(`(${fit.steps} step(s) ahead, ${fit.n} values${fit.dropped ? `, ${fit.dropped} skipped` : ""})`)}`,
    `  ${bold("mean")}: ${n(fit.mean)}   ${bold("sd")}: ${n(fit.sd)}  ${dim(`(${basis})`)}`,
    `  ${bold("quantiles")}: ${fit.quantiles.map((q) => `${Math.round(q.level * 100)}% ${n(q.value)}`).join(" | ")}`,
  ];
  if (fit.candidates) {
    lines.push(
      `  ${dim("candidates")}: ${fit.candidates
        .map((c) => `${c.method} ${n(c.mean)}${c.rms !== undefined ? ` (rms ${n(c.rms)})` : ""}`)
        .join(" | ")}`,
    );
  }
  if (buckets) {
    lines.push(
      ...bucketLines(bucketProbabilities({ kind: "normal", mean: fit.mean, sd: fit.sd }, buckets)),
    );
  }
  return lines;
}

/** Parse `0.1=38,0.5=42,0.9=47` (levels may be written as percents: `10=38` or `10%=38`). */
function parseQuantiles(text: string): Array<{ level: number; value: number }> {
  return text
    .split(/[,;]+/)
    .filter((s) => s.trim().length > 0)
    .map((item) => {
      const m = /^\s*([-+0-9.e]+)(%?)\s*[=:]\s*(.+?)\s*$/i.exec(item);
      if (!m) throw new RangeError(`cannot read quantile "${item}" (want level=value)`);
      let level = Number(m[1]);
      if (m[2] === "%" || level > 1) level /= 100;
      const value = Number(m[3]!.replace(/[$%]/g, ""));
      if (!Number.isFinite(level) || !Number.isFinite(value)) {
        throw new RangeError(`cannot read quantile "${item}" (want level=value)`);
      }
      return { level, value };
    });
}

/** `quant buckets …` → reply lines. Throws RangeError on bad input. */
export function runQuantBuckets(args: string): string[] {
  const [head, tail] = splitOnTerminator(args);
  const mods = parseModifiers(
    head.split(/\s+/).filter((t) => t.length > 0),
    {
      mean: { type: "number", aliases: ["mu"] },
      sd: { type: "number", aliases: ["sigma"] },
      q: { type: "string", aliases: ["quantiles"] },
      cuts: { type: "string", aliases: ["thresholds"] },
      closed: { type: "string" },
    },
  );
  if (mods.errors.length > 0) throw new RangeError(mods.errors.join("; "));
  let buckets = readBuckets(tail ?? (mods.rest.length > 0 ? mods.rest.join(" ") : undefined));
  if (mods.values.cuts !== undefined) {
    if (buckets) throw new RangeError("give cuts: or a bucket list, not both");
    const closed = ((mods.values.closed as string | undefined) ?? "lower").toLowerCase();
    if (closed !== "lower" && closed !== "upper")
      throw new RangeError("closed must be lower or upper");
    const cuts = (mods.values.cuts as string).split(/[,;]+/).filter((s) => s.trim().length > 0);
    if (cuts.length + 1 > MAX_BUCKETS) throw new RangeError(`at most ${MAX_BUCKETS} buckets`);
    buckets = thresholdBuckets(
      cuts.map((c) => {
        const v = Number(c.replace(/[$%]/g, ""));
        if (!Number.isFinite(v)) throw new RangeError(`not a number: "${c}"`);
        return v;
      }),
      closed,
    );
  }
  if (!buckets) throw new RangeError("no buckets given (after --, or cuts:a,b,c)");
  let pred: Predictive;
  if (mods.values.q !== undefined) {
    if (mods.values.mean !== undefined || mods.values.sd !== undefined) {
      throw new RangeError("give mean:/sd: or q:, not both");
    }
    pred = { kind: "quantiles", quantiles: parseQuantiles(mods.values.q as string) };
  } else {
    if (mods.values.mean === undefined || mods.values.sd === undefined) {
      throw new RangeError("give mean: and sd: (or q:level=value,...)");
    }
    pred = { kind: "normal", mean: mods.values.mean as number, sd: mods.values.sd as number };
  }
  const desc =
    pred.kind === "normal"
      ? `normal(mean ${n(pred.mean)}, sd ${n(pred.sd)})`
      : `quantiles ${pred.quantiles.map((q) => `${Math.round(q.level * 1000) / 10}%=${n(q.value)}`).join(", ")}`;
  return [`  ${bold("distribution")}: ${desc}`, ...bucketLines(bucketProbabilities(pred, buckets))];
}

export function quantCommand(deps: { getEntity: (id: string) => Entity | undefined }): CommandDef {
  return {
    category: "System",
    usage: [
      {
        syntax:
          "quant fit <values> [steps:N | to:<date>] [method:<method>] [alpha:<a>] [damping:<phi>] [trend:<n>] [-- <buckets>]",
        effect: "read",
      },
      { syntax: "quant buckets mean:<m> sd:<s> -- <buckets>", effect: "read" },
      { syntax: "quant buckets q:<level>=<value>,... -- <buckets>", effect: "read" },
      { syntax: "quant buckets mean:<m> sd:<s> cuts:<t1>,<t2>,...", effect: "read" },
    ],
    name: "quant",
    aliases: [],
    minRank: 0,
    help: HELP,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const args = input.args?.trim() ?? "";
      const space = args.search(/\s/);
      const sub = (space < 0 ? args : args.slice(0, space)).toLowerCase();
      const rest = space < 0 ? "" : args.slice(space + 1);
      if (sub === "" || sub === "help") {
        ctx.send(input.entity, QUANT_USAGE);
        return;
      }
      if (sub !== "fit" && sub !== "buckets") {
        ctx.send(input.entity, unknownSubcommand("quant", sub, QUANT_USAGE));
        return;
      }
      let body: string[];
      try {
        body = sub === "fit" ? runQuantFit(rest) : runQuantBuckets(rest);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.send(input.entity, `quant ${sub}: ${message}\n${QUANT_USAGE}`);
        return;
      }
      ctx.send(input.entity, [header(`quant ${sub}`), separator(), ...body].join("\n"));
    },
  };
}
