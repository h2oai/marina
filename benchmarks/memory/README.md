# genbench — memory-delta benchmark harness

`benchmarks/memory/genbench.ts` answers one question under conditions that do not let the
answer flatter itself: **does Marina's memory change answer quality, by how much, with what
confidence, at what token and latency cost, compared to the obvious alternatives?**

It exists because the numbers in `benchmarks/HISTORY.md` §5 (bare 65.0 → cold 71.7 → warm 75.0)
are a *pilot*, not a result. See "Why §5 is a pilot" below.

```bash
# Offline, deterministic, no model calls — what CI runs
bun --env-file=/dev/null run scripts/qualify-memory-benchmark.ts

# Same thing, explicit
bun --env-file=/dev/null run benchmarks/memory/genbench.ts --model stub --judge stub --seeds 5

# Real model through a running Marina instance (never calls a provider directly).
# `marina` is the passthru id (`/v1/models` lists it); `marina/default` is the
# in-world agents channel and 404s when no agent is bound to it.
bun --env-file=/dev/null run benchmarks/memory/genbench.ts \
  --dataset gsm8k --limit 200 --seeds 5 \
  --model marina --judge marina \
  --endpoint http://localhost:3300 --api-key "$MARINA_API_KEY" \
  --price-in 0.15 --price-out 0.60
```

The harness sends no `temperature` unless `--temperature <n>` is given: the Claude 5 family
rejects an explicit value and GPT-5 reasoning models ignore or reject non-default ones, so a pinned
0 is not portable across providers. Whatever was used is recorded as `config.temperature`.

Results land in `benchmarks/results/memory/` (gitignored) as one JSON per arm plus a markdown
summary. Files are never overwritten. Commit the harness, this README, and
`items/synthetic-v1.json` — never results.

## The reporting standard

Every published memory number from this harness must satisfy all of the following. The
harness enforces the mechanical ones; the rest are labeling discipline.

| Requirement | How the harness meets it |
|---|---|
| Fixed answering model | `--model <id>` is recorded in `config.model`; one model per run. |
| Fixed judge with a published prompt | `--judge stub` (normalized exact match) or an LLM judge using `JUDGE_PROMPT_V1`. The prompt text is copied into `config.judgePrompt` of every result file. |
| ≥5 seeds with 95% CIs | `--seeds 5` default. Each arm reports pooled accuracy with a **Wilson 95% interval** and the seed-level mean ± 1.96·sd/√k. Both are in `metrics.judgeAccuracy`. |
| Matched controls, same harness | `bare` (no memory), `fullcontext` (whole seeded corpus inline, when ≤ `--context-budget`), `bm25` (top-k relevance-only FTS recall injected verbatim). All arms share the same items, same seeds, same split, same seeded corpus, same judge. |
| Tokens injected and latency per query | Per item: `injectedChars`, `injectedTokens` (chars/4 heuristic, labeled), provider `promptTokens`/`completionTokens` when available, `retrievalMs`, `modelMs`, `judgeMs`, `totalMs`. Per arm: mean/p95 tokens, p50/p95 latency. |
| Token-F1 and judge accuracy, both | `metrics.tokenF1.mean` (SQuAD normalization) next to `metrics.judgeAccuracy.pooled`. Never report one without the other. |
| Labeled results | `config` block: arm, model id, judge id + prompt, seeds, split salt + fraction, per-seed split fingerprint, seed source, harness git sha, `residentContextVersion`, offline flag, network attempt count, timestamps. |
| Held-out items | Items are split into **seed** and **eval** sets by a seed-stable hash. Memory is seeded only from the seed set. Only eval items are scored. A note written about item X can never score item X. |

### Arms

