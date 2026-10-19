// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { Retriever } from "../src/arena/research/retrieve";
import {
  type AnswerContract,
  checkContract,
  contractInstruction,
  contractModeFromEnv,
  datesIn,
  enforceContract,
  fallbackFor,
  formatDate,
  parseAnswerContract,
  parseContractSpec,
  renderContract,
} from "../src/forecast/answer-contract";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { forecastFormed } from "../src/forecast/formations";
import { typedOptionsFromEnv } from "../src/forecast/service";
import type { ModelPart } from "../src/forecast/typed";

const abc: AnswerSpec = {
  type: "choice",
  options: [
    { id: "A", label: "Yes" },
    { id: "B", label: "No" },
    { id: "C", label: "Postponed" },
  ],
};

describe("parsing the question's own instructions", () => {
  it("returns nothing when the text states no answer form (the spec alone governs)", () => {
    expect(parseAnswerContract({ question: "Will it rain?", answer: abc })).toBeUndefined();
    expect(
      parseAnswerContract({ question: "How many?", context: "Resolves on the bureau's figure." }),
    ).toBeUndefined();
  });

  it("reads a boxed single choice from the format line", () => {
    const c = parseAnswerContract({
      question: "Will the vote pass?",
      context:
        "A. Yes\nB. No\nC. Postponed\nIMPORTANT: End with the selected option letter in \\boxed{}.",
      answer: abc,
    })!;
    expect(c.form).toBe("single-choice");
    expect(c.wrapper).toBe("boxed");
    expect(c.options?.map((o) => o.id)).toEqual(["A", "B", "C"]);
    expect(c.formatLine).toContain("IMPORTANT: End with");
  });

  it("reads multi-select pick bounds", () => {
    const multi: AnswerSpec = {
      type: "multi",
      options: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
    };
    expect(
      parseAnswerContract({ question: "Which will happen? Select up to two.", answer: multi }),
    ).toMatchObject({ form: "multi-select", maxPicks: 2 });
    expect(
      parseAnswerContract({ question: "Which? Select exactly 3 options.", answer: multi }),
    ).toMatchObject({ minPicks: 3, maxPicks: 3 });
  });

  it("reads a number's unit, integer and decimals", () => {
    expect(
      parseAnswerContract({
        question: "What will CPI inflation be?",
        context: "Report the value in percent. Give your answer rounded to one decimal place.",
        answer: { type: "number" },
      }),
    ).toMatchObject({ form: "number", unit: "percent", decimals: 1 });
    expect(
      parseAnswerContract({
        question: "How many seats?",
        context: "Answer as a whole number.",
        answer: { type: "number" },
      }),
    ).toMatchObject({ form: "number", integer: true });
  });

  it("turns a text question into a date when a date format is named or a date is asked", () => {
    expect(
      parseAnswerContract({
        question: "When will the launch happen?",
        context: "Answer with a date in DD/MM/YYYY.",
        answer: { type: "text" },
      }),
    ).toMatchObject({ form: "date", dateFormat: "DD/MM/YYYY" });
    expect(
      parseAnswerContract({ question: "On what date will it open?", answer: { type: "text" } }),
    ).toMatchObject({ form: "date", dateFormat: "YYYY-MM-DD" });
    // A choice question naming a date format stays a choice.
    expect(
      parseAnswerContract({
        question: "Which?",
        context: "Dates are YYYY-MM-DD. End with \\boxed{X}",
        answer: abc,
      })?.form,
    ).toBe("single-choice");
  });

  it("reads a list size and a free-text word limit", () => {
    expect(
      parseAnswerContract({
        question: "Which films will lead the box office? List the top 3.",
        answer: { type: "ranking" },
      }),
    ).toMatchObject({ form: "ranked-list", size: 3 });
    expect(
      parseAnswerContract({
        question: "Who will win?",
        context: "Answer in at most four words.",
        answer: { type: "text" },
      }),
    ).toMatchObject({ form: "free-text", maxWords: 4 });
  });

  it("infers a yes/no choice without a spec", () => {
    expect(
      parseAnswerContract({ question: "Will it close higher? Answer yes or no." }),
    ).toMatchObject({ form: "single-choice", options: [{ id: "Yes" }, { id: "No" }] });
  });

  it("says the form in one instruction, bare value in JSON when wrapped", () => {
    const text = contractInstruction({
      form: "date",
      dateFormat: "YYYY-MM-DD",
      wrapper: "boxed",
      formatLine: "End with \\boxed{YYYY-MM-DD}",
    });
    expect(text).toContain("one calendar date written YYYY-MM-DD");
    expect(text).toContain("bare value");
    expect(text).toContain('format line: "End with');
  });
});

