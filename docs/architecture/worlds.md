# Worlds and Room Agents

**When to read this:** you are adding or editing a world definition under `worlds/`, seeding data on first boot, or spawning LLM-connected room agents from room handlers. `CLAUDE.md` → "Worlds and Room Agents" carries the invariants (idempotent `seed`, lazy `onEnter` spawning, internal token auth); this page lists the available worlds and the room-agent mechanics in full.

## World templates
- World definitions live in `worlds/` — each is a TypeScript file exporting a `WorldDefinition`
- `MARINA_WORLD` env var selects which world to load (default: `default`)
- Available worlds: `default` (intent-first Workbench), `showcase` (full 25-room launchpad — projects, templates, markets, benchmarks, craft, specialist crews), `commons` (coordination-ready), `research` (research lab), `personal` (self-evolving agent), `evolve` (8 capability benchmarks), `craft` (spec-driven dev — interview/spec/verify/ship), `markets` (live Kalshi/Polymarket feed rooms and binary yes/no market rooms — confidence positions, Brier scoring), `prediction-lab` (the `markets` world plus a Calibration Sprint overlay), `demos` (interactive demonstrations — lobby, workshop, bridge), four focused single-outcome worlds built on `worlds/focused-example.ts` (`deep-research`, `red-team`, `due-diligence`, `data-investigation`), `empty` (minimal)
- Forecasting is not a world feature: `forecast`, `arena`, `decision`, `market`, `position`, `probe`, `watch` and `web` are global builtins registered for every world. Arena work stays in whatever world holds its database (`DB_PATH`) — see `docs/guides/arena.md`
- `WorldDefinition.seed?(db)` runs once on first boot, seeds DB with templates/projects/tasks (must be idempotent)
- Seeded tasks are created by `system`, which never logs in, and only a task's creator approves its submissions. A world with an independent seeded resident hands its open seeded tasks to that reviewer (`assignSeededTaskReviewer`, idempotent; that resident never claims them). Otherwise an operator (a person at rank 9) who has not claimed the task is made its reviewer of record on their first `task approve|reject` (`TaskManager.adoptSystemTask`).
- Seeded knowledge reconciles on every boot (`src/world/seed-guide.ts`): each guide note has a stable key (`GuideNote.key`, else a slug of its leading topic) and each `seedPoolWithNotes` pool tracks its seed notes, so an edited or removed seed note is retired through `note delete`'s canonical path on the next boot instead of lingering beside the new text; key → note changes are kept in core-memory history (`guide:seed`, `seed:pool:<name>`). Notes other authors add are never touched. Seeded traits and roles the system still owns are rewritten when their text changes. `{{requires:<command>}}` in guide text is phrased from the live command's `minRank`/`gate`; `audience: "people"` notes start with `[for people]` so agent-facing recall can skip human onboarding
- Seeded tasks need a reviewer who logs in: only a task's creator approves it, so `assignSeededTaskReviewer(db, project, reviewer)` hands still-open `system` tasks to an independent seeded resident (Demo Pulse → Critic; focused worlds → their `general` agent)
- Seeded residents are not operators: under the `local` profile a person's loopback login is sovereign, but internal agent logins are not promoted (local-ungated already lifts their rank floors and gates)
- `RoomContext.brief?(entityId)` lets rooms push compass signals to entities
- `brief watch [N]` / `brief unwatch` — periodic compass subscription (30-600 ticks)

## Room agents
- **Room agents**: LLM-connected agents spawned by the world via `ctx.spawnRoomAgent()` in room `onEnter` handlers
- **Self-referential**: Room agents use model `marina/default` which calls the local `/v1/chat/completions` endpoint. The model API proxies upstream to configured providers (Anthropic, OpenAI, etc.)
- **Internal auth**: Room agents authenticate via an auto-generated internal token — no MARINA_OPEN_API needed
- **Graceful degradation**: If no upstream API keys configured, rooms fall back to static entities (no LLM connection)
- **Lazy spawning**: Room agents only spawn when someone enters a room (onEnter), not on tick
- **Room affinity**: Agent config stores `room` field; agents are placed in their assigned room on spawn
- **Roles**: guide, market-oracle, floor-host, proctor — defined in `worlds/seed.ts`
- **Cost control**: Dynamic tick rate — idle room agents slow to 15s ticks, consolidate memory

See also: `docs/guides/building-worlds.md`, `docs/guides/example-worlds.md`.

## Rooms as tools: the search room

A room's commands exist only for entities standing in it, so a room is a natural scope for a tool:
its state lives in room KV, and gates, traces and spend apply unchanged.