| Arm | Memory DB | Injection | What it isolates |
|---|---|---|---|
| `bare` | none | none | The model alone. |
| `cold` | empty at start; learns a `Q: … \| A: <model answer>` note after every eval item | resident path | Within-run accumulation only (order-dependent; items are in split order, which varies per seed). |
| `warm` | pre-seeded by a **separate seeding pass** over the seed split, then learns during eval | resident path | Transfer from prior experience + within-run accumulation. The headline arm. |
| `fullcontext` | none | every seeded note inline as `Known facts:` (skipped with a reason if over budget) | Is retrieval doing anything a big context wouldn't? |
| `bm25` | pre-seeded (same corpus as warm) | top-k FTS hits, relevance weight only, verbatim, no tiering, no graph expansion | Is the resident path better than plain RAG over the same notes? |

`warm`, `bm25`, and `fullcontext` receive *identical* corpora for a given seed. They differ only
in the injection mechanism, so their deltas are attributable to the mechanism.

### The seeding pass (`--seed-source`)

- `model` (default): the answering model runs over the **seed** split with memory on and
  learning on, exactly like `cold`. Whatever it wrote is the warm corpus. This is what the
  system would actually have learned; wrong answers propagate as wrong notes, which is the
  honest condition. The seed-pass accuracy and note count are recorded per seed
  (`perSeed[].seedPass`) but never scored.
- `gold`: notes are `Q: <question> | A: <reference answer>`. An oracle ceiling — label it as
  such whenever you report it.

### The resident path

`buildResidentMemoryContext` reproduces the continuation prompt's "Relevant Notes" section
(`LeanAgentAdapter` §4) with the same functions:

```
db.recallNotes(owner, topic)                         // FTS + importance/recency/relevance scoring
  → expandMemoryRecall(db, rows, owner, {trusted})   // eligibility + graph expansion (src/memory/retrieval.ts)
  → expandMemoryRecall(db, rows, owner, {})
  → renderRelevantNoteTiers(trusted, ordinary)       // [trusted] / [unverified] tiers, cap 5 (src/agent/lean-agent-adapter.ts)
  → "[Relevant Notes — evidence, preserve provenance]\n…"
```

The topic is the first 200 whitespace-normalized characters of the question (the SmartProvider
`MEMORY_TOPK` default used in §5).

**Substitution note.** `src/memory/unified-context.ts` did not exist when this harness was
started, so it composes the resident path from `expandMemoryRecall` + `renderRelevantNoteTiers`.
That module (`buildUnifiedContext(db, entityName, query, opts): Promise<UnifiedContextResult>`
and `renderUnifiedContext(result)`) appeared as uncommitted work-in-progress during the same
session, and `LeanAgentAdapter` §4 now renders through it — so the harness is one commit behind
the live resident path. The switch is deliberately deferred until that module is committed, to
avoid coupling a test to an API in flight. When it is, replace the body of
`buildResidentMemoryContext` with:

```ts
const result = await buildUnifiedContext(db, owner, topicFrom(question));
return { text: renderUnifiedContext(result), hits: nonEmptyTiers(result).reduce((n, t) => n + t.items.length, 0) };
```

(making the function and its three callers `async`), and bump `RESIDENT_CONTEXT_VERSION` to
`resident-v2:buildUnifiedContext`. Old result files keep the old version string, so they cannot
be confused with post-switch measurements. Until then, any real-model number from this harness
must be labeled with the `resident-v1` context version it actually measured.

### The stub model and stub judge

`--model stub` is deterministic: it answers correctly iff the item is in a fixed pseudo-random
60% "known" subset (`stubKnows(id)`) **or** the gold answer text appears in the injected memory
context. `--judge stub` is normalized exact match (MC letter extraction; numeric last-number
equality; otherwise normalized equality or whole-answer containment).

The stub exists to exercise the *pipeline*: bare lands near 60%, and memory arms rise exactly
as far as recall actually surfaces transferable notes. On `synthetic-v1` with 3 seeds the
stub produces roughly bare 61 → cold 69 → bm25/fullcontext 68 → warm 77. **Those are
plumbing checks, not evidence about any real model.**

