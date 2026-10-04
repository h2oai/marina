// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Typed-answer fixes from failure analysis: the FutureX answer shape a row
// asks for, numbers read with their scale and sign, the order-of-magnitude
// check across runs, and confidence-based run selection. Every fixture is
// synthetic; the optional audit at the end reads a local FutureX batch file.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { FuturexRow } from "../benchmarks/futurex/dataset";
import { specFor, titleUnit } from "../benchmarks/futurex/map";
import {
  levelWeighted,
  predictionUnder,
  promotionCheck,
  type SavedRow,
} from "../benchmarks/futurex/rescore-selection";
import { parseTruth } from "../benchmarks/futurex/score";
import {
  type AnswerSpec,
  combineAnswers,
  parseNumberWithScale,
  unitScale,
  validateAnswer,
} from "../src/forecast/answer-types";
import { critiqueApplies, reselect, type TypedRun } from "../src/forecast/typed";

const open = (q: string) =>
  `You are an agent that can predict future events. The event to be predicted: "${q} (resolved around 2030-08-26T16:35:00+08:00 (GMT+8))."\nReturn exactly the source-native value required by the settlement contract, with no units or commentary.\nIMPORTANT: End with \\boxed{YOUR_PREDICTION}.`;
const lettered = (q: string, options: string[]) =>
  `You are an agent that can predict future events. The event to be predicted: "${q} (resolved around 2030-09-14T23:59:59+08:00 (GMT+8)).\n${options
    .map((o, i) => `${String.fromCharCode(65 + i)}. the outcome be ${o}`)
    .join("\n")}"\nIMPORTANT: End with the selected option letter(s) in \\boxed{...}.`;
const row = (level: number, title: string, prompt = open(title)): FuturexRow => ({
  id: "r",
  level,
  en_title: `${title} (resolved around 2030-08-26T16:35:00+08:00 (GMT+8)).`,
  prompt,
  end_time: "2030-08-26T16:35:00+08:00",
});

describe("FutureX answer shape (specFor)", () => {
  it("an official statistic named by series and period asks for its figure", () => {
    for (const title of [
      "Widgetland health-service whole-time-equivalent staff — June 2030",
      "Statistics Widgetland food-services sales, June 2030",
      "Widgetland job openings — July 2030 survey",
      "Widgetland construction spending, July 2030",
      "Widgetland preliminary benchmark revision to March 2030 payroll employment",
      "Widgetland real retail-trade turnover month-on-month change — July 2030",
      "Utility patents issued in the Widget Gazette dated 1 September 2030",
    ]) {
      expect(specFor(row(3, title)).type).toBe("number");
    }
  });

  it("reads an inline unit and asks for a number", () => {
    const spec = specFor(
      row(3, "What exact maximum sustained wind, in knots, will the agency report for Storm X?"),
    );
    expect(spec).toEqual({ type: "number", unit: "knots" });
    expect(titleUnit("What exact minimum pressure, in mb, will it report?")).toBe("mb");
    expect(titleUnit("Widget exports (in thousands) for May")).toBe("thousands");
  });

  it("one top entry is one name, not a list", () => {
    expect(
      specFor(row(3, "Which club will be first in the final 2030 Widget Cup club ranking?")).type,
    ).toBe("text");
    // …but "first and second" is still a list.
    expect(
      specFor(row(3, "Which two candidates will rank first and second in the 2030 poll?")).type,
    ).toBe("ranking");
  });

  it("several winners or which-<plural> identifiers ask for a list", () => {
    expect(
      specFor(
        row(4, "Official winners of the six Widget Fight Night main-card bouts on 1 May 2030"),
      ).type,
    ).toBe("ranking");
    expect(
      specFor(row(4, "Which CVE identifiers will the agency add to its catalog from 9 to 14 May?"))
        .type,
    ).toBe("ranking");
  });

  it("a count with bucketed options is one choice, even with a top-N cue", () => {
    const title =
      "How many songs from the prior weekly top five will remain in the top five next week?";
    const spec = specFor(row(2, title, lettered(title, ["0 or 1", "2", "3", "4 or 5"])));
    expect(spec.type).toBe("choice");
  });

  it("keeps the other shapes", () => {
    expect(specFor(row(3, "What exact title will the agency publish for its picture?")).type).toBe(
      "text",
    );
    const nominees = "Best Picture nominees? (2030)";
    expect(specFor(row(2, nominees, lettered(nominees, ["Film A", "Film B"]))).type).toBe("multi");
  });
});

