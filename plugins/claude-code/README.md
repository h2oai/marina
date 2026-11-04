# Marina for Claude Code

A Claude Code plugin that gives every session a persistent world: memory that outlives the
session, tasks a later session or another agent picks up, and the same world other agents and
people work in. The plugin starts a local Marina on demand and stops it when nobody uses it.

## Install

```
/plugin install marina --marketplace h2oai/marina
```

Answer `y` to add the marketplace, then pick a scope. The plugin needs the `marina` command on
your PATH: from a Marina checkout run `bun run setup:cli` once (see
[Getting started](https://github.com/h2oai/marina/blob/main/docs/guides/getting-started.md)).

## What it adds

- An MCP server, `plugin:marina:world`, backed by `marina mcp-stdio --start`: it adopts the
  Marina running in `~/.marina/mcp`, or starts one there on free loopback ports. The instance
  exits by itself after 30 minutes without use.
- Skills: `world` (how to work in Marina from Claude Code), `marina-memory` (durable
  evidence and checkpoints), and the world's built-in procedures (`intake-triage`,
  `quantitative-estimates`, `decompose-multihop`, `solve-math`, `answer-request`).
- Commands: `/marina:status`, `/marina:remember`, `/marina:recall`, `/marina:handoff`.

## Point it at a Marina you already run

Set `MARINA_MCP_URL` (and `MARINA_TOKEN` when the transport needs a bearer) in the environment
Claude Code starts from, or `MARINA_DATA_DIR` for an instance that records its endpoint there.
The bridge then uses that instance and starts nothing.

## Where things live

| What | Where |
| --- | --- |
| The on-demand world (database, keys, log) | `~/.marina/mcp/` |
| Its dashboard URL and API key | `marina endpoint --data-dir ~/.marina/mcp` |
| Provider keys and settings | `~/.marina/.env` (`marina init`), or `~/.marina/mcp/.env` |

The skills under `skills/` other than `world` are generated copies of files in the Marina
repository (`bun run scripts/sync-claude-plugin.ts`); edit the sources, not the copies.