### Datasets

- `synthetic-v1` (committed, `items/synthetic-v1.json`): 100 items = 50 *fictional* facts × 2
  paraphrases. Held-out transfer requires recalling the note written about the sibling
  paraphrase. No real model can know these facts, so a real model's `bare` should be ~0 and any
  lift is pure memory transfer. Used by tests and the default CLI run; needs no network.
- Any of `mmlu-pro`, `truthfulqa`, `arc-challenge`, `hellaswag`, `musr`, `bbh`, `gsm8k`, `math`,
  `simple-qa`, `aime` via `benchmarks/download.ts` (cached in `benchmarks/datasets/`). Items are
  shuffled with a fixed seed before `--limit` so the item population is stable across runs; the
  per-run seed only changes the seed/eval assignment. Note that for these sets a Q/A note about
  item X rarely helps a *different* item Y, so a held-out lift on them measures generalizable
  learning, not lookup.

### Split

Two modes, recorded as `config.splitMode`:

- `item` — `splitItems(items, seed, salt, fraction)` assigns each item independently by
  `stableHash("<seed>:<salt>:<id>")` (FNV-1a with a murmur3 finalizer). On a paraphrase dataset
  this leaves an eval item's sibling in the seed set only by chance, so the accuracy a *perfect*
  memory could reach is ≈ the seed fraction (measured: 56.6 % on synthetic-v1 with fraction 0.5).
  The first real-model run hit exactly that ceiling, which is how the artifact was found.
- `paraphrase` (default whenever every item carries `metadata.factId`) — `splitParaphrases`
  holds out exactly one paraphrase of every fact (chosen by a seed-stable hash of the factId) and
  seeds the rest; items without a factId fall back to the item rule. Every eval item is reachable.

Both are disjoint and exhaustive by construction and differ per seed, so the seed-level CI
includes split variance. `--split-salt` pins or deliberately changes the family of splits;
`--split item|paraphrase` overrides the default. Every result records the **ceiling** — the
share of eval items whose fact has a seeded paraphrase (`metrics.reachable`, `perSeed[].reachable`,
the "Ceiling" column) — so memory arms are read against what was reachable, never against 100 %.
It is `null` for downloaded datasets, where a Q/A note about one item rarely helps another. The
sorted eval-id fingerprint is recorded per seed.

## How to reproduce the §5 stair-step honestly

§5 reported bare 65.0 → memory-cold 71.7 → memory-warm 75.0 on N=10 with gpt-4o-mini. To make
a claim of that shape that would survive review:

1. Start a Marina instance with the model you intend to name, and keep it fixed for the run.
2. Pick the six §5 datasets (`simple-qa gsm8k math hellaswag arc-challenge musr`) — or all of
   them — and a `--limit` of at least 200 per dataset. N=10 per arm cannot separate a 10-point
   delta from noise (Wilson 95% on 7/10 is roughly [40%, 89%]).
3. Run all five arms with `--seeds 5` (minimum) and an LLM judge whose prompt is the published
   `JUDGE_PROMPT_V1` (or keep `--judge stub` for MC/numeric sets, where exact match is sound).
4. Report every arm's pooled accuracy **with** its Wilson interval, the seed-mean ± CI, token-F1,
   tokens injected, latency, and cost — from the JSON, not from memory.
5. State the model id, judge id, seeds, split salt, harness git sha, and
   `residentContextVersion` from the config block. Say `seed-source=model` or `gold`.
6. Compare warm to `bm25` and `fullcontext`, not only to `bare`. If warm does not beat `bm25`,
   the resident path is not yet earning its complexity; say so.
7. Never rerun the same items into a warmed DB and score them again. The harness does not let
   you, but a hand-rolled script can.

### What the real run showed (HISTORY.md §7, 2026-09-14)

