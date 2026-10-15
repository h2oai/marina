// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Jev-compatibility conformance: does an engine answer in TypeSafe's published
 * shape (docs.typesafe.ai/api)? The same fixed requests run against real Jev,
 * an OpenJev server and every Marina engine (`qualify:decisions` reports it per
 * backend; `test/decision-engines.test.ts` runs it offline), so "Jev-compatible"
 * is something measured, not claimed. Shape only — accuracy and calibration are
 * the qualification cases' job.
 */

import { toWireAnswers } from "./answers";
import { locate, parseQuestions } from "./questions";
import type { DecisionProvider, DecisionQuestions, DecisionRequest } from "./types";

/** Probability mass may miss 1 by this much (rounding in the backend's reply). */
const SUM_TOLERANCE = 0.02;

const in01 = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

function distributionViolations(where: string, probabilities: unknown, keys: string[]): string[] {
  if (!probabilities || typeof probabilities !== "object") return [`${where}: no probabilities`];
  const p = probabilities as Record<string, unknown>;
  const out: string[] = [];
  const missing = keys.filter((k) => !Object.hasOwn(p, k));
  const extra = Object.keys(p).filter((k) => !keys.includes(k));
  if (missing.length > 0) out.push(`${where}: probabilities missing ${missing.join(", ")}`);
  if (extra.length > 0) out.push(`${where}: probabilities for unknown ${extra.join(", ")}`);
  if (!Object.values(p).every(in01)) out.push(`${where}: a probability is outside 0..1`);
  const sum = Object.values(p).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE)
    out.push(`${where}: probabilities sum to ${sum.toFixed(3)}`);
  return out;
}

/** Everything wrong with one wire reply (`answers` as served over HTTP). Empty ⇒ conformant. */
export function wireViolations(questions: DecisionQuestions, answers: unknown): string[] {
  if (!answers || typeof answers !== "object") return ["answers is not an object"];
  const a = answers as Record<string, Record<string, unknown> | undefined>;
  const out: string[] = [];
  for (const [id, q] of Object.entries(questions)) {
    const ans = a[id];
    if (!ans) {
      out.push(`${id}: not answered`);
      continue;
    }
    if (ans.type !== q.type) out.push(`${id}: type ${String(ans.type)}, asked ${q.type}`);
    if (q.type === "noul") {
      if (!in01(ans.noul)) out.push(`${id}: noul is not a probability`);
      continue;
    }
    if (!in01(ans.confidence)) out.push(`${id}: confidence is not in 0..1`);
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      if (typeof ans.choice !== "string" || !keys.includes(ans.choice)) {
        out.push(`${id}: choice is not a listed option`);
      }
      out.push(...distributionViolations(id, ans.probabilities, keys));
      continue;
    }
    if (q.type === "box") {
      const b = ans.box as Record<string, unknown> | undefined;
      if (!b || !["top", "bottom", "left", "right"].every((k) => in01(b[k]))) {
        out.push(`${id}: box edges are not fractions in 0..1`);
      } else if (
        (b.top as number) > (b.bottom as number) ||
        (b.left as number) > (b.right as number)
      ) {
        out.push(`${id}: box edges are out of order`);
      }
      continue;
    }
    const levels = q.criteria.map((_, i) => String(i));
    const s = ans.score;
    if (typeof s !== "number" || s < 0 || s > levels.length - 1) {
      out.push(`${id}: score is outside 0..${levels.length - 1}`);
    }
    const legend = ans.legend as Record<string, unknown> | undefined;
    if (!legend || levels.some((l) => typeof legend[l] !== "string")) {
      out.push(`${id}: legend does not describe every level`);
    }
    out.push(...distributionViolations(id, ans.probabilities, levels));
  }
  return out;
}

/** Fixed requests covering every question type and TypeSafe's edge cases. */
export const CONFORMANCE_REQUESTS: ReadonlyArray<{ name: string; request: DecisionRequest }> = [
  {
    name: "noul-with-criteria",
    request: {
      state: "The customer wrote: my card was charged twice for one order, please refund one.",
      questions: parseQuestions({
        refund: {
          type: "noul",
          instructions: "The customer is asking for a refund.",
          criteria: { true: "They ask for money back.", false: "They ask for anything else." },
        },
      }),
    },
  },
  {
    name: "choice-null-description",
    request: {
      state: { ticket: "The export button does nothing in Firefox.", customer: "enterprise" },
      questions: parseQuestions({
        team: {
          type: "choice",
          instructions: "Which team should handle this ticket?",
          criteria: { billing: null, technical: "Bugs, errors and broken features.", sales: null },
        },
      }),
    },
  },
  {
    name: "score-ten-levels",
    request: {
      state: "Production database is down for all customers; no workaround.",
      questions: parseQuestions({
        severity: {
          type: "score",
          instructions: { rubric: "Rate the incident's severity.", scale: "0 lowest, 9 highest" },
          criteria: Array.from({ length: 10 }, (_, i) =>
            i === 0 ? "No impact." : i === 9 ? "Total outage, no workaround." : `Severity ${i}.`,
          ),
        },
      }),
    },
  },
  {
    name: "several-questions",
    request: {
      state: ["Delete the staging bucket.", "Requested by the on-call engineer during cleanup."],
      questions: parseQuestions({
        destructive: { type: "noul", instructions: "The request destroys existing data." },
        tier: {
          type: "choice",
          instructions: "Which model tier should handle the request?",
          criteria: { fast: "Simple, well-specified.", powerful: "Ambiguous or high-stakes." },
        },
        risk: {
          type: "score",
          instructions: "How risky is it?",
          criteria: ["low", "medium", "high"],
        },
      }),
    },
  },
];

