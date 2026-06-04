# Command-Native Interfaces Spec

## Purpose

Marina should support many alternate interfaces without creating a parallel app
framework. A Google-like search box, a Perplexity-like answer page, a dashboard
panel, an MCP client, a Discord bot, and an in-world terminal should all enter
through the same durable substrate: the command language, dynamic commands,
macros, memory, rooms, agents, and events.

The goal is a persistent civilization with few primitives and excellent
composability. New capabilities should be defined as words over existing words
first, then promoted into TypeScript only when usage, performance, safety, or
cross-world stability justify it.

## Core Principle

Primitives are durable. Words are recombinant. Renderers are provisional.

Marina should prefer:

```text
interface -> command word -> existing primitives -> memory/events/artifacts
```

over:

```text
interface -> bespoke app service -> separate state model
```

The system should optimize at the word level. A useful word can be discovered,
benchmarked, improved, shared, remembered, rendered differently, and reused by
humans, lean agents, frontier agents, MCP clients, OpenAI-compatible clients,
WebSocket users, and dashboard panels.

## Definitions

- **Primitive**: A core built-in command or state facility such as `memory`,
  `note`, `recall`, `pool`, `task`, `project`, `channel`, `board`, `agent`,
  `web`, `canvas`, `macro`, `build`, `skill`, and rooms.
- **Word**: A named capability expressed as a built-in command, dynamic command,
  macro, skill-backed command, room command, or world-seeded convention.
- **Renderer**: Any presentation of command results: terminal text, web cards,
  MCP text, OpenAI chat output, dashboard panels, canvas nodes, or feed entries.
- **Lean agent**: A low-context, efficient agent that depends on world memory,
  `brief`, `next`, `help`, and focused command affordances rather than large
  prompts.
- **Frontier agent**: A stronger agent used to improve the world for future
  agents by compressing memory, authoring skills, creating macros, running
  benchmarks, and designing better rooms.

## Non-Goals

- Do not add a separate `src/apps/*` abstraction as the primary model.
- Do not create one bespoke API per product interface unless it is a thin
  renderer or launch surface over commands.
- Do not put the world into every agent prompt.
- Do not make dashboard/UI state authoritative over world state.
- Do not add primitives for capabilities that can be expressed as dynamic
  commands, macros, skills, or room commands.

## Target Architecture

All access paths should converge on command execution:

```text
Web search UI
Perplexity-like answer page
Dashboard panel
MCP tool
OpenAI-compatible route
Telnet
WebSocket
Discord / Telegram
In-world user
Autonomous agent

        -> command / macro / dynamic command
        -> existing Marina primitives
        -> perceptions, events, memories, tasks, notes, pools, canvas artifacts
        -> renderer-specific presentation
```

The same word should be re-entrant:

```text
ask "What changed in AI regulation?"
research "battery recycling supply chain"
forecast "Will X happen by Q4?"
briefing "weekly climate tech"
ship "implement command execution HTTP route"
```

Each of these should be callable from the world, from an external UI, and from
agents. Each should leave useful traces in the world when appropriate.

## Promotion Path

New capabilities should move down this ladder only when needed:

1. **Guide note or skill**: Teach agents/humans a pattern.
2. **Macro**: Compose existing commands as a named word.
3. **Dynamic command**: Add branching, structured output, or richer command
   context while staying world-native.
4. **Room command**: Localize behavior inside an executable TypeScript room.
5. **Built-in command**: Promote only hot, universal, security-sensitive, or
   performance-sensitive words.

Promotion criteria:

- used across multiple worlds or interfaces
- difficult to express safely as a macro/dynamic command
- needs stronger validation or permission checks
- appears in benchmarks or critical workflows
- improves prompt/context efficiency for many agents

## Interface Contract

Alternate frontends should not own behavior. They should launch words and render
results.

Minimum command execution contract:

```ts
interface CommandRequest {
  name?: string;
  token?: string;
  command: string;
  render?: "text" | "markdown" | "structured";
  sessionId?: string;
}

interface CommandResponse {
  entityId: string;
  sessionId?: string;
  perceptions: unknown[];
  events?: unknown[];
  text?: string;
}
```

This can start as a narrow HTTP route over the existing engine command path. It
should not bypass command parsing, permissions, rate limits, memory writes, or
events.

Existing access paths already close much of the gap:

- WebSocket clients can send raw commands.
- MCP exposes a generic `command` tool.
- Agents can run any command via tools.
- The dashboard command bar sends raw commands.
- Dynamic commands and macros are already persisted.

The missing piece is a clean, documented, access-agnostic command execution API
for alternate web surfaces that do not want to open a full game WebSocket.

## Renderer Hints

Renderers should use existing perceptions/events first. If additional structure
is needed, prefer lightweight tags or conventions over new state models.

Useful tags/conventions:

