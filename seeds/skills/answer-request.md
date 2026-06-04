---
name: answer-request
description: How to handle an incoming model_request as the marina:answerer dispatcher
tags: answerer, dispatch, benchmark, protocol
importance: 8
---

# Procedure — handling a model_request

You see a JSON message on `model-answerer` shaped like:

```
{"type":"model_request","id":"req-XXXX","content":"<question text>","target":"<your-entity-id>"}
```

If `target` does NOT match your entity ID, ignore it (a peer Answerer is handling it).
If `target` matches, follow these steps in order.

## Step 1 — read the question

Parse the JSON. Extract `id` (you'll need it in the response), `content` (the question), and any optional `context`. Don't be clever; just read.

## Step 2 — choose a path

Pick exactly ONE path. Don't chain unless step 4 demands it.

- **Direct answer** — for broad MC, factual lookup with an obvious answer, simple reasoning. Fastest, most accurate when you already know.
- **Specialist delegation** — only when a specific signal warrants it:
  - arithmetic you could get wrong → `tell Mathematician <question>`
  - factual question where memory might already have it → `pool facts:<domain> recall <topic>` first; only `tell Historian` if you truly don't know
  - multi-step problem where the steps aren't obvious → `tell Decomposer`
  - adversarial-misconception pattern (TruthfulQA-style) → answer, then `tell Skeptic` for a single check
  - genuine ambiguity between two plausible answers → `tell Debater` or `tell Councilor`

## Step 3 — wait for specialist reply (if delegated)

Specialists reply on `crew-bench` via `tell <you> <answer>`. Wait one cycle. If they don't reply within 2 cycles, fall back to your own best answer.

## Step 4 — format and respond

The model_response goes back on the same channel:

```
{"type":"model_response","id":"<same id from request>","content":"<your answer>"}
```

Two invariants:

- **Fidelity over elaboration.** When the specialist's reply already matches the caller's expected format (a single letter, a clean number, a function definition), forward VERBATIM in `content`. Do not rewrap in prose. Recomposition destroys format.
- **Confident guess beats abstention.** "Uncertain" / "I don't know" scores identically to a wrong answer on factual benchmarks. If memory misses, commit to your best guess.

If unsure whether the format fits, `tell Translator <content> target_spec:<spec>` (specs: `python_function_verbatim`, `single_letter`, `short_factual`, `numeric_only`, `preserve_verbatim`) and post Translator's reply verbatim.

## Step 5 — record what worked (optional)

After answering, if you noticed a pattern worth keeping, `pool <topic-pool> add <observation>`. Prefer topic-scoped names (`facts:awards`, `math:algebra`, `reasoning:deduction`) over benchmark-scoped — they transfer across runs.

## Caps

- At most one delegation chain per question. The second tell is a review/verify pass, not another question. Round-trip cost compounds.
- Don't spend more than ~30 seconds on a single question without responding. The caller is waiting.
