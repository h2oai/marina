# DeepResearch Bench I and II

[DeepResearch Bench](https://github.com/Ayanami0730/deep_research_bench) (100 PhD-level research
tasks, 50 Chinese and 50 English) and
[DeepResearch Bench II](https://github.com/imlrz/DeepResearch-Bench-II) (132 tasks with expert
rubrics) score long-form research reports. Marina enters them through a thin adapter over its
general research-report pipeline. The adapter adds nothing to the method: a task is its prompt,
its language, and the sources it bars.

Nothing runs unless you invoke it, and **nothing is sent**. `export` writes the files a
submission would contain; whether to email them is the operator's decision.

## The research-report pipeline (`src/research/`)

Any research task, not only these benchmarks, goes through these steps:

1. **Plan.** The lead model turns the task into sections. It mirrors any structure the task asks
   for (parts, numbered items, required tables, time limits). Each section gets a goal and web
   queries. For a task that is not in English, the queries mix the task's language and English.
2. **Research.** Each section's queries go through the `search` retriever
   ([Search](search.md)). It tries the backend chain, reads pages through the SSRF guard, and
   quotes passages verbatim. Paid calls are recorded in the spend ledger. Then the lead names
   what is still missing, and one gap round searches for it.
3. **Verify.** Every evidence line goes through the mechanical citation check. Only verified
   passages become numbered evidence.
4. **Write.** The lead writes each section from its numbered evidence, citing with `[n]`, then
   writes the summary and conclusion. Markers are renumbered by first use, and a reference list
   is appended in the form `[n] url - title`.
5. **Audit.** Every figure in a cited sentence must appear in the evidence of a source the
   sentence cites. `figurePrecision` is the share of figure-bearing cited sentences that pass.

**Optional cross-model fact pass (`factCheckReport`).** A second model checks each section
against the evidence it cites and proposes minimal edits. An edit applies only when its text
occurs exactly once in the section, and only if it adds no figure missing from the cited evidence.
It runs on a finished report, so a comparison with and without the pass shares the same research
and draft.

Same-model self-review is deliberately not offered: our measurements found it does not help.

**Languages.** Passage ranking tokenises Chinese, Japanese and Korean text as character bigrams.
It splits CJK sentences at full-width stops.

**Barred sources.** `ResearchBrief.exclude` takes URL prefixes and titles. The retriever drops a
barred page before reading it, using either the search hit or the page's own title.

## The adapter (`benchmarks/deepresearch/`, `bun run deepresearch`)

The adapter keeps the benchmark data at arm's length:

- **Pinned data.** Tasks are read from the official repositories at pinned commits, in
  `<out>/data` (outside the tracked tree).
- **What the generator sees.** Only the prompt text and, for DRB II, the structured barred source
  the prompt names. Criteria, reference articles and rubrics are never loaded.
- **What every run bars.** The benchmarks' own repositories, datasets, leaderboards and papers,
  which publish reference articles and other systems' reports for these exact prompts.

```bash
bun run deepresearch select                      # seeded dev / held-out ids → <out>/selection.json
bun run deepresearch run --board drb1 --label A --lead openrouter/anthropic/claude-opus-5.5 \
    --split heldout --max-usd 20
bun run deepresearch check --board drb1 --from A --label B --checker openrouter/openai/gpt-6.1-sol
bun run deepresearch score --board drb1 --label A --max-usd 10   # official evaluator, our key, capped
bun run deepresearch compare --board drb1 --a A --b B            # paired difference, bootstrap CI
bun run deepresearch file --board drb1 --label A                 # ledger + judged lessons (DB_PATH)
bun run deepresearch export --board drb1 --label A               # submission layout
```

### Running a batch

- **Saved as it goes.** Each finished task is written to `<out>/<label>/tasks/<id>.json` as soon
  as it lands. A run stopped by `--max-usd` or by the daily cap keeps what was paid for, and a
  rerun skips finished tasks.
- **Search backends.** `--search` sets the backend order for the run (the same names as
  `MARINA_RESEARCH_SEARCH_BACKENDS`).
- **Lessons.** `--lessons on` shows the planner lessons recalled from the `research` domain. It is
  off by default, as a measurement control.

### Local scoring

Local scoring runs the official Python evaluators, unmodified, at the pinned commits:

- **Setup.** The tarballs are unpacked and a venv is created under `--cache`, which defaults to
  `~/.cache/marina/deepresearch`. This needs Python 3.9 or later with `venv`.
- **Judge calls.** The evaluators call their default judges: GPT-5.5 for both, plus DRB I's
  GPT-5.6-luna article cleaner. They reach them through a loopback proxy that forwards to
  OpenRouter on `OPENROUTER_API_KEY`.
- **What the proxy enforces.** It lets only those judge models through, meters every reply's
  cost into the spend ledger, and refuses further calls with `429` past `--max-usd`.
- **Key isolation.** The evaluator's environment holds a dummy key, never the real one.

DRB I is scored with RACE. Its FACT citation metric needs a Jina Reader key and is not run.
`figurePrecision` is Marina's own, narrower proxy for it.

### Records

- **Ledger.** `file` records one ledger run per label and board: `deepresearch-bench` or
  `deepresearch-bench-ii`. It stores item ids and graded scores only. An item counts as correct
  at half credit: on DRB I the report beats the reference, and on DRB II half the rubrics pass.
- **Lessons.** `file` also hands one general outcome per report to the lesson loop, in the
  `research` domain. The outcome holds the language, topic area, dimension scores, and evidence
  and citation numbers. The prompt travels only as private context for the leak check.

## Caveats to disclose with any entry

- **Public data.** Both prompt sets are public, and so are the DRB I reference articles and the
  DRB II rubrics. Scores measure report quality, not unseen-task generalisation.
- **Judges.** The official judge is GPT-5.5 on both boards. DRB II's older Gemini-2.5 board uses a
  different judge, and its numbers are not comparable.
- **Task licences.** DRB II licenses each task separately. Two tasks are CC BY-NC.
  `select` leaves them out unless you pass `--include-nc`.