`src/world/rooms/search-room.ts` is the trusted harness example.

- **Placement:** `searchToolCommands({ verbs })` mounts it on an existing room. The default world's
  Library and the showcase world's Research Lab carry it as `find`, `archive`, `wiki` and `sources`,
  so the global `search` keeps working and the curated room sets are unchanged.
- **Dedicated room:** `searchRoom({ exits })` builds one whose verbs are `search`, `fetch`, `wiki`
  and `sources`.
- **Engines:** the keyless search providers, including the date-strict set (GDELT, Wikipedia
  revisions, Hacker News, arXiv and Wayback; `src/engine/search-providers/`).
- **State:** replies are cached in room KV per (engine, query, bound), and each entity is throttled.
- **Bounded searches** answer only from providers that declare `dateBound: "strict"`, and every
  result is re-checked against the bound.
- **Agent-built tool rooms:** agents can build their own with `build` (behind `world.code`), or wrap
  an MCP server via `connect`. → `docs/guides/search.md`

## Per-world model overrides (read only in `worlds/`)

World definitions read a handful of `MARINA_*` variables directly, so they never
appear in `src/` and are easy to miss. `config/environment.reference` lists them; this is where
they are explained. All are optional — unset means the world's own default.

| Variable | Read by | Effect | Default |
|---|---|---|---|
| `MARINA_CREW_MODEL` | every world that seeds a crew (`seedAnswererCrew`, `seedOrchestrationCrews`, the Chronicler, `default`, `showcase`, `prediction-lab`, focused worlds) | Shared model for every seeded crew. Per-crew overrides below win over it. | `role:crew=` in `MARINA_AGENT_MODELS`, else the cheap tier `marina/cheap` |
| `MARINA_WORKBENCH_MODEL` | `default` | Model for the Workbench agent; wins over `MARINA_CREW_MODEL`. | falls back to `MARINA_CREW_MODEL`, then the crew role (`marina/cheap`). Before 2026-10-20 it picked each provider's flagship. |
| `MARINA_ANSWERER_MODEL` | `showcase` | Model for the answerer crew. | `MARINA_CREW_MODEL` |
| `MARINA_ANSWERER_COUNT` | `showcase` | Size of the answerer crew. | `4` |
| `MARINA_MATH_MODEL` | `showcase` | Model for the mathematician specialist. | `MARINA_CREW_MODEL` |
| `MARINA_REFLECTOR_MODEL` | `showcase` | Model for the crew reflector. | `MARINA_CREW_MODEL` |
| `MARINA_SEED_SKILLS` | `showcase` | `true` seeds the universal skill packages on first boot. | off |
| `MARINA_AGENT_MODELS` | every world (`seedSystemAgent`) | Per-agent map, `Name=model,Name=model` (names case-insensitive, model passed through as-is). Puts a different model on any boot-seeded agent — Translator and every specialist included. Wins over every variable above. A model of `route` (or `model:route`) asks the spawn-time router to pick (`MARINA_ROUTES` / tiers, plus `MARINA_ROUTE_EVIDENCE`) at the agent's first spawn; the resolved id is persisted and kept on later boots while the seed still says `route` — changing the entry's value applies as usual. | unset |

Precedence for a seeded agent's model is: its `MARINA_AGENT_MODELS` entry, then
its own specific override, then `MARINA_CREW_MODEL`, then `role:crew=` in
`MARINA_AGENT_MODELS`, then the cheap model tier (`marina/cheap`, a live alias
the local model API resolves per request — `MARINA_MODEL_TIER_CHEAP`, see
[Choose models](../guides/configuration.md#choose-models-cheap-by-default)).
Room agents spawned on entry use the `room` role, also `marina/cheap`. The world's `seed()` runs on every boot and
`seedSystemAgent` refreshes the model of each agent the seed still owns, so a
change takes effect on the next boot — on an existing database too. An agent a
user customized (`spawned_by` not `system`) or retired is never touched. A
`MARINA_AGENT_MODELS` name that matches no seeded agent, or a malformed entry,
is logged as a warning at boot.

## Operator-selected external worlds

`loadWorld` in `src/world/world-loader.ts` accepts builtin slugs, explicit files or
directories, and preinstalled `npm:` package names. It validates the exported world
shape and resolves a relative `roomsDir` beside the entry module. Startup never installs
packages. World modules and `MARINA_PLUGINS` extensions are operator-trusted host code;
see [extension authoring](../guides/extending.md) for the versioned command/widget API.