describe("numbers: scale, sign and unit", () => {
  const num = (unit?: string): AnswerSpec => ({ type: "number", ...(unit ? { unit } : {}) });

  it("reads scale words, accounting negatives, sign words and a Unicode minus", () => {
    expect(parseNumberWithScale("1.2 million")).toEqual({ value: 1_200_000, scale: 1e6 });
    expect(parseNumberWithScale("$3.4bn")?.value).toBe(3.4e9);
    expect(parseNumberWithScale("68k")?.value).toBe(68_000);
    expect(parseNumberWithScale("3 m")?.value).toBe(3); // metres, not millions
    expect(parseNumberWithScale("(79,000)")?.value).toBe(-79_000);
    expect(parseNumberWithScale("−79000")?.value).toBe(-79_000);
    expect(parseNumberWithScale("down 0.4")?.value).toBe(-0.4);
    expect(parseNumberWithScale("a decline of 2.5%")?.value).toBe(-2.5);
    expect(parseNumberWithScale("about 25 knots")?.value).toBe(25);
    expect(parseNumberWithScale("1 234 567")?.value).toBe(1_234_567);
    expect(parseNumberWithScale("no figure")).toBeUndefined();
  });

  it("converts to the unit's scale when the answer names one", () => {
    expect(unitScale("USD billions")).toBe(1e9);
    expect(unitScale("thousands of persons")).toBe(1e3);
    expect(unitScale("knots")).toBeUndefined();
    expect(validateAnswer(num("USD billions"), "1,234 million")).toEqual({ value: 1.234 });
    expect(validateAnswer(num("USD billions"), "2157.6")).toEqual({ value: 2157.6 });
    expect(validateAnswer(num("thousands"), "7.271 million")).toEqual({ value: 7271 });
    expect(validateAnswer(num(), "7.271 million")).toEqual({ value: 7_271_000 });
    expect(validateAnswer(num(), 42)).toEqual({ value: 42 });
  });

  it("brings a run written at another power-of-ten scale to the runs' scale", () => {
    const c = combineAnswers(num(), [
      { value: 7271, weight: 1 },
      { value: 7_300_000, weight: 1 },
      { value: 7250, weight: 1 },
    ]);
    expect(c?.value).toBe(7271);
    expect(c?.rescaled).toBe(1);
    expect(c?.method).toContain("scale-aligned");
    // Two runs cannot outvote each other on scale; a non-power-of-ten gap is left alone.
    expect(
      combineAnswers(num(), [
        { value: 7271, weight: 1 },
        { value: 7_271_000, weight: 1 },
      ])?.rescaled,
    ).toBeUndefined();
    expect(
      combineAnswers(num(), [
        { value: 100, weight: 1 },
        { value: 50_000, weight: 1 },
        { value: 110, weight: 1 },
      ])?.rescaled,
    ).toBeUndefined();
  });
});

