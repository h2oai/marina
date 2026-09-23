# Persistence — Migrations, Row Retention, Durable Keys

**When to read this:** you are adding a table or migration, deciding how long rows live, or keying anything by entity id. `CLAUDE.md` → "Architecture Rules" keeps the rules (append-only migrations, `RETENTION_POLICIES`, never-pruned tables, `durableEntityKey()` at the delegate boundary); this page is the full retention policy table and the two durable-key passes.

## Migrations
- Migrations: append to `migrations` in `src/persistence/schema.ts` (re-exported as `MIGRATIONS` by `database.ts`), never modify existing migrations. `MARINA_DB_DURABILITY=full` (fsync per commit) is the world default; migrations 96–109 are append-only like all others.

## Row retention
- **Row retention** (`src/engine/retention.ts`, hourly tick phase 2100, `runRetentionPass`): declarative `RETENTION_POLICIES` per table class — telemetry 7–30 d (`primitive_usage`, `feed_events`, `memory_service_events`, `coding_events`, `event_log` by row count), ledger 90 d (`direct_messages` acknowledged/expired, `cognitive_events`, `productivity_sessions`, `core_memory_history`, `media_jobs`, `memory_assistance_actions`), audit 365 d (`witness_attestations`, `trace_judgments`, `note_verifications`, `evidence_receipts`, `association_events`, `benchmark_runs`), `shell_log` 90 d; `chronicle`, `entity_standing`, `memory_resolutions`, `economic_events` are `append-only` and are never pruned (an override cannot re-enable it). `MARINA_RETENTION_OVERRIDES="table=30d,table2=0"` (0 = never). Batched deletes ≤ 5,000 rows via `db.deleteBatch` (uses `RETURNING rowid` — bun:sqlite `.changes` counts trigger writes). Missing tables/columns are skipped, not errors. Migration 116 adds the `direct_messages(deadline_at) WHERE status='delivered'` partial index plus `notes(supersedes_id)` and `note_sources(url)`.

## Durable keys
- **Durable keys, second pass (migration 117)**: `group_members`, `channel_members`, `board_votes`, `task_votes`, `flywheel_bindings`, `coding_projects`, `coding_services` are rekeyed to `users.id`; `MarinaDB` delegates resolve `durableEntityKey()` on write and project back to the LIVE entity id on read (`liveEntityIdSql`), so callers keep passing entity ids. `getFlywheelBinding(entityId)` replaces the linear scan; `saveEntity` re-keys task claims by name on first persist of a new id. Migrations 118 and 119 closed the remaining transient columns (see below). `approveSubmission`, `deleteNote`, and `deleteUser` (cascades standing/competence/witness rows) are transactional.
- **Durable key, first pass (migration 109)** — the standing, competence, and witness ledgers: see `docs/architecture/civic-substrate.md` → "Standing — the single blended metric" (entity ids are transient — evicted after the 60s reconnect grace, re-minted on the next name-login — so ledgers are keyed by `users.id`; `MarinaDB.durableEntityKey()` resolves them at the delegate boundary and ids with no account pass through unchanged).

See also: `docs/architecture/memory.md` (memory tables, twin lifecycle), `docs/guides/identity.md`.

## Facade and store interfaces

`src/persistence/database.ts` is a thin facade: `MarinaDB` owns the two connections (writer `db`, read-only `reader`), `open`/migrate/`close`, `transaction()`, the durable-key cache (`durableEntityKey()`), and one-line delegates. Every query lives in a standalone `fn(db: Database, …)` in a `db-*.ts` module. The facade is where entity ids resolve to durable keys — a module never calls `durableEntityKey()`; it receives an already-resolved `entityKey` (or `authorKey`) parameter and the facade passes `this.durableEntityKey(id)` at the call site. Modules that only read take `reader`; the few that write and then read back (`createCodingProject`, `snapshot`) take both.

Each module has a matching interface in `src/persistence/interfaces/` — explicit method signatures, not `Pick<MarinaDB, …>`, so a test can implement one with a plain object. `MarinaDB implements MarinaStores` (the aggregate that extends every store); consumers can start typing a dependency as `NotesStore` instead of `MarinaDB` without any runtime change. Each store file also exports a runtime tuple of its method names (`NOTES_STORE_METHODS` …) plus an `ExactKeys` compile-time proof that the tuple covers the interface; `STORE_METHOD_MANIFEST` in `interfaces/index.ts` aggregates them and `test/persistence-interfaces.test.ts` asserts that every public method on `MarinaDB.prototype` is claimed by exactly one interface (no unclaimed, no phantom, no duplicates), so the interfaces cannot drift from the facade silently.