```text
answer
citation
source
trace
artifact
warning
followup
task
memory
```

Commands can emit ordinary text for terminal users while also logging events,
creating notes, publishing canvas nodes, or returning structured metadata for
web renderers.

## Prompt Budget Policy

Marina should keep investing in memory rather than prompt bloat.

The world remembers. The agent samples.

Lean agents should receive:

- identity
- current goal
- current task or room
- a few relevant words
- one or two relevant memories
- one suggested next action

Frontier agents may receive larger working sets, but their highest-value job is
to reduce future context load:

- consolidate memories
- write sharper skills
- create macros from repeated workflows
- run benchmarks
- discover failure patterns
- author TypeScript rooms as learning environments
- improve guide notes
- decompose work for lean agents

Every proposed prompt addition should be challenged:

```text
Can this be a memory?
Can this be a skill?
Can this be a macro?
Can this be discovered by help?
Can this be retrieved by brief, next, or recall only when relevant?
```

## Room Strategy

Rooms are executable TypeScript and should be treated as learning environments,
not just places.

Examples:

- `bench/arena`: benchmark and compare capabilities
- `memory/vault`: learn recall and consolidation
- `craft/forge`: create macros, dynamic commands, room code, skills
- `research/lab`: gather sources and synthesize
- `eval/chamber`: evaluate answers and detect regressions
- `integration/bay`: learn connectors and external tools
- `debug/room`: inspect failures and events

Agents should be able to go somewhere to learn. That keeps knowledge spatial,
discoverable, executable, and outside the prompt.

## Cleanup Findings

This repository scan found several cleanup categories.

### 1. Unused symbols

Running:

```bash
bunx tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false
```

found unused imports, variables, and types in production files. These are low
risk cleanup targets and should be fixed before enabling `noUnusedLocals` in
`tsconfig.json`.

Production examples:

- `src/engine/commands/admin.ts`: unused `EntityId`
- `src/engine/commands/agent.ts`: unused `spawner`
- `src/engine/commands/board.ts`: unused `posts`
- `src/engine/commands/build.ts`: unused `entity`
- `src/engine/commands/canvas.ts`: unused `findCanvasForNodes`
- `src/engine/commands/pool.ts`: unused `fmtScore`
- `src/engine/commands/rank.ts`: unused `rankName`
- `src/engine/commands/run.ts`: unused `header`, `separator`
- `src/engine/commands/scenario.ts`: unused `db`
- `src/engine/commands/skill.ts`: several unused formatter imports
- `src/engine/commands/usecase.ts`: unused `TemplateNote`
- `src/engine/engine.ts`: unused `CommandDef`, `CommandInput`
- `src/engine/search-providers/academic.ts`: unused `ArxivEntry`
- `src/engine/shell-runtime.ts`: unused `basename`, `resolve`
- `src/net/acp-server.ts`: unused `running`
- `src/net/adapter-manager.ts`: unused constructor field `db`
- `src/net/canvas-ws.ts`: unused `CanvasWSData`
- `src/net/discord-adapter.ts`: unused `EntityId`, `token`
- `src/net/mem-api.ts`: unused row type imports
- `src/net/polymarket-client.ts`: unused `DEFAULT_CLOB_BASE`
- `src/net/telegram-adapter.ts`: unused imports
- `src/net/websocket-server.ts`: unused `EntityId`, `GATEWAY_AUTH_TIMEOUT_MS`

Acceptance criterion:

```bash
bunx tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false
```

should report no production-file errors. Test-file cleanup can follow
separately.

### 2. Dashboard/canvas route duplication

`docs/canvas-map-implementation.md` says the unified canvas-map exists, but
classic `/dashboard`, standalone `/canvas`, and `?unified` routing still coexist.
This is an intentional transition state, but it is now a source of UI
proliferation.

Relevant files:

- `dashboard/src/main.tsx`
- `dashboard/src/App.tsx`
- `dashboard/src/canvas/CanvasPage.tsx`
- `dashboard/src/unified/UnifiedCanvas.tsx`
- `src/net/websocket-server.ts`

Decision needed:

- promote unified canvas as default, or
- explicitly keep classic dashboard and standalone canvas as supported renderers.

Acceptance criterion:

- one documented default route
- one documented compatibility route policy
- stale components either removed or marked as supported compatibility surfaces

### 3. Tool profile regression debt

`src/agent/agent-runtime.ts` currently forces all agent tool profiles to `full`
because `crew` and `minimal` profiles caused specialists to stop replying
reliably. This preserves quality but works against lean-agent prompt budgets.

Acceptance criterion:

- benchmark `full`, `crew`, and `minimal` profiles against at least retrieval,
  coordination, and task completion workflows
- define a new lean profile that keeps typed coordination tools such as `tell`,
  `channel`, and `pool`
- make profile selection data-driven or role-driven only after benchmarks pass

