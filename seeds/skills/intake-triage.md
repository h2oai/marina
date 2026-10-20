---
name: intake-triage
description: Before answering a question or starting a task, classify it — lookup, anchor, list or forecast — so a figure that is already published gets read, not forecast
tags: triage, intake, lookup, anchor, list, forecast, method, published, release, calendar, plan
importance: 8
---

# Procedure — decide the method before you spend on it

Many questions look like forecasts but are already answered: the statistic came out last week, the
match was played yesterday, the chart is on the publisher's page. Reading it is cheaper and right;
forecasting it is expensive and often wrong. Triage first.

## Step 1 — triage it

```
triage <question or task> [type:number|choice|multi|ranking|text] [options:A,B] [size:N] [ends:<ISO>] [resolves:<ISO>] [asof:<ISO>]
```

Rank 0, no model call, milliseconds. It reports the class, why, the facts it read (publisher,
period, release or event date), the method and an effort budget. The CLOCK decides "is it already
published?", not opinion: a release or event before now is published; one after now is not, even if
it falls before the question closes. In a backtest, pass `asof:` — the cutoff is your now, and
nothing published after it may count.

## Step 2 — act on the class

| Class | What to do | Budget |
|---|---|---|
| `lookup` | Open the publisher's page, read the exact field (period, measure, units) with its as-of date, STOP. Cite it. If the field is not there, fall back to `forecast`. | one search, one read |
| `anchor` | Read the latest official reading and its history, then `quant fit … to:<target date>` (and `quant buckets` for ranges). Move from the baseline only for specific dated evidence. | short |
| `list` | Rebuild the full current board (standings, chart, table) from its publisher, project every entry to the resolution date, sort, answer exactly the number asked. | full |
| `forecast` | The full method: `forecast <question>` or your own research with several independent passes. | full |

## Anti-patterns

- Forecasting a number that was published before now.
- Treating a scheduled release as published because it falls before the deadline.
- Reading a page dated after your cutoff in a backtest.
- Reading the right number from the wrong row: level vs change, core vs headline, seasonally adjusted vs not.
- Answering a top-N with a different N.

Numbers you then compute: `skill builtin quantitative-estimates`.
