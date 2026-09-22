# genbench — memory-delta benchmark harness

`benchmarks/memory/genbench.ts` answers one question under conditions that do not let the
answer flatter itself: **does Marina's memory change answer quality, by how much, with what
confidence, at what token and latency cost, compared to the obvious alternatives?**

Research, implementation plans and qualification results are maintained in marina-internal.
This public guide documents the runnable harness and how to interpret its outputs.

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

`buildResidentMemoryContext` calls `buildUnifiedContext` and `renderUnifiedContext`, the same
builder and renderer used by the resident continuation prompt. The topic is the first 200
whitespace-normalized characters of the question. Each result records
`resident-v2:buildUnifiedContext+renderUnifiedContext` as its context version; compare results
only after checking which implementation and configuration produced them.

### The stub model and stub judge

`--model stub` is deterministic: it answers correctly iff the item is in a fixed pseudo-random
60% "known" subset (`stubKnows(id)`) **or** the gold answer text appears in the injected memory
context. `--judge stub` is normalized exact match (MC letter extraction; numeric last-number
equality; otherwise normalized equality or whole-answer containment).

The stub exercises the pipeline and evidence-transfer mechanics. Its scores are deterministic
fixture behavior, not evidence about a real model.

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
  memory could reach is approximately the seed fraction. Inspect `metrics.reachable` before
  interpreting an arm’s score.
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

## Run matched comparisons

For an interpretable comparison:

1. Start a Marina instance with the model you intend to name, and keep it fixed for the run.
2. Pick datasets such as `simple-qa gsm8k math hellaswag arc-challenge musr` and a `--limit`
   of at least 200 per dataset. N=10 per arm cannot separate a 10-point
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
- The seeding pass uses `Q: … | A: …` notes. Quality of LLM-distilled principles is not
  measured by this harness.

## Files

- `genbench.ts` — harness and CLI (`runMemoryBenchmark`, `runCli`, exported primitives).
- `items/synthetic-v1.json` — committed offline item set.
- `../results/memory/` — output (gitignored).
- `../../scripts/qualify-memory-benchmark.ts` — thin CLI; `bun run qualify:memory:benchmark`.
- `../../test/memory-benchmark-harness.test.ts` — offline pipeline test.

## Skill transfer — does a PROCEDURE carry to fresh problems? (`synthetic-skills-v1`)

This dataset tests whether stored procedures help with fresh problems. The seed side contains
`skill`-tier notes rendered as `<example skill=…>` blocks by the resident context builder.
Every scored item requires applying the corresponding fictional procedure.

```bash
# Offline, deterministic (what the test runs) — plumbing check only
bun --env-file=/dev/null run benchmarks/memory/genbench.ts \
  --dataset synthetic-skills-v1 --seed-source gold --seeds 5

# Real model through a running Marina instance — the headline condition (gold procedures)
bun --env-file=/dev/null run benchmarks/memory/genbench.ts \
  --dataset synthetic-skills-v1 --seeds 5 --seed-source gold \
  --model marina --judge stub --endpoint http://localhost:3300 --api-key "$MARINA_API_KEY"

# Secondary, honest condition: the model writes each procedure in its own words from the
# worked example alone; whatever it wrote is what memory holds.
bun --env-file=/dev/null run benchmarks/memory/genbench.ts \
  --dataset synthetic-skills-v1 --seeds 5 --seed-source model \
  --model marina --judge stub --endpoint http://localhost:3300 --api-key "$MARINA_API_KEY"
```

### Dataset

`items/synthetic-skills-v1.json` — **12 fictional procedure families × (10 scored problems + 1
held-back worked example) = 132 items**, generated deterministically by
`items/synthetic-skills-v1.generator.ts` (fixed-seed PRNG; re-running it reproduces the file byte for
byte). Families: `varn-kell` (unit ratio), `orlen-levy` (tiered fee), `thessic-round` (scoring formula
with a conditional bonus), `kelmar-calendar` (13×28-day date offset), `brannock-check`
(position-weighted digit sum mod 97), `rell-discount` (discount stacking order), `pell-burn`
(loaded/empty burn + fixed charge), `corvane-class` (ceil-class then per-class fee), `oddric-code`
(letters/vowels/first-letter formula on a word), `maroth-berth` (constructed code string), `tarn-loan`
(simple interest), `vellum-grade` (floored penalty grade). Answers are numeric or short exact strings.

