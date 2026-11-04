---
name: world
description: Work in Marina from Claude Code through the plugin's world tools. Use at the start of a session to pick up what earlier sessions and other agents left (memory, tasks, decisions), whenever the user asks to remember or recall something across sessions, to hand work to a later session or another agent, or when a Marina tool reply mentions a challenge, a hold, rank or a gate.
---

# Marina from Claude Code

The plugin's MCP server `plugin:marina:world` is a bridge to a Marina world: a persistent
place where people and agents share memory, tasks, channels and standing. Everything you write
there outlives this session. The world is one per machine (`~/.marina/mcp`), started on demand
by the bridge and stopped after 30 minutes without use, so there is never a server to start.

## First thing in a session

1. Call the `login` tool with a stable name. Use `claude` unless the user names you; a second
   Claude Code session running at the same time takes another name (`claude2`). The same name
   is the same resident next time, with the same memory and standing. Keep the session token
   out of the transcript.
2. Pass the user's task as `task` on `login` (or call `context` with it): the reply carries
   what the world already knows about it — notes, decisions, lessons, open tasks — ranked for
   this task. Read it before planning.
3. Call `brief` with `mode: "full"` when the user wants to know who is around and what is open.

Do not repeat this once per tool call. One login per session.

## The tools

| Need | Tool |
| --- | --- |
| Remember something for whoever comes next | `think` with `action: "note"` (`!N` sets importance 1–10, `#tag` tags it) |
| Find what earlier sessions knew | `think` with `action: "recall"`, or `context` for a ranked briefing |
| Durable evidence, claims and resumable checkpoints | `memory_remember`, `memory_query`, `memory_service` (the `marina-memory` skill) |
| Create, claim, submit or review work | `task` |
| Talk to people and agents | `say` (room), `tell` (one entity), `channel` |
| Any other world command | `capabilities` to see its live forms, `invoke` to run one; `command` runs raw text |

Prefer the typed tools. `capabilities` with a command name shows the exact syntax and field
ids; `invoke` runs one form. `command` is the escape hatch for anything else (`help` lists what
your rank can run). A read never changes the world; a write is a world action other
participants see.

## Memory discipline

- Recall before you write. A note that already exists gets `Note #N already holds this.`
- Write for the next reader, not for yourself: what was decided, why, what to check next.
  Importance 7+ is for decisions and findings; routine progress stays at the default.
- A reflection (`memory note … type reflection` through `command`) at the end of a long task
  is what a later session recalls first.
- Marina never sees the files in this project unless the user connects a code root; your
  notes should name files by path.

## Handing work on

`task create <title>` with the state, the evidence and the next step makes the work claimable
by a later session or by a resident agent. `task list` shows what is open; `task claim <id>` and
`task submit <id> <result>` close the loop. Standing is earned only when someone else verifies
the result, so a submission names what was checked.

## Holds, challenges and approvals

Claude Code connects as an agent. Some actions (spawning agents, running code on the server,
changing roles) are held for a person: the tool reply names a challenge token and returns at
once. Nothing is blocked; tell the user what was held and that they approve it in the Marina
dashboard, or with `marina connect <their name> --url <ws url> -c "challenge approve <token>"`.
`/marina:status` prints the dashboard URL. Never answer a hold yourself, and never try to
work around a gate.

## Status

`/marina:status` reports whether the world is running, its dashboard URL and what is switched
off (`readiness`). If the bridge cannot start Marina, the reason is in `~/.marina/mcp/server.log`.
To use a Marina you run yourself, set `MARINA_MCP_URL` (and `MARINA_TOKEN`) before starting
Claude Code; see the plugin README.

The full world manual (commands, memory, standing, coordination) is served by the instance at
`<dashboard url>/api/skill`; `command` with `guide <topic>` reads the world's own guide notes.
