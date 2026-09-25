// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The signal language — what a discovery agent may propose. A signal is DATA,
 * never code: a centre (where the forecast sits) and a spread (how sure it
 * is), each chosen from a fixed menu of primitives, optionally scoped to one
 * task family. Every primitive reads only the round's frozen lock and the
 * archives as they stood at the lock, so any signal is leakage-free by
 * construction and backtestable.
 *
 *   centre:  last | nowcast | ewma:<α 0.05–1> | mean:<k 2–12> | median:<k 3–12>
 *            | trend:<k 3–12> | nowcast-shrink:<w 0–1>
 *   spread:  arena | baseline | rms:<window 6–52> | mad:<window 6–52> | scale:<k 0.3–3>
 */

import type { ArenaData } from "../data";
import { forecastScalar, horizonSteps, PERSISTENCE_SD } from "../forecast";
import { civiqsNowcast } from "../research/civiqs-nowcast";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "../types";

export interface SignalSpec {
  centre: string;
  spread: string;
  /** Task family (arena tracker) the signal is for; omitted = every numeric round. */
  tracker?: string;
}

const CENTRE =
  /^(last|nowcast|ewma:(0?\.\d+|1(\.0+)?)|mean:\d+|median:\d+|trend:\d+|nowcast-shrink:(0?\.\d+|0|1(\.0+)?))$/;
const SPREAD = /^(arena|baseline|rms:\d+|mad:\d+|scale:\d+(\.\d+)?)$/;

function param(s: string): number {
  return Number(s.split(":")[1]);
}

/** Validate a proposed spec; returns a reason when it is not in the language. */
export function validateSignal(spec: SignalSpec): string | undefined {
  if (!CENTRE.test(spec.centre)) return `unknown centre "${spec.centre}"`;
  if (!SPREAD.test(spec.spread)) return `unknown spread "${spec.spread}"`;
  const c = spec.centre.split(":")[0]!;
  const cp = param(spec.centre);
  if (c === "ewma" && !(cp >= 0.05 && cp <= 1)) return "ewma α must be 0.05–1";
  if (
    (c === "mean" || c === "median" || c === "trend") &&
    !(cp >= (c === "mean" ? 2 : 3) && cp <= 12)
  ) {
    return `${c} window out of range`;
  }
  const s = spec.spread.split(":")[0]!;
  const sp = param(spec.spread);
  if ((s === "rms" || s === "mad") && !(sp >= 6 && sp <= 52)) return `${s} window must be 6–52`;
  if (s === "scale" && !(sp >= 0.3 && sp <= 3)) return "scale must be 0.3–3";
  if (spec.tracker !== undefined && !/^[a-z0-9_]{2,40}$/.test(spec.tracker)) return "bad tracker";
  return undefined;
}

/** A stable key, so the same idea is never tried twice under another spelling. */
export function signalKey(spec: SignalSpec): string {
  return `${spec.tracker ?? "*"}|${spec.centre}|${spec.spread}`;
}

function values(points: ArenaPoint[]): number[] {
  return points.map((p) => p.value).filter((v) => Number.isFinite(v));
}

function centreOf(kind: string, p: number, v: number[], steps: number): number {
  const last = v.at(-1)!;
  if (kind === "ewma") {
    let m = v[0]!;
    for (const x of v) m = p * x + (1 - p) * m;
    return m;
  }
  const tail = v.slice(-p);
  if (kind === "mean") return tail.reduce((a, b) => a + b, 0) / tail.length;
  if (kind === "median") {
    const s = [...tail].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  }
  if (kind === "trend") {
    const n = tail.length;
    const xm = (n - 1) / 2;
    const ym = tail.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    tail.forEach((y, i) => {
      num += (i - xm) * (y - ym);
      den += (i - xm) ** 2;
    });
    return last + (den ? num / den : 0) * steps;
  }
  return last;
}

function spreadOf(kind: string, p: number, v: number[], steps: number, baselineSd: number): number {
  if (kind === "arena") return PERSISTENCE_SD;
  if (kind === "baseline") return baselineSd;
  if (kind === "scale") return Math.max(0.05, p * baselineSd);
  const diffs: number[] = [];
  for (let i = Math.max(steps, v.length - p); i < v.length; i++) diffs.push(v[i]! - v[i - steps]!);
  if (diffs.length < 4) return baselineSd;
  if (kind === "rms")
    return Math.max(0.05, Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length));
  const abs = diffs.map(Math.abs).sort((a, b) => a - b);
  return Math.max(0.05, 1.4826 * abs[Math.floor(abs.length / 2)]!);
}

/** The forecast a signal makes for a numeric round, from what existed at its lock. */
export async function applySignal(
  spec: SignalSpec,
  round: ArenaRound,
  lock: ArenaLock,
  data: ArenaData,
): Promise<Distribution> {
  const history = lock.answer_history ?? lock.history ?? [];
  const v = values(history);
  if (v.length === 0) throw new Error("no history");
  const steps = horizonSteps(history, round.release_at);
  const baseline = forecastScalar(history, round.release_at);
  const [ck, cpRaw] = spec.centre.split(":") as [string, string | undefined];
  const cp = Number(cpRaw);
  let mean: number;
  if (ck === "nowcast" || ck === "nowcast-shrink") {
    const n =
      round.tracker === "civiqs"
        ? await civiqsNowcast(data, round).catch(() => undefined)
        : undefined;
    const fresher = n && n.date > (history.at(-1)?.date ?? "") ? n.value : v.at(-1)!;
    mean = ck === "nowcast" ? fresher : v.at(-1)! + cp * (fresher - v.at(-1)!);
  } else {
    mean = centreOf(ck, cp, v, steps);
  }
  const [sk, spRaw] = spec.spread.split(":") as [string, string | undefined];
  const sd = spreadOf(sk, Number(spRaw), v, steps, baseline.sd);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { mean: r(mean), sd: r(sd) };
}