describe("run selection", () => {
  const choice: AnswerSpec = { type: "choice", options: [{ id: "A" }, { id: "B" }] };
  const runs = [
    { value: "A", weight: 1, confidence: 0.4 },
    { value: "A", weight: 1, confidence: 0.5 },
    { value: "B", weight: 1, confidence: 0.9 },
  ];

  it("agreement (the default) takes the plurality with agreement as confidence", () => {
    const c = combineAnswers(choice, runs);
    expect(c).toMatchObject({ value: "A", agreement: 0.667 });
    expect(c?.selfConfidence).toBeUndefined();
  });

  it("confidence takes the most self-confident run with its own confidence", () => {
    const c = combineAnswers(choice, runs, { selection: "confidence" });
    expect(c).toMatchObject({ value: "B", selfConfidence: 0.9, agreement: 0.333 });
    expect(c?.method).toBe("most self-confident run");
    // Ties go to the run agreeing with the plurality.
    const tied = combineAnswers(
      choice,
      [
        { value: "B", weight: 1, confidence: 0.7 },
        { value: "A", weight: 1, confidence: 0.7 },
        { value: "A", weight: 1, confidence: 0.2 },
      ],
      { selection: "confidence" },
    );
    expect(tied?.value).toBe("A");
    // Numbers and lists: the chosen run's own value.
    expect(
      combineAnswers(
        { type: "number" },
        [
          { value: 10, weight: 1, confidence: 0.3 },
          { value: 12, weight: 1, confidence: 0.8 },
          { value: 11, weight: 1, confidence: 0.3 },
        ],
        { selection: "confidence" },
      )?.value,
    ).toBe(12);
  });

  it("re-selects a saved forecast offline, the critique judged against the new confidence", () => {
    const saved = {
      answer: choice,
      runs: runs.map((r, i) => ({ run: i + 1, model: "m", status: "ok", ...r })) as TypedRun[],
      critique: {
        model: "c",
        verdict: "revise" as const,
        proposed: "A",
        confidence: 0.8,
        applied: false,
      },
    };
    expect(critiqueApplies(0.8, 0.667)).toBe(true);
    expect(critiqueApplies(0.8, 0.9)).toBe(false);
    // Agreement: plurality A; the critic (0.8 > 0.667) proposes A anyway.
    expect(reselect(saved, "agreement")).toBe("A");
    // Confidence: run 3's B at 0.9 — the critic (0.8) is not more sure.
    expect(reselect(saved, "confidence")).toBe("B");
  });

  it("scores modes offline and gates promotion on the holdout margin", () => {
    const truth = new Map<string, FuturexRow>();
    const mk = (id: string, level: number, gold: string, values: Array<[string, number]>) => {
      truth.set(id, {
        id,
        level,
        prompt: lettered("Q?", ["x", "y"]),
        end_time: "2030-01-01",
        ground_truth: `['${gold}']`,
      });
      return {
        id,
        level,
        prediction: "",
        answer: {
          answer: choice,
          runs: values.map(([v, c], i) => ({
            run: i + 1,
            model: "m",
            status: "ok",
            weight: 1,
            value: v,
            formatted: v,
            confidence: c,
          })),
        },
      } satisfies SavedRow;
    };
    const rows: SavedRow[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(
        mk(`r${i}`, 1 + (i % 4), "B", [
          ["A", 0.3],
          ["A", 0.4],
          ["B", 0.95],
        ]),
      );
    }
    const ids = rows.map((r) => r.id);
    expect(parseTruth(truth.get("r0")!.ground_truth)).toEqual(["B"]);
    expect(predictionUnder(rows[0]!, "agreement")).toBe("A");
    expect(predictionUnder(rows[0]!, "confidence")).toBe("B");
    expect(predictionUnder({ ...rows[0]!, fallback: true, prediction: "A" }, "confidence")).toBe(
      "A",
    );
    expect(
      levelWeighted([
        { level: 1, score: 1 },
        { level: 4, score: 0 },
      ]),
    ).toBeCloseTo(0.2);
    const check = promotionCheck([rows], truth, ids, "confidence", "agreement", 0, 500);
    expect(check.delta).toBe(1);
    expect(check.promotable).toBe(true);
    const flat = promotionCheck([rows], truth, ids, "agreement", "agreement", 0, 500);
    expect(flat.promotable).toBe(false);
    expect(flat.reasons.join(" ")).toContain("margin");
  });
});

// The rows the failure analysis found mistyped (ids only). Runs only where the
// operator's local FutureX past batch is present: FUTUREX_SHAPE_AUDIT_BATCH.
const BATCH = process.env.FUTUREX_SHAPE_AUDIT_BATCH;
const MISTYPED: Record<string, AnswerSpec["type"]> = {
  "79e880b57dbaa4f15792c013": "text",
  "6a2baa120769500205fc4f3a": "number",
  "2b9575679e010acb837fcf8e": "number",
  "24cd9256742b7c52c8d0e823": "number",
  "376e51ad4bfe4a7ee2fdec98": "number",
  "4c36b26cf6ccaea7b5d84076": "number",
  "0d02915536896c29f65eb3b0": "number",
  "7add4b00f374b4d0ad16ce52": "ranking",
  "5a885dba6c546caf89da69bc": "number",
  "48e68bf06f1297c45a5c0b0d": "number",
  "6cfe435dd2e257e03e033825": "number",
  "7242aae05ce7e7ed1cb361d4": "number",
  "4254aa7f59a5e47de1acc61d": "choice",
  "015307b6d0b309d6538e74ca": "ranking",
};
describe.skipIf(!BATCH || !existsSync(BATCH))("FutureX shape audit (local batch)", () => {
  it("types every row the failure analysis found mistyped by its truth's shape", () => {
    const rows = new Map(
      (JSON.parse(readFileSync(BATCH!, "utf8")).rows as FuturexRow[]).map((r) => [r.id, r]),
    );
    for (const [id, type] of Object.entries(MISTYPED)) {
      expect(rows.has(id)).toBe(true);
      expect([id, specFor(rows.get(id)!).type]).toEqual([id, type]);
    }
  });
});
