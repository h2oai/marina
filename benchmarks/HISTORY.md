# Benchmark history — Gen-0 → Gen-1 → tier-filter

The headline numbers from the snapshot-driven experiments that shaped the
substrate. The snapshots themselves (`seeds/gen0-*.db`, `seeds/gen1-*.db`)
were deleted on 2026-04-27 — migration 37 (memory tiers) changed recall
semantics so the old DBs are no longer faithful baselines for the current
substrate. Numbers below are preserved for citation and trend tracing.

All runs use `seed=42`, `bare Sonnet 4.6` for the baseline, and
`marina:answerer` (dispatcher + specialist crew) for Marina. World:
`default`.

---

## 1. Gen-0 TruthfulQA pilot — N=25, 2026-04-20

First Marina-vs-foundation comparison on identical questions.

| Contestant | Score | Correct | Avg latency | Duration |
|---|---|---|---|---|
| `marina` (bare Sonnet 4.6) | 96.0% | 24/25 | 4.2s | 53s |
| `marina:answerer` (cold DB) | **100.0%** | 25/25 | 8.9s | 222s |

Δ +4.0pp. Single flip on Q14 (California misconception trap) — bare Sonnet
fell for the popular misconception, Marina's Skeptic + Verifier caught it.
Exactly the territory Marina is supposed to win.

Engagement check: every specialist (Councilor, Decomposer, Debater,
Mathematician, Historian, Verifier, Reflector, Scholar, Skeptic) was
dispatched 138-286 times across the run. Latency 2.1× bare — the dispatch
tax is real but reasonable.

Caveat: N=25 with a 1-question delta is statistically fragile.

Snapshot was 2.5MB / 273 notes / 36 pools.

---

## 2. Gen-0 full sweep — N=50, all 13 Phase A benchmarks, 2026-04-21

First complete per-benchmark profile.

| Benchmark | Bare | Answerer | Δ | Winner |
|---|---|---|---|---|
| truthfulqa | 100.0% | 98.0% | −2.0 | baseline |
| mmlu-pro | 86.0% | 74.0% | **−12.0** | baseline |
| ifeval | 88.0% | 86.0% | −2.0 | baseline |
| **humaneval** | **94.0%** | **50.0%** | **−44.0** | baseline |
| hellaswag | 54.0% | 90.0% | **+36.0** | answerer |
| arc-challenge | 86.0% | 90.0% | +4.0 | answerer |
| gsm8k | 96.0% | 76.0% | **−20.0** | baseline |
| bbh | 100.0% | 94.0% | −6.0 | baseline |
| musr | 76.0% | 80.0% | +4.0 | answerer |
| math | 80.0% | 58.0% | **−22.0** | baseline |
| simple-qa | 12.0% | 34.0% | **+22.0** | answerer |
| frames | 66.0% | 57.8% | −8.2 | baseline |
| aime | 43.3% | 80.0% | **+36.7** | answerer |
| **Average** | **75.5%** | **74.4%** | **−1.0** | baseline |

Bare Sonnet edges Marina by 1.0pp on average. Marina wins 5/13, loses
8/13 — but the win profile is **crystal clear**:

- **Decisive Marina wins** (reasoning + memory + adversarial): AIME +36.7,
  HellaSwag +36.0, SimpleQA +22.0, ARC +4.0, MuSR +4.0
- **Decisive Marina losses** (single-shot extraction): HumanEval −44.0,
  MATH −22.0, GSM8K −20.0, MMLU-Pro −12.0
- **Within noise**: TruthfulQA, IFEval

The split is orthogonal: deliberation territory (Marina) vs. clean-extraction
territory (bare). HumanEval −44pp is the canonical case for the **Translator
role** — a normalizer that takes verbose crew output and emits the format the
adapter expects.

Three harness bugs surfaced and were fixed mid-run:
1. Controller close race in `model-api.ts` (commit `38a3ea0`).
2. Too-tight timeouts (90s → 600s) — competition math legitimately needs >90s.
3. HumanEval silently 0% — Bun 1.3 dropped `.timeout()` from `$`-templates
   (commit `439429c`); switched to `Bun.spawn()` + `AbortController`.

Snapshot was 1.6GB / 5006 notes / 41 pools.

---

## 3. Gen-1 full sweep — N=50, booted from Gen-0 snapshot, 2026-04-21

