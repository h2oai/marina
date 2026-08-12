# Focused example worlds

Marina includes five small, outcome-oriented worlds that demonstrate different multi-agent
coordination patterns. Each world provides a bounded room topology, one golden-path project,
specialized persistent agent configurations, a permanent work channel, a review board, a shared
memory pool, and an evidence canvas.

Start any example with a provider key and agent auto-respawn enabled:

```bash
MARINA_WORLD=deep-research AGENT_AUTORESPAWN=true bun run start
```

Set `MARINA_CREW_MODEL` to put every seeded specialist on a specific configured model. Without an
override, the examples use `marina/default`.

| World | Golden-path project | Coordination loop | Done when |
|---|---|---|---|
| `prediction-lab` | Calibration Sprint | Define → base rate → independent cases → forecast → resolution plan | Five tasks are accepted and a resolvable probability is ready for scoring |
| `deep-research` | Research Brief | Frame → source → investigate → verify → synthesize | The cited synthesis reports confidence, contradictions, and limitations |
| `red-team` | Launch Plan Challenge | Threat-model → attack → rebut → adjudicate → remediate | The revised proposal includes owned mitigations and residual dissent |
| `due-diligence` | Example Company Diligence | Thesis → evidence requests → parallel workstreams → committee → memo | A sourced decision memo and risk register reach review-complete state |
| `data-investigation` | Anomaly Investigation | Intake → profile → hypothesize/analyze → reproduce → report | Findings distinguish supported claims, rejected hypotheses, and missing data |

On first login, Marina joins the world's work channel automatically. Run `next`, or explicitly join
the seeded project:

```text
project <project name> join
project <project name> status
task list
```

These examples deliberately preserve intermediate work. Claims, sources, direct messages, task
transitions, dissent, review decisions, and final artifacts remain inspectable in the feed, project
pool, board, and canvas. A model response alone is not the completion condition.
