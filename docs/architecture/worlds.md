# Worlds and Room Agents

**When to read this:** you are adding or editing a world definition under `worlds/`, seeding data on first boot, or spawning LLM-connected room agents from room handlers. `CLAUDE.md` → "Worlds and Room Agents" carries the invariants (idempotent `seed`, lazy `onEnter` spawning, internal token auth); this page lists the available worlds and the room-agent mechanics in full.

## World templates
- World definitions live in `worlds/` — each is a TypeScript file exporting a `WorldDefinition`
- `MARINA_WORLD` env var selects which world to load (default: `default`)
- Available worlds: `default` (intent-first Workbench), `showcase` (full 25-room launchpad — projects, templates, markets, benchmarks, craft, specialist crews), `commons` (coordination-ready), `research` (research lab), `personal` (self-evolving agent), `evolve` (8 capability benchmarks), `craft` (spec-driven dev — interview/spec/verify/ship), `markets` (prediction markets — confidence forecasting, Brier scoring, research-driven positions), `demos` (interactive demonstrations — lobby, workshop, bridge), five focused single-outcome worlds built on `worlds/focused-example.ts` (`prediction-lab`, `deep-research`, `red-team`, `due-diligence`, `data-investigation`), `empty` (minimal)
- `WorldDefinition.seed?(db)` runs once on first boot, seeds DB with templates/projects/tasks (must be idempotent)
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

## Per-world model overrides (read only in `worlds/`)

World definitions read a handful of `MARINA_*` variables directly, so they never
appear in `src/` and are easy to miss. `.env.example` lists them; this is where
they are explained. All are optional — unset means the world's own default.

| Variable | Read by | Effect | Default |
|---|---|---|---|
| `MARINA_CREW_MODEL` | `default`, `showcase`, focused worlds | Shared model for every seeded crew. Per-crew overrides below win over it. | `marina/default` |
| `MARINA_WORKBENCH_MODEL` | `default` | Model for the Workbench agent; wins over `MARINA_CREW_MODEL`. | falls back to `MARINA_CREW_MODEL`, then `marina/default` |
| `MARINA_ANSWERER_MODEL` | `showcase` | Model for the answerer crew. | `MARINA_CREW_MODEL` |
| `MARINA_ANSWERER_COUNT` | `showcase` | Size of the answerer crew. | `4` |
| `MARINA_MATH_MODEL` | `showcase` | Model for the mathematician specialist. | `MARINA_CREW_MODEL` |
| `MARINA_REFLECTOR_MODEL` | `showcase` | Model for the crew reflector. | `MARINA_CREW_MODEL` |
| `MARINA_SEED_SKILLS` | `showcase` | `true` seeds the universal skill packages on first boot. | off |

Precedence for a seeded agent's model is: its own specific override, then
`MARINA_CREW_MODEL`, then `marina/default` (which routes through the local
model API to whatever upstream is configured). Changing one of these takes
effect on the next boot; a world's `seed()` runs once, so a model change does
not re-seed an existing database.
