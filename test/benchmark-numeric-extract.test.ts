// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { extractAnswer } from "../benchmarks/adapters/numeric";

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