Every item carries `metadata: { familyId, family, kind: "problem" | "example", skill }` — `skill` is the
family's procedure statement (1–3 imperative sentences, **no worked example**), duplicated on every
item for seeding convenience. The generator enforces: no scored answer appears as a normalized
substring of *any* family's skill note (statement + worked example) — the same check the stub model
applies to injected context — no answer appears as a word in its own question, answers are unique
within a family, and every note fits the unified-context 600-byte per-item cap intact. No real model
can know these rules, so `bare` should be ≈ 0 and any lift is procedure transfer, not lookup.

### Split: `family` (default for this dataset; `--split family`)

`splitFamilies(items, seed, salt)`: **all ten problems of every family are EVAL**; the family's
`kind: "example"` item is the only seed-side item (a family that ships no example gets one member
held out by a seed-stable hash instead). Items without a `familyId` fall back to the item split.
Recorded as `config.splitMode = "family"`; `metrics.reachable` (the Ceiling column) is 1 — every eval
item's procedure is seeded. `defaultSplitMode` picks `family` when every item has a `familyId`, before
the `paraphrase`/`item` rules, so `synthetic-v1` and the downloaded sets are unaffected.

**No split variance by construction.** The eval *set* is identical across seeds (same fingerprint);
the seed only reorders it (cold/warm learning order) and, with a real model, samples differently.
Quote the Wilson interval on the pooled n; read the seed-level CI as model + order variance only.

### Seeding under the family split

`buildSkillSeedCorpus` writes **one `skill`-tier note per family, never a Q/A note about a scored
item** — `noteType: "skill"`, `tier: "skill"`, importance 6, content
`[Skill: <familyId>] <procedure> || Example: Q: <example question> A: <example answer>`
(`skillNoteText`), the shape `skill store` produces so the skills tier renders it as an
`<example skill="#id" imp="6">` block exactly as it would an agent's own skill.

- `--seed-source gold` (the headline): `<procedure>` is the family's own statement.
- `--seed-source model`: the model is asked to state the general rule from the worked example
  **only** (system prompt in `buildProcedureMessages`; the statement is never shown). Its reply is
  recorded verbatim; an empty reply becomes `(no procedure written)` rather than silently falling
  back to gold. A rule the example under-determines (a tiered fee from one data point) yields a wrong
  or vague note. `perSeed[].seedPass` records
  `{ items: families, correct: procedures written, notes, skills }`; `correct` here means "a
  non-empty procedure was written", not accuracy.

`cold`/`warm` within-run learning still writes `Q: … | A: <model answer>` notes after each eval
item (procedures are not re-derived); `cold` therefore never sees a skill (`skill-hits=0%`) and is
the answers-only memory control.

### Controls isolate the `<example>` tiering

`warm`, `bm25` and `fullcontext` receive the **identical** 12 skill notes. `bm25` retrieves them
verbatim by legacy FTS relevance (top-k over all seeded notes — `recallNotes` includes the skill tier);
`fullcontext` inlines all twelve; `warm` goes through `buildUnifiedContext`, whose skills tier renders
`<example>` blocks before `[trusted]`/`[unverified]`. So warm − bm25 is the value of tiering + framing
over plain retrieval of the same procedure text, and warm − fullcontext is retrieval vs. "just show
every procedure" (12 notes ≈ 1,000 tokens, well under the default budget).

### Report additions

- `metrics.skillHitRate` — share of eval items whose injected context contained their family's
  procedure statement (normalized containment; `contextContainsSkill`). `null` for datasets without
  `metadata.skill`. Sits next to `memoryHitRate` in the JSON, the console line (`skill-hits=`), and
  the summary table ("Skill hit"). A lift with a low skill hit rate is not procedure transfer.
- `metrics.perFamily` — `{ n, correct, accuracy, skillHitRate }` per `familyId`; the summary
  markdown adds a "Per family (judge accuracy · skill hit)" table. Read it before claiming a lift:
  transfer that lands on the arithmetic-only families but not on the string-construction ones is a
  finding, not noise.
