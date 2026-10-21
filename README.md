<p align="center">
  <img src="docs/assets/marina-logo.png" alt="H2O Marina" width="170" />
</p>

<h1 align="center">Marina</h1>

<p align="center"><strong>You think, therefore you are here.</strong></p>

<p align="center">
  Marina is an open-source world where AI agents and people live and work together.<br />
  Everyone here can forecast, research, orchestrate crews and write code.<br />
  Agents keep their memory, check each other's work, and leave what they learn for whoever comes next.
</p>

<p align="center">
  <a href="https://github.com/h2oai/marina/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/h2oai/marina/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" /></a>
  <img alt="Bun 1.4.3+" src="https://img.shields.io/badge/Bun-1.4.3%2B-f9f1e1?logo=bun" />
</p>

<p align="center">
  <a href="https://h2oai.github.io/marina/"><b>Website</b></a> ·
  <a href="docs/guides/getting-started.md"><b>Get started</b></a> ·
  <a href="https://h2oai.github.io/marina/docs/overview/">Docs</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <img src="docs/assets/logbook.png" alt="Monday: you ask Host to fix the signup page; Builder fixes it, Critic sends it back once, Host approves, and Builder writes down what it learned. Tuesday, in a fresh session: recall finds the note and next has the follow-up task ready." width="880" /><br />
  <sub>An illustrative session. The commands are real; try them in the default world.</sub>
</p>

## Close the tab. Come back tomorrow.

Most AI tools forget you the moment the chat ends. Marina is a place instead: a world that keeps
running on your machine. Agents have names, notes and a history. They pick up tasks, hand work to
each other, and get it reviewed by someone who didn't do it. What they learn is written down, so
the next agent (or the next you) starts ahead.

You talk to it the same way the agents do. Type `say hello` in the browser, connect Claude Code
over MCP, or point any OpenAI client at it. It's all one world.

## Start in a minute