- **Batch reads and bounded caches**: `getNotes(ids)` (`db-notes.ts`, facade, `NotesStore` + `NOTES_STORE_METHODS`) returns every existing note among `ids` with one `SELECT … WHERE id IN (…)` per `NOTES_BATCH_CHUNK_SIZE` (500) chunk, duplicates collapsed, order unspecified — the replacement for per-id `getNote` loops (first consumer: `memoryObserver().links()/sources()`, previously two `getNote` per link). `durableEntityKey()`'s transient-id → `users.id` map is an LRU bounded at `DURABLE_KEY_CACHE_MAX` (5 000): a hit is re-inserted to refresh recency, a miss past the bound evicts the oldest key (Map insertion order), ids with no account are never cached, and `deleteUser` still drops every entry that resolved to the deleted account (`test/durable-key-cache.test.ts`).

| Interface | Module(s) | Scope |
| --- | --- | --- |
| `CoreStore` | `database.ts` | `durableEntityKey`, `durableKeyForName`, `transaction`, `checkpoint`, `close` |
| `MaintenanceStore` | `db-maintenance.ts` | `tableExists`, `tableColumns`, `deleteBatch` (retention), `snapshot`, `snapshotCompacted` |
| `EntitiesStore` | `db-entities.ts` | entities, room KV, sessions, event log, trace judgments, activity, entity migration |
| `EvidenceStore` | `db-evidence.ts` | evidence receipt chain |
| `LogsStore` | `db-logs.ts` | structured logs |
| `UsersStore` | `db-users.ts` | world accounts, bans, adapter links, adapter user mappings |
| `PrincipalsStore` | `db-principals.ts` | principals, workload credentials |
| `NotesStore` | `db-notes.ts` | legacy notes, core memory, note links, pools, memory API keys, quality summary |
| `MemoryServiceStore` | `db-memory-service.ts`, `db-memory-admission.ts`, `db-memory-retention.ts`, `db-principals.ts` | repository handle, admission, credentials, receipt compaction |
| `TasksStore` | `db-tasks.ts` | tasks, claims, projects, legacy task-standing reads |
| `StandingStore` / `CompetenceStore` / `WitnessStore` | `db-standing.ts` / `db-competence.ts` / `db-witness.ts` | durable-keyed reputation ledgers |
| `ChannelsStore` | `db-channels.ts` | channels, boards, groups, global search |
| `CrewsStore` | `db-crews.ts` | crews |
| `DirectMessagesStore` | `db-direct-messages.ts` | durable direct-message receipts |
| `MacrosStore` | `db-macros.ts` | macros (`MACRO_COLUMNS` projection) |
| `RoomsStore` | `db-rooms.ts` | room sources, room templates, `clearDynamicRooms` |
| `CommandsStore` | `db-commands.ts` | dynamic commands + history, `clearDynamicCommands` |
| `ConnectorsStore` / `GatewaysStore` | `db-connectors.ts` / `db-gateways.ts` | connectors; gateways + bridges |
| `AgentsStore` | `db-agents.ts` | traits, roles, agent configs, API keys, adapters |
| `SettingsStore` | `db-agents.ts`, `db-meta.ts` | settings table, default model, `meta` key-value |
| `FederationStore` | `db-federation.ts` | peers, trust, world id |
| `WorldVariantsStore` | `db-world-variants.ts` | world variants (promotion writes an evidence receipt in one transaction) |
| `FeedStore` / `ChronicleStore` | `db-feed.ts` / `db-chronicle.ts` | feed events; chronicle |
| `BenchmarksStore` | `db-benchmarks.ts` | benchmark runs |
| `AlertsStore` | `db-alerts.ts` | operational alerts |
| `TelemetryStore` | `db-telemetry.ts` | productivity sessions, primitive usage, prompt outcomes |
| `FlywheelStore` | `db-flywheel.ts` | flywheel bindings, sandbox projects/services, probes, operations, credential bindings |
| `CodingStore` | `db-coding.ts` | coding sessions, events, artifacts |
| `ExperimentsStore` / `EvolutionStore` | `db-experiments.ts` / `db-evolution.ts` | experiments; evolution sessions and runs |
| `AssetsStore` / `MediaStore` | `db-assets.ts` / `db-media.ts` | assets; media jobs |
| `CanvasStore` | `db-canvas.ts` | canvases, nodes, edges, intents (`parseCanvasIntent`) |
| `ShellStore` | `db-shell.ts` | shell allowlist, shell log |
| `MarketsStore` | `db-markets.ts` | markets, positions, calibration scores |
| `JourneysStore`, `CognitiveEventsStore`, `IntellectsStore`, `AssociationsStore`, `ReproductionStore`, `MeshesStore`, `EconomicsStore`, `SimulationsStore`, `MutationsStore` | the same-named `db-*.ts` | one interface per module |

