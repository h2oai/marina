# Persistence — Migrations, Row Retention, Durable Keys

**When to read this:** you are adding a table or migration, deciding how long rows live, or keying anything by entity id. `CLAUDE.md` → "Architecture Rules" keeps the rules (append-only migrations, `RETENTION_POLICIES`, never-pruned tables, `durableEntityKey()` at the delegate boundary); this page is the full retention policy table and the two durable-key passes.

## Migrations
- Migrations: append to `FORWARD_MIGRATIONS` in `src/persistence/schema.ts` (re-exported as `MIGRATIONS` by `database.ts`), never modify existing migrations. `MARINA_DB_DURABILITY=full` (fsync per commit) is the world default; migrations 96–109 are append-only like all others.

## Known-at times for the as-of fence (migration 172)

The as-of fence (`src/memory/as-of.ts`) dates a canonical version, a captured source and an
assistance proposal by the service event that recorded it (`memory.created` / `memory.revised`,
`source.captured`, `assistance.completed`). Migration 172 persists that time on the row —
`memory_record_versions.known_at`, `memory_sources.known_at`,
`memory_assistance_jobs.completed_known_at` — through AFTER INSERT triggers on
`memory_service_events` (same transaction, every write path). It is additive and idempotent:
nullable columns added only when missing (`ALTER TABLE … ADD COLUMN` is a schema-only change in
SQLite, no table rewrite), `IF NOT EXISTS` triggers, and a one-row cursor
`memory_known_at_backfill(cursor, upto)` where `upto` is the event log's last seq at migration time.
Rows older than that are filled by the `memory-known-at-backfill` tick job
(`src/persistence/db-memory-known-at.ts`; every 10 ticks, phase 5): ≤ 8 windows of 5,000 event
seqs per pass, each its own short transaction over the INTEGER PRIMARY KEY — never at boot,
never a whole-log scan. Retention keeps a dating event while it is inside the pending range
(`KNOWN_AT_RETENTION_WHERE`), so nothing the backfill still needs is pruned; fenced reads fall
back to the event log only until the backfill is done. Bundle-imported rows carry no event and
stay undated (fail closed).
## Message envelope

Migration 171 adds `cause TEXT` and `depth INTEGER NOT NULL DEFAULT 0` to `direct_messages`
and `channel_messages`. `cause` is the ref of the message a post answers (`tell:<id>`,
`channel_msg:<id>`, `say:<uuid>`, `shout:<uuid>`) and `depth` is the cause's depth + 1, or 0
when the cause is unknown. `src/engine/message-envelope.ts` holds the rule: an explicit reply
(`re`) names the tell it answers; otherwise the command execution's cause applies
(`CommandExecutionOptions.cause`, kept on the `runCommandScope` frame in `gate-context.ts` and
inherited by macro and `batch` expansions); otherwise the message starts a thread at depth 0.
One exception: a `tell` between two agents that names no cause continues the pair's
conversation (`latestDirectMessageBetween`, 30-minute window). It is one deeper than the other
side's latest tell, its `cause` stays NULL, and a person's tell is always depth 0. Delivered
perceptions carry `messageRef`, `cause` and `depth`, and tells also carry a server-stamped
`senderKind` (`agent` / `person`). The `say_sent` / `tell_sent` events carry names, the ref and
the envelope, never the words.

## Private investigations

Migration 170 appends the prediction/research service tables after the media-memory migration
169. `db-investigations.ts` owns admission and snapshots; the collaboration, journal and lifecycle
modules own access grants, bounded evidence/events, completion, cancellation and erasure.
`MarinaDB` exposes these through `InvestigationsStore`. Durable account IDs own cases; the actor
on an attempt may be an authorized person or agent working for that owner.

Admission keys distinguish transport retries from new work. Completion atomically saves the
canonical forecast and publishes the attempt; execution generations and selected-attempt checks
prevent late or superseded work from replacing the current answer. Service initialization marks
orphaned active work interrupted without replaying provider calls. Private forecast markers keep
these answers out of shared histories and learning even after erasure.