describe("an explicit contract from JSON", () => {
  it("takes options from the spec and checks the form fits the type", () => {
    expect(parseContractSpec({ form: "single-choice", wrapper: "boxed" }, abc)).toEqual({
      contract: { form: "single-choice", options: abc.options, wrapper: "boxed" },
    });
    expect(parseContractSpec({ form: "date" }, { type: "text" })).toEqual({
      contract: { form: "date", dateFormat: "YYYY-MM-DD" },
    });
    expect(
      parseContractSpec(
        { form: "number", decimals: 2, unit: "USD", integer: false },
        {
          type: "number",
        },
      ),
    ).toEqual({ contract: { form: "number", decimals: 2, unit: "USD" } });
    expect(parseContractSpec({ form: "date" }, abc)).toHaveProperty("error");
    expect(
      parseContractSpec(
        { form: "multi-select", minPicks: 3, maxPicks: 2 },
        { type: "multi", options: abc.options },
      ),
    ).toEqual({ error: "contract.minPicks exceeds contract.maxPicks" });
    expect(parseContractSpec({ form: "ranked-list", size: 99 }, { type: "ranking" })).toEqual({
      error: "contract.size must be an integer 1–50",
    });
  });
});

describe("checking and normalising", () => {
  const choice: AnswerContract = { form: "single-choice", options: abc.options, wrapper: "boxed" };

  it("normalises a choice losslessly (case, label, wrapper) and renders it boxed", () => {
    expect(checkContract(choice, "B")).toEqual({
      ok: true,
      value: "B",
      rendered: "\\boxed{B}",
      normalized: false,
    });
    expect(checkContract(choice, "\\boxed{b}")).toMatchObject({ ok: true, value: "B" });
    expect(checkContract(choice, "Postponed")).toMatchObject({ ok: true, value: "C" });
    expect(checkContract(choice, "A, B")).toMatchObject({ ok: false });
    expect(checkContract(choice, "Maybe")).toMatchObject({ ok: false });
  });

  it("checks multi-select bounds", () => {
    const multi: AnswerContract = {
      form: "multi-select",
      options: [{ id: "A" }, { id: "B" }, { id: "C" }],
      maxPicks: 2,
    };
    expect(checkContract(multi, "C, A")).toMatchObject({ ok: true, value: ["A", "C"] });
    expect(checkContract(multi, ["A", "B", "C"])).toMatchObject({ ok: false });
  });

  it("checks a number: one number, rounded to the stated decimals", () => {
    const n: AnswerContract = { form: "number", decimals: 1 };
    expect(checkContract(n, 3.1234)).toMatchObject({ ok: true, value: 3.1, rendered: "3.1" });
    expect(checkContract(n, "about 3.0")).toMatchObject({ ok: true, value: 3, rendered: "3.0" });
    expect(checkContract(n, "between 3 and 4")).toMatchObject({ ok: false });
    expect(checkContract(n, "unknown")).toMatchObject({ ok: false });
    expect(checkContract({ form: "number", integer: true }, "7.6")).toMatchObject({ value: 8 });
  });

  it("checks a date in any notation and writes it in the format", () => {
    const d: AnswerContract = { form: "date", dateFormat: "YYYY-MM-DD" };
    expect(checkContract(d, "2026-10-03")).toMatchObject({ ok: true, normalized: false });
    expect(checkContract(d, "October 3rd, 2026")).toMatchObject({ value: "2026-10-03" });
    expect(checkContract(d, "3 Oct 2026")).toMatchObject({ value: "2026-10-03" });
    expect(checkContract(d, "10/03/2026")).toMatchObject({ value: "2026-10-03" });
    expect(checkContract({ form: "date", dateFormat: "DD/MM/YYYY" }, "10/03/2026")).toMatchObject({
      value: "10/03/2026",
    });
    expect(checkContract(d, "2026-02-30")).toMatchObject({ ok: false });
    expect(checkContract(d, "2026-10-03 or 2026-10-04")).toMatchObject({ ok: false });
    expect(checkContract(d, "next week")).toMatchObject({ ok: false });
    expect(formatDate({ y: 2026, m: 10, d: 3 }, "Month D, YYYY")).toBe("October 3, 2026");
    expect(datesIn("October 2026", "YYYY-MM")).toEqual([{ y: 2026, m: 10 }]);
  });

  it("checks a ranked list's size (cut when long, a violation when short)", () => {
    const r: AnswerContract = { form: "ranked-list", size: 2 };
    expect(checkContract(r, "X, Y, Z")).toMatchObject({ ok: true, value: ["X", "Y"] });
    expect(checkContract(r, "1. X 2. Y")).toMatchObject({ ok: true, value: ["X", "Y"] });
    expect(checkContract(r, "X")).toMatchObject({ ok: false });
  });

  it("checks free text against its word limit", () => {
    const t: AnswerContract = { form: "free-text", maxWords: 2 };
    expect(checkContract(t, "Jane Doe")).toMatchObject({ ok: true });
    expect(checkContract(t, "Jane Q. Public")).toMatchObject({ ok: false });
    expect(renderContract({ ...t, wrapper: "boxed" }, "Jane Doe")).toBe("\\boxed{Jane Doe}");
  });

  it("falls back deterministically", () => {
    const c: AnswerContract = { form: "single-choice", options: abc.options };
    expect(fallbackFor(c, "probably B or C")?.value).toBe("B");
    expect(fallbackFor(c, "unclear", { A: 0.2, B: 0.1, C: 0.7 })?.value).toBe("C");
    expect(fallbackFor(c, "unclear")?.value).toBe("A");
    expect(fallbackFor({ form: "number" }, "between 3 and 4")?.value).toBe(3);
    expect(fallbackFor({ form: "date" }, "maybe 2026-10-03, maybe later")?.value).toBe(
      "2026-10-03",
    );
    expect(fallbackFor({ form: "date" }, "next week")).toBeUndefined();
    expect(fallbackFor({ form: "free-text", maxWords: 2 }, "Jane Q. Public")?.value).toBe(
      "Jane Q.",
    );
  });
});