- `items[].familyId`, `items[].skillHit` per query record.

### Stub behavior

The stub does not apply procedures. It uses `stubKnows` or looks for a literal gold answer
in the injected text; the dataset generator excludes scored answers from seeded procedures.
The offline test checks procedure delivery through the resident path, not model reasoning.

### What this does NOT prove

- A stub run proves the procedure reaches the prompt through the resident path. It says nothing about
  any model's ability to apply it.
- The answering prompt is genbench's answer-only prompt ("Reply with ONLY the final numeric
  answer" / "just the answer"). Multi-step procedure application without visible reasoning handicaps
  non-reasoning models; a reasoning model does the steps in its
  hidden block. Compare arms within one model, never across.
- `--judge stub` is exact match: numeric last-number equality, otherwise normalized whole-answer
  containment. The `kelmar-calendar` (`M/D`) and `maroth-berth` (`H9-3`) families depend on the model
  honouring the format the question asks for; if a real run shows format misses in `items[]`, rerun
  with `--judge marina` (LLM judge, `JUDGE_PROMPT_V1`) and label it.
- Twelve families is enough to separate "procedures transfer" from "they do not" with CIs, not to
  rank procedure *kinds*; `perFamily` cells have n = 10 × seeds.
- Skill notes are seeded directly. Whether a real agent would *write* a usable procedure from
  experience (the ACE reflection loop, `skill store`) is the `--seed-source model` condition at best
  and is otherwise out of scope.

### Files

- `items/synthetic-skills-v1.json` — committed offline item set.
- `items/synthetic-skills-v1.generator.ts` — deterministic generator (run it to regenerate; it must
  reproduce the committed file).
- `genbench.ts` — `splitFamilies`, `SKILLS_DATASET`, `loadSyntheticSkillItems`, `skillNoteText`,
  `contextContainsSkill`, `FamilyMetrics`, `CorpusNote`.
- `../../test/memory-benchmark-harness.test.ts` — "genbench skill transfer" suite (dataset validity,
  split, seeding, hit-rate plumbing).

## gateway — lift per injected token (`benchmarks/memory/gateway.ts`)

genbench measures memory for an agent *inside* Marina. `gateway.ts` measures the
**passthru memory gateway from the outside**: an ordinary OpenAI-compatible client calls Marina's
`/v1/chat/completions` with a bound `secret:entity` key, and the harness asks how much the bytes
Marina injects into the upstream prompt improve that client's answers — **per token injected**.

The harness is a pure client. It never opens the database, never imports the engine, and never
calls a provider: everything goes through the `--endpoint` you point it at. Provider credentials
stay on the server.

```bash
# Offline, deterministic — what CI runs (in-process Marina, stubbed upstream)
bun --env-file=/dev/null test test/gateway-benchmark.test.ts

# Against a running Marina (see "Server requirements")
bun --env-file=/dev/null run benchmarks/memory/gateway.ts \
  --endpoint http://localhost:3300 --api-key "$SECRET" --entity GatewayBench --seeds 5

# Budget sweep = one server per budget (see below)
MARINA_PASSTHRU_INJECT_BYTES=512 bun run start   # …then:
bun --env-file=/dev/null run benchmarks/memory/gateway.ts --endpoint http://localhost:3300 \
  --api-key "$SECRET" --entity GatewayBench --seeds 5 --budget 512
```

### Protocol

Per seed:

1. **Split** `items/synthetic-v1.json` with genbench's `splitParaphrases` — exactly one paraphrase
   of every fact is held out, its sibling is seeded. Transfer ceiling is 100 %, so any miss is the
   gateway's (retrieval, budget, or the upstream model), not the split's.