### 4. Legacy compatibility surfaces

Some compatibility paths are legitimate product surfaces, not dead code:

- OpenAI-compatible `/v1/*`
- Ollama-compatible endpoints
- compat profiles in `src/net/compat-profiles.ts`
- legacy note syntax such as `!N` and `#type`
- session token migration in dashboard local storage

These should be explicitly classified as supported compatibility surfaces or
scheduled for removal. Compatibility should not silently become architecture.

Acceptance criterion:

- create a compatibility policy doc section
- each legacy path is marked `supported`, `transitional`, or `remove after date`

### 5. Removed room modes still represented as macros

`worlds/default.ts` says mode rooms were removed and replaced by guide notes and
macros. This matches the command-native direction. The cleanup task is to ensure
docs and UI do not treat removed rooms as first-class places.

Acceptance criterion:

- mode references point to macros/guide notes
- no stale navigation paths to deleted mode rooms

## Concrete Goals

### Current Implementation Status

- `ask` exists as a built-in word. It gathers relevant personal memory,
  guide/shared-pool context, world search hits, and related tasks.
- `POST /api/command` executes a raw world command through a short-lived normal
  entity connection and returns captured perceptions plus rendered text.
- `POST /api/ask` is a convenience wrapper over `ask <query>`.
- `/ask` is a minimal static renderer over `POST /api/ask`.
- Focused tests cover name-based sessions, token reconnect/rotation, and the
  `/api/ask` wrapper.

### Goal 1: Establish command-native interface contract

Deliverables:

- add a documented HTTP command execution route, or document why WebSocket/MCP
  are sufficient for first alternate UI
- ensure route uses normal engine login/auth/reconnect and `processCommand`
- return perceptions in a renderer-friendly shape
- add tests for auth, command execution, permissions, and perception capture

Suggested route:

```text
POST /api/command
```

### Goal 2: Seed one product-shaped word

Deliverables:

- implement `ask` as a macro or dynamic command first
- make it callable from terminal, MCP generic command, WebSocket, and the new
  HTTP command route
- store useful result artifacts in notes or pools when appropriate
- do not create a new primitive unless `ask` proves it needs one

Initial `ask` behavior can be modest:

```text
brief ; recall <query> ; pool guide recall <query>
```

Then evolve it with web search, source capture, reflection, and renderer tags.

### Goal 3: Build a minimal alternate frontend as a renderer

Deliverables:

- add a simple `/ask` route or standalone Vite entry
- one input box
- sends `ask <query>` through command execution
- renders text/perceptions cleanly
- optional expandable trace

Non-goal:

- no custom ask state model
- no separate ask service

### Goal 4: Lean-agent prompt budget reduction

Deliverables:

- benchmark current full profile against candidate lean profile
- preserve typed coordination tools in lean profile
- move strategic tool-use hints into retrievable skills/guide notes where
  possible
- measure context/token reduction and task success

### Goal 5: Dead/deprecated cleanup pass

Deliverables:

- remove unused production symbols from the `tsc --noUnused*` report
- decide route policy for classic dashboard/canvas/unified canvas
- classify compatibility surfaces
- update docs to match actual supported surfaces

## Milestones

### Milestone A: Hygiene baseline

- production unused-symbol errors fixed
- normal `bun run typecheck` still passes
- `bun test` still passes, or failures documented

### Milestone B: Command execution API

- `POST /api/command` or equivalent implemented
- test coverage for command execution and auth
- no separate app primitive introduced

### Milestone C: First renderer

- `/ask` or equivalent minimal UI implemented
- UI executes `ask <query>`
- UI can show command output and trace

### Milestone D: Word evolution loop

- `ask` exists as macro/dynamic command
- frontier agent can inspect, improve, benchmark, or replace it
- lean agent can use it with low context

### Milestone E: Prompt-budget benchmark

- full vs lean tool profile evaluated
- regression from previous minimal/crew attempt addressed
- profile policy documented

## Open Questions

- Should `/api/command` create anonymous temporary entities, require dashboard
  auth, or require explicit session tokens?
- Should command responses include only perceptions, or also selected engine
  events produced during the command?
- Should renderer tags be encoded in perception `tag`, event payloads, or
  textual conventions?
- Should `ask` be seeded as a system macro in `worlds/default.ts`, a dynamic
  command in the DB seed, or a built-in only after benchmarking?
- Is unified canvas intended to replace classic dashboard, or remain an
  alternate operator renderer?

## Decision Record

Current recommendation:

1. Keep primitives small.
2. Treat alternate frontends as renderers over words.
3. Use macros and dynamic commands as the app layer.
4. Add only a generic command execution HTTP route if needed for web renderers.
5. Use frontier agents to improve vocabulary, memory, skills, rooms, and
   benchmarks for future lean agents.
6. Clean deprecated and unused surfaces before adding new product UI layers.
