# LongMemEval-V2 with Marina

[LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) ([paper](https://arxiv.org/abs/2605.12493), Apache-2.0) scores **memory systems**, not models. A memory system ingests long histories of web-agent trajectories (`insert`) and returns bounded evidence for a question (`query`). A **fixed reader** (Qwen3.5-9B) answers from that evidence, and gpt-5.2 judges the open-ended answers. The board ranks a method by how much it improves the accuracy–latency frontier (LAFS gain) over the released baselines.

Marina enters as the system under test with one thin adapter, `benchmarks/longmemeval/`. The official harness, reader prompt, evaluator and scoring run unmodified.

## What Marina does

- **Ingestion.** Each haystack gets a fresh, throwaway Marina database. Every trajectory state becomes a canonical `observation` record (the run's goal and outcome, URL, thought, action and accessibility tree), and every trajectory an `episode` record (goal, outcome, action sequence). Records go through the canonical record repository, one transaction per trajectory. By default there is no model call and no embedding.
- **Retrieval.** `--retrieval unified` (the default) retrieves through `buildUnifiedContext`, the path Marina serves its own residents: the evidence tier's search, validity filter and query-overlap filter, plus the optional relevance gate. `--retrieval raw` serves the memory service's `search` hits as ranked, with no relevance filter (the first pilot's behaviour, kept for paired comparisons). Both are lexical (FTS5) by default. `--mode hybrid` is used only when the operator has configured an embedding provider (`MARINA_MEMORY_EMBEDDINGS`); without one, the adapter refuses hybrid rather than silently falling back. With hybrid the adapter drains the vector index once after ingestion, before the first query: `MemoryService.drainIndex` waits for the background index worker too, and the reply reports anything still `pending` when its bound runs out (sidecar `--index-concurrency`, default 8 embedding requests in flight; `--drain-timeout-ms`, default 6 h). Long records are cut to `MARINA_MEMORY_EMBEDDING_MAX_TOKENS` before embedding (set it below the embedder's context). A model-backed gate (`--gate-backend model`) asks an OpenRouter-routed model not to reason and is bounded by `MARINA_MEMORY_RELEVANCE_GATE_TIMEOUT_MS`.
- **Relevance gate** (unified only, `--gate off|observe|on`, default off). After retrieval, each candidate record is judged for whether it bears on the question; `on` drops the ones that do not (at most `--gate-max` kept, default 8) and, when nothing is left, tells the reader "No relevant memory was found…" instead of showing keyword noise. `observe` reports what would be dropped without dropping it. The judge is chosen with `--gate-backend`: `decisions` (the decision layer, `MARINA_DECISIONS`, metered into `DB_PATH`'s spend ledger), `model` (`--gate-model` behind `--gate-base-url`, default a local Marina `/v1` so spend lands on its ledger; the key is read from the variable named by `--gate-api-key-env`), `mechanical` (query-term coverage, no model), or `auto` (decisions, else model when named, else mechanical). An outage or the spend cap serves the ungated set and is labelled. The gate's per-question counts (`relevance`: outcome, candidates, dropped, kept, calls, cost — no content) appear in the harness's per-question memory metadata.
- **Ingest-time notes** (`--ingest-notes off|on`, default off). After each trajectory is stored, Marina writes a few short derived notes about it (who did what, which state changed, the outcome) as canonical records linked to the trajectory's records ([memory architecture → ingest-time notes](../architecture/memory.md#ingest-time-notes-srcmemoryingest-notests)). The writer reads a compact view: the run summary, plus each state's URL, thought, action and only the page lines that are new since the previous state, up to `--notes-max-bytes` (default 48,000, four 12 KB calls). `--notes-model <id>` writes the notes with one chat model behind `--notes-base-url` (default a local Marina `/v1`, so spend lands on its ledger and daily cap). The key is read from the variable named by `--notes-api-key-env`. Without `--notes-model`, the mechanical extractor runs with no model. Lines whose names, numbers or dates are not in the trajectory are dropped. A retrieved note is shown as `### Past run <id> (derived note)` with the run's summary. The insert reply carries the counts (written, ungrounded, duplicates, calls).
- **Context.** Hits in rank order. A state hit is shown as a slice (± `radius` states, each an extractive excerpt that keeps the lines matching the question) under its run's summary. Everything fits byte budgets (`context_bytes`, `state_bytes`, `episode_bytes`). Text only: question images are not used.

The backend sees only what every backend sees: trajectories on insert and the question text on query. It never reads question ids, types or answers.

## Setup

Keep the dataset and the official checkout outside the repository.

```bash
LME=~/.cache/marina-lme
git clone https://github.com/xiaowu0162/LongMemEval-V2 $LME/LongMemEval-V2
# Data (Hugging Face xiaowu0162/longmemeval-v2): questions.jsonl, trajectories.jsonl (1.2 GB),
# haystacks/*.json. Screenshots (5.9 GB) are not needed for the text-only adapter.
python3 -m venv $LME/venv          # Python 3.11
$LME/venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
$LME/venv/bin/pip install "transformers>=5" huggingface_hub numpy openai openai-agents pillow tqdm
$LME/venv/bin/pip install --no-deps -e $LME/LongMemEval-V2
```

The harness counts context tokens with the Qwen3.5-9B processor (downloaded from Hugging Face on first use; no model weights).

## Run

Serve the reader and judge through a Marina `/v1` (spend ledger and daily cap apply), then run one domain at a time. The output directory name `<method>_<domain>_<tier>` is what the board's packaging reads.

```bash
OPENAI_API_KEY=<a MODEL_API_KEYS entry> $LME/venv/bin/python benchmarks/longmemeval/run.py \
  --lme-root $LME/LongMemEval-V2 --data-root $LME/data --tier small --domain web \
  --output-dir runs/marina_lexical_web_small \
  --reader-model openrouter/qwen/qwen3.5-9b --reader-base-url http://localhost:3300/v1 \
  --reader-quantizations bf16 \
  --evaluator-model openai/gpt-5.2 --evaluator-base-url http://localhost:3300/v1
```

- `--backend no_retrieval` runs the official no-memory control with the same reader and judge.
- `--mode hybrid` needs `MARINA_MEMORY_EMBEDDINGS` in the environment of the run.
- `--retrieval raw` reproduces the first pilot's ungated retrieval; compare arms on the same questions, reader and judge, and name the output directories by arm (`marina_unified_…`, `marina_raw_…`, `marina_gate_…`).
- `--gate on --gate-backend model --gate-model <reader model>` gates with the same single model as the reader; `--gate observe` measures what the gate would drop without changing the reader's context.
- `--ingest-notes on --notes-model <cheap model> --notes-base-url http://localhost:3300/v1` adds ingest-time notes. Ingestion now costs model calls, so compare against the same arm without notes on the same questions, reader and judge, and name the directories by arm (`marina_unified_notes_…`).
- `--reader-retries 6 --reader-cache runs/web-reader.jsonl` makes a long run survive a transient reader failure: the official harness aborts the whole run on one failed call and keeps nothing. Retries cover 429, 5xx, timeouts and empty replies (30 s doubling backoff); the cache lets a rerun resume, reusing replies for identical requests. Scoring is untouched. Disclose both if you submit.
- `--reader-quantizations bf16` restricts OpenRouter's provider routing for the reader to unquantized endpoints, matching the paper's reader. It changes request routing only.
- The memory budgets (`--search-limit`, `--context-bytes`, `--state-bytes`, `--episode-bytes`, `--radius`) are the method's settings; keep them fixed across the two domains of one operating point.

Summarize a web + enterprise pair and file it in the ledger (ids and verdicts only):

```bash
bun run longmemeval summary runs/marina_lexical_web_small runs/marina_lexical_enterprise_small
bun run longmemeval convert runs/marina_lexical_web_small runs/marina_lexical_enterprise_small \
  --target marina-memory:lexical --out results/lme-small.json
DB_PATH=marina.db bun run benchmark:import results/lme-small.json --target-kind model \
  --target marina-memory:lexical --learn
```

`summary` reports the board's accuracy (both domains pooled), a question-bootstrap interval, the mean query latency, per-category accuracy, and the answered-wrong rates (non-abstention questions answered wrongly, and false premises accepted), which show how often retrieved context misleads the reader.

## Scale

`bun benchmarks/longmemeval/throughput.ts --data $LME/data --tier small --domain web` times model-free ingestion of one haystack. On a 16-core workstation a small-tier haystack (100 trajectories, 40–84 MB of record text) ingests in 4–7 s and a lexical query takes 10–60 ms. Medium-tier questions each have their own haystack of up to 500 trajectories; the harness builds a fresh memory per question, so a full medium run is dominated by ingestion.

## Submitting

The board takes submissions through its Google Form only: a package built with the official `leaderboard/build_submission_step_1_single_operating_point.py` and `…_step_2_build_package.py`, a system description, and one code file (`benchmarks/longmemeval/marina_memory.py`). Marina never submits anything itself.
