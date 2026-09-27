// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Earned gate calibration. A chat model's "0.8" is not a frequency, so the gate
 * treats every chat classifier as uncalibrated (one cut at 0.5, positives go to
 * a person). Calibration lets a backend EARN the graded policy on measured
 * evidence instead of being declared calibrated:
 *
 *   1. `qualify:decisions --calibrate <out.json>` runs the labeled gate cases
 *      (no extra calls) and fits, per backend, a Platt map from the gate's
 *      decision variable — its WORST risk probability — to P(hold).
 *   2. The fit is scored leave-one-out, so the numbers are out of sample, and
 *      is EARNED only when there is enough evidence (both classes), the
 *      calibrated error is small, the fit does not make the Brier score worse,
 *      and the backend actually discriminates (a model that always answers the
 *      base rate is perfectly "calibrated" and useless — it never earns).
 *      It must also DECIDE at least as well: out of sample, the fitted gate
 *      may not be less accurate than today's, nor miss more holds.
 *   3. The operator points `MARINA_DECISION_CALIBRATION` at the file. For a
 *      backend whose model has an EARNED entry, the gate maps every risk
 *      probability through the fit (monotone, so the worst stays the worst)
 *      and holds a call when the fitted P(hold) ≥ 0.5 (`gateActionWithFit`).
 *      The cases say only hold vs allow, so a fit never turns an ask into a
 *      block: only a natively calibrated backend blocks, on its own number.
 *
 * Scope is deliberately narrow: the fit is of the gate's decision variable on
 * gate cases, so it is applied to the gate only — never to the verifier,
 * judges or `/v1/systemone` callers, whose questions it was not measured on.
 * Optional by construction: no file, an unreadable file, or no earned entry ⇒
 * the gate behaves exactly as before. A file never downgrades a backend.
 */

import { readFileSync, statSync } from "node:fs";
import { Logger } from "../engine/logger";
import { DEFAULT_GATE_POLICY, type GatePolicy, UNCALIBRATED_GATE_POLICY } from "./policy";

const logger = new Logger();

// ─── Fitting ─────────────────────────────────────────────────────────────────

export interface CalibrationPoint {
  /** The backend's probability (the gate's worst risk). */
  p: number;
  /** 1 = the call should be held, 0 = allowed. */
  y: 0 | 1;
}

/** P(hold) = σ(a · logit(p) + b). Identity is a = 1, b = 0. */
export interface PlattMap {
  a: number;
  b: number;
}

const EPS = 1e-4;
const logit = (p: number) => {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function applyPlatt(p: number, map: PlattMap): number {
  return sigmoid(map.a * logit(p) + map.b);
}

/**
 * Regularized Platt scaling: Newton's method with a backtracking line search
 * on the penalized log loss, so every step lowers it (plain Newton overshoots
 * badly on a saturated classifier whose inputs are all 0 or 1). The L2 pull
 * toward the identity (a = 1, b = 0) keeps a small or perfectly separable case
 * set from driving the slope to infinity; the bounds keep it finite anyway.
 */
export function fitPlatt(points: readonly CalibrationPoint[], lambda = 1): PlattMap {
  const xs = points.map((pt) => logit(pt.p));
  const bound = (m: PlattMap): PlattMap => ({
    a: Math.min(20, Math.max(0.01, m.a)),
    b: Math.min(20, Math.max(-20, m.b)),
  });
  const loss = (m: PlattMap) => {
    let l = (lambda / 2) * ((m.a - 1) ** 2 + m.b ** 2);
    for (let i = 0; i < xs.length; i++) {
      const z = m.a * xs[i]! + m.b;
      // log(1 + e^z) - y·z, computed stably.
      l += (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))) - points[i]!.y * z;
    }
    return l;
  };
  let m: PlattMap = { a: 1, b: 0 };
  let current = loss(m);
  for (let iter = 0; iter < 200; iter++) {
    let ga = lambda * (m.a - 1);
    let gb = lambda * m.b;
    let haa = lambda;
    let hab = 0;
    let hbb = lambda;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      const q = sigmoid(m.a * x + m.b);
      const r = q - points[i]!.y;
      const w = q * (1 - q);
      ga += r * x;
      gb += r;
      haa += w * x * x;
      hab += w * x;
      hbb += w;
    }
    const det = haa * hbb - hab * hab;
    // Newton direction when the Hessian is usable, else plain gradient descent.
    let da = det > 1e-12 ? (hbb * ga - hab * gb) / det : ga;
    let db = det > 1e-12 ? (haa * gb - hab * ga) / det : gb;
    if (da * ga + db * gb <= 0) {
      da = ga;
      db = gb;
    }
    let step = 1;
    let next = bound({ a: m.a - da, b: m.b - db });
    let nextLoss = loss(next);
    while (nextLoss > current && step > 1e-8) {
      step /= 2;
      next = bound({ a: m.a - step * da, b: m.b - step * db });
      nextLoss = loss(next);
    }
    if (nextLoss > current) break;
    const moved = Math.abs(next.a - m.a) + Math.abs(next.b - m.b);
    m = next;
    current = nextLoss;
    if (moved < 1e-10) break;
  }
  return m;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface CalibrationMetrics {
  /** Mean squared error of the probability (0 perfect, 0.25 = always 0.5). */
  brier: number;
  /** Expected calibration error over 10 equal-width bins. */
  ece: number;
  logLoss: number;
}

