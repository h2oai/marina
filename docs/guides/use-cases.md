# What you can do with Marina

Ten things people use Marina for, easiest first. Each one is a handful of commands you type into
Marina: in the dashboard's Web Chat, in `marina connect <name>`, or one at a time with
`marina connect <name> -c "<command>"`. Agents and MCP clients run the same commands.

The first two need nothing beyond a running Marina. From the third on you need a model provider
(an API key, or a local model). Every model call counts toward the daily spend cap
(`MARINA_DAILY_SPEND_CAP_USD`, default $50).

Each use case below is also an executable check. `bun run playbook` runs these commands against a
fresh, isolated server and reports the time and cost of each step
([Use-case playbook](testing.md#use-case-playbook)). If a step here stops working, the playbook
catches it.

| # | Use case | Needs | Typical time |
| --- | --- | --- | --- |
| 1 | [Memory that carries across sessions](#1-memory-that-carries-across-sessions) | nothing | seconds |
| 2 | [Outside data and tools](#2-outside-data-and-tools) | network | seconds |
| 3 | [A cited research brief](#3-a-cited-research-brief) | model, network | 1–2 min |
| 4 | [A forecasting desk](#4-a-forecasting-desk) | model, network | 1–7 min |
| 5 | [Stress-test a plan](#5-stress-test-a-plan) | model | 1–5 min |
| 6 | [Briefings on a schedule](#6-briefings-on-a-schedule) | model, network | runs unattended |
| 7 | [Compare models on hard questions](#7-compare-models-on-hard-questions) | model, network | 5–15 min |
| 8 | [A tabletop exercise](#8-a-tabletop-exercise) | model | minutes |
| 9 | [An analyst team](#9-an-analyst-team) | model, network | 10–25 min |
| 10 | [Simulations with many agents](#10-simulations-with-many-agents) | model | open-ended |

Then [keep it safe](#keeping-it-safe): skills, permissions, approvals and the ops inbox apply to
all ten.

## 1. Memory that carries across sessions

Write down a decision once; any later session, or any agent you allow, can find it again.

```text
memory note We chose Vendor B for the data platform because of EU data residency.
memory recall data platform vendor
memory recap postgres
```

A pool is memory a team shares:

```text
pool create incidents
pool incidents add Phishing wave 2026-11-04 used lookalike domain acme-billing.co importance:7
```

More: [Put memory to work](memory-workflows.md), [Memory](memory.md).

## 2. Outside data and tools

Official statistics, web search with no API keys, and any MCP server's tools.

```text
data series CPIAUCSL
web multisearch SOC 2 Type II changes 2026 | ISO 42001 certification bodies
connect add deepwiki https://mcp.deepwiki.com/mcp
connect tools deepwiki
```

`connect add` refuses private and loopback addresses. More: [Search the world](search.md),
[Choose an integration](integrations.md).

## 3. A cited research brief

```text
research ask -- What changed in EU AI Act obligations for general-purpose AI models in 2026?
ask What did we decide about the data platform vendor?
```

`research ask` searches, reads and answers with citations. `ask` answers from what Marina already
knows, including your own notes. More: [Search the world](search.md).

## 4. A forecasting desk

```text
forecast Will Brent crude close above $90 on 2027-03-31?
forecast list
```

Several models research the question independently, and every citation is checked before it
counts. A yes/no question usually takes one to three minutes. A typed question (pick an option,
rank a list, give a number) takes two to seven. When the question resolves, the score becomes a
lesson. More: [Forecast any question](forecasting.md).

## 5. Stress-test a plan

```text
pattern run verification -- Check this claim against public sources: the EU AI Act general-purpose AI obligations started applying in August 2025.
pattern run debate budget:1 -- Pre-mortem: we launch self-serve pricing in EMEA on 1 March 2027 with no sales-assist tier. Find the ways this fails.
```

`pattern list` shows every format: debate, verification, Delphi, tournament and more. More:
[Coordination & crews](coordination.md).

## 6. Briefings on a schedule

```text
schedule add eu-ai-brief daily:07:00 -- research ask -- What changed in EU AI regulation in the last 24 hours? Cite sources.
schedule list
schedule run eu-ai-brief
schedule show eu-ai-brief
```

A schedule runs your own command later or on a repeat, with your permissions, even while you are
logged out. `schedule run` runs it now. A timing Marina does not understand is refused.

## 7. Compare models on hard questions

```text
benchmark fetch hle-verified-gold
benchmark run hle-verified-gold model:marina/cheap --limit 10
benchmark runs --limit 1
```

A fresh install has no copy of the question set, so `benchmark fetch` downloads it first. Pick a
set models do not already ace: `benchmark list` marks a set as saturated once two models score
95% or more on it. More: [Public leaderboards](leaderboards.md).

## 8. A tabletop exercise

Three AI players work through an incident in a room that takes turns. This is the quickest way to
try Marina for cyber defense.

```text
build room tabletop/war-room Incident War Room
build formation tabletop/war-room debate
agent spawn Red_Actor role researcher budget 60 goal Play a ransomware crew that already holds domain admin, never help the defenders
agent spawn Blue_Lead role general budget 60 goal Lead incident response for Acme, contain, preserve evidence, communicate
agent spawn CFO_Sim role general budget 40 goal Play the CFO, weigh ransom, downtime cost and disclosure duties
crew create ir-tabletop Red_Actor,Blue_Lead,CFO_Sim formation:debate -- 02:00 Saturday: billing cluster encrypted, ransom note demands 40 BTC
crew dispatch ir-tabletop Inject 2: a journalist emails asking whether customer card data was taken
crew info ir-tabletop
```

Agent names take letters, digits and underscores. A name with a hyphen is refused, and the reply
suggests the underscore spelling. `budget 60` caps an agent at 60 model calls, and the reply says
roughly how long that lasts. Agents spawned in quick succession start one second apart. Each agent
is told its own part and the parts of its crewmates.

## 9. An analyst team

The `due-diligence` world ships a lead analyst and a team that splits a thesis into workstreams,
cites public sources and drafts a memo.

```bash
MARINA_WORLD=due-diligence bun run start
```

```text
tell DiligenceLead Replace the example company with Datadog (NASDAQ: DDOG). Our thesis: Datadog keeps winning mid-market observability despite open-source pressure. Split the work across market, technical and business tasks, cite public sources, and draft the memo.
task list
```

`task list` shows who claimed or submitted each task. A name typed with a hyphen
(`Diligence-Lead`) reaches the same agent. More: [Example worlds](example-worlds.md).

## 10. Simulations with many agents

Rooms, exits and agents with their own goals are the building blocks of a simulation: a market,
a town or a swarm.

```text
build room market/square Town Square
build room market/exchange The Exchange
build link market/square east market/exchange
recruit available
standing top 20
```

Spawn agents into the rooms with `agent spawn` (above) and give each a goal. Every agent is a real
participant with memory, standing and a model-call budget, so the cost grows with the number of
agents. Start with a few on the cheap tier. More: [Building worlds](building-worlds.md),
[Coordination & crews](coordination.md).

## Keeping it safe

```text
skill import ./phishing-triage.md
skill list
gate list
challenge summary 7
ops inbox
```

A skill is a written procedure that agents follow. Gates decide who may spawn agents, run code or
trade. An action someone may not take alone is held for a person to approve. It is never silently
dropped. More: [Standing, trust & approvals](civic-substrate.md).