Same benchmarks, same seed — but the answerer crew started from the warm
Gen-0 DB instead of cold.

| Benchmark | Bare | Gen-0 | Gen-1 | Gen-0→Gen-1 | Gen-1 vs bare |
|---|---|---|---|---|---|
| **aime** | 43.3% | 80.0% | **80.0%** | 0 | **+36.7** |
| **hellaswag** | 54.0% | 90.0% | 86.0% | −4.0 | **+32.0** |
| simple-qa | 12.0% | 34.0% | 22.0% | **−12.0** | +10.0 |
| arc-challenge | 86.0% | 90.0% | 90.0% | 0 | +4.0 |
| musr | 76.0% | 80.0% | 80.0% | 0 | +4.0 |
| frames | 66.0% | 57.8% | **66.6%** | **+8.8** | +0.6 |
| **bbh** | 100.0% | 94.0% | **100.0%** | **+6.0** | 0 |
| **math** | 80.0% | 58.0% | **80.0%** | **+22.0** | 0 |
| truthfulqa | 100.0% | 98.0% | 98.0% | 0 | −2.0 |
| gsm8k | 96.0% | 76.0% | 94.0% | **+18.0** | −2.0 |
| mmlu-pro | 86.0% | 74.0% | 78.0% | **+4.0** | −8.0 |
| **ifeval** | 88.0% | 86.0% | 74.0% | **−12.0** | **−14.0** |
| humaneval | 94.0% | 50.0% | 50.0% | 0 | **−44.0** |
| **Average** | **75.5%** | **74.4%** | **76.5%** | **+2.1** | **+1.0** |

**First aggregate win for Marina: 76.5% vs bare 75.5%, +1.03pp average
across 13 benchmarks.** The stair-step is real.

The math family is the cleanest demo of generational memory — MATH +22pp,
GSM8K +18pp, GSM8K and MATH both hit bare-Sonnet parity. Pool deposits
from Gen-0's math reasoning got recalled and reused.

Two regressions exposed the next failure mode:

- **IFEval −12pp from Gen-0** — strict format compliance regressed under
  memory growth. Pool recall pulled in irrelevant context that bled into the
  output and violated strict constraints.
- **SimpleQA −12pp from Gen-0** — for a benchmark that should benefit most
  from factual memory, going backwards was the loudest signal. The answerer
  was recalling polluted facts and confidently misstating.

The pattern: benchmarks where the answer depends on NOT bringing in extra
context regressed with growth. The crew's pool-recall heuristic was
"more context = better" — wrong for strict-format and narrow-factual tasks.

Notes grew Gen-0 → Gen-1 by +2732 (5006 → 7738), pool count moved by +1 —
new content filled existing topic pools, which is what consolidation looks
like.

Snapshot was 2.4GB / 7738 notes / 42 pools.

---

## 4. Tier filter — N=10 post-migration-37, 2026-04-24

After migration 37 added the `tier` column and recall-time filter excluding
`process` notes (the `[compaction]` chaff), we measured the SimpleQA
regression hypothesis directly.

| Benchmark | Bare | Gen-0 | Gen-1 (pre-tier) | Gen-1 + tier filter |
|---|---|---|---|---|
| SimpleQA | ~50% | ~72% (+22) | ~38% (−12) | **90% (+40 over bare)** |
| GSM8K | ~75% | ~75% | ~93% (+18) | 60% (timeouts, see below) |
| HellaSwag | ~60% | ~60% | ~95% (+36) | 50% (timeouts) |
| AIME-2025 | — | — | — | 50% (first measurement) |

**SimpleQA went 38% → 90% on the same Gen-1 DB** with the tier filter on —
the cleanest validation we have of the recall-quality hypothesis. The 4945
`[compaction]` notes had been polluting recall alongside real facts; with
fact-like-only recall, the answerer saw signal again.

GSM8K / HellaSwag / AIME timeouts at 300s exposed a separate problem —
crew dispatch latency on hard questions, not memory quality. The fix lever
is per-question budget + dispatcher-routing policy, not memory. Documented
separately, not addressed in migration 37.

N=10 — significance is weak. Migration 37 ships, the next move is N=50
seed=42 confirmation under the tier filter to compare against the Gen-1
table above.

---

## Lineage and what changed under the substrate