export function scoreProbabilities(
  predictions: readonly number[],
  labels: readonly (0 | 1)[],
): CalibrationMetrics {
  const n = predictions.length;
  if (n === 0) return { brier: 0, ece: 0, logLoss: 0 };
  let brier = 0;
  let logLoss = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - EPS, Math.max(EPS, predictions[i]!));
    const y = labels[i]!;
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    const bin = bins[Math.min(9, Math.floor(p * 10))]!;
    bin.n++;
    bin.p += p;
    bin.y += y;
  }
  const ece = bins.reduce(
    (s, bin) => (bin.n ? s + (bin.n / n) * Math.abs(bin.y / bin.n - bin.p / bin.n) : s),
    0,
  );
  return { brier: brier / n, ece, logLoss: logLoss / n };
}

/** The bar a fit must clear to be used. Tuned conservatively; see `earnCalibration`. */
export const CALIBRATION_BAR = {
  /** Cases with a probability. */
  minCases: 40,
  /** Per class (hold and allow). */
  minPerClass: 15,
  /** Out-of-sample expected calibration error. */
  maxEce: 0.1,
  /** Out-of-sample Brier score: must discriminate, not just match the base rate (0.25). */
  maxBrier: 0.12,
} as const;

export interface CalibrationEntry {
  method: "platt";
  stage: "gate";
  a: number;
  b: number;
  cases: number;
  holds: number;
  /** The backend's own probabilities, as served. */
  raw: CalibrationMetrics;
  /** Leave-one-out: each case predicted by a fit that never saw it. */
  fitted: CalibrationMetrics;
  earned: boolean;
  /** Why it was not earned (empty when earned). */
  reasons: string[];
  /** How a chat classifier obtained its probabilities when this was measured. */
  classifierMethod?: string;
  /** Gate DECISIONS on the cases, today's policy vs the fitted rule (leave-one-out). */
  decisions?: { today: GateTally; fitted: GateTally };
}

export interface GateTally {
  accuracy: number;
  missedHolds: number;
  falseHolds: number;
}

/**
 * A fitted P(hold) at or above this holds the call. The cases are labeled
 * hold/allow only ("ask or block is correct"), so a fit decides allow vs hold
 * and nothing more: whether a hold is an outright block stays the backend's
 * native judgement (`gateActionWithFit`).
 */
export const FITTED_HOLD_AT = 0.5;

/**
 * The gate action under an earned fit: allow when the fitted P(hold) is below
 * `FITTED_HOLD_AT`; otherwise ask a person — or block, only when the backend is
 * natively calibrated and its RAW worst risk reaches `DEFAULT_GATE_POLICY.blockAt`.
 * A chat classifier with a fit therefore still never blocks outright.
 */
export function gateActionWithFit(
  rawWorst: number,
  fittedWorst: number,
  nativelyCalibrated: boolean,
): "allow" | "ask" | "block" {
  if (fittedWorst < FITTED_HOLD_AT) return "allow";
  return nativelyCalibrated && rawWorst >= DEFAULT_GATE_POLICY.blockAt ? "block" : "ask";
}

const actionOf = (p: number, policy: GatePolicy) =>
  p >= policy.blockAt ? "block" : p >= policy.askAt ? "ask" : "allow";

function tally(actions: readonly string[], labels: readonly (0 | 1)[]): GateTally {
  let correct = 0;
  let missedHolds = 0;
  let falseHolds = 0;
  actions.forEach((a, i) => {
    const held = a !== "allow";
    if (held === (labels[i] === 1)) correct++;
    if (held && labels[i] === 0) falseHolds++;
    if (!held && labels[i] === 1) missedHolds++;
  });
  return { accuracy: actions.length ? correct / actions.length : 0, missedHolds, falseHolds };
}