Operator logical exports include the seven investigation tables together, preserving the instance
ID, account ownership, grants, admission keys, evidence and event cursors. Like exports containing
private notes, these are private backup artifacts. Restored access is checked through the same
case policy; existing backups are outside live-case erasure. The [user guide](../guides/forecasting.md#saved-private-predictions-and-research)
documents the available interfaces and capture/accounting limits.

## Row retention
- **Row retention** (`src/engine/retention.ts`, hourly tick phase 2100, `runRetentionPass`): declarative `RETENTION_POLICIES` per table class — telemetry 7–30 d (`primitive_usage`, `feed_events`, `memory_service_events`, `coding_events`, `coding_service_probes`, `event_log` by row count), `memory_service_events` keeps the dating events the migration-171 backfill has not copied yet (`KNOWN_AT_RETENTION_WHERE`), ledger 30–90 d (`direct_messages` acknowledged/expired, `cognitive_events`, `productivity_sessions`, `core_memory_history`, `media_jobs`, `memory_assistance_actions`, `memory_index_jobs` settled states only), continuity-journal receipts in `memory_requests` 7 d (`CONTINUITY_RECEIPT_WHERE`: `archive:` / `archive-batch:` / `manifest:` / `checkpoint:` keys and uuid-keyed `resident` checkpoint saves, whose per-process keys are never resent; every other receipt is kept), staged model-API request images 7 d (`assets` and `canvas_nodes` rows with `origin = request` only; their blobs and their derivatives' blobs removed first by `pruneRequestImageBlobs`; uploaded, generated, tool and derived assets are people's files and never age out — `asset_tags` / `asset_links` cascade with their asset), audit 365 d (`witness_attestations`, `trace_judgments`, `note_verifications`, `evidence_receipts`, `association_events`), `shell_log` 90 d; `chronicle`, `entity_standing`, `memory_resolutions`, `economic_events` — and the lineage/replay logs `intellect_events`, `mesh_events`, `mesh_membership_events`, `journey_events`, `simulation_events`, `arena_submissions`, `arena_shadow`, and the benchmark ledger `benchmark_runs` / `benchmark_items` / `benchmark_promotions` / `benchmark_defaults` / `benchmark_run_validity` — are `append-only` and are never pruned (an override cannot re-enable it). `MARINA_RETENTION_OVERRIDES="table=30d,table2=0"` (0 = never). Batched deletes ≤ 5,000 rows via `db.deleteBatch` (uses `RETURNING rowid` — bun:sqlite `.changes` counts trigger writes). Missing tables/columns are skipped, not errors. Migration 116 adds the `direct_messages(deadline_at) WHERE status='delivered'` partial index plus `notes(supersedes_id)` and `note_sources(url)`.

## Benchmark ledger (migration 146)
- **Runs:** every benchmark run is a ledger row. `benchmark_runs` gains:
  - `cost_usd`, `n` and the Wilson 95 % interval (`ci_low`/`ci_high`);
  - `seed` and `slice_hash` (an order-free hash of the item ids);
  - `judge` (model plus route);
  - `target_kind` (`model` | `crew` | `population`) and `target_json`;
  - `label`, `source` (`in-world` | `import`) and `content_hash` (a unique import key).
- **Items:** `benchmark_items` keeps one outcome per item: id, correct, score, latency, cost, `trace_id`, `participants_json` (agents and models) and the judge verdict.
  - Item ids only: case content (questions, answers, responses) is never stored.
  - Rows are never rewritten; a trigger refuses `UPDATE`.
  - Migration 157 adds three per-item labels, NULL when a run did not report them:
    - `answer_hash`: the harness sends `answerDigest` (sha256 of the normalised answer, `normalizeAnswerForHash`); the ledger stores an HMAC of it keyed by a random per-ledger key (`app_settings` `benchmark.answer_hash_key`) and bound to the item id. Equal answers to one item match across runs, so plurality voting and offline selectors can be measured, but a short answer (a choice letter) cannot be recovered by hashing guesses.
    - `budget_forced`: 1 when the answer was forced at a turn, step or time budget.
    - `verification`: `passed` | `failed` | `not_run`. A check that never ran (dependency preparation failed, the checker was unavailable) is `not_run`, never `failed`. `benchmark result` and the SWE-bench adapter report the three counts apart.
- **Writes:** one transaction through `recordBenchmarkLedgerRun`. Re-importing the same file returns the existing run.
- **Import:** `bun run benchmark:import` (`scripts/benchmark-import.ts`) records harness or Tier-0 results. It is an operator script, never an in-world command, and it drops any credential in the result's config.
- **Ranking:** the pure functions live in `src/engine/benchmark-ledger.ts` (paired comparison with exact McNemar, Pareto frontier, participant credit). They back `benchmark compare | frontier | participants` and the ledger columns of `benchmark leaderboard`.
- **Auto-filing (`POST /v1/benchmarks/runs`, `src/net/api/benchmarks-api.ts`):** a harness files a finished run into the Marina it measured.
  - The body is `{ result, targetKind, target, label?, judge?, costUsd? }`. Only item ids, outcomes, scores, latency, cost, judge verdict and `traceId` are kept, and the content hash is taken over that slim document, so re-filing is a no-op.
  - Auth is the model API's. The open-API sentinel may file only under the local, ungated profile; elsewhere a `MODEL_API_KEYS` credential is required (403 `open_api_read_only`).
  - The ledger source is `import`. The run's `config_json` records the attribution counts.
- **Participants (`src/engine/benchmark-participants.ts`):** each item's `traceId` is the target's `x-request-id` (`traceId === requestId`), resolved against the event log. Each participant records which evidence put it there:
  - `trace`: an `agent_turn_end` serving the request. That is either its own trace (the agent received the `model_request` while idle and the request parented its prompt) or a span link to it (see [Execution traces](traces.md) → span links):
    - the request was steered into a prompt already running;
    - the prompt served several requests at once;
    - the agent acted on work handed over from the request: a tell, crew post or task notice sent by an agent working on it carries its trace, and this is transitive.

    A turn serving one request is charged to it in full. A turn serving n requests gives each 1/n of its cost and marks the participant `tracedShared` (evidence `traced-shared`). A passthru request credits the upstream model.
  - `window`: turns by the routed agent's crew-mates that ended inside the request's received→completed window and serve no request trace (neither their own nor a link). This is the fallback when nothing propagated.
  - `shared`: another request to the same crew overlapped the window (found on a ±30 min padded range). The participant is listed, but its cost is not charged to the item.
  - The filing reply and the run's `config_json` also count `tracedSharedItems`: items with at least one cost-split turn.
  - An item whose request left no lifecycle events (event log pruned, or never routed through this Marina) records no participants and counts as `none`.

## Earned promotion of defaults (migration 147)
A default configuration — a crew formation, a per-agent model map, a world's crew model, any named slot — changes only when a challenger run from the ledger earns it over the incumbent run. `src/engine/benchmark-promotion.ts` holds the rule; `benchmark defaults | challenge | promote` is the surface.
- **Tables:**
  - `benchmark_defaults` has one row per slot: value, incumbent run, `holdout_fraction`.
  - `benchmark_promotions` is the append-only history: every seed, promotion and refused attempt, with the evidence statistics. A trigger refuses `UPDATE`; both tables are part of export and restore.
  - The actor is stored as the opaque durable account key, never a display name.
  - Retention never prunes either table.
- **Holdout:** each item belongs to a slot's selection or holdout split by a stable hash of slot + item id.
  - The fraction (default ½) is fixed once the slot exists.
  - `benchmark challenge` is a dry run that shows only the selection split. The holdout is read only by a `benchmark promote` attempt.
  - Evidence that touches a selection item is refused.
- **Rule:** the challenger and incumbent must have the same benchmark, the same recorded judge and the same item slice.
  - At least 20 paired holdout items.
  - The paired 95 % interval on the accuracy difference lies above zero: Agresti–Min for single runs, the two-stage bootstrap over replicates (below) otherwise.
  - The difference clears `promotionMargin(tried)` — the fishing margin `evolve replicate` and arena signal discovery share — where `tried` counts earlier attempts on the slot, each of which read the holdout.
  - Optional `--max-cost-ratio`.
- **Who:**
  - Promotion takes `role.edit` through `checkRoleEdit`, since a default changes every agent that runs on it. A refusal raises a challenge.
  - The author of the challenger run can never promote it; the check compares durable account keys.
  - The first incumbent seeds an empty slot.
- **Replicated:** the challenger's replicate group (below) must hold at least `MARINA_PROMOTION_MIN_REPLICATES` runs (default 2) — seeding included.
  - The check runs BEFORE the holdout is read, so an unreplicated attempt neither sees the holdout nor counts as a try.
  - With replicates on either side, the interval is the two-stage bootstrap on pooled per-item outcomes, not Agresti–Min. A challenger in the incumbent's own group is refused.
  - **Only one configuration pools.** A group label is something anyone filing a run can set, so a promotion refuses a challenger group with any member whose benchmark, target (canonical JSON), item slice or judge differs from the challenger's — before the holdout is read, recording nothing. A run with no recorded target or slice never counts as another run's replicate. The incumbent's group is restricted to the incumbent's own configuration instead, so a stray run filed under its label can neither pad, dilute nor freeze the slot.
  - **Self-attestation covers the pool:** the promoter may author no run pooled as the challenger (every replicate, durable keys compared), and the account that invalidated the incumbent may author none of them.
- **Consumers:** `getPromotedDefault(db, slot)`. The showcase world reads slot `showcase:crew`'s `model` for its crew when `MARINA_CREW_MODEL` is unset; environment variables always win.

## Replicate groups (migration 148)
Identical runs differ: two runs of one crew on the same 200 items can disagree on a dozen. So one run — and one McNemar p-value — is a single draw. `benchmark_runs.replicate_group` lets repeated runs of ONE configuration pool (`src/engine/benchmark-replicates.ts`; statistics in `src/stats/replicates.ts`).
- **Membership:**
  - A run belongs to the group it names. It gets one from `--group` on the harness and import, `replicateGroup` on `POST /v1/benchmarks/runs`, or `--replicate-of <run>`; `bun run benchmark:import --regroup <ids> --group <key> --reason "<why>"` moves recorded runs.
  - **Regroups are audited (migration 155):** every run a regroup actually moves (also `--replicate-of` naming a group for a run that had none) gets an append-only `benchmark_run_regroups` row — `run_id`, `from_group`, `to_group`, `reason`, `actor`, `source`, `created_at` — in the same transaction as the move. A trigger refuses `UPDATE`; retention never prunes it; it is part of export and restore. Item outcomes are never touched.
  - A run that names none belongs to the automatic group of its benchmark, target (canonical JSON), item slice and judge. A run with no target or slice is its own group.
  - Groups never cross benchmarks. Members whose target, slice or judge differ are flagged.
- **Pooled view:**
  - Each item's score is the mean of its replicates' outcomes, and pooled accuracy is the mean over items. Only items in every replicate are used. A majority-vote figure is shown too.
  - Between-run variation is the SD of replicate accuracies plus per-item agreement: unanimous items, and mean pairwise agreement.
- **Comparison:** a two-stage (cluster) bootstrap resamples each group's runs, then items, giving a percentile interval and a two-sided p on the pooled difference. Resampling runs puts run-level variance — a degraded crew, a provider's bad patch — inside the interval.
  - Every replicate pair's exact McNemar p is listed, to show how far one draw can swing.
  - A side with one replicate is flagged "not replicated".
- **Surface:** `benchmark compare` adds the pooled section, `benchmark leaderboard` lists replicate groups pooled, and `benchmark replicates <run>` shows one group.
- **Re-filing is a no-op:** a run's `content_hash` covers its STABLE content only — config, metadata and every item outcome in canonical key order, without the wall-clock `timestamp` / `duration_ms` (kept only when no item carries a latency or trace id, so identical unmeasured replicates stay distinct). A resumed harness or a repeated `file` step therefore matches the run already recorded (`created: false`), and the filing reply reports the STORED run's group, status and numbers. A run recorded under the earlier raw-bytes hash still matches. The harnesses keep the rest: BrowseComp-Plus records each replicate's filing (`filed.json`) and the arm's group (`group.json`) and files only new replicates into that group on `--resume`; SWE-bench's ledger result is stamped with the last attempt's write, not the filing time, and every replicate of an arm records the same target.

## Invalid runs (migration 153)
A run can measure the infrastructure instead of the target: the spend cap was hit, a provider was down, most items fell back to a default. Such a run must not rank, pool or promote — but the record of it must not disappear either.
- **Status, not deletion:** an invalid run keeps its row and every item outcome; only `benchmark_runs.status` changes, from `completed` to `invalid`. `benchmark_run_validity` is the append-only audit: one row per invalidate or revalidate with `run_id`, `action`, `reason`, `actor` (the opaque durable account key, `operator`, or null for an automatic check), `source` (`in-world` | `operator` | `auto`) and `created_at`. A trigger refuses `UPDATE`; retention never prunes it; it is part of export and restore. The status change and its row commit in one transaction (`setBenchmarkRunValidity`), and only `completed → invalid` or `invalid → completed` is accepted.
- **Who:**
  - In-world: `benchmark invalidate <run> reason:<text>` and `benchmark revalidate <run> reason:<text>`. Both take `role.edit` through `checkRoleEdit` — the same authority as `benchmark promote`, since retiring evidence can change which default wins. A refusal raises a challenge. Retiring your own run is allowed; revalidating it is self-attestation and is refused (durable account keys compared).
  - Operator: `DB_PATH=<db> bun run benchmark:import --invalidate <run> --reason "<why>"` (or `--revalidate`), the same transaction with actor `operator` — for a ledger whose world is not running, or when no in-world account holds `role.edit`. Like `--regroup`, it is a script on the operator's own database file, never an in-world path.
  - Automatic: when more than `MARINA_BENCHMARK_MAX_FALLBACK_RATE` (default 0.25, exceeded strictly; `off` disables) of a run's items are fallbacks, the run is recorded `invalid` as it is written, with reason `fallback rate X% exceeds threshold Y% (k of n items …)` and source `auto`. A fallback is an item flagged `fallback: true` (FutureX rows with no usable answer) or a harness item whose response is its `ERROR:` marker (spend-cap 429s, provider errors, timeouts). The check runs in `ledgerFromHarnessResult` — so every recording path (`POST /v1/benchmarks/runs`, `benchmark:import`, `bun run futurex`) applies it — and in the in-world runner. Only the flag crosses the wire, never the response text. The threshold is conservative: a few timeouts are the target's own failures and stay scored.
- **Readers:** every ranking reader reads only `completed` runs, so an invalid run is excluded from `benchmark leaderboard`, `frontier`, `participants`, pooled replicate groups (`loadReplicateGroup` skips it, even as its own group's member), route evidence (`loadEvidenceItems`), outcome lessons (`noteBenchmarkRun`) and promotion. `benchmark compare` refuses an invalid run by name; `benchmark replicates <invalid run>` shows its group without it. A promotion refuses an invalid challenger. A slot whose incumbent was invalidated reads as unset in `getPromotedDefault` (environment and built-ins apply) until it is filled again.
- **Invalidation never frees a slot:**
  - When the slot's promotion history holds an earlier incumbent that is still valid, a challenger must beat the best of them (highest accuracy, the most recent on a tie) on the holdout under the normal rules: same benchmark, judge and items; interval above 0; the fishing margin; replicates. Its attempt counts toward the margin like any other.
  - Only a slot that never had another valid incumbent re-seeds from replicates alone, recorded as `re-seeded: incumbent … was invalidated and no earlier incumbent is valid`.
  - Self-attestation: neither the promoter nor the challenger's author may be the account that invalidated the incumbent (durable keys compared; the refusal records nothing). So one `role.edit` holder cannot invalidate a default and install their own run.
- **Visible:** `benchmark runs` lists invalid runs marked `INVALID` with the reason; `benchmark result` shows the reason and the full validity history.

## Durable keys
- **Durable keys, second pass (migration 117)**: `group_members`, `channel_members`, `board_votes`, `task_votes`, `flywheel_bindings`, `coding_projects`, `coding_services` are rekeyed to `users.id`; `MarinaDB` delegates resolve `durableEntityKey()` on write and project back to the LIVE entity id on read (`liveEntityIdSql`), so callers keep passing entity ids. `getFlywheelBinding(entityId)` replaces the linear scan; `saveEntity` re-keys task claims by name on first persist of a new id. Migrations 118 and 119 closed the remaining transient columns (see below). `approveSubmission`, `deleteNote`, and `deleteUser` (account erasure, below) are transactional.
- **Durable key, first pass (migration 109)** — the standing, competence, and witness ledgers: see `docs/architecture/civic-substrate.md` → "Standing — the single blended metric" (entity ids are transient — evicted after the 60s reconnect grace, re-minted on the next name-login — so ledgers are keyed by `users.id`; `MarinaDB.durableEntityKey()` resolves them at the delegate boundary and ids with no account pass through unchanged).

See also: `docs/architecture/memory.md` (memory tables, twin lifecycle), `docs/guides/identity.md`.

## Account erasure — the one exception to append-only
`deleteUser(id)` (`src/persistence/db-users.ts`) is the single, explicit exception to the append-only ledgers: erasing a world account removes what is keyed by its durable id instead of leaving orphans nothing can resolve. One transaction:
- **deleted** (the account's own rows): `entity_standing` and `entity_standing_cache`, `entity_competence`, `witness_attestations`, `group_members`, `channel_members`, `board_votes`, `macros`, `adapter_links`;
- **anonymized** to `ERASED_ACCOUNT` (`"[erased]"`, rows other people depend on): `tasks.creator_id`/`creator_name`, `board_posts.author_id`/`author_name`; a group the account led passes to its highest-ranked remaining member, else `ERASED_ACCOUNT`;
- **audited**: one chronicle `event` (source `account`, title `account erased`, ref `user:<id>`, body = per-table counts — never the name). The call returns the same counts (`AccountErasure`).

No other code path deletes or rewrites `entity_standing`; the former `migrateEntityId` (which rewrote it on id changes) was removed — durable keys make it unnecessary. Retention never prunes it (`append-only` policy).

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
| `AssetsStore` / `MediaStore` | `db-assets.ts` / `db-media.ts` | assets (record v2: facts, tags, lineage, library query); media jobs |
| `CanvasStore` | `db-canvas.ts` | canvases, nodes, edges, intents (`parseCanvasIntent`) |
| `ShellStore` | `db-shell.ts` | shell allowlist, shell log |
| `MarketsStore` | `db-markets.ts` | markets, positions, calibration scores |
| `JourneysStore`, `CognitiveEventsStore`, `IntellectsStore`, `AssociationsStore`, `ReproductionStore`, `MeshesStore`, `EconomicsStore`, `SimulationsStore`, `MutationsStore` | the same-named `db-*.ts` | one interface per module |

Adding a delegate: put the query in the module, add the one-line delegate to `MarinaDB`, add the method to the matching interface and its `*_STORE_METHODS` tuple — the `ExactKeys` check and the drift test fail until all three agree. Row types are declared in their module and re-exported from `database.ts` so importers keep one path.

## Command phase: per-entity chains and a wall-clock budget

`processCommand` is async, and firing it un-awaited would let one entity's queued commands interleave past their first `await`. `CommandCoordinator` (`src/engine/command-coordinator.ts`) keeps a per-entity promise tail (`chains`): an idle entity's command starts synchronously, a busy entity's is chained after its previous one, so a single entity runs strictly FIFO while different entities still interleave. A rejection that escapes `processCommand` before the handler's own try (modal routing, parse, context build) is routed to the tick error path (`recordTickError`) instead of becoming an unhandled rejection. The command phase stops dispatching after `COMMAND_PHASE_BUDGET_MS` (150 ms, `MARINA_COMMAND_PHASE_BUDGET_MS`) and carries the per-entity remainder to the next tick in order; `MAX_COMMANDS_PER_TICK` still bounds the count. `drainCommands()` / `queuedCommandCount` are test seams. The macro fan-out stays un-awaited (its tests expect synchronous completion).

`RoomSandbox.wrapModule` returns a room command handler's value, so an async room command's promise reaches the chain; an async rejection is recorded as a room violation via `execHandler`, never as an unhandled rejection.

## Migration 118 and the contradiction-case twin exclusion

`groups_.leader_id` and `tasks.creator_id` are rekeyed to `users.id` (EXISTS-guarded `UPDATE OR IGNORE`); `createGroup`/`createTask` resolve `durableEntityKey()` and every group/task read projects the live id back (`GROUP_COLUMNS`, `TASK_COLUMNS`), so `GroupManager` and `TaskManager` keep comparing entity ids.

## Migration 119: board post and macro authors

`board_posts.author_id` and `macros.author_id` are rekeyed to `users.id` with the same EXISTS-guarded `UPDATE OR IGNORE`. `macros` has `UNIQUE(name, author_id)`, so a collision (the account already owns a durable macro of that name) leaves the transient row in place — a macro is content, not a mirror row, so nothing is deleted. `MarinaDB.createBoardPost` / `createMacro` resolve `durableEntityKey()` on write, the `author_id = ?` lookups (`getMacroByName`, `listMacros(authorId)` — the "my macros" path) resolve it too, and every read projects the live entity id back (`BOARD_POST_COLUMNS` in `db-channels.ts`, `MACRO_COLUMNS` in `database.ts`), so `MacroManager`'s ownership checks, `crew` result posts and the `paper-orders` board keep passing and comparing entity ids. An offline account (no live entity) reads back as the durable key itself. `room_sources.author_id` / `room_templates.author_id` stay as they are: display-only (`author_name` is what renders), never compared or looked up. With 119 no entity-keyed column is still transient.

## Migration 120: `agent_configs.thinking_level`

`ALTER TABLE agent_configs ADD COLUMN thinking_level TEXT` — nullable, NULL = never set. `saveAgentConfig` writes the level when given and otherwise keeps the stored value (`COALESCE(excluded.thinking_level, agent_configs.thinking_level)`), so a `model`/`role` reconfigure never clears an earlier `thinking` choice; `AgentRuntime.init()` and `restart()` hand the persisted level back to `spawn` via `parseAgentThinkingLevel`, and an unset column stays `undefined` (resolved at spawn by `resolveAgentThinkingLevel`, never stored as `'off'`).

`refreshContradictionCases` (`db-notes.ts`) excludes durable service-memory rows (`memory_record_versions`) from candidates and skips any pair where one note is the other's twin (`note_sources.url = marina-memory://record/<id>`), so `note conflicts` never lists a note against its own durable mirror.

## Migration 144: a stable FTS key for `markets`
`markets` had a TEXT primary key and `markets_fts` used `content_rowid=rowid`; VACUUM and VACUUM INTO (`snapshot`, `snapshotCompacted`, recovery bundles) may renumber the implicit rowid of such a table, silently pointing the external-content index at the wrong rows. Migration 144 rebuilds `markets` with `seq INTEGER PRIMARY KEY` (`id` stays the public key, `UNIQUE`, and the FK target), re-creates the FTS table on `content_rowid=seq` with its three triggers, and rebuilds the index. Because DROP TABLE on a referenced parent cascades with `foreign_keys=ON`, `market_positions` and `market_scores` are rebuilt alongside it, referencing the new parent before the rename. Any new external-content FTS table must use an INTEGER PRIMARY KEY as its `content_rowid` (`test/markets-fts-vacuum.test.ts`).

## Retired sources in `[evidence]`

`servableSourceIds(db, spaceId, sourceIds, now)` in `unified-context.ts` drops `source_search` hits whose every deriving record is retired (superseded tombstone, current note superseded, or `valid_until` past); a source with no deriving record stays (a plain capture), and a fresh record re-deriving it makes it servable again. A query failure keeps all hits — it is a guard, not an access check.


## Fresh schema and existing database upgrades

Fresh databases install `schema-baseline.ts` (version 167, the schema of v0.8.0) in one
SQLite transaction, then apply any `FORWARD_MIGRATIONS` in `schema.ts`. This avoids replaying
historical ALTER statements, index rebuilds, data conversions and per-version disk commits on
an empty database. The baseline marker stays 167; forward migrations advance the database to the
current version. Consolidation does not reset the schema counter.

`schema-history.ts` retains the original SQL unchanged for populated databases. A
database with any existing schema takes the historical upgrade path; the baseline
is never stamped over existing tables. Pending versions still commit individually,
a failure stops at the previous version, and newer unsupported schemas fail closed.

`bun run schema:check` regenerates the baseline in a disposable in-memory database
and checks the committed artifact. The generator replays an EMPTY database exactly as
`MarinaDB` upgrades one — each migration's SQL and its data conversion (`apply`), one
transaction per version, foreign keys on — so the baseline is "the schema an empty
database has at version N". FTS shadow tables are created by SQLite, not copied as
independent tables. Indexes, triggers, foreign keys and seeded allowlist entries are
included; seed timestamps remain installation timestamps. A seeded row in any table the
generator has not been told how to reproduce at installation fails generation, and two
independent replays must produce the same artifact, so a per-database value (a
`randomblob` id, a `unixepoch()` stamp) is never baked in. `test/schema-baseline.test.ts`
compares the baseline with replay, and a fresh `MarinaDB` with an empty database migrated
one version at a time from 0: every schema object's SQL verbatim, column, index and
foreign-key pragmas, every table's rows (FTS shadow tables included, except the
`_data` averages record, which `integrity-check` covers), and integrity checks.
Other tests cover populated older databases, FTS writes/deletion, and reopening.
`test/schema-replay.ts` (`migrateEmptyTo`) builds a database at any older version
for upgrade tests, independent of where the baseline sits.

New changes belong in `FORWARD_MIGRATIONS`, after its last version. Migration 138
converts numeric memory inside the same transaction as its DDL and version marker. Migration 139
adds `challenge_outcomes` (answered challenges, see civic-substrate.md), migration 140 carries
capability across to the `world.lineage` / `world.code` gates, migration 141 adds `roles.loop`
(JSON role-owned loop sections, see agent-cognition.md), and migration 142 rebuilds `spend_daily`
so image/video generation (`media`) joins the daily spend ledger. Migration 143 rewrites
`mem_api_keys.secret` as a `sha256:<hex>` digest; keys are looked up by digest and the raw
secret is never stored. Migration 144 gives `markets` a stable INTEGER key for its FTS index, and
migration 145 adds `forecast_answers`; migration 151 rebuilds it (SQLite cannot widen a CHECK in
place) so typed answers — `choice`, `multi`, `ranking`, `text` — join `probability` and `number`,
with a `prediction` column holding the typed answer as one string; migration 152 adds the
append-only `external_submissions` (what was filed to an outside evaluation: batch, variant,
identity, file hash — one row per file; the scored run joins the benchmark ledger once the batch
resolves). Do not edit the baseline
or archived migrations to implement a new feature.

Migration 159 adds `benchmark_run_evidence` and `benchmark_item_evidence` as append-only source
attribution overlays. Original benchmark rows remain immutable; facade readers project recovered
participants. Operator imports require exact item outcomes and request IDs. See
[execution evidence](../guides/execution-evidence.md).

Migration 160 adds the append-only `benchmark_item_lessons`: the judged lesson ids each ledger item
was served (`served`) or recalled without being shown (`observed`), with the run's lesson regime
(`measure` excludes lessons learned from the same benchmark, `live` does not). Ids only, never lesson
or item text. See [benchmarks.md](benchmarks.md).

## Upgrades from real releases

`test/upgrade-from-releases.test.ts` loads, for every release, a database that release's
own code created (`test/fixtures/upgrade/<tag>.sql`, with a `<tag>.json` manifest of tag,
commit, schema version and seeded rows), opens it with today's `MarinaDB`, and asserts:
the schema version is the latest; the normalized schema — every column's type, `NOT
NULL`, default and key, foreign keys, indexes (automatic ones included), each table's
definition, views, triggers and FTS tables — equals a fresh install's, with a readable
line diff on failure; the seeded user, entity, note, core memory, task, channel message,
board post and canvas read back through today's API; `PRAGMA integrity_check`,
`foreign_key_check` and every FTS5 `integrity-check` pass; and the database reopens.
`KNOWN_DRIFT` in that file is the reviewed allowlist of accepted differences (empty).
This complements the schema-131/132 fixtures in `upgrade-compatibility.test.ts`, which
are built by replaying today's history and pin memory-identity conversions.

`bun scripts/generate-upgrade-fixture.ts <tag>` builds a fixture: it checks the tag out
in a temporary worktree, installs that release's own lockfile, opens a fresh database
through the release's `MarinaDB` constructor, runs its default world `seed(db)`, writes
the representative rows through the release's own `MarinaDB` methods (fixed clock, no
`.env`, no network) and dumps the result as plain SQL. The dump loads under SQLite's
defensive mode: FTS5 tables (all external-content) are recreated and rebuilt from their
content tables instead of copying shadow tables, and triggers are created after the rows.
`test/fixtures/upgrade/README.md` lists the fixtures and any release that could not be
booted.

## Baseline refresh policy

The baseline is a cache of historical replay, never a second definition:
`schema-history.ts` plus `FORWARD_MIGRATIONS` define the schema, and
`bun run schema:check` proves the baseline equals replay.

- **Every released version keeps an upgrade fixture.** After tagging a release, run
  `bun scripts/generate-upgrade-fixture.ts vX.Y.Z` and commit
  `test/fixtures/upgrade/vX.Y.Z.{sql,json}`. A fixture is never deleted to make a change
  pass; ending support for upgrades from an old version is an explicit compatibility
  decision recorded in [compatibility](../guides/compatibility.md) and the release
  notes.
- **Refresh only at a release boundary**, and only for migrations that already
  shipped in a tagged release — never for a migration still on `main`, whose SQL may
  still change before release.
- **Refresh only when it pays**: fresh-install time or the size of the forward list is
  a measured problem. The baseline exists to spare empty databases the historical
  rebuilds and data conversions; it is not tidied for its own sake.
- **Fold a contiguous prefix, hooks included.** The generator runs each migration's
  `sql` AND its `apply` hook on the empty database, because a hook may change the schema
  even with no rows (138's conversion drops `legacy_memory_outbox`). A folded hook stays
  in `MIGRATION_HOOKS` in `schema.ts`, keyed by version, so an existing database that
  upgrades through that version still converts its data; `schema-history.ts` stays pure
  SQL. 138 and 143 are folded this way (2026-10, baseline 137 → 167, v0.8.0).
- **Seeded rows need a decision.** A migration that inserts rows on an empty database
  must reproduce them at installation, not copy the generation-time value: list the
  table in the generator's `SEEDED_TABLES` with an install-time SQL expression for every
  per-database column (`shell_allowlist.added_at` today). The next refresh past 170
  meets `investigation_instance` (a `randomblob` uuid per database): generation fails
  until it gets such an entry, and `test/schema-baseline.test.ts` asserts two fresh
  installs get different ids.
- **How**: move the folded entries verbatim (same versions, same SQL) from
  `FORWARD_MIGRATIONS` to the end of `schema-history.ts` (hooks to `MIGRATION_HOOKS`),
  raise `SCHEMA_BASELINE_VERSION` in `schema-baseline.ts`, regenerate with
  `bun scripts/generate-schema-baseline.ts`, and run `bun run schema:check`,
  `test/schema-baseline.test.ts` and `test/upgrade-from-releases.test.ts`. Tests that
  need an older database build it with `migrateEmptyTo`, never from `SCHEMA_BASELINE`.
  Before folding, check each moved migration's SQL is byte-identical to the tagged
  release's. The schema counter never resets: `SCHEMA_VERSION` and every database's
  `schema_version` are unchanged by a refresh, and every release fixture must still
  upgrade to exactly the fresh-install schema.

The operator side — backup, first-boot migration, verification, rollback and the
newer-schema refusal — is in [Upgrading a server](../guides/upgrading.md).

## Asset record v2 (migration 168)

`assets` gains `origin` (`upload|generated|request|derived|tool`), `sha256`, `width`, `height`, `duration_ms`, `pages`, `alt`, `caption`, `provenance` (JSON: prompt, model, provider, cost, job id), `derived_from`, `placeholder`, `derivative_state` / `derivative_note` and `updated_at`. Tags live in `asset_tags(asset_id, tag)` (facets, AND filters) and lineage in `asset_links(from_id, to_id, kind)` (`thumbnail-256`, `thumbnail-1024`, `poster`, `preview`, and later edits/variations). Both cascade with their asset. A derivative is an `assets` row with `derived_from` set (origin `derived`): the `ON DELETE CASCADE` foreign key deletes its row with the parent, and the read check follows `derived_from` (see security.md). `assets_fts` is a standalone FTS5 table (`asset_id UNINDEXED, filename, caption, alt, prompt, tags`) kept by insert/update/delete triggers on `assets` and `asset_tags`. Assets have TEXT ids, so an external-content table would hang on an implicit rowid that `VACUUM` may renumber. The upgrade sets `origin`/`provenance` from legacy `metadata` and seeds the FTS rows. Hashes, dimensions and derivatives are filled by the bounded `asset-backfill` tick job (~30 s, `BACKFILL_BATCH` rows a pass), never at boot. The owner stays `entity_name`. That is the account name the ownership checks already use; it is not a transient entity id, so no durable-key rekey applies. Writes go through `src/engine/media/asset-library.ts` (`ingestAsset`, `editAsset`, `removeAsset`), which emits the content-free `asset_created|asset_updated|asset_deleted` events.
