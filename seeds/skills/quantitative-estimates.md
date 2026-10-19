---
name: quantitative-estimates
description: How to compute numbers you will state or forecast — calc for exact arithmetic, quant fit for a series, quant buckets for numeric ranges
tags: calc, quant, forecast, numbers, units, percent, growth, extrapolation, buckets, multiple-choice
importance: 8
---

# Procedure — numbers you will state, compare or forecast

Every number you report comes from a tool, not from your head. Three rank-0 commands cover it, with no
model call and no code sandbox:

- `calc <expression>` — exact arithmetic, units, statistics (mathjs)
- `quant fit <values> …` — a series and a horizon → mean, sd, quantiles
- `quant buckets …` — a distribution and a set of ranges → the probability of each range

## Step 1 — compute with `calc`

Statements run in order and share variables (`;` separates them). End with the value you want.

| Need | Write |
|---|---|
| Percent change | `calc (112.5 - 104.2) / 104.2 * 100` |
| Percentage points vs percent | `calc 4.1 - 3.8` (points) and `calc (4.1 - 3.8) / 3.8 * 100` (percent) |
| Share of a total | `calc 120 * 15%` |
| Compound growth | `calc 250 * (1 + 3%)^10` |
| Growth rate (CAGR) between two values | `calc (380 / 250)^(1/7) - 1` |
| Periods to reach a level | `calc log(2) / log(1.035)` |
| Annualise a monthly rate | `calc (1 + 0.4%)^12 - 1` |
| Linear extrapolation | `calc a = 3.1; b = 3.9; n = 4; b + (b - a) / n * 2` |
| Unit conversion | `calc 5 mile to km`, `calc 100 degF to degC`, `calc 3 kWh to J`, `calc 60 mi/h to m/s` |
| Summary statistics | `calc mean([3.1, 3.3, 3.6])`, `calc std([3.1, 3.3, 3.6])`, `calc median([3.1, 3.3, 3.6])`, `calc quantileSeq([3.1, 3.3, 3.6], 0.9)` |
| Differences | `calc diff([3.1, 3.3, 3.6])` |
| Rounding for the answer | `calc round(7.96545, 1)`, `calc format(1234567.891, {notation: 'fixed', precision: 2})` |

Notes:
- Large results print in exponent form (`1.4285714285714e+5`). Wrap in `format(x, {notation: 'fixed', precision: 2})` when you need digits.
- `%` is a unit (`15%` = 0.15); `20% of 150` does not parse, write `150 * 20%`.
- Currency has no exchange rates. Look up the rate, then multiply.
- Write miles per hour as `mi/h`, not `mph`.
- Check a result a second way when it matters (for example, compute a growth rate and then apply it forward).

## Step 2 — forecast a series with `quant fit`

Give values oldest first, plain or dated:

```
quant fit 41 42 40 43 44 42 45 46 47 46 48 49 steps:2
quant fit 2026-01-31=3.1, 2026-02-28=3.3, 2026-03-31=3.6, 2026-04-30=3.5 to:2026-07-31
```

- `steps:N` counts releases ahead. `to:<date>` converts a target date at the series' median spacing.
- `method:` is `auto` by default. `auto` takes the method with the lowest error on the series' own past (rolling origin) and keeps persistence unless another method beats it by 5%. You can also pick `persistence`, `ewma`, `blend` (persistence and EWMA averaged; good for noisy polls), `trend` (straight line), `damped` (a line that flattens; usually safer than `trend` beyond a few steps), or `combo`.
- The sd is the method's own past miss size at that horizon. When the output says "treat as rough", the series is too short for that and the sd is only a random-walk guess. Widen it if you know of a coming shock.
- `NaN`, `na` and `null` values are skipped and counted.
- The fit is a baseline. Adjust it for news the series cannot know, and say what you changed and why.

## Step 3 — numeric ranges and multiple choice with `quant buckets`

When the answer is a range ("below 3%", "3–3.5%", "above 4%"), do not round your point estimate into one. Compute each range's probability:

```
quant buckets mean:3.4 sd:0.3 -- A: <3; B: 3-3.5; C: 3.5-4; D: >=4
quant buckets q:0.1=38,0.5=42,0.9=47 -- <40, 40-45, >=45
quant buckets mean:10 sd:2 cuts:5,10,15
quant fit 41 42 40 43 44 42 45 46 -- <42, 42-46, >=46
```

- Ranges: `<x`, `<=x`, `>x`, `>=x`, `a-b` (same as `[a, b)`), `a..b`, `[a, b]`, `(a, b]`, `x+`, or a bare number for an exact value. Prefix a label with `A:` to keep option letters.
- Open ends are fine. sd 0 puts all the probability on one value, and the range that contains it gets 100%.
- Match the question's boundary rule. "3% or more" is `>=3` and "more than 3%" is `>3`. This matters when the outcome is reported rounded.
- When the options leave gaps or overlap, the output shows the coverage and each option's share.
- Answer with the most likely bucket when one choice is required. Give the full probability list when a distribution is asked for.

## Anti-patterns

- Doing arithmetic in your head and stating the result as exact.
- Extrapolating a trend linearly far past the data. Prefer `damped` or `auto`, and check against persistence.
- Reporting a point forecast with no spread.
- Picking the bucket that contains your mean when a wide sd puts more mass in a neighbouring bucket. Run `quant buckets`.
