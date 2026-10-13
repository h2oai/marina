# Paraphrase retrieval gate

The evidence gate for turning hybrid retrieval on (see `docs/architecture/memory.md`). A frozen,
authored corpus of 200 `(fact, paraphrase-query, distractor-query)` triples — 50 each across
`ops`, `dev`, `personal-preference` and `scheduling` — is inserted twice into one temporary
MarinaDB (legacy notes for one entity and durable records in one world account's resident space)
and every retrieval path is scored on the same questions.

## Corpus

| file | sha256 |
| --- | --- |
| `corpus.json` | `fc9a7324529c447791eb91365cc73cb016222d5ff541bc788bec19bf99761801` |

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

## Gate

Hybrid retrieval stays opt-in (`MARINA_MEMORY_EMBEDDINGS`, explicit `mode:"hybrid"`). Turning it
on by default is an operator decision against an absolute bar on this corpus — hit@3, no
exact-identifier regression (no triple lexical finds in the top three is lost under hybrid), and
`distr@1` within a small margin of the lexical baseline — not a relative gain over a baseline that
is already near the ceiling.

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
