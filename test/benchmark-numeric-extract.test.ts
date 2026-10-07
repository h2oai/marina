// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { answersMatch, extractAnswer } from "../benchmarks/adapters/numeric";

describe("numeric benchmark answer extraction", () => {
  it("extracts \\boxed answers", () => {
    expect(extractAnswer("Step 1... so the answer is \\boxed{25}.")).toBe("25");
  });

  it("repairs JSON-escape-mangled LaTeX (\\b → backspace, \\f → formfeed)", () => {
    // `{"content":"\boxed{25}"}` parses to backspace + "oxed{25}" — the exact
    // failure that scored a fully-correct 10/10 gsm8k run at 10% (2026-09).
    expect(extractAnswer("The final answer is \boxed{25}.")).toBe("25");
    // Mangled \frac inside a mangled \boxed: repair restores both so the
    // boxed rule extracts the fraction (normalize() evaluates it downstream).
    expect(extractAnswer("Result: \boxed{\frac{1}{2}}")).toBe("\\frac{1}{2}");
  });

  it("keeps GSM8K and explicit-answer conventions working", () => {
    expect(extractAnswer("blah blah\n#### 1,250")).toBe("1250");
    expect(extractAnswer("Therefore the answer is 42.")).toBe("42");
    expect(extractAnswer("compute 3 then 7 then 99")).toBe("99");
  });
});

describe("numeric benchmark answer equivalence", () => {
  it("accepts equivalent forms", () => {
    expect(answersMatch("0.5", "\\frac{1}{2}")).toBe(true);
    expect(answersMatch("1/2", "0.5")).toBe(true);
    expect(answersMatch("\\frac12", "0.5")).toBe(true);
    expect(answersMatch("-\\frac{1}{2}", "-0.5")).toBe(true);
    expect(answersMatch("2\\sqrt{3}", "3.4641")).toBe(true);
    expect(answersMatch("1,250", "1250")).toBe(true);
    expect(answersMatch("\\$42", "42")).toBe(true);
    expect(answersMatch("90^\\circ", "90")).toBe(true);
    expect(answersMatch("x = 7", "7")).toBe(true);
    expect(answersMatch("\\pi/2", "1.5708")).toBe(true);
    expect(answersMatch("(1, 2)", "(1,2)")).toBe(true);
    expect(answersMatch("[0.5, 3]", "\\left[ \\frac{1}{2}, 3 \\right]")).toBe(true);
  });

  it("rejects near misses", () => {
    expect(answersMatch("10002", "10000")).toBe(false);
    expect(answersMatch("(1,2)", "(12)")).toBe(false);
    expect(answersMatch("(1,2)", "(2,1)")).toBe(false);
    expect(answersMatch("[1,2]", "(1,2,3)")).toBe(false);
    expect(answersMatch("1.73", "\\sqrt{3}")).toBe(false);
    expect(answersMatch("1/0", "0")).toBe(false);
  });
});