/** Fit, score out of sample, and decide whether the calibration is earned. */
export function fitGateCalibration(
  points: readonly CalibrationPoint[],
  opts: { classifierMethod?: string; nativelyCalibrated?: boolean } = {},
): CalibrationEntry {
  const { classifierMethod, nativelyCalibrated = false } = opts;
  const labels = points.map((pt) => pt.y);
  const holds = labels.filter((y) => y === 1).length;
  const map = fitPlatt(points);
  const loo = points.map((pt, i) => applyPlatt(pt.p, fitPlatt(points.filter((_, j) => j !== i))));
  const raw = scoreProbabilities(
    points.map((pt) => pt.p),
    labels,
  );
  const fitted = scoreProbabilities(loo, labels);
  const reasons: string[] = [];
  const bar = CALIBRATION_BAR;
  if (points.length < bar.minCases) reasons.push(`${points.length} cases < ${bar.minCases}`);
  if (Math.min(holds, points.length - holds) < bar.minPerClass) {
    reasons.push(
      `fewer than ${bar.minPerClass} cases in a class (${holds} hold / ${points.length - holds} allow)`,
    );
  }
  if (fitted.ece > bar.maxEce)
    reasons.push(`calibration error ${fitted.ece.toFixed(3)} > ${bar.maxEce}`);
  if (fitted.brier > bar.maxBrier)
    reasons.push(
      `Brier ${fitted.brier.toFixed(3)} > ${bar.maxBrier} (does not discriminate enough)`,
    );
  if (fitted.brier > raw.brier + 1e-9)
    reasons.push(
      `the fit makes Brier worse (${raw.brier.toFixed(3)} → ${fitted.brier.toFixed(3)})`,
    );
  // Better probabilities are not enough: the fitted gate must DECIDE at least as
  // well as today's, out of sample, and never miss more holds.
  const todayPolicy = nativelyCalibrated ? DEFAULT_GATE_POLICY : UNCALIBRATED_GATE_POLICY;
  const decisions = {
    today: tally(
      points.map((pt) => actionOf(pt.p, todayPolicy)),
      labels,
    ),
    fitted: tally(
      points.map((pt, i) => gateActionWithFit(pt.p, loo[i]!, nativelyCalibrated)),
      labels,
    ),
  };
  if (decisions.fitted.missedHolds > decisions.today.missedHolds) {
    reasons.push(
      `the fitted gate misses more holds (${decisions.today.missedHolds} → ${decisions.fitted.missedHolds})`,
    );
  }
  if (decisions.fitted.accuracy < decisions.today.accuracy - 1e-9) {
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
    reasons.push(
      `the fitted gate decides worse (${pct(decisions.today.accuracy)} → ${pct(decisions.fitted.accuracy)})`,
    );
  }
  return {
    method: "platt",
    stage: "gate",
    a: map.a,
    b: map.b,
    cases: points.length,
    holds,
    raw,
    fitted,
    earned: reasons.length === 0,
    reasons,
    ...(classifierMethod ? { classifierMethod } : {}),
    decisions,
  };
}

// ─── The file ────────────────────────────────────────────────────────────────

export interface CalibrationFile {
  version: 1;
  generatedAt: string;
  /** The case file the fits were measured on. */
  cases: string;
  /** Keyed by the backend's model id as the gate sees it (`typesafe/jev-1.13`, `z-ai/glm-5.3-flash`, `marina/classifier:<m>`). */
  engines: Record<string, CalibrationEntry>;
}

function validEntry(e: unknown): e is CalibrationEntry {
  const x = e as CalibrationEntry;
  return (
    !!x &&
    x.method === "platt" &&
    x.stage === "gate" &&
    Number.isFinite(x.a) &&
    Number.isFinite(x.b) &&
    typeof x.earned === "boolean"
  );
}

let cache: { key: string; file: CalibrationFile | undefined } | undefined;

/**
 * The operator's calibration file (`MARINA_DECISION_CALIBRATION`), re-read
 * when it changes. Missing, unreadable, malformed, or writable by anyone but
 * its owner ⇒ undefined and a warning: a bad file never breaks the gate, it
 * only leaves it uncalibrated.
 */
export function loadCalibration(env: NodeJS.ProcessEnv = process.env): CalibrationFile | undefined {
  const path = env.MARINA_DECISION_CALIBRATION?.trim();
  if (!path) return undefined;
  let key: string;
  try {
    const st = statSync(path);
    key = `${path}|${st.mtimeMs}|${st.size}`;
  } catch (err) {
    if (cache?.key !== `${path}|missing`) {
      logger.warn("decisions", "calibration file unreadable; gate stays uncalibrated", {
        path,
        error: (err as Error).message,
      });
    }
    cache = { key: `${path}|missing`, file: undefined };
    return undefined;
  }
  if (cache?.key === key) return cache.file;
  let file: CalibrationFile | undefined;
  try {
    // It can loosen a safety gate, so only its owner may be able to change it.
    if (process.platform !== "win32" && (statSync(path).mode & 0o022) !== 0) {
      throw new Error("writable by group or others (chmod 644 or stricter)");
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as CalibrationFile;
    if (raw?.version !== 1 || !raw.engines || typeof raw.engines !== "object")
      throw new Error("not a version-1 calibration file");
    const engines: Record<string, CalibrationEntry> = {};
    for (const [model, entry] of Object.entries(raw.engines))
      if (validEntry(entry)) engines[model] = entry;
    file = { ...raw, engines };
  } catch (err) {
    logger.warn("decisions", "calibration file invalid; gate stays uncalibrated", {
      path,
      error: (err as Error).message,
    });
  }
  cache = { key, file };
  return file;
}

/** Test seam. */
export function resetCalibrationCacheForTests(): void {
  cache = undefined;
}

/** The EARNED gate calibration for a backend model, if any. */
export function earnedGateCalibration(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): CalibrationEntry | undefined {
  const entry = loadCalibration(env)?.engines[model];
  return entry?.earned ? entry : undefined;
}