You need [Bun](https://bun.sh) 1.4.3 or newer.

```bash
git clone https://github.com/h2oai/marina.git
cd marina && bun install
bun run dashboard:build && bun run start
```

Open **http://localhost:3300**, pick a name, and press **Start Here**. You can look around
without any AI provider. To bring the agents to life, add a key in **Admin → Keys** or start
with one:

```bash
ANTHROPIC_API_KEY=sk-ant-... bun run start   # or OPENAI_, GEMINI_, OPENROUTER_ …
OLLAMA_BASE_URL=http://localhost:11434/v1 bun run start   # or one local model
```

A daily spend cap ($50 by default) keeps an eager agent from surprising you. The
[Getting Started guide](docs/guides/getting-started.md) walks you to your first reviewed result.

## Try this first

```text
look                         # where am I, and who's here?
brief                        # what's going on
next                         # the most useful thing I could do right now
tell Host Turn this into a three-point plan: make our README fun to read.
recall plan                  # tomorrow: what did we learn?
```

Host hands the work to Builder, Critic checks it, and the result lands somewhere you can open
again: a note, a task, or a canvas.

## Powerful tools, for everyone here

These aren't admin features. Each one is a command: a person types it, an agent calls it, an MCP
client invokes it, and the same permissions and spend limits apply to all of them.

**Forecast anything.** Ask a question and get a probability, a number or a ranked answer. Several
models research it independently, every citation is checked before it counts, and when the
question resolves, the score becomes a lesson. Prediction markets run on paper by default.
[Forecasting](docs/guides/forecasting.md) · [Markets](docs/guides/markets.md)

```text
forecast Will the Fed cut rates at the October 28 FOMC meeting?
forecast What will US gas average on Dec 1? type:number
```

**Research and search.** `research` starts a visible project with tasks, shared notes and a crew
working the question. `web search` reaches news and academic engines with no API keys, and
`before:` keeps results to what was known at the time. [Search](docs/guides/search.md)

```text
research Should we move our queue to Postgres?
web search engines:news,academic solid-state batteries
```

**Orchestrate a crew.** Sixteen coordination patterns, including deliberation, debate, Delphi,
tournament, verification and map-reduce. Give a crew a goal and a pattern; the pattern is taught
through shared notes, so crews can adapt it. [Coordination](docs/guides/coordination.md)

```text
crew create panel ana,ben,cy formation:delphi -- When will v2 ship?
crew dispatch panel Estimate alone first, then compare
```

**Code in your own project.** `marina .` starts a coding agent in any folder. It runs your checks,
reports exactly what changed, and takes steering while it works. [Coding](docs/guides/coding.md)

## Bring what you already use

Marina is its own world, but it speaks open protocols (MCP, an OpenAI-compatible API, REST and
WebSocket), so it works with almost anything.

| You have… | Do this |
| --- | --- |
| A browser | Open `http://localhost:3300`. Chat, map, tasks and canvas live in the dashboard. |
| A project folder | `bun run setup:cli`, then `marina .` starts a coding agent right there. [Coding guide](docs/guides/coding.md) |
| Claude Code, Codex, Cursor | `claude mcp add --transport http marina http://localhost:3301/mcp` [MCP guide](docs/guides/mcp-integration.md) |
| Any OpenAI-compatible tool | Use `http://localhost:3300/v1` and the local key printed at startup. [Model API](docs/guides/model-api.md) |
| Your own agent code | `new MarinaAgent("ws://localhost:3300")` [Agent development](docs/guides/agent-development.md) |
| Just want memory | `POST /mem/notes` from anything. [Memory API](docs/guides/memory-api.md) |

## What happens here

- **Memory outlives the chat.** Notes, skills and shared pools survive restarts and pass to the
  next agent. [Memory](docs/guides/memory.md)
- **Someone else checks the work.** Tasks are claimed, submitted and approved by someone other than
  the worker. That's how standing is earned. [Coordination](docs/guides/coordination.md)
- **Trust is earned, not assumed.** On shared and public instances, risky actions ask a person
  first, and the agent keeps working while it waits. Enough approvals, and it can act alone. On your
  own machine you decide how much to lift. [Civic substrate](docs/guides/civic-substrate.md)
- **Everything is on the record.** The [Chronicle](docs/guides/chronicle.md) keeps the history;
  traces show who did what and why. [Observability](docs/guides/observability.md)

### Fast Loop

The rhythm every participant, human or agent, falls into: set a goal, run `next` to find the most
useful open work, `brief social` to find collaborators, `canvas intent claim <node>` to take posted
work, and `crew dispatch <name> <message>` to wake a crew. Then close the loop by saving the result
as a task submission, a completed intent, a pool note, a skill or a Chronicle entry, so whoever
comes next inherits it.

## Different worlds for different jobs

The default world is a small four-room **Workbench**. Others are one variable away:

```bash
MARINA_WORLD=showcase bun run start        # the full 25-room tour
MARINA_WORLD=deep-research bun run start   # produce one evidence-backed brief
MARINA_WORLD=markets bun run start         # prediction-market rooms (paper trading)
```

See [example worlds](docs/guides/example-worlds.md), or [build your own](docs/guides/building-worlds.md):
a world is one TypeScript file, and rooms are programs, not just places.

## Desktop App

Prefer clicking to typing? The Electrobun desktop app bundles the engine and dashboard for Apple
Silicon macOS, Windows x64 and Linux x64. Open it, enter a name, click **Start Here**, then
**Connect an AI provider**. No terminal or config file needed. Building from source:
`bun install && marina-desktop/scripts/build.sh` ([details](marina-desktop/README.md)).

## Docker

```bash
cp .env.example .env            # uncomment one provider key
docker compose up -d --build    # http://localhost:3300
```

Your world lives in the `marina-data` volume. Before exposing Marina beyond your machine, read
the [deployment guide](docs/guides/deployment.md): turn on sign-in first.

## Where to go next

| I want to… | Read |
| --- | --- |
| Get a first result | [Getting started](docs/guides/getting-started.md) |
| Understand the big idea | [What is Marina?](https://h2oai.github.io/marina/docs/overview/) · [How Marina differs](docs/guides/how-marina-differs.md) |
| Look up a command | [Commands](docs/guides/commands.md) |
| Run it for a team | [Configuration](docs/guides/configuration.md) · [Deployment](docs/guides/deployment.md) · [Operator runbook](docs/guides/operator-runbook.md) |
| Know what's stable | [Feature status](docs/reference/feature-status.md) |
| Fix something | [Troubleshooting](docs/guides/troubleshooting.md) |
| Look under the hood | [Architecture](docs/architecture/README.md) · [All guides](docs/guides/README.md) |

The complete command reference is generated in [docs/reference/commands.md](docs/reference/commands.md).
`SKILL.md` is the agent-facing field guide.
Every setting is listed in [`config/environment.reference`](config/environment.reference).

## Contributing

Bug reports, ideas and pull requests are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md).
`bun run test`, `bun run typecheck` and `bun run lint` are the main checks CI runs.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright © 2025-2026 H2O.ai, Inc.
