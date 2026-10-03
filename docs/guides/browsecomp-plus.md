# BrowseComp-Plus with Marina

[BrowseComp-Plus](https://github.com/texttron/BrowseComp-Plus) (MIT, [paper](https://arxiv.org/abs/2508.06600)) is a deep-research benchmark. It has 830 hard questions over a **fixed corpus** of about 100,000 web documents, with no live web. An LLM judge grades each answer, and human-verified evidence documents allow retrieval to be measured too.

Marina runs it with two general pieces and one thin adapter:

- **Local corpora:** an offline BM25 index that any agent or tool can search. See [Search → Local corpora](search.md#local-corpora).
- **The model API:** every model call goes through a Marina `/v1`, so passthru, `marina/verify:` and `marina:<crew>` are all targets, with spend, traces and the daily cap applied.
- **The adapter:** `benchmarks/browsecomp-plus/` plus `bun run browsecomp-plus`. It runs the official agent prompt and tools, judges with the official grader, writes the official run and summary files, and files ledger runs.

## Data

The dataset is published on Hugging Face as `Tevatron/browsecomp-plus` (queries) and `Tevatron/browsecomp-plus-corpus` (documents), and the qrels are in the GitHub repository. Keep everything **outside the repository**, on a disk with several GB free:

1. Download the parquet shards of both datasets (any Hugging Face client, or plain HTTPS from the dataset's `resolve/main/data/` URLs) into `$DATA/hf/corpus/` and `$DATA/hf/queries/`.
2. Download the GitHub repository's `topics-qrels/` directory.
3. Export both datasets to JSONL (the exporter needs `pyarrow`):

```bash
DATA=~/.local/share/marina-browsecomp
python3 -m venv $DATA/venv && $DATA/venv/bin/pip install pyarrow
$DATA/venv/bin/python benchmarks/browsecomp-plus/export.py corpus  $DATA/hf/corpus  $DATA/data/corpus.jsonl
$DATA/venv/bin/python benchmarks/browsecomp-plus/export.py queries $DATA/hf/queries $DATA/data/queries.jsonl
```

The queries are published obfuscated. `export.py` decrypts them with the benchmark's own scheme, and only into your private data directory. **Never commit or publish the decrypted queries or answers.** The benchmark asks that they not appear as plain text online.

Build the index once. It takes about 20 minutes and several GB, under `MARINA_CORPUS_DIR` (default `~/.local/share/marina/corpora`):

```bash
SQLITE_TMPDIR=$DATA/tmp bun run corpus build browsecomp-plus $DATA/data/corpus.jsonl \
  --source "Tevatron/browsecomp-plus-corpus (MIT)"
bun run corpus search browsecomp-plus "a query"      # sanity check
```

`SQLITE_TMPDIR` keeps SQLite's sort files off a small `/tmp`.

## Run

Start a Marina server with a `MODEL_API_KEYS` entry. Then:

```bash
export MARINA_BENCH_API_KEY=<that key>
bun run browsecomp-plus run --queries $DATA/data/queries.jsonl \
  --qrels $DATA/topics-qrels/qrel_evidence.txt \
  --model openrouter/openai/gpt-6-luna --limit 100 --seed 1 --replicates 2 \
  --out $DATA/runs/luna --file-to http://localhost:3300
```

`--model` is any id the server serves:

| Arm | `--model` | What answers |
|---|---|---|
| Single model | `openrouter/<vendor>/<model>` | One model in the official tool loop (`search` and `get_document`). |
| Verification formation | `marina/verify:<proposer>[+<checker>]` | Each step is drafted, reviewed by a checker and revised once on a flag (see [τ²-bench](tau2.md#the-verification-formation-as-a-model-marinaverify)). |
| Crew | `marina:<crew>` | A Marina crew answers in text. Its agents search the same corpus in-world with `web search engines:corpus:browsecomp-plus <q>` and `web fetch corpus://browsecomp-plus/<docid>`. |

## Research formations

`--formation` turns one agent into a research team. Every member uses the same tools through the same Marina server:

| `--formation` | Team |
|---|---|
| `single` (default) | The official loop: one agent. |
| `ensemble:N` | N independent researchers. A lead then weighs their reports and answers. |
| `mapreduce:N` | The lead plans N complementary angles over the question's clues (map). N researchers pursue one angle each, and the lead reduces their reports. |
| `sharding:N` | N researchers, each searching one hash shard of the corpus, so together they read N times deeper into the ranking. `get_document` reads any document. A lead answers. |
| `blackboard:NxR` | N researchers over R rounds. Between rounds, each sees the team's posted answers and evidence. A lead answers. |

**The lead.**
- It answers in the official format.
- It may use the tools to check a report before answering (`--lead-turns`, default 12).
- `--lead-model` puts a different model in the lead.

**Composing with verification.** `--model` is the researchers' model. Making it a `marina/verify:<proposer>[+<checker>]` id puts each researcher's steps under review.

**Counting.** A team's run file holds every member's steps, each tagged with an `agent` field:
- Recall counts every document any member's search returned.
- Search calls count the whole team.
- Cost is the team's.

**Searches run in parallel.** Searches run in a pool of `--workers` processes (default 6), each with its own read-only index handle, so one agent's search never waits on another's.

## The tool loop

The tool loop follows the official harness:

- `search` returns the top `--k` hits (default 5), each with its docid, BM25 score and the document's first `--snippet-chars` characters (default 2000, about the official 512-token snippet).
- `get_document` returns a document, capped at `--doc-chars` (default 20,000).
- A run that reaches `--max-turns` model turns (default 30) without a text answer is incomplete, and counts as wrong.

**The judge.** It is the official grader prompt, with the official sampling: temperature 0.7, top-p 0.8, top-k 20, 4,096 tokens, thinking off. It runs through the same Marina server under `--judge-model` (default `openrouter/qwen/qwen3-32b`, the official Qwen3-32B). As in the official evaluator, an incomplete run is never judged.

**Metrics.** These match `evaluate_run.py`:

- **Accuracy:** judged correct over all queries.
- **Recall:** the share of each query's evidence documents that any search returned, averaged over queries.
- **Search calls:** the average per query.
- **Calibration error:** binned at β = 100, computed only with ≥ 100 parsed confidences.

For a crew, the adapter cannot see the agents' searches, so recall is measured on the docids the answer **cites**. That is a lower bound, and the run file records it as `metadata.recall_source: "cited"`.

## Output

Each replicate writes to `<out>/rep<i>/` (or straight to `<out>` for one replicate):

| File | What |
|---|---|
| `runs/run_<query_id>.json` | The official run format: `query_id`, `status`, `tool_call_counts`, `retrieved_docids`, `result[]`. The official `evaluate_run.py` accepts this directory as-is. |
| `evals/run_<query_id>_eval.json` | The judge's reply and verdict, citations, retrieval recall, cost and trace ids. |
| `summary.json` | The leaderboard fields: LLM, Retriever, Accuracy (%), Recall (%), Search Calls, Calibration Error (%), Link, Evaluation Date and `per_query_metrics`. |
| `result.json` | The ledger result: item ids, outcomes, cost and judge verdicts. It holds no query or answer text. |

`--file-to <url>` files each replicate into that server's benchmark ledger (`POST /v1/benchmarks/runs`) under one replicate group (`--group`, or a generated one). `benchmark compare` and `benchmark replicates` then pool the runs. Locally, compare two arms on their common queries:

```bash
bun run browsecomp-plus compare $DATA/runs/verify $DATA/runs/luna
```

This prints pooled accuracy per arm and A − B, with a two-stage bootstrap interval and p, and the range of single-pair McNemar p.

## Submitting

Nothing is submitted by the adapter. The leaderboard takes the `summary.json` fields for **all 830 queries**, sent to the maintainers by email or through AgentBeats; see the repository README.

**Choose the configuration on a held-out split, never on the scored set.** `--limit N --seed S --offset O` takes `N` queries at offset `O` of one fixed shuffle, so different offsets give disjoint splits. A typical sequence:

1. Compare candidates at offset 0.
2. Confirm the chosen one at offset `N`.
3. Only then run all 830.

Disclose which queries were used to select the configuration, and the configuration's cost per query.

Before submitting:

- Set `--llm` to the model's public name.
- Keep the `Retriever` label honest. Marina's index is BM25 over SQLite FTS5 (Porter stemming, default `k1`/`b`), not the official Pyserini BM25.
- Describe a `marina/verify:`, formation or crew arm as the system it is: agents with their own control flow, and how many of them.