describe("enforcing", () => {
  const d: AnswerContract = { form: "date", dateFormat: "YYYY-MM-DD", wrapper: "boxed" };

  it("records ok / normalized without a re-ask", async () => {
    let asked = 0;
    const reask = async () => {
      asked++;
      return { answer: "x" };
    };
    expect((await enforceContract(d, "2026-10-03", { mode: "on", reask })).status).toBe("ok");
    const n = await enforceContract(d, "Oct 3, 2026", { mode: "on", reask });
    expect(n).toMatchObject({ status: "normalized", value: "2026-10-03" });
    expect(n.rendered).toBe("\\boxed{2026-10-03}");
    expect(asked).toBe(0);
  });

  it("re-asks once on a violation, then falls back", async () => {
    const seen: string[] = [];
    const fixed = await enforceContract(d, "early October", {
      mode: "on",
      reask: async (v) => {
        seen.push(v);
        return { answer: "2026-10-02", model: "critic" };
      },
    });
    expect(fixed).toMatchObject({ status: "reasked", value: "2026-10-02" });
    expect(fixed.reask).toEqual({ model: "critic", accepted: true });
    expect(seen).toEqual(["no date"]);

    let calls = 0;
    const fb = await enforceContract(d, "around 2026-10-05 or 2026-10-06", {
      mode: "on",
      reask: async () => {
        calls++;
        return { answer: "soon" };
      },
    });
    expect(calls).toBe(1);
    expect(fb).toMatchObject({ status: "fallback", value: "2026-10-05" });
    expect(fb.violations).toEqual(["more than one date", "re-ask: no date"]);

    const thrown = await enforceContract(d, "unknown", {
      mode: "on",
      reask: async () => {
        throw new Error("model down");
      },
    });
    expect(thrown.status).toBe("violation");
    expect(thrown.reask?.error).toBe("model down");
  });

  it("observe records the violation and never re-asks", async () => {
    const rec = await enforceContract(d, "early October", {
      mode: "observe",
      reask: async () => {
        throw new Error("must not be called");
      },
    });
    expect(rec).toMatchObject({ mode: "observe", status: "violation", violations: ["no date"] });
    expect(rec.value).toBeUndefined();
  });
});

describe("configuration", () => {
  it("is off by default and read from MARINA_FORECAST_CONTRACT", () => {
    expect(contractModeFromEnv({})).toBe("off");
    expect(contractModeFromEnv({ MARINA_FORECAST_CONTRACT: "ON" })).toBe("on");
    expect(contractModeFromEnv({ MARINA_FORECAST_CONTRACT: "junk" })).toBe("off");
    expect(typedOptionsFromEnv({}).contract).toBeUndefined();
    expect(typedOptionsFromEnv({ MARINA_FORECAST_CONTRACT: "observe" }).contract).toBe("observe");
  });
});

// ─── Through the pipeline ────────────────────────────────────────────────────

const retriever: Retriever = async () => ({
  report: "- 2026-09-20 — the launch was scheduled ([src](https://example.org/1))",
  sources: [{ url: "https://example.org/1" }],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
});

