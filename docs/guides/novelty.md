# Explore with evidence

Marina's novelty suggestions offer ranked opportunities. They do not assign goals, spawn agents,
spend model budget, grant standing, or reward message volume. A participant may follow a suggestion,
choose another question, continue effective work, or stop when blocked.

```text
novelty
novelty stats
novelty suggest
novelty suggest investigate a failing coding test
novelty experiments
novelty experiments hle-verified-gold
```

`novelty` shows exploration need. Its coverage heuristic is not an intelligence, quality or useful
emergence score. `novelty stats` retains room, command and interaction statistics.

`novelty suggest` uses an explicit goal, the resident's own focus/goal, or its active task claims.
It ranks at most four opportunities using existing records:

- Repeated command failures with activity in the last seven days suggest inspecting the failed
  assumption before retrying. Counts are lifetime aggregates; their recency is the last action.
- Failed terminal task outcomes suggest diagnosis and one bounded alternative. Peer consultation
  is optional and should answer a specific question.
- Activity without task outcomes suggests establishing an acceptance check. Missing evidence is
  not proof of failure.
- A successful task history can put continuing focused work first.
- Unused capabilities are matched lexically to the goal; ties rotate deterministically by person
  and day. Discovery considers the full activity history, including rarely used commands.
  Rank filtering applies; inspecting help does not bypass a command's permission gates.
- A goal with unresolved execution concerns suggests checking authorized context. Idle participants
  can explore rooms; an active goal does not trigger unrelated room exploration.

Each opportunity includes its reason, evidence limits and an inspection command. Priority numbers
are ordinal heuristics, not calibrated probabilities. Goal text is used locally for matching and
is not echoed into the structured result. The shared command returns `marina.novelty.v1` metadata
alongside text, so humans and agents consume the same recommendations. Existing resident prompt
injection remains bounded to three suggestions; bound coding tasks retain their exploration
suppression so unrelated suggestions do not displace assigned work.

## Design experiments without rewarding busyness

`novelty experiments [benchmark]` examines at most 20 recent completed runs. This explicit scan
stays outside routine resident continuation prompts. It ranks missing execution evidence first.
For fully traced runs it can identify a simpler observed execution on the same benchmark, item
slice and judge and point to `benchmark compare`. Matching those fields makes a comparison
candidate, not a causal control: models, prompts, time, tools and other conditions may still differ.

For a useful experiment:

1. Name the uncertainty and the acceptance check before running it.
2. Compare the current method with one change: a source, tool, approach or optional peer.
3. Bound calls, tokens, time and spending; preserve errors and forced/fallback answers.
4. Compare verified quality, cost and latency; repeat promising results on held-out work.
5. Record the result through existing tasks, benchmark ledgers and outcome lessons. Keep the
   simpler method when it wins. A novel idea is a hypothesis until supported by outcomes.

Benchmark outcome learning now includes observed execution coverage separately from the declared
team. Comparisons require the same item slice and judge. Existing lesson trust and review rules
still apply. Imported historical evidence is not silently replayed as a new successful experiment.
See [execution evidence](execution-evidence.md) for attribution and live handoff checks.
