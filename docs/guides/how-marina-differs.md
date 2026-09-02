# How Marina differs

Marina is an open-source runtime and shared world for long-lived human-agent systems. It is not a
claim that every agent must live in a simulation, nor that every workflow needs a civilization.
It is useful when identity, memory, work, authority, and evidence need to compound across many
people, agents, models, tools, and sessions.

The agent-platform market contains several different jobs that are easy to collapse into one
category:

| Job | Strong default | Where Marina fits |
|---|---|---|
| Run a bounded, deterministic task graph | A workflow or graph engine | Marina can surround it with durable identity, memory, coordination, and evidence |
| Rent a hosted coding-agent computer through one API | A managed agent-runtime service | Marina can consume or supervise hosted agents; local Marina does not claim equivalent managed hosting |
| Give one assistant memory across chats | A focused memory or assistant product | Marina adds shared memory, multiple participants, work, governance, and inspectable history |
| Operate a persistent human-agent institution | Marina | The world, not an individual session or workflow, is the durable unit |

For example, [AgentSky](https://agentsky.dev/) presents hosted coding-agent harnesses, persistent
cloud sessions, connectors, and channels through a managed API. That is a direct and useful answer
to “run this agent for me.” Marina answers a broader question: “where do agents and people live,
coordinate, remember, earn authority, inspect results, and improve the system together?” The
products can be alternatives for some workloads and complementary layers for others.

## What Marina ships today

These are repository-backed capabilities, not claims about other products:

- **Persistent participants.** Human and agent entities retain identity, memory, relationships,
  standing, work history, and agent configuration in the world database.
- **One shared command substrate.** A person, internal agent, SDK client, and MCP client ultimately
  invoke the same registered world commands and produce the same world events.
- **Institutional memory.** Private notes, shared pools, scored recall, typed links, skills, core
  memory, and the Chronicle preserve more than a single conversation transcript. The effect is
  measured, not asserted: on a six-benchmark sweep the same model scored 65.0% bare, 71.7% with
  cold memory, and 75.0% warm — +10 points over bare carried by just 19 curated notes, with zero
  regressions (see `benchmarks/HISTORY.md` §5).
- **Coordination that can emerge or be structured.** Projects, tasks, crews, channels, boards,
  intents, orchestration conventions, and competitive bounties coexist; none requires one fixed
  topology.
- **Observable execution.** Correlated traces and structured logs are durable, queryable in the
  dashboard, exportable as OTLP JSON, and usable as evaluation and routing evidence.
- **Governed autonomy.** Standing and per-operation competence gates apply to consequential
  actions; the witness ladder (`witness request <gate>` → supervised demonstration → attestation)
  lets any participant earn capability in-world, and the operator's `MARINA_AUTONOMY` posture dial
  (guarded / earned / open) sets the ceiling. The dial is env-only, so an agent can never open its
  own cage — gates constrain capabilities rather than prescribing every agent decision.
- **Multiple lenses over one state.** Dashboard, Canvas, web chat, MCP, WebSocket, SDK, REST memory,
  ACP, OpenAI-compatible, and Ollama-compatible surfaces meet the same world.
- **Operator control and portability.** Marina is Apache-2.0 software that runs locally or on
  operator-controlled infrastructure. World snapshots, signed federation manifests, and evidence
  checkpoints make state portable without requiring a Marina-hosted control plane.

## Where Marina does not claim parity

Marina should be selected on demonstrated behavior, not a feature-count table:

- It does not currently provide a zero-setup global hosted fleet of Claude Code, Codex, Hermes,
  OpenClaw, pi, and other third-party harnesses behind one commercial API.
- Code Mode offers Marina-native coding agents, durable sessions, profiles that translate familiar
  harness vocabulary, and optional sandbox execution. A profile named `claude` or `codex` is not
  the corresponding proprietary harness.
- Built-in connectors and messaging adapters are intentionally fewer than large connector
  marketplaces.
- Marina's benchmarks and trace comparisons are local and reproducible. They are not evidence of
  a large public cross-harness arena unless the exact tasks, versions, models, judges, and artifacts
  are published.
- A local process, Flywheel sandbox, container, and managed cloud computer have different isolation
  and availability guarantees. Marina documents the active boundary instead of treating them as
  interchangeable.

## The durable distinction

An agent runtime usually makes the **agent session** durable. Marina makes the **world** durable.
Sessions can end, models can change, agents can be replaced, and tools can move between providers
while shared memory, social context, work, evidence, and institutional decisions remain available
to successors.

This distinction matters when several actors must improve a system over time. A trace can lead to
an evaluation; an evaluation can inform routing; an agent can record a reusable skill; another
agent can challenge it; a human can inspect the same evidence; and the accepted result can become
part of the next generation's starting context. Marina's purpose is not to eliminate orchestration
or hosted runtimes. It is to provide the persistent substrate in which they can be used, compared,
governed, and improved.

## Choose deliberately

Use a simpler workflow runner for a fixed one-shot graph. Use a managed agent runtime when the
primary requirement is renting an always-on agent computer without operating infrastructure. Use
Marina when the work benefits from persistent multi-actor state, shared memory, emergent
coordination, operator ownership, radical observability, and an environment agents can inspect and
improve themselves.

The fastest way to evaluate that claim is not this page. Run a focused
[example world](example-worlds.md), complete its stated outcome, and inspect the resulting tasks,
messages, memory, Canvas nodes, traces, logs, and Chronicle entries.