/** A model that records every prompt and answers by which one it was given. */
function recorder(
  answer: unknown,
  prompts: string[],
  reask = '{"answer": "2026-10-02"}',
): ModelPart {
  return {
    name: "m",
    complete: async (system, user) => {
      prompts.push(`${system}\n${user}`);
      if (system.startsWith("You plan research")) return '{"queries": ["launch date"]}';
      if (system.startsWith("You review a research dossier")) return '{"done": true}';
      if (system.startsWith("You restate a forecast")) return reask;
      if (system.startsWith("You are the forecaster's critic")) {
        return '{"verdict": "keep", "confidence": 0.5}';
      }
      return JSON.stringify({ answer, confidence: 0.6, reason: "r" });
    },
  };
}

const dateQuestion = {
  question: "When will the launch happen?",
  context: "IMPORTANT: End with the date in \\boxed{YYYY-MM-DD}.",
  answer: { type: "text" } as AnswerSpec,
  endTime: "2026-10-20T00:00:00Z",
};
const now = () => new Date("2026-10-05T00:00:00Z");

describe("forecastFormed with a contract", () => {
  it("off (default): no contract, no prompt change, answer untouched", async () => {
    const prompts: string[] = [];
    const m = recorder("early October", prompts);
    const a = await forecastFormed(dateQuestion, {
      retriever,
      analysts: [m],
      now,
      options: { runs: 1, researchRounds: 1 },
    });
    expect(a.contract).toBeUndefined();
    expect(a.formatted).toBe("early October");
    expect(prompts.some((p) => p.includes("Required answer form"))).toBe(false);
  });

  it("observe: records the violation, changes neither prompts nor answer", async () => {
    const prompts: string[] = [];
    const a = await forecastFormed(dateQuestion, {
      retriever,
      analysts: [recorder("early October", prompts)],
      now,
      options: { runs: 1, researchRounds: 1, contract: "observe" },
    });
    expect(a.contract).toMatchObject({ mode: "observe", status: "violation" });
    expect(a.formatted).toBe("early October");
    expect(prompts.some((p) => p.includes("Required answer form"))).toBe(false);
  });

  it("on: carries the contract to planner, runs and critic, re-asks once and replaces", async () => {
    const prompts: string[] = [];
    const a = await forecastFormed(dateQuestion, {
      retriever,
      analysts: [recorder("early October", prompts)],
      now,
      options: { runs: 1, researchRounds: 1, contract: "on" },
    });
    const asked = (start: string) => prompts.find((p) => p.startsWith(start)) ?? "";
    expect(asked("You plan research")).toContain("one calendar date written YYYY-MM-DD");
    expect(asked("You are a careful forecaster")).toContain("Required answer form");
    expect(asked("You are the forecaster's critic")).toContain("Required answer form");
    expect(a.contract).toMatchObject({
      mode: "on",
      status: "reasked",
      before: "early October",
      rendered: "\\boxed{2026-10-02}",
    });
    expect(a.prediction).toBe("2026-10-02");
    expect(a.formatted).toBe("2026-10-02");
  });

  it("on: a normalisable answer needs no re-ask; a caller's contract is enforced without the env", async () => {
    const prompts: string[] = [];
    const a = await forecastFormed(
      {
        ...dateQuestion,
        contract: { form: "date", dateFormat: "YYYY-MM-DD" },
      },
      {
        retriever,
        analysts: [recorder("October 9, 2026", prompts)],
        now,
        options: { runs: 1, researchRounds: 1 },
      },
    );
    expect(a.contract).toMatchObject({ status: "normalized", value: "2026-10-09" });
    expect(a.formatted).toBe("2026-10-09");
    expect(prompts.some((p) => p.startsWith("You restate a forecast"))).toBe(false);
  });

  it("on: a failed re-ask falls back deterministically", async () => {
    const prompts: string[] = [];
    const a = await forecastFormed(
      {
        question: "Which of these will happen? Select up to one.",
        answer: { type: "multi", options: [{ id: "A" }, { id: "B" }, { id: "C" }] },
      },
      {
        retriever,
        analysts: [recorder(["A", "B"], prompts, '{"answer": "A, B"}')],
        now,
        options: { runs: 1, researchRounds: 1, critique: false, contract: "on" },
      },
    );
    expect(prompts.filter((p) => p.startsWith("You restate a forecast"))).toHaveLength(1);
    expect(a.contract).toMatchObject({
      status: "fallback",
      before: "A, B",
      value: ["A"],
      violations: ["more than 1 options", "re-ask: more than 1 options"],
    });
    expect(a.prediction).toEqual(["A"]);
  });
});
