# Mind2Web 2

[Mind2Web 2](https://osu-nlp-group.github.io/Mind2Web-2/) evaluates agentic search on the live
web: each task asks for several facts that must be found, checked and cited, and a task-specific
judge (an LLM extractor and verifier over a rubric tree) checks every answer against the pages it
cites. Marina answers with its general live-web research agent (`src/research/`); the adapter in
`benchmarks/mind2web2/` and `scripts/mind2web2.ts` only reads the task list, writes answers in the
official layout, exports the pages the agent read, and runs the official judge locally. Nothing in
Marina's core knows about Mind2Web 2, nothing runs unless an operator starts it, and nothing is
sent anywhere.

## Commands

```bash
OFFICIAL=~/src/Mind2Web-2       # a checkout of github.com/OSU-NLP-Group/Mind2Web-2
OUT=~/m2w2                      # answers, caches, results (outside the repository)

bun run mind2web2 run   --official $OFFICIAL --out $OUT --arm single --split tune --cap-usd 10
bun run mind2web2 cache --official $OFFICIAL --out $OUT --arm single
bun run mind2web2 judge --official $OFFICIAL --out $OUT --arm single --cap-usd 5
bun run mind2web2 score --official $OFFICIAL --out $OUT --arm lead --compare single --split heldout
bun run mind2web2 record --official $OFFICIAL --out $OUT --arm single --split heldout
```

- `run` answers every selected task (`--task <id>` to pick, `--runs 1,2,3` for independent runs)
  and writes `answers/<agent>/<task_id>/answer_<k>.md` plus `answer_<k>.meta.json`
  (`time_seconds`). `--cap-usd` is required: the batch stops before the next model turn once its
  spend (models and paid search) reaches it; a stopped run is recorded as not run, never as an
  answer. Spend also counts toward the `DB_PATH` world's daily cap.
- Dev tasks come from the checkout's `eval_scripts/dev_set/*.py` (only `TASK_ID` and
  `TASK_DESCRIPTION` are read). A test run passes the task list with `--tasks <csv>` (a `task_id`
  column and a description column).
- `--split tune|heldout` uses a fixed, hashed split of the dev set (three tune tasks, seven
  held-out) so configuration choices are made on tasks that were not used for debugging.
- `cache` exports the pages behind every cited URL into `cache/<agent>/<task_id>/` in the judge's
  layout (`index.json`, text plus screenshot, or PDF). Pages are exported as the agent read them;
  cited URLs the agent never read are captured by the judge at evaluation time.
- `judge` runs the official `run_eval.py` from the checkout's Python environment
  (`--python`, default `<checkout>/.venv/bin/python`; install it with the checkout's own
  instructions) under `benchmarks/mind2web2/judge_capped.py`, which prices every judge response and
  stops the judge when `--cap-usd` is reached (unfinished answers stay unscored). It needs
  `OPENAI_API_KEY`; the judge model is the paper's `o4-mini`.
- `score` prints partial completion (mean rubric root score), success (share of perfect scores),
  pass@k, cost and time per run, and with `--compare` a paired difference over shared tasks with a
  bootstrap interval. A run that errored or produced nothing scores 0.
- `record` writes the judged run to the benchmark ledger (item ids `<task>#<k>`, root scores,
  cost; no task or answer text) and turns each answer into a judged lesson.

## Arms

| Arm | Agent name | What runs |
|---|---|---|
| `single` | `marina-single` | One research loop on `anthropic/claude-opus-5-5` writes the answer. |
| `lead` | `marina-lead` | The lead plans up to three parts; researchers each run the loop on one; the lead writes; `openai/gpt-6.1-sol` checks each cited claim against the text of the page it cites; the lead revises once. |

Both end with the mechanical citation audit: a cited URL the agent never opened, or one that failed
to load, gets one repair pass.

## The research agent

`src/research/web-agent.ts` is a tool loop over any one model: `web_search` (the configured search
chain — Tavily, Exa, SearXNG, DuckDuckGo, OpenRouter's Exa plugin), `fetch_page` (SSRF-guarded,
paged, with the page's links; PDFs through `pdftotext` when installed) and `find_in_page` (searches
a page already read, without a new request). It works with a single local model. Every page read
lands in a **provenance cache** (`src/research/provenance-cache.ts`): URL, status, fetch time,
sha256 of the bytes and the extracted text, so each citation in an answer can be traced to exactly
what the agent saw. The adapter's fetcher refuses the benchmark's own repository, dataset and
leaderboard pages.

## Submitting

Marina never submits. The organisers accept answers (and optionally the page cache) by email; see
the [official submission guideline](https://github.com/OSU-NLP-Group/Mind2Web-2#-submission-guideline).