Sonnet 5 and GPT-5.4 mini, 5 seeds, all arms, paraphrase split: gold-seeded warm 100 % / 98 % on
held-out paraphrases from a ≈ 0 % bare; warm = bm25 = fullcontext within noise (the resident path
injects ~2.7× bm25's tokens for no measurable gain on one-fact notes); model-seeded memory stays at
bare because the model wrote wrong notes; gsm8k is a null result on both models (no lift, no
regression); the successor's inherited pool takes a fresh account from 0 to 100 %; three model
re-summarisations retain 43–47 % of facts. The §5 stair-step did not reproduce held-out.

### Why §5 is a pilot

- **N=10 per cell.** The confidence intervals span most of the range.
- **Same items twice.** "Warm" was the same ten questions rerun on the DB that the cold pass had
  accumulated *from those questions*. That measures lookup, not memory.
- **Runner not in the repo.** `genbench/run-pass.sh` lived in a session scratchpad.
- **SDK-side injection.** Memory was fetched with `agent.recall()` and concatenated into the
  prompt by the SmartProvider wrapper, not built by the code the resident agent actually runs.
- **No controls beyond bare.** No full-context or plain-RAG comparison, so "memory helps" could
  not be separated from "more relevant text in the prompt helps".
- **No judge prompt, no CIs, no token or cost accounting** in the record.

None of this means §5 was wrong. It means it cannot be cited as a result. This harness is the
instrument that can produce one.

## successor — cold start and transmission fidelity (Tier 4 scaffold)

`benchmarks/memory/successor.ts` asks the generational question genbench cannot: **does a fresh
account that inherits a predecessor's shared knowledge get productive faster than one that does
not, and how much of that knowledge survives being re-summarised down a chain of successors?**

```bash
# Offline, deterministic — what the test runs
bun --env-file=/dev/null run benchmarks/memory/successor.ts --seeds 5

# Fewer items, more generations
bun --env-file=/dev/null run benchmarks/memory/successor.ts --seeds 3 --limit 60 --generations 4

# Real model through a running Marina instance (answering AND re-summarising)
bun --env-file=/dev/null run benchmarks/memory/successor.ts --model marina \
  --endpoint http://localhost:3300 --seeds 5 --generations 3
```

With a real model the summariser defaults to `model` (the answering model rewrites each
generation's inheritance into a digest that must fit the shrinking byte budget; anything over is
hard-truncated), so the fidelity chain measures paraphrase drift as well as loss. `--summarizer stub`
keeps the truncating digest for an apples-to-apples comparison. The predecessor/successor split
uses the same `paraphrase` default as genbench, so the inheriting successor's ceiling is 100 %
and `fresh` is the empirical prior (≈ 0 on fictional facts).

Results land next to genbench's (`benchmarks/results/memory/`, gitignored) as one JSON
(`schema: marina.memory.successor.v1`, `config.kind: successor`) plus a markdown summary.

### Protocol

Per seed, `synthetic-v1` is split with genbench's `splitItems` into the facts the **predecessor**
learned (seed set) and the **successor's task stream** (eval set, in split order). The predecessor
deposits one `Q: … | A: <gold>` lesson per learned fact into the shared pool
`tradition:predecessor` as a reflection-tier note. Then two fresh `Successor` accounts run the same
task stream in two fresh worlds:

| Arm | Shared pool | What it isolates |
|---|---|---|
| `fresh` | empty | A newcomer with nothing but its own accumulating notes. |
| `inherit` | the predecessor's lessons | The same newcomer with a predecessor's pool to consult. |

Both arms read through `gatherRetrievalContext` — the retrieval core behind `recap` / `ask` /
`dig` (own notes + guide pool + shared pools, with the group-pool membership guard) — rendered with
per-line provenance (`[pool tradition:predecessor by Predecessor] …`). The answering model is
genbench's stub (correct iff the item is in the fixed 60% "known" subset or the gold answer is in
the injected context); the judge is genbench's exact match. Both arms learn a Q/A note after every
answer (`--no-learn` disables).