/**
 * A 288×288 PNG (inside Jev's pixel range, so it is sent unchanged): a red
 * circle (r 45) centred at (216, 72) on white — box ≈ top 0.09, bottom 0.41,
 * left 0.59, right 0.91.
 */
export const CONFORMANCE_IMAGE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASAAAAEgAgMAAABp7UYTAAAADFBMVEX/AQH/////cHD/yMiOo3omAAAACXBIWXMAAAsTAAALEwEAmpwYAAABsUlEQVR42u3ZPU7DQBCG4YmjFIBc+gipqOlzhBQhSYEQR/ARfIn0XII+l0hPyTFAiJ+1M0LKzCfZSO8c4JG1a69nvrV7URkQEBAQEBDQxKDdm9ntKQ/tnu2jrk9p6NU+6yYL7e2rlkmo+4aqHPTzQINHuhg6/kLzDPRoRb0koLaE6gTUlVAVhzbWqyYMtX2oDkPHPjSPQjsb1CkIPQyhuyC0HkKLILQaQrMg1A2hKgadrXWx2pZa62K1LXiEnB0llnive++2pTat2DZLbVqxbRdB5lQE2nrQIQBtPKgJQHsPWgagtQctAlDrQXUAevKgqwC08qBZADp60DwAdR5UjQmZ/fGNWOp8LM7IMaCtDx3GgzY+1AAB/W9oet/a9M4j2VE7wb+I7Acp+2XLmghZWyNrtGStn6wZlbXHsoZdN0LIhhrZmCUb/GSjqGw4lo3rugBBFmnIQhZZ7CMLonTRmCysk8WHukBTFrHKQl9dDC0LxnVRvezyQHedIbtg4TYLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICOjSegc51u8hMx1OtwAAAABJRU5ErkJggg==";

/**
 * Image requests (Jev ≥ 1.14, or a vision classifier): an image noul and a
 * box paired with its presence question. Run with `runConformance(p, { images: true })`.
 */
export const IMAGE_CONFORMANCE_REQUESTS: ReadonlyArray<{ name: string; request: DecisionRequest }> =
  [
    {
      name: "image-noul",
      request: {
        state: [
          "A generated image.",
          { type: "image_url", image_url: { url: CONFORMANCE_IMAGE_PNG } },
        ],
        questions: parseQuestions({
          depicts: { type: "noul", instructions: "The image depicts a red circle." },
        }),
      },
    },
    {
      name: "image-box",
      request: {
        state: [{ type: "image_url", image_url: { url: CONFORMANCE_IMAGE_PNG } }],
        questions: locate("circle", "a red circle"),
      },
    },
  ];

export interface ConformanceResult {
  passed: number;
  total: number;
  failures: Array<{ name: string; problems: string[] }>;
}

/**
 * Run every conformance request through a provider (real, billed calls for a
 * live backend); `images` adds {@link IMAGE_CONFORMANCE_REQUESTS}.
 */
export async function runConformance(
  provider: DecisionProvider,
  opts: { images?: boolean } = {},
): Promise<ConformanceResult> {
  const failures: ConformanceResult["failures"] = [];
  const requests = opts.images
    ? [...CONFORMANCE_REQUESTS, ...IMAGE_CONFORMANCE_REQUESTS]
    : CONFORMANCE_REQUESTS;
  for (const { name, request } of requests) {
    try {
      const result = await provider.ask(request);
      const problems = wireViolations(
        request.questions,
        toWireAnswers(request.questions, result.answers),
      );
      if (problems.length > 0) failures.push({ name, problems });
    } catch (err) {
      failures.push({ name, problems: [`call failed: ${(err as Error).message}`] });
    }
  }
  return {
    passed: requests.length - failures.length,
    total: requests.length,
    failures,
  };
}