Adding a delegate: put the query in the module, add the one-line delegate to `MarinaDB`, add the method to the matching interface and its `*_STORE_METHODS` tuple — the `ExactKeys` check and the drift test fail until all three agree. Row types are declared in their module and re-exported from `database.ts` so importers keep one path.

## Command phase: per-entity chains and a wall-clock budget (2026-09-22)

`processCommand` is async; the round-robin used to fire it un-awaited, so one entity's queued commands could interleave past their first `await`. `Engine.dispatchQueued` now keeps a per-entity promise tail (`commandChains`): an idle entity's command starts synchronously, a busy entity's is chained after its previous one, so a single entity runs strictly FIFO while different entities still interleave. A rejection that escapes `processCommand` before the handler's own try (modal routing, parse, context build) is routed to the tick error path (`recordTickError`) instead of becoming an unhandled rejection. The command phase stops dispatching after `COMMAND_PHASE_BUDGET_MS` (150 ms, `MARINA_COMMAND_PHASE_BUDGET_MS`) and carries the per-entity remainder to the next tick in order; `MAX_COMMANDS_PER_TICK` still bounds the count. `drainCommands()` / `queuedCommandCount` are test seams. The macro fan-out stays un-awaited (its tests expect synchronous completion).

`RoomSandbox.wrapModule` returns a room command handler's value (previously the closure discarded it), so an async room command's promise reaches the chain; an async rejection is recorded as a room violation via `execHandler`, never as an unhandled rejection.

## Migration 118 and the contradiction-case twin exclusion

`groups_.leader_id` and `tasks.creator_id` are rekeyed to `users.id` (EXISTS-guarded `UPDATE OR IGNORE`); `createGroup`/`createTask` resolve `durableEntityKey()` and every group/task read projects the live id back (`GROUP_COLUMNS`, `TASK_COLUMNS`), so `GroupManager` and `TaskManager` keep comparing entity ids.

## Migration 119: board post and macro authors

`board_posts.author_id` and `macros.author_id` are rekeyed to `users.id` with the same EXISTS-guarded `UPDATE OR IGNORE`. `macros` has `UNIQUE(name, author_id)`, so a collision (the account already owns a durable macro of that name) leaves the transient row in place — a macro is content, not a mirror row, so nothing is deleted. `MarinaDB.createBoardPost` / `createMacro` resolve `durableEntityKey()` on write, the `author_id = ?` lookups (`getMacroByName`, `listMacros(authorId)` — the "my macros" path) resolve it too, and every read projects the live entity id back (`BOARD_POST_COLUMNS` in `db-channels.ts`, `MACRO_COLUMNS` in `database.ts`), so `MacroManager`'s ownership checks, `crew` result posts and the `paper-orders` board keep passing and comparing entity ids. An offline account (no live entity) reads back as the durable key itself. `room_sources.author_id` / `room_templates.author_id` stay as they are: display-only (`author_name` is what renders), never compared or looked up. With 119 no entity-keyed column is still transient.

## Migration 120: `agent_configs.thinking_level`

`ALTER TABLE agent_configs ADD COLUMN thinking_level TEXT` — nullable, NULL = never set. `saveAgentConfig` writes the level when given and otherwise keeps the stored value (`COALESCE(excluded.thinking_level, agent_configs.thinking_level)`), so a `model`/`role` reconfigure never clears an earlier `thinking` choice; `AgentRuntime.init()` and `restart()` hand the persisted level back to `spawn` via `parseAgentThinkingLevel`, and an unset column stays `undefined` (resolved at spawn by `resolveAgentThinkingLevel`, never stored as `'off'`).

`refreshContradictionCases` (`db-notes.ts`) excludes durable service-memory rows (`memory_record_versions`) from candidates and skips any pair where one note is the other's twin (`note_sources.url = marina-memory://record/<id>`), so `note conflicts` never lists a note against its own durable mirror.

## Retired sources in `[evidence]`

`servableSourceIds(db, spaceId, sourceIds, now)` in `unified-context.ts` drops `source_search` hits whose every deriving record is retired (superseded tombstone, current note superseded, or `valid_until` past); a source with no deriving record stays (a plain capture), and a fresh record re-deriving it makes it servable again. A query failure keeps all hits — it is a guard, not an access check.