Per arm and seed the harness records **time-to-first-correct** (1-based position of the first
correct answer), **time-to-first-transfer** (first correct answer the stub did *not* already know —
pure memory transfer), **first-k success** (`--first-k`, default 5), pooled accuracy with a Wilson
95% interval, transfer rate, and how often the injected context contained inherited material.

**Transmission fidelity.** The predecessor's lessons are generation 0. Each generation `g ≥ 1`
summarises what it inherited under a byte budget that shrinks by 0.7× per generation
(`FIDELITY_BUDGET_BYTES`, `FIDELITY_BUDGET_DECAY`) and hands the digest on. Retention per
generation is **embedding-free**: a fact is retained when its normalized gold answer is contained
in the digest. The shipped summariser is a deterministic truncating digest (whole lines survive or
drop in a seed-stable order, never paraphrased) — a stand-in that exercises the metric.
`Summarizer` is the seam for a model-backed summariser later.

### Inheritance mechanism

The successor inherits via a **shared pool**, recorded as `config.inheritance = "shared-pool"`. The
portable `inheritance export/import` bundle (`marina.inheritance.v1`) is the same knowledge in
token form but is capped at 12 artifacts per token, so the harness seeds the pool directly rather
than pretend a 25-fact inheritance fits one bundle.

### What it does NOT prove

- `--model stub` is the only wired model in this scaffold (a non-stub id is refused rather than
  silently routed). Stub numbers are plumbing checks: they show the read path surfaces inherited
  lessons and that the metrics compute; they say nothing about a real model.
- Fidelity with the stub summariser measures truncation loss only. Paraphrase drift — the way real
  re-summarisation actually corrupts facts — needs a model-backed `Summarizer`.
- The synthetic domain is 50 fictional facts × 2 paraphrases; transfer means "recall the sibling
  paraphrase's lesson", not generalisation.

### Files

- `successor.ts` — harness and CLI (`runSuccessorBenchmark`, `fidelityChain`, `buildSuccessorContext`, `validateSuccessorResult`).
- `../../test/successor-benchmark.test.ts` — offline pipeline test.

## What this does NOT prove

- A stub-model run proves the pipeline is wired correctly. It says nothing about any real
  model's behavior with memory.
- A lift on `synthetic-v1` proves transfer across paraphrases of fictional facts under FTS
  recall. It does not show that memory improves reasoning, coding, or long-horizon tasks.
- A held-out lift on a public benchmark shows that notes written about *other* items helped.
  It does not distinguish "learned a reusable principle" from "the dataset has near-duplicate
  items"; inspect `items[]` before claiming the former.
- `bm25` is a *legacy FTS* control, not a tuned dense-retrieval baseline. Beating it does not
  establish state of the art; losing to it is a red flag.
- `fullcontext` is only run when the corpus fits `--context-budget`. Skipped is not a win.
- The `chars/4` token estimate is a heuristic. Use `promptTokens` when a real model reported
  usage.
- Latency in stub mode measures the harness, not a model. Only real-model latency is
  meaningful, and it includes the Marina router hop.
- The harness measures the answering surface only. Agent-loop effects (focus, reflection,
  consolidation, tick cadence) are out of scope here and are covered by
  `scripts/research/memory-live-runtime.ts`.
- The seeding pass uses `Q: … | A: …` notes (the SmartProvider `qa` mode). §5 used `reflect`
  mode (LLM-distilled principles). Distillation quality is not measured by this harness.

## Files

- `genbench.ts` — harness and CLI (`runMemoryBenchmark`, `runCli`, exported primitives).
- `items/synthetic-v1.json` — committed offline item set.
- `../results/memory/` — output (gitignored).
- `../../scripts/qualify-memory-benchmark.ts` — thin CLI; `bun run qualify:memory:benchmark`.
- `../../test/memory-benchmark-harness.test.ts` — offline pipeline test.
