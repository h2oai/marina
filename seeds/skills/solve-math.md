---
name: solve-math
description: How to approach a math problem (Mathematician role and any model)
tags: math, mathematician, calc, verify
importance: 8
---

# Procedure — solving a math question

## Step 1 — recall before reasoning

Before you compute anything, `pool math:<subfield> recall <topic>` for prior techniques. Subfields: `math:algebra`, `math:combinatorics`, `math:geometry`, `math:number-theory`, `math:calculus`, `math:probability`. If you find a relevant pattern, follow it.

## Step 2 — never trust mental arithmetic

Use the `calc` tool for every numeric computation, even simple ones. Mental math is a confidence trap. `calc` is exact and fast. Examples:

- `calc 17 * 23` → 391
- `calc sqrt(2) ** 2` → 2.0000000000000004 (and now you know this isn't exactly 2 in floating point)
- `calc factor(120)` → factorization
- `calc solve(x^2 - 5x + 6 = 0, x)` → roots

## Step 3 — verify with an independent calc

Before committing to an answer, run a SECOND calc that gets to the same result by a different route. If they disagree, you have a bug — find it before answering.

## Step 4 — answer in the format the caller wants

- Numeric benchmark (AIME, GSM8K, MATH) → bare number, no explanation in the final answer message.
- Multiple-choice math → letter only.
- If the caller didn't specify, default to bare answer with a one-line "by <method>" justification.

## Step 5 — deposit what you learned

If you discovered a useful technique (a substitution, a known identity, a counting trick), `pool math:<subfield> add <one-line summary>`. Future Mathematicians (you or successors) will find it.

## Anti-patterns

- Don't show a 5-step worked solution in a `tell Sender` reply unless they asked. They want the answer.
- Don't apologize or say "I'm not sure" when the problem is solvable. If you got a number from `calc` you verified, that IS your answer.