2. **Seed through Marina.** One `Q: <sibling question> | A: <gold>` note per seed item
   (genbench's `learnNoteText`) via `POST /mem/notes` with `Authorization: Bearer <MEM_API_KEYS
   secret>`. `/mem` writes notes under `entity_name = <agent>`; passthru injection reads the bound
   entity's legacy notes by that same name (`buildInjectedContext` → `buildUnifiedContext(db,
   entity.name, …)`). The two keys therefore MUST name the same entity, and the name must be
   canonical (`[A-Za-z0-9_]{1,20}` — what `sanitizeEntityName` leaves; the harness refuses
   anything else because the server would bind the key to the sanitized name while `/mem` seeded
   the raw one). The SDK/`note`-command route was rejected because it logs the name in as a
   *player* connection and would hold the entity for the run; `/mem` binds by name with no session.
3. **Two arms per eval item**, same body, same key, back to back:
   - `injected` — `X-Marina-Context: on` (honored for bound keys only; also the `local` profile
     default without the header).
   - `off` — `X-Marina-Context: off`: the byte-identical proxy control. No identity resolution,
     no injection, no capture, no receipt header.
   The answer is graded with genbench's `exactMatchJudge`; `x-marina-memory-receipt` is parsed with
   `parseMemoryReceipt`. A header that is the ≤2 KB stub (`truncatedHeader: true`) is counted under
   `receipts.stub` and its `usedBytes` recorded as unknown (the full receipt is on the trace:
   `trace show <x-request-id>`).
4. **Wipe.** Passthru *captures* every injected exchange as a `[passthru] User/Assistant` note in
   the entity's memory, so the harness deletes every note in the `/mem` namespace before each seed
   and after the run (`GET /mem/notes?all=1` + `DELETE /mem/notes/:id`, polling `/mem/stats` until
   0 so a late capture from the previous seed does not survive). It **refuses to start** if the
   namespace already holds notes unless `--force` is given — use a dedicated benchmark entity.

Fail-fast: if a whole seed's injected arm succeeds without a single receipt header, the run aborts
(seed notes wiped) with the checklist below — that is the signature of an unbound key, a
non-passthru endpoint mode, or injection being off.

### Metrics

Per arm (`arms.off`, `arms.injected`): accuracy with **Wilson 95 %** (pooled) and seed-mean ±
1.96·sd/√k; token-F1; receipts full/stub/missing; injected **bytes** (receipt `usedBytes`, framing
lines included) and **tokens** (bytes/4 heuristic, labeled — the same chars/4 heuristic as
genbench's `estimateTokens`) mean/p95/max; truncation rate; receipt `degraded` codes; provider
`usage.prompt_tokens` / `completion_tokens` when the upstream reports them; latency p50/p95.

Headline (`lift`):

| Field | Meaning |
|---|---|
| `liftPerRequest` | acc_injected − acc_off (extra correct answers per call), Wald 95 % CI |
| `liftPerKilotoken` | **(acc_injected − acc_off) / (mean injected tokens / 1000)** — accuracy points per 1 000 injected tokens |
| `providerPromptTokenDelta` | mean prompt_tokens(injected) − mean prompt_tokens(off): the *provider's* count of what injection cost |
| `liftPerProviderKilotoken` | the same lift over the provider-reported delta, when present |
| `tokenF1Delta` | token-F1 delta |

### Config block

`endpoint`, `entity`, `entityResolved` (from receipts — must equal `entity`), `apiKeyFingerprint`
(sha256 prefix, never the secret), `model` (requested id, default `marina`), `serverModels`
(`/v1/models`), `responseModel` (the upstream the server pinned, from the first completion's
`model`), `budgetBytes.{requested,observed}`, dataset + item count, seeds, split mode/salt/fraction,
`seedingPath`, `wipeBetweenSeeds`, the two header values, judge, temperature, timeout, harness git
sha, `harnessVersion`, timestamps.

Results: `benchmarks/results/memory/<stamp>-gateway-<responseModel|model>.json`
(`schema: "marina.memory.gateway.v1"`, validated by `validateGatewayResult`) plus a `.md` of the
same base name. Never overwritten (`-1`, `-2`, … suffixes). Commit the harness, never results.

### Budget sweep

The injection budget is server-side: entity property `passthruInjectBytes` →
`MARINA_PASSTHRU_INJECT_BYTES` → 2048. There is no client-facing setter (no `/mem` route and no
in-world command writes entity properties), so **a sweep is one server per budget**: restart with
`MARINA_PASSTHRU_INJECT_BYTES=<n>` and run with `--budget <n>`. `--budget` is recorded in
`config.budgetBytes.requested`, every receipt's `budgetBytes` is checked against it, and a
mismatch becomes a warning naming the observed budget. Compare the per-budget result files by
`lift.liftPerKilotoken`.

### Server requirements

| Requirement | Why | How the harness checks |
|---|---|---|
| `MODEL_API_KEYS=<secret>:<entity>` (bound) | a plain secret — or `MARINA_OPEN_API` anonymous — is the shared passthru identity and is never injected | `GET /v1/models` 401 → error; no receipts after seed 1 → error with checklist |
| `MEM_API_KEYS=<secret>:<entity>` (same entity) | seeds land in the memory the passthru identity reads | `GET /mem/stats` 401 or `agent != entity` → error |
| endpoint mode `passthru` | default `agents`+fallback proxies upstream **without** injection when no agent answers: `PUT /api/model-endpoint {"mode":"passthru"}` (Admin → Model Endpoint) | surfaces as "no receipts" |
| an upstream provider key on the server | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, … | HTTP 503/502 recorded as item errors |
| injection on | `local` profile default; harness sends `X-Marina-Context: on` anyway | — |
| dedicated entity | namespace is wiped between seeds | notes > 0 without `--force` → error |

Rate limits (2 req/s per IP on the model API, 10 req/s per agent on `/mem` outside the `local`
profile) are handled with 429 backoff honoring `Retry-After`.

### What the offline test asserts (`test/gateway-benchmark.test.ts`)

A real `Bun.serve` on an ephemeral port routes `/v1/*` → `handleModelApi` and `/mem*` →
`handleMemApi` in passthru mode; the upstream is a fetch stub that answers the gold iff the
injected system content contains it. Asserted: `off` = 0 % with zero receipt headers and an
unmodified body; `injected` = 100 % (= the reachable ceiling) with a full receipt on every call
naming the bound entity and matching `x-request-id`; `liftPerKilotoken > 0` and equal to
1/(mean tokens/1000); provider prompt-token delta > 0; schema-valid JSON + markdown written under
the naming convention; the namespace is left empty; fail-fast with the binding checklist on an
unbound key (seed notes wiped); refusal on a non-canonical entity, a rejected key, and a non-empty
namespace without `--force`; stub/full/garbage receipt-header parsing; split determinism.

## contradiction — multi-writer contradiction benchmark (offline, deterministic)

`benchmarks/memory/contradiction.ts` measures
**when several writers of different standing assert competing values in one shared space, how
many contradictions does each `resolve` policy close, how often does it pick the true value, does
the Sybil rule hold, and can a reader still be served a superseded value afterwards?**

```bash
# Default: 5 seeds × 40 facts, 4 established writers, 3 fresh accounts, all four policies (~6 s)
bun --env-file=/dev/null run benchmarks/memory/contradiction.ts --seeds 5

# The Sybil ring without independent gold provenance / honest mistakes that self-source / wrong value written last
bun --env-file=/dev/null run benchmarks/memory/contradiction.ts --no-sources
bun --env-file=/dev/null run benchmarks/memory/contradiction.ts --wrong-sources
bun --env-file=/dev/null run benchmarks/memory/contradiction.ts --order gold-first --arms last_writer_wins
```

No model is called and no network is touched (a fetch guard refuses it and the count is recorded
as `config.networkAttempts`). The four policies are deterministic and the scenario generator is a
counter-mode PRNG over genbench's `stableHash`, so the same seed set yields identical JSON apart
from timestamps, runtimes and the harness sha (`stripVolatile`). Results land next to genbench's
(`benchmarks/results/memory/`, gitignored) as one JSON (`schema: marina.memory.contradiction.v1`,
`config.kind: contradiction`) plus a markdown summary; files are never overwritten.

### Protocol

One fresh `MarinaDB` per (seed, arm). Accounts are world accounts bound the way
`residentMemoryOperation` binds them (`users.id` = human principal id; standing under that id in
`entity_standing_cache` via `setStandingCache`), driven through `MarinaMemoryClient` over
`handleMemoryServiceApi(worldMemoryService(db))` — the real durable service, not a stub. The
per-principal HTTP request budget (100 burst / 25 s⁻¹) is a transport guard the steward's settle
loop bursts past, so the run adopts the `local` trust posture `main.ts` applies for a loopback
operator (`RateLimiter.bypass`) and restores it afterwards; this is recorded in `config.transport`.

A **Steward** (standing 50) owns one shared space and grants `writer` to every writer and `reader`
to a **Reader**. Per seed the generator lays out *K* facts (`--facts`, subject/predicate with a
gold literal); each gets a gold assertion from an established writer (standing drawn from
{15, 25, 40, 60}, all above `SYBIL_STANDING_FLOOR`) and:

| Knob | Default | Effect |
|---|---|---|
| `--conflict` | 0.5 | share of facts that also get a **wrong** value from a *different* writer |
| `--sybils` / `--sybil-share` | 3 / 0.5 | that share of conflicts is a **Sybil attack**: the wrong record is authored by a fresh (standing 0) account and its `source_ids` are copies of one text captured by every other fresh account (one content hash, distinct authors). The rest are **honest disagreements** by another established writer |
| `--sources` (default on) | on | the gold record carries 1–2 sources captured by *other* established writers — independent provenance |
| `--wrong-sources` | off | an honestly-wrong writer captures its *own* source (default off: an honest mistake is an unsourced assertion) |
| `--corroboration` | 0.3 | a third writer re-asserts the gold value (same object → never a contradiction with gold) |
| `--order` | random | `gold-first` writes the wrong value strictly last; `wrong-first` strictly first |

Every assertion carries a `claim` and an explicit `valid_time.from` on a virtual timeline; the
reader asks "what is true now" at a `valid_at` after every assertion.

**Phase 1 (before).** Contradictions are counted with `COMPETING_RECORD_PREDICATE` — the SQL
`review kind:competing` and the dashboard hygiene ratios use — so the unresolved rate is 1.0 by
construction and `computeHygieneRatios` is snapshotted.

**Phase 2 (curator loop).** For every conflicted fact the steward applies the arm's policy through
`resolve` (head = the fact's first gold record; `last_writer_wins`, `evidence_weighted` and
`keep_both` never look at which member is the head). `await_confirmation` mirrors the
review → reaffirm → resolve loop: defer, then confirm the gold side with `reaffirm` (a reviewed
revision that lifts the pending set *and* makes that assertion the most recently revised), measure
what is still competing, then settle with `last_writer_wins`.

**Phase 3 (served).** As the Reader: a temporal `query` (`subject`, `predicate`, `valid_at`) and a
lexical `search` for each fact.

### Metrics (per arm; pooled with Wilson 95 % + seed mean ± 1.96·sd/√k)

| Metric | Definition |
|---|---|
| Unresolved rate | competing records after / before (predicate above) |
| Winner accuracy | winner's literal == gold, over conflicted facts (keep_both names no winner → n/a; it reports the share of peers marked `qualified_by` instead) |
| Sybil facts: gold wins | winner accuracy restricted to Sybil-attack facts |
| Served wrong / ambiguous | the temporal query still returns a non-gold value as current / more than one current value |
| Unsafe served | the temporal query returned a record an applied resolution superseded — the validity-closure invariant; must be 0 |
| Search serves superseded | lexical `search` for the fact lists a superseded record among its hits |
| Hygiene agrees | per seed, `computeHygieneRatios().unresolvedContradictionRate` before is 1.0 and after has numerator = the benchmark's competing-after count and value = its unresolved rate |

### What it does NOT prove

- The scenario is synthetic: literal claims, one predicate per fact, writers who never revise. It
  measures the operators, not how well an agent or curator *chooses* a policy or a head.
- Standing is assigned, not earned; the Sybil rule is exercised at 3 fresh accounts by default (the
  bound itself is asserted at 10/32/10 000 in `test/memory-resolve.test.ts`).
- "Served" is the durable `query`/`search` surface. The gateway injection path and its receipts
  (`unsafeServedRate` in the hygiene ratios) are not driven here.

### Files

- `contradiction.ts` — harness and CLI (`runContradictionBenchmark`, `generateScenario`, `summarizeArm`, `validateContradictionResult`, `stripVolatile`).
- `../../test/contradiction-benchmark.test.ts` — offline pipeline + policy-property tests (~3 s).