- **2026-04-20**: Gen-0 TruthfulQA pilot — single benchmark, validated the
  machinery + Skeptic catch.
- **2026-04-21**: Gen-0 full sweep — per-benchmark profile, 5/13 wins,
  Translator role identified as missing primitive, three harness bugs fixed.
- **2026-04-21**: Gen-1 full sweep — warm DB beats cold by +2.1pp average,
  beats bare Sonnet by +1.0pp. IFEval/SimpleQA regressions surfaced
  recall-pollution.
- **2026-04-24**: Migration 37 (tier column + recall filter + write dedup +
  process quota) — schema-level enforcement of the 6-layer memory architecture
  every commercial system (mem0, Letta, Zep, Cognee, LangMem) already has.
  SimpleQA 38% → 90% on N=10 validated the hypothesis.

The Gen-0 / Gen-1 snapshots were cold/warm comparisons against a substrate
that pre-dates migration 37. The post-migration substrate prunes process-tier
chaff at recall time, so old snapshots over-recall and under-perform compared
to a fresh sweep on the new code. Future generations should be built and
measured on the migration-37 substrate; the table above is preserved as a
historical anchor, not a current benchmark.

The next confirming sweep should use `usecase experiment <generation-name>`
(see `src/engine/commands/usecase.ts`) — the in-world recipe that replaced
the deleted `benchmarks/big-experiment.sh` and `gen1-experiment.sh`.

---

## 5. Migration-94 confirmation sweep — N=10, 2026-09-01

The confirming sweep §4 called for, run on the current substrate (migration
94: tiered recall + seq-ordered replay + the v0.7.0 hardening). Deliberately
bounded and honestly labeled: **N=10, seed=42, gpt-4o-mini**, six of the
thirteen benchmarks (truthfulqa/ifeval dataset downloads were unavailable at
run time), and the **SmartProvider memory wrapper** (recall + reflect-per-QA
into private notes and a shared pool) rather than the full answerer specialist
crew — this isolates the memory variable from crew-dispatch effects. Bare =
thin passthrough to the same model. Warm = the same questions, same seed,
rerun on the DB the cold pass accumulated (the same memory-reuse design as
the original Gen-1).

| Benchmark | Bare | Memory cold | Memory warm | cold→warm | warm vs bare |
|---|---|---|---|---|---|
| simple-qa | 10.0% | 20.0% | 20.0% | 0 | **+10.0** |
| gsm8k | 90.0% | 100.0% | 100.0% | 0 | **+10.0** |
| math | 80.0% | 90.0% | 90.0% | 0 | **+10.0** |
| hellaswag | 70.0% | 70.0% | **90.0%** | **+20.0** | **+20.0** |
| arc-challenge | 80.0% | 80.0% | 80.0% | 0 | 0 |
| musr | 60.0% | 70.0% | 70.0% | 0 | **+10.0** |
| **Average** | **65.0%** | **71.7%** | **75.0%** | **+3.3** | **+10.0** |

**The stair-step reproduces on the current code: bare 65.0 → cold 71.7 →
warm 75.0.** Three observations:

1. **No regressions.** The original Gen-1's failure mode (IFEval −12,
   SimpleQA −12 from recall pollution) does not appear: zero benchmarks
   declined cold→warm. This is the tier-filter working as designed — the
   warm substrate held 19 notes (9 fact, 10 skill), zero process-tier chaff,
   versus the 7,738-note pre-tier Gen-1.
2. **Warm is faster, not just better.** Latency dropped cold→warm on 5/6
   benchmarks (hellaswag 114.8s→96.7s, arc 136.2s→96.4s, musr
   137.2s→100.3s) — recalled principles substitute for re-derivation.
3. **19 notes moved the average +10pp over bare.** The memory that did this
   is small and curated (reflect-mode distillation), not voluminous —
   quality-over-volume, the exact lesson §4 paid for.

Caveats, unchanged in kind from §4: N=10 is weak significance; the substrate
model differs from the historical table (gpt-4o-mini vs Sonnet 4.6), so
absolute scores are not comparable across sections — only the within-run
bare/cold/warm deltas are the claim. Total run cost ≈ $1. Runner script
preserved in the session scratchpad (`genbench/run-pass.sh`); a full N=50 ×
13-benchmark × answerer-crew rerun remains the operator-approval item.
