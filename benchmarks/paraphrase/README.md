# Paraphrase retrieval gate

The evidence behind "turning hybrid on is evidence-gated (paraphrase hit@3 vs BM25 on both
silos)" in `CLAUDE.md`. A frozen, authored corpus of 200 `(fact, paraphrase-query,
distractor-query)` triples — 50 each across `ops`, `dev`, `personal-preference` and
`scheduling` — is inserted twice into one temporary MarinaDB (legacy notes for one entity and
durable records in one world account's resident space) and every retrieval path is scored on the
same questions.

## Corpus

| file | sha256 |
| --- | --- |
| `corpus.json` | `571c37958cbbd1c66d6c1ed1778e0f0b47bb9315697948fc0d645c294d3d44a9` |

The corpus is frozen. Changing it changes the hash; update this table and re-run every path in
the same commit so numbers stay comparable. `test/retrieval-quality.test.ts` asserts the hash.

## Metrics

- `hit@3` — the fact is among the top three results for its paraphrase (primary metric).
- `hit@1` — the fact ranks first for its paraphrase.
- `distr@1` — the fact ranks first for its *distractor* query (a near-miss question in the same
  domain whose answer is a different fact). Lower is better.

## Paths

| path | what it measures |
| --- | --- |
| `legacy-fts-plain` | pre-migration-112 behavior: `unicode61` tokenizer, no stop-word removal, pure FTS rank (a shadow index built in the temp DB) |
| `legacy-fts-porter` | migration 112 + `fts.ts` stop-words, pure FTS rank — same SQL shape, isolates the tokenizer/query change |
| `legacy-recall` | the production `db.recallNotes` blend (importance / recency / relevance / confidence) |
| `legacy-recall+expansion` | `legacy-recall` fused (RRF, k=60) over the original query plus at most four alternatives from a caller vocabulary (`--vocab`) |
| `durable-lexical` | the durable memory service, `mode:"lexical"` |
| `durable-hybrid` | the durable memory service, `mode:"hybrid"` — only with `--embeddings local\|ollama` and a reachable provider; otherwise `skipped` |

## Measured 2026-09-14

Corpus `571c3795…d44a9`, 200 triples, `--vocab benchmarks/paraphrase/vocab.example.json`.
Embedding provider for the hybrid row: the local-embeddings extension, pinned
`Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9:onnx1.27-tokenizers0.2-q8-mean-chunks500-v2`,
downloaded once (~90 MB) with SHA-256 verification into a scratch `--model-cache`. No paid model.

| path | hit@3 | hit@1 | distr@1 | n |
| --- | ---: | ---: | ---: | ---: |
| `legacy-fts-plain` | 79.5% | 62.0% | 11.5% | 200 |
| `legacy-fts-porter` (BM25/porter baseline) | 89.0% | 77.5% | 11.5% | 200 |
| `legacy-recall` | 89.0% | 77.0% | 11.5% | 200 |
| `legacy-recall+expansion` | 91.0% | 78.5% | 11.5% | 200 |
| `durable-lexical` | 88.5% | 77.5% | 11.5% | 200 |
| `durable-hybrid` (MiniLM-L6-v2 + FTS5, RRF) | **97.0%** | 86.5–87.0% | 14.5–15.0% | 200 |

Per domain, hit@3 (`durable-lexical` → `durable-hybrid`): ops 88% → 98%, dev 92% → 98%,
personal-preference 98% → 100%, scheduling 78% → 92%.

**Gate verdict: not cleared as written.** The gate asks for hybrid hit@3 ≥ BM25/porter + 20pp with
no exact-identifier regression. Hybrid gains **+8.0pp** over `legacy-fts-porter` (89.0% → 97.0%),
and +8.5pp over `durable-lexical`; a +20pp bar from an 89% baseline would require 109% and is
unreachable on this corpus — the baseline is already near the ceiling. On the second half of the
gate the result is clean: **0 triples** that lexical found in the top three are lost under hybrid
(no exact-identifier regression — every port, hostname, ticket and date paraphrase that BM25 hit,
hybrid hits too); 16 triples are newly found (mostly paraphrases sharing no content token with the
fact, e.g. "how long before the backup on-call gets paged" → "pager escalation … secondary after
10 minutes"). The cost is precision on near-miss questions: `distr@1` rises 11.5% → 15.0%
(11 distractor queries now rank the neighbouring fact first, e.g. "when is jeff's eye exam" →
the dentist appointment). Two runs of the hybrid path differed by one triple on hit@1/distr@1
(86.5/14.5 vs 87.0/15.0); hit@3 was 97.0% both times.

No default changes based on this measurement: hybrid stays opt-in (`MARINA_MEMORY_EMBEDDINGS`,
explicit `mode:"hybrid"`). Re-frame the gate before re-running (an absolute bar, e.g. hit@3 ≥ 95%
with distr@1 ≤ baseline + 2pp, or a recall-at-fixed-precision target) — as written it cannot be
met by any retriever on this corpus.

**How the hybrid row was produced.** `bun run scripts/qualify-paraphrase.ts --embeddings local …`
currently aborts with `retrieval_incomplete: index_incomplete` before printing: the runner calls
`service.stopWorker()` (which sets the service's `stopping` flag) and then drains the index queue
with `service.runIndexJobs(64)`, whose loop breaks on that same flag — so zero jobs are embedded and
the first hybrid search fails. The row above comes from a scratch driver that replicates the
runner's durable path verbatim (one world account, one record per fact, importance 5, `limit 3`,
same `score` arithmetic) on a `MemoryService` whose worker was never started, so the drain
actually runs (200 records indexed in ~0.6 s). The `durable-lexical` row from that driver was
89.0% vs 88.5% from the committed script (one triple; the two paths build the service with and
without a provider). Fixing the runner — drain before `stopWorker()`, or reset the flag — is a
one-line change in `benchmarks/paraphrase/runner.ts`, deliberately left out of this slice.

## Running

```bash
bun run qualify:paraphrase
bun run scripts/qualify-paraphrase.ts --vocab benchmarks/paraphrase/vocab.example.json
bun run scripts/qualify-paraphrase.ts --embeddings local --model-cache data/memory-models --local-only
bun run scripts/qualify-paraphrase.ts --out data/scratch/paraphrase-hit3.json --limit 20
```

Prints a table and writes `marina.paraphrase.report.v1` JSON to `--out`
(default `data/scratch/paraphrase-hit3.json`). Exit code is always 0. Nothing is downloaded and
no paid model is called; the local provider requires the optional extension
(`bun install --cwd extensions/local-embeddings --frozen-lockfile`).
