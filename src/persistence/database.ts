// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import type { AgentSupports, AgentThinkingLevel } from "../agent/agent-types";
import type { Session } from "../auth/session-manager";
import { DURABLE_KEY_CACHE_MAX, type NoteTier } from "../engine/constants";
import type { MemoryStorageAmounts } from "../sdk/memory-types";
import type {
  RoutingChannelPage,
  RoutingChannelReceipt,
  RoutingEvent,
  RoutingEventInput,
  RoutingEventPage,
  RoutingJoin,
  RoutingMessage,
  RoutingSend,
  RoutingSession,
  RoutingSessionPage,
} from "../sdk/routing-types";
import type { EngineEvent, Entity, EntityId, RoomId } from "../types";
import type { TraitCapabilities } from "./db-agents";
import * as agentsDb from "./db-agents";
import * as alertsDb from "./db-alerts";
import * as arenaDb from "./db-arena";
import * as assetsDb from "./db-assets";
import * as associationsDb from "./db-associations";
import * as benchmarksDb from "./db-benchmarks";
import * as canvasDb from "./db-canvas";
import * as channelsDb from "./db-channels";
import * as chronicleDb from "./db-chronicle";
import * as codingDb from "./db-coding";
import * as cognitiveEventsDb from "./db-cognitive-events";
import * as commandsDb from "./db-commands";
import * as competenceDb from "./db-competence";
import * as connectorsDb from "./db-connectors";
import * as crewsDb from "./db-crews";
import * as decisionsDb from "./db-decisions";
import * as directMessagesDb from "./db-direct-messages";
import * as economicsDb from "./db-economics";
import * as entitiesDb from "./db-entities";
import * as evidenceDb from "./db-evidence";
import * as evolutionDb from "./db-evolution";
import * as experimentsDb from "./db-experiments";
import * as federationDb from "./db-federation";
import * as feedDb from "./db-feed";
import * as flywheelDb from "./db-flywheel";
import * as gatewaysDb from "./db-gateways";
import * as intellectsDb from "./db-intellects";
import * as journeysDb from "./db-journeys";
import * as logsDb from "./db-logs";
import * as macrosDb from "./db-macros";
import * as maintenanceDb from "./db-maintenance";
import * as marketsDb from "./db-markets";
import * as mediaDb from "./db-media";
import { admitMemoryImport } from "./db-memory-admission";
import { compactMemoryReceipts } from "./db-memory-retention";
import { configureMemoryStorage, memoryLimitsFromEnv } from "./db-memory-storage";
import * as meshesDb from "./db-meshes";
import * as metaDb from "./db-meta";
import * as mutationsDb from "./db-mutations";
import * as notesDb from "./db-notes";
import * as principalsDb from "./db-principals";
import * as reproductionDb from "./db-reproduction";
import * as roomsDb from "./db-rooms";
import * as routingDb from "./db-routing";
import * as shellDb from "./db-shell";
import * as simulationsDb from "./db-simulations";
import * as standingDb from "./db-standing";
import * as tasksDb from "./db-tasks";
import * as telemetryDb from "./db-telemetry";
import * as usersDb from "./db-users";
import * as witnessDb from "./db-witness";
import * as worldVariantsDb from "./db-world-variants";
import type { MarinaStores } from "./interfaces";

export type {
  AdapterRow,
  AgentConfigRow,
  ApiKeyRow,
  EditHistoryRow,
  RoleRow,
  TraitCapabilities,
  TraitRow,
} from "./db-agents";
export type {
  BoardPostRow,
  BoardRow,
  BoardVoteRow,
  ChannelMemberRow,
  ChannelMessageRow,
  ChannelRow,
  GlobalSearchResult,
  GroupMemberRow,
  GroupRow,
} from "./db-channels";
export type { CompetenceRow } from "./db-competence";
export type { CrewMemberRow, CrewRow } from "./db-crews";
export type {
  EconomicAdapterRow,
  EconomicContractRow,
  EconomicEventKind,
  EconomicEventRow,
} from "./db-economics";
export { ECONOMIC_EVENT_KINDS } from "./db-economics";
export type { MediaJobRow, MediaJobStatus, MediaJobType } from "./db-media";
export type { StandingCacheRow, StandingLedgerRow } from "./db-standing";
export type { TaskClaimRow, TaskRow } from "./db-tasks";

import type {
  AdapterRow,
  AgentConfigRow,
  ApiKeyRow,
  EditHistoryRow,
  RoleRow,
  TraitRow,
} from "./db-agents";
import type {
  BoardPostRow,
  BoardRow,
  BoardVoteRow,
  ChannelMemberRow,
  ChannelMessageRow,
  ChannelRow,
  GlobalSearchResult,
  GroupMemberRow,
  GroupRow,
} from "./db-channels";
import type { ProjectRow, TaskClaimRow, TaskRow } from "./db-tasks";

export type {
  AssociationDirection,
  AssociationEventKind,
  AssociationEventRow,
  AssociationLinkRow,
  AssociationParticipant,
  AssociationProjection,
  AssociationRelationRow,
  AssociationRow,
} from "./db-associations";
export { ASSOCIATION_DIRECTIONS, ASSOCIATION_EVENT_KINDS } from "./db-associations";
export type {
  ChronicleEntry,
  ChronicleKind,
  ChronicleQuery,
  InsertChronicle,
} from "./db-chronicle";
export type {
  CognitiveEventKind,
  CognitiveEventRow,
  CognitiveVerification,
} from "./db-cognitive-events";
export { COGNITIVE_EVENT_KINDS } from "./db-cognitive-events";
export type { FeedEventRow, FeedQuery, InsertFeedEvent } from "./db-feed";
export type {
  IntellectEventKind,
  IntellectEventRow,
  IntellectInstanceRow,
  IntellectRow,
} from "./db-intellects";
export { INTELLECT_EVENT_KINDS } from "./db-intellects";
export type {
  JourneyEventKind,
  JourneyEventRow,
  JourneyLinkKind,
  JourneyLinkRow,
  JourneyRow,
  JourneyWitnessRow,
} from "./db-journeys";
export { JOURNEY_EVENT_KINDS, JOURNEY_LINK_KINDS } from "./db-journeys";
export type {
  MeshEventRow,
  MeshMembershipEventRow,
  MeshRow,
  MeshTranslationRow,
  MeshWitnessRow,
} from "./db-meshes";
export type { CivilizationMutationRow, MutationDisposition } from "./db-mutations";
export type {
  CoreMemoryHistoryRow,
  CoreMemoryRow,
  MemApiKeyRow,
  MemoryPoolRow,
  NoteLinkRow,
  NoteRow,
  ScoredNoteRow,
} from "./db-notes";
export type {
  CognitiveReproductionComponentRow,
  CognitiveReproductionRow,
  ComponentDisposition,
  MarinaDescendantRow,
  MarinaGenomeRow,
} from "./db-reproduction";
export type {
  ReproducibilityLevel,
  SimulationComparisonRow,
  SimulationEventRow,
  SimulationManifestRow,
  SimulationMode,
  SimulationRunRow,
} from "./db-simulations";

import type {
  CoreMemoryHistoryRow,
  CoreMemoryRow,
  MemApiKeyRow,
  MemoryPoolRow,
  NoteLinkRow,
  NoteRow,
  ScoredNoteRow,
} from "./db-notes";

// ─── Base Schema (migration 0 — applied via CREATE IF NOT EXISTS) ────────────

// Schema + migrations live in ./schema.ts (pure data). Re-exported for the
// tests and tools that introspect the migration chain.
import * as memoryServiceDb from "./db-memory-service";
import { BASE_SCHEMA, MIGRATIONS } from "./schema";

// Row types for the domains lifted out of this file live in their modules and
// are re-exported here so importers keep a single path.
export type { OperationalAlertRow } from "./db-alerts";
export type { AssetRow } from "./db-assets";
export type { BenchmarkRunRow } from "./db-benchmarks";
export type {
  CanvasEdgeRow,
  CanvasIntentClaimResult,
  CanvasIntentCompleteResult,
  CanvasIntentData,
  CanvasIntentFailResult,
  CanvasIntentStatus,
  CanvasIntentSummary,
  CanvasNodeRow,
  CanvasRow,
} from "./db-canvas";
export { parseCanvasIntent } from "./db-canvas";
export type { CodingArtifactRow, CodingEventRow, CodingSessionRow } from "./db-coding";
export type { CommandHistoryRow, CommandSourceRow } from "./db-commands";
export type { ConnectorRow } from "./db-connectors";
export type { DirectMessageRow } from "./db-direct-messages";
export type {
  EvolutionActivitySummary,
  EvolutionRunRow,
  EvolutionSessionRow,
  EvolutionSessionStatus,
} from "./db-evolution";
export type {
  ExperimentParticipantRow,
  ExperimentResultRow,
  ExperimentRow,
} from "./db-experiments";
export type {
  CodingProjectRow,
  CodingServiceProbeRow,
  CodingServiceRow,
  FlywheelBindingRow,
  FlywheelBindingState,
  FlywheelCredentialBindingRow,
  FlywheelOperationSummary,
} from "./db-flywheel";
export type { GatewayRow } from "./db-gateways";
export type { MacroRow } from "./db-macros";
export type { CompactionOpts, CompactionStats } from "./db-maintenance";
export type { MarketPositionRow, MarketRow } from "./db-markets";
export type { RoomSourceRow, RoomTemplateRow } from "./db-rooms";
export type { ShellLogRow } from "./db-shell";
export type {
  PrimitiveUsageSummary,
  ProductivitySummary,
  ProductivityTrendPoint,
  PromptOutcomeSummary,
} from "./db-telemetry";
export type { AdapterLinkRow, AdapterUserMappingRow, BanRow, UserRow } from "./db-users";
export { MIGRATIONS } from "./schema";

import type { OperationalAlertRow } from "./db-alerts";
import type { AssetRow } from "./db-assets";
import type { BenchmarkRunRow } from "./db-benchmarks";
import type {
  CanvasEdgeRow,
  CanvasIntentClaimResult,
  CanvasIntentCompleteResult,
  CanvasIntentFailResult,
  CanvasIntentStatus,
  CanvasIntentSummary,
  CanvasNodeRow,
  CanvasRow,
} from "./db-canvas";
import type { CodingArtifactRow, CodingEventRow, CodingSessionRow } from "./db-coding";
import type { CommandHistoryRow, CommandSourceRow } from "./db-commands";
import type { ConnectorRow } from "./db-connectors";
import type { DirectMessageRow } from "./db-direct-messages";
import type {
  EvolutionActivitySummary,
  EvolutionRunRow,
  EvolutionSessionRow,
  EvolutionSessionStatus,
} from "./db-evolution";
import type {
  ExperimentParticipantRow,
  ExperimentResultRow,
  ExperimentRow,
} from "./db-experiments";
import type {
  CodingProjectRow,
  CodingServiceProbeRow,
  CodingServiceRow,
  FlywheelBindingRow,
  FlywheelBindingState,
  FlywheelCredentialBindingRow,
  FlywheelOperationSummary,
} from "./db-flywheel";
import type { GatewayRow } from "./db-gateways";
import type { MacroRow } from "./db-macros";
import type { CompactionOpts, CompactionStats } from "./db-maintenance";
import type { MarketPositionRow, MarketRow } from "./db-markets";
import type { RoomSourceRow, RoomTemplateRow } from "./db-rooms";
import type { ShellLogRow } from "./db-shell";
import type {
  PrimitiveUsageSummary,
  ProductivitySummary,
  ProductivityTrendPoint,
  PromptOutcomeSummary,
} from "./db-telemetry";
import type { AdapterLinkRow, AdapterUserMappingRow, BanRow, UserRow } from "./db-users";

// ─── Database Class ──────────────────────────────────────────────────────────

export class MarinaDB implements MarinaStores {
  compactMemoryReceipts(options: Parameters<typeof compactMemoryReceipts>[1]) {
    return compactMemoryReceipts(this.db, options);
  }
  private db: Database;
  private reader: Database;

  readonly durability: "normal" | "full";

  constructor(
    path = "marina.db",
    options: { durability?: "normal" | "full"; memoryLimits?: Partial<MemoryStorageAmounts> } = {},
  ) {
    this.durability = options.durability ?? "normal";
    this.db = new Database(path);
    let reader: Database | undefined;
    try {
      configureMemoryStorage(this.db, options.memoryLimits ?? memoryLimitsFromEnv());
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec(
        this.durability === "full" ? "PRAGMA synchronous=FULL" : "PRAGMA synchronous=NORMAL",
      );
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec("PRAGMA busy_timeout=5000"); // Wait up to 5s for locks instead of failing immediately
      this.db.exec("PRAGMA cache_size=-64000"); // 64MB page cache (negative = KB)
      this.db.exec("PRAGMA mmap_size=268435456"); // 256MB memory-mapped I/O for reads
      this.db.exec("PRAGMA temp_store=MEMORY"); // Keep temp tables in memory
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // Flush WAL so read-only connection can open

      this.db.exec(BASE_SCHEMA);
      this.runMigrations();

      // Checkpoint so the readonly reader can see all schema/migration changes
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      reader = new Database(path, { readonly: true });
      reader.exec("PRAGMA mmap_size=268435456");
      reader.exec("PRAGMA cache_size=-64000");
      this.reader = reader;
    } catch (error) {
      reader?.close();
      this.db.close();
      throw error;
    }
  }

  private runMigrations(): void {
    const currentVersion = this.getSchemaVersion();
    const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
    if (pending.length === 0) return;

    for (const migration of pending) {
      try {
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (?)", [
            migration.version,
          ]);
        })();
      } catch (err) {
        // Do not silently advance past a failed migration. Bun SQLite
        // auto-rolls-back the transaction, so the DB is still at the
        // previous version — halt startup with a clear error so the
        // operator can fix the migration or restore from backup before
        // running again. Continuing would leave later migrations running
        // against partially-migrated schema.
        const version = migration.version;
        const schemaNow = this.getSchemaVersion();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Migration ${version} failed — halting startup.\n  Current schema version: ${schemaNow}\n  Failed migration: ${version}\n  Error: ${msg}\n  Fix the migration or restore the DB from backup, then restart.`,
        );
      }
    }
  }

  private getSchemaVersion(): number {
    const row = this.db.query("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number | null;
    } | null;
    return row?.version ?? 0;
  }

  // ─── Entity Persistence (delegated to db-entities.ts) ────────────────────

  saveEntity(entity: Entity): void {
    // First persist of a freshly minted id ⇒ this name just (re-)entered the
    // world. Task claims carry `entity_name`, so re-key any live claim to the
    // new id here — the token `reconnect()` path did this, but a plain
    // name-login after eviction minted a new id and left the claim pointing at
    // the dead one. Idempotent; a no-op when the name has no live claims.
    const isNew = !entitiesDb.entityExists(this.db, entity.id);
    entitiesDb.saveEntity(this.db, entity);
    if (isNew) entitiesDb.migrateTaskClaimsByName(this.db, entity.name, entity.id);
  }

  loadEntity(id: EntityId): Entity | undefined {
    return entitiesDb.loadEntity(this.reader, id);
  }

  loadAllEntities(): Entity[] {
    return entitiesDb.loadAllEntities(this.reader);
  }

  findEntityIdByName(name: string): string | undefined {
    return entitiesDb.findEntityIdByName(this.db, name);
  }

  deleteEntity(id: EntityId): void {
    entitiesDb.deleteEntity(this.db, id);
  }

  loadEntitiesInRoom(room: RoomId): Entity[] {
    return entitiesDb.loadEntitiesInRoom(this.db, room);
  }

  // ─── Room Key-Value Store (delegated to db-entities.ts) ────────────────

  getRoomStoreValue(roomId: RoomId, key: string): unknown | undefined {
    return entitiesDb.getRoomStoreValue(this.reader, roomId, key);
  }

  setRoomStoreValue(roomId: RoomId, key: string, value: unknown): void {
    entitiesDb.setRoomStoreValue(this.db, roomId, key, value);
  }

  deleteRoomStoreValue(roomId: RoomId, key: string): void {
    entitiesDb.deleteRoomStoreValue(this.db, roomId, key);
  }

  getRoomStoreKeys(roomId: RoomId): string[] {
    return entitiesDb.getRoomStoreKeys(this.reader, roomId);
  }

  // ─── Event Log (delegated to db-entities.ts) ──────────────────────────

  logEvent(event: EngineEvent): void {
    entitiesDb.logEvent(this.db, event);
  }

  getRecentEvents(limit = 100): EngineEvent[] {
    return entitiesDb.getRecentEvents(this.db, limit);
  }

  getRecentTraceEvents(
    limit = 5000,
    traceId?: string,
  ): { events: EngineEvent[]; truncated: boolean } {
    return entitiesDb.getRecentTraceEvents(this.reader, limit, traceId);
  }

  getTraceEventsByTraceIds(traceIds: readonly string[]): EngineEvent[] {
    return entitiesDb.getTraceEventsByTraceIds(this.reader, traceIds);
  }

  getMaxEventId(): number {
    return entitiesDb.getMaxEventId(this.reader);
  }

  addTraceJudgment(input: entitiesDb.TraceJudgmentInput): entitiesDb.TraceJudgmentRow {
    return this.db.transaction(() => {
      const row = entitiesDb.addTraceJudgment(this.db, input);
      evidenceDb.appendEvidenceReceipt(this.db, {
        eventType: "trace_judgment",
        ref: `trace:${row.traceId}/judgment:${row.id}`,
        payload: row,
        createdAt: row.createdAt,
      });
      return row;
    })();
  }

  getTraceJudgments(traceId: string, limit = 100): entitiesDb.TraceJudgmentRow[] {
    return entitiesDb.getTraceJudgments(this.reader, traceId, limit);
  }

  getTraceJudgmentsByTraceIds(
    traceIds: readonly string[],
    limitPerTrace = 100,
  ): Map<string, entitiesDb.TraceJudgmentRow[]> {
    return entitiesDb.getTraceJudgmentsByTraceIds(this.reader, traceIds, limitPerTrace);
  }

  appendEvidenceReceipt(
    input: Parameters<typeof evidenceDb.appendEvidenceReceipt>[1],
  ): evidenceDb.EvidenceReceiptRow {
    return evidenceDb.appendEvidenceReceipt(this.db, input);
  }

  listEvidenceReceipts(limit = 100): evidenceDb.EvidenceReceiptRow[] {
    return evidenceDb.listEvidenceReceipts(this.reader, limit);
  }

  verifyEvidenceChain(): evidenceDb.EvidenceVerification {
    return evidenceDb.verifyEvidenceChain(this.reader);
  }

  getEventCount(): number {
    return entitiesDb.getEventCount(this.db);
  }

  // ─── Structured Logs (delegated to db-logs.ts) ──────────────────────

  appendStructuredLog(entry: logsDb.StoredLogEntry | Omit<logsDb.StoredLogEntry, "id">): number {
    return logsDb.appendLog(this.db, entry);
  }

  queryStructuredLogs(query: logsDb.LogQuery = {}): logsDb.LogPage {
    return logsDb.queryLogs(this.reader, query);
  }

  pruneStructuredLogs(keepLast: number): number {
    return logsDb.pruneLogs(this.db, keepLast);
  }

  pruneEvents(keepLast: number): number {
    return entitiesDb.pruneEvents(this.db, keepLast);
  }

  // ─── Journeys (delegated to db-journeys.ts) ──────────────────────────

  createJourney(input: Parameters<typeof journeysDb.createJourney>[1]): journeysDb.JourneyRow {
    return journeysDb.createJourney(this.db, input);
  }

  getJourney(id: string): journeysDb.JourneyRow | undefined {
    return journeysDb.getJourney(this.reader, id);
  }

  getLatestJourneyForRequester(requesterId: string): journeysDb.JourneyRow | undefined {
    return journeysDb.getLatestJourneyForRequester(this.reader, requesterId);
  }

  listJourneys(input: Parameters<typeof journeysDb.listJourneys>[1] = {}): journeysDb.JourneyRow[] {
    return journeysDb.listJourneys(this.reader, input);
  }

  addJourneyLink(
    input: Parameters<typeof journeysDb.addJourneyLink>[1],
  ): journeysDb.JourneyLinkRow {
    return journeysDb.addJourneyLink(this.db, input);
  }

  listJourneyLinks(journeyId: string): journeysDb.JourneyLinkRow[] {
    return journeysDb.listJourneyLinks(this.reader, journeyId);
  }

  appendJourneyEvent(
    input: Parameters<typeof journeysDb.appendJourneyEvent>[1],
  ): journeysDb.JourneyEventRow {
    return journeysDb.appendJourneyEvent(this.db, input);
  }

  listJourneyEvents(journeyId: string, limit = 200): journeysDb.JourneyEventRow[] {
    return journeysDb.listJourneyEvents(this.reader, journeyId, limit);
  }

  getJourneyWitness(journeyId: string, viewerId: string): journeysDb.JourneyWitnessRow | undefined {
    return journeysDb.getJourneyWitness(this.reader, journeyId, viewerId);
  }

  witnessJourney(
    journeyId: string,
    viewerId: string,
    eventId: number,
  ): journeysDb.JourneyWitnessRow {
    return journeysDb.witnessJourney(this.db, journeyId, viewerId, eventId);
  }

  // ─── Cognitive provenance (delegated to db-cognitive-events.ts) ───────

  appendCognitiveEvent(
    input: Parameters<typeof cognitiveEventsDb.appendCognitiveEvent>[1],
  ): cognitiveEventsDb.CognitiveEventRow {
    return cognitiveEventsDb.appendCognitiveEvent(this.db, input);
  }

  listCognitiveEvents(
    input: Parameters<typeof cognitiveEventsDb.listCognitiveEvents>[1] = {},
  ): cognitiveEventsDb.CognitiveEventRow[] {
    return cognitiveEventsDb.listCognitiveEvents(this.reader, input);
  }

  countCognitiveEvents(
    input: Parameters<typeof cognitiveEventsDb.countCognitiveEvents>[1] = {},
  ): number {
    return cognitiveEventsDb.countCognitiveEvents(this.reader, input);
  }

  verifyCognitiveEvent(row: cognitiveEventsDb.CognitiveEventRow) {
    return cognitiveEventsDb.verifyCognitiveEvent(row);
  }

  // ─── Intellect identity and lifecycle (delegated to db-intellects.ts) ──

  createIntellect(input: Parameters<typeof intellectsDb.createIntellect>[1]) {
    return intellectsDb.createIntellect(this.db, input);
  }
  getIntellect(id: string) {
    return intellectsDb.getIntellect(this.reader, id);
  }
  listIntellects(limit = 100) {
    return intellectsDb.listIntellects(this.reader, limit);
  }
  findIntellectsByIdPrefix(selector: string) {
    return intellectsDb.findIntellectsByIdPrefix(this.reader, selector);
  }
  getLatestIntellectLifecycleKind(intellectId: string) {
    return intellectsDb.getLatestIntellectLifecycleKind(this.reader, intellectId);
  }
  createIntellectInstance(input: Parameters<typeof intellectsDb.createIntellectInstance>[1]) {
    return intellectsDb.createIntellectInstance(this.db, input);
  }
  listIntellectInstances(intellectId: string) {
    return intellectsDb.listIntellectInstances(this.reader, intellectId);
  }
  appendIntellectEvent(input: Parameters<typeof intellectsDb.appendIntellectEvent>[1]) {
    return intellectsDb.appendIntellectEvent(this.db, input);
  }
  listIntellectEvents(intellectId: string, limit?: number) {
    return intellectsDb.listIntellectEvents(this.reader, intellectId, limit);
  }
  verifyIntellectEvent(row: intellectsDb.IntellectEventRow) {
    return intellectsDb.verifyIntellectEvent(row);
  }

  // ─── Generalized association (delegated to db-associations.ts) ───────

  createAssociation(input: Parameters<typeof associationsDb.createAssociation>[1]) {
    return associationsDb.createAssociation(this.db, input);
  }
  getAssociation(id: string) {
    return associationsDb.getAssociation(this.reader, id);
  }
  listAssociations(limit = 100) {
    return associationsDb.listAssociations(this.reader, limit);
  }
  appendAssociationEvent(input: Parameters<typeof associationsDb.appendAssociationEvent>[1]) {
    return associationsDb.appendAssociationEvent(this.db, input);
  }
  listAssociationEvents(associationId: string) {
    return associationsDb.listAssociationEvents(this.reader, associationId);
  }
  declareAssociationRelation(
    input: Parameters<typeof associationsDb.declareAssociationRelation>[1],
  ) {
    return associationsDb.declareAssociationRelation(this.db, input);
  }
  listAssociationRelations(associationId: string) {
    return associationsDb.listAssociationRelations(this.reader, associationId);
  }
  getAssociationRelation(id: string) {
    return associationsDb.getAssociationRelation(this.reader, id);
  }
  findAssociationsBySelector(selector: string) {
    return associationsDb.findAssociationsBySelector(this.reader, selector);
  }
  linkAssociation(input: Parameters<typeof associationsDb.linkAssociation>[1]) {
    return associationsDb.linkAssociation(this.db, input);
  }
  listAssociationLinks(associationId: string) {
    return associationsDb.listAssociationLinks(this.reader, associationId);
  }
  projectAssociation(associationId: string) {
    return associationsDb.projectAssociation(
      this.listAssociationEvents(associationId),
      this.listAssociationRelations(associationId),
    );
  }
  verifyAssociationEvent(row: associationsDb.AssociationEventRow) {
    return associationsDb.verifyAssociationEvent(row);
  }
  verifyAssociationRelation(row: associationsDb.AssociationRelationRow) {
    return associationsDb.verifyAssociationRelation(row);
  }
  verifyAssociationLink(row: associationsDb.AssociationLinkRow) {
    return associationsDb.verifyAssociationLink(row);
  }

  // ─── Cognitive and Marina reproduction ──────────────────────────────

  recordCognitiveReproduction(
    input: Parameters<typeof reproductionDb.recordCognitiveReproduction>[1],
  ) {
    return reproductionDb.recordCognitiveReproduction(this.db, input);
  }
  getCognitiveReproduction(id: string) {
    return reproductionDb.getCognitiveReproduction(this.reader, id);
  }
  listCognitiveReproductions() {
    return reproductionDb.listCognitiveReproductions(this.reader);
  }
  listReproductionComponents(id: string) {
    return reproductionDb.listReproductionComponents(this.reader, id);
  }
  verifyCognitiveReproduction(row: reproductionDb.CognitiveReproductionRow) {
    return reproductionDb.verifyCognitiveReproduction(this.reader, row);
  }
  verifyMarinaGenome(row: reproductionDb.MarinaGenomeRow) {
    return reproductionDb.verifyMarinaGenome(row);
  }
  createMarinaGenome(input: Parameters<typeof reproductionDb.createMarinaGenome>[1]) {
    return reproductionDb.createMarinaGenome(this.db, input);
  }
  getMarinaGenome(hash: string) {
    return reproductionDb.getMarinaGenome(this.reader, hash);
  }
  listMarinaGenomes() {
    return reproductionDb.listMarinaGenomes(this.reader);
  }
  createMarinaDescendant(input: Parameters<typeof reproductionDb.createMarinaDescendant>[1]) {
    return reproductionDb.createMarinaDescendant(this.db, input);
  }
  getMarinaDescendant(id: string) {
    return reproductionDb.getMarinaDescendant(this.reader, id);
  }
  listMarinaDescendants() {
    return reproductionDb.listMarinaDescendants(this.reader);
  }

  // ─── Transparent meshes ──────────────────────────────────────────────

  createMesh(input: Parameters<typeof meshesDb.createMesh>[1]) {
    return meshesDb.createMesh(this.db, input);
  }
  getMesh(id: string) {
    return meshesDb.getMesh(this.reader, id);
  }
  listMeshes(limit?: number) {
    return meshesDb.listMeshes(this.reader, limit);
  }
  findMeshesBySelector(selector: string) {
    return meshesDb.findMeshesBySelector(this.reader, selector);
  }
  appendMeshMembershipEvent(input: Parameters<typeof meshesDb.appendMeshMembershipEvent>[1]) {
    return meshesDb.appendMeshMembershipEvent(this.db, input);
  }
  listMeshMembershipEvents(id: string) {
    return meshesDb.listMeshMembershipEvents(this.reader, id);
  }
  appendMeshEvent(input: Parameters<typeof meshesDb.appendMeshEvent>[1]) {
    return meshesDb.appendMeshEvent(this.db, input);
  }
  listMeshEvents(id: string, limit?: number) {
    return meshesDb.listMeshEvents(this.reader, id, limit);
  }
  getMeshEvent(id: string) {
    return meshesDb.getMeshEvent(this.reader, id);
  }
  countMeshEvents(id: string) {
    return meshesDb.countMeshEvents(this.reader, id);
  }
  witnessMeshEvent(input: Parameters<typeof meshesDb.witnessMeshEvent>[1]) {
    return meshesDb.witnessMeshEvent(this.db, input);
  }
  listMeshWitnesses(id: string, limit?: number) {
    return meshesDb.listMeshWitnesses(this.reader, id, limit);
  }
  countMeshWitnesses(id: string) {
    return meshesDb.countMeshWitnesses(this.reader, id);
  }
  createMeshTranslation(input: Parameters<typeof meshesDb.createMeshTranslation>[1]) {
    return meshesDb.createMeshTranslation(this.db, input);
  }
  listMeshTranslations(id: string) {
    return meshesDb.listMeshTranslations(this.reader, id);
  }
  verifyMeshEvent(row: meshesDb.MeshEventRow) {
    return meshesDb.verifyMeshEvent(row);
  }
  exportMeshEvent(row: meshesDb.MeshEventRow) {
    return meshesDb.exportMeshEvent(row);
  }
  importMeshEvent(token: string, opts?: { expectedMeshId?: string }) {
    return meshesDb.importMeshEvent(this.db, token, opts);
  }

  // ─── Asset-neutral economics ────────────────────────────────────────
  createEconomicContract(input: Parameters<typeof economicsDb.createEconomicContract>[1]) {
    return economicsDb.createEconomicContract(this.db, input);
  }
  getEconomicContract(id: string) {
    return economicsDb.getEconomicContract(this.reader, id);
  }
  listEconomicContracts() {
    return economicsDb.listEconomicContracts(this.reader);
  }
  appendEconomicEvent(input: Parameters<typeof economicsDb.appendEconomicEvent>[1]) {
    return economicsDb.appendEconomicEvent(this.db, input);
  }
  listEconomicEvents(id: string, limit?: number) {
    return economicsDb.listEconomicEvents(this.reader, id, limit);
  }
  verifyEconomicEvent(row: economicsDb.EconomicEventRow) {
    return economicsDb.verifyEconomicEvent(row);
  }
  createEconomicAdapter(input: Parameters<typeof economicsDb.createEconomicAdapter>[1]) {
    return economicsDb.createEconomicAdapter(this.db, input);
  }
  listEconomicAdapters() {
    return economicsDb.listEconomicAdapters(this.reader);
  }

  // ─── Unified simulation laboratory ──────────────────────────────────
  createSimulationManifest(input: Parameters<typeof simulationsDb.createSimulationManifest>[1]) {
    return simulationsDb.createSimulationManifest(this.db, input);
  }
  getSimulationManifest(hash: string) {
    return simulationsDb.getSimulationManifest(this.reader, hash);
  }
  listSimulationManifests() {
    return simulationsDb.listSimulationManifests(this.reader);
  }
  createSimulationRun(input: Parameters<typeof simulationsDb.createSimulationRun>[1]) {
    return simulationsDb.createSimulationRun(this.db, input);
  }
  getSimulationRun(id: string) {
    return simulationsDb.getSimulationRun(this.reader, id);
  }
  listSimulationRuns(hash?: string) {
    return simulationsDb.listSimulationRuns(this.reader, hash);
  }
  appendSimulationEvent(input: Parameters<typeof simulationsDb.appendSimulationEvent>[1]) {
    return simulationsDb.appendSimulationEvent(this.db, input);
  }
  listSimulationEvents(id: string) {
    return simulationsDb.listSimulationEvents(this.reader, id);
  }
  createSimulationComparison(
    input: Parameters<typeof simulationsDb.createSimulationComparison>[1],
  ) {
    return simulationsDb.createSimulationComparison(this.db, input);
  }
  listSimulationComparisons() {
    return simulationsDb.listSimulationComparisons(this.reader);
  }

  // ─── Recursive civilization mutation lineage ────────────────────────
  appendCivilizationMutation(input: Parameters<typeof mutationsDb.appendCivilizationMutation>[1]) {
    return mutationsDb.appendCivilizationMutation(this.db, input);
  }
  getCivilizationMutation(id: string) {
    return mutationsDb.getCivilizationMutation(this.reader, id);
  }
  listCivilizationMutations(domain?: string, targetRef?: string) {
    return mutationsDb.listCivilizationMutations(this.reader, domain, targetRef);
  }
  verifyCivilizationMutation(row: mutationsDb.CivilizationMutationRow) {
    return mutationsDb.verifyCivilizationMutation(row);
  }

  // ─── Session Persistence (delegated to db-entities.ts) ─────────────────

  saveSession(session: Session): void {
    entitiesDb.saveSession(this.db, session);
  }

  loadSession(token: string): Session | undefined {
    return entitiesDb.loadSession(this.db, token);
  }

  deleteSession(token: string): void {
    entitiesDb.deleteSession(this.db, token);
  }

  deleteSessionsByEntity(entityId: EntityId): void {
    entitiesDb.deleteSessionsByEntity(this.db, entityId);
  }

  deleteExpiredSessions(now: number): number {
    return entitiesDb.deleteExpiredSessions(this.db, now);
  }

  loadSessionByEntity(entityId: EntityId): Session | undefined {
    return entitiesDb.loadSessionByEntity(this.db, entityId);
  }

  // ─── Bulk Operations (delegated to db-entities.ts) ─────────────────────

  saveAllEntities(entities: Entity[]): void {
    entitiesDb.saveAllEntities(this.db, entities);
  }

  // ─── Channel Persistence (delegated to db-channels.ts) ──────────────────

  createChannel(c: {
    id: string;
    type: string;
    name: string;
    ownerId?: string;
    persistence?: string;
    retentionHours?: number;
  }): void {
    channelsDb.createChannel(this.db, c);
  }
  getChannel(id: string): ChannelRow | undefined {
    return channelsDb.getChannel(this.db, id);
  }
  getChannelByName(name: string): ChannelRow | undefined {
    return channelsDb.getChannelByName(this.db, name);
  }
  getAllChannels(): ChannelRow[] {
    return channelsDb.getAllChannels(this.db);
  }
  deleteChannel(id: string): void {
    channelsDb.deleteChannel(this.db, id);
  }
  // Membership rows are keyed by the durable account id (migration 117);
  // callers keep passing entity ids and `getChannelMembers` projects the live
  // id back (`liveEntityIdSql`).
  addChannelMember(channelId: string, entityId: string, canRead = true, canWrite = true): void {
    channelsDb.addChannelMember(
      this.db,
      channelId,
      this.durableEntityKey(entityId),
      canRead,
      canWrite,
    );
  }
  removeChannelMember(channelId: string, entityId: string): void {
    channelsDb.removeChannelMember(this.db, channelId, this.durableEntityKey(entityId));
  }
  getChannelMembers(channelId: string): ChannelMemberRow[] {
    return channelsDb.getChannelMembers(this.db, channelId);
  }
  getEntityChannels(entityId: string): ChannelRow[] {
    return channelsDb.getEntityChannels(this.db, this.durableEntityKey(entityId));
  }
  isChannelMember(channelId: string, entityId: string): boolean {
    return channelsDb.isChannelMember(this.db, channelId, this.durableEntityKey(entityId));
  }
  addChannelMessage(
    channelId: string,
    senderId: string,
    senderName: string,
    content: string,
  ): number {
    return channelsDb.addChannelMessage(this.db, channelId, senderId, senderName, content);
  }
  getChannelHistory(channelId: string, limit = 20): ChannelMessageRow[] {
    return channelsDb.getChannelHistory(this.db, channelId, limit);
  }
  countChannelMessages(channelId: string): number {
    return channelsDb.countChannelMessages(this.db, channelId);
  }
  countBoardPosts(boardId: string, archived = false): number {
    return channelsDb.countBoardPosts(this.db, boardId, archived);
  }
  pruneExpiredMessages(now: number): number {
    return channelsDb.pruneExpiredMessages(this.db, now);
  }

  // ─── Board Persistence (delegated to db-channels.ts) ───────────────────

  createBoard(b: {
    id: string;
    name: string;
    scopeType?: string;
    scopeId?: string;
    readRank?: number;
    writeRank?: number;
    pinRank?: number;
  }): void {
    channelsDb.createBoard(this.db, b);
  }
  getBoard(id: string): BoardRow | undefined {
    return channelsDb.getBoard(this.db, id);
  }
  raiseBoardRanks(boardId: string, ranks: { writeRank?: number; pinRank?: number }): void {
    channelsDb.raiseBoardRanks(this.db, boardId, ranks);
  }

  getBoardByName(name: string): BoardRow | undefined {
    return channelsDb.getBoardByName(this.db, name);
  }
  getBoardsForScope(scopeType: string, scopeId: string): BoardRow[] {
    return channelsDb.getBoardsForScope(this.db, scopeType, scopeId);
  }
  getAllBoards(): BoardRow[] {
    return channelsDb.getAllBoards(this.db);
  }
  deleteBoard(id: string): void {
    channelsDb.deleteBoard(this.db, id);
  }
  createBoardPost(post: {
    boardId: string;
    parentId?: number;
    authorId: string;
    authorName: string;
    title?: string;
    body: string;
    tags?: string[];
  }): number {
    // `author_id` is durable-keyed (migration 119); reads project the live id back.
    return channelsDb.createBoardPost(this.db, {
      ...post,
      authorId: this.durableEntityKey(post.authorId),
    });
  }
  getBoardPost(id: number): BoardPostRow | undefined {
    return channelsDb.getBoardPost(this.db, id);
  }
  listBoardPosts(
    boardId: string,
    opts?: { offset?: number; limit?: number; archived?: boolean },
  ): BoardPostRow[] {
    return channelsDb.listBoardPosts(this.db, boardId, opts);
  }
  searchBoardPosts(boardId: string, query: string): BoardPostRow[] {
    return channelsDb.searchBoardPosts(this.db, boardId, query);
  }
  rebuildBoardSearchIndex(): void {
    channelsDb.rebuildBoardSearchIndex(this.db);
  }
  pinBoardPost(postId: number): void {
    channelsDb.pinBoardPost(this.db, postId);
  }
  unpinBoardPost(postId: number): void {
    channelsDb.unpinBoardPost(this.db, postId);
  }
  archiveBoardPost(postId: number): void {
    channelsDb.archiveBoardPost(this.db, postId);
  }
  voteBoardPost(postId: number, entityId: string, value: number, score = 0): void {
    channelsDb.voteBoardPost(this.db, postId, this.durableEntityKey(entityId), value, score);
  }
  getBoardPostVoteCount(postId: number): number {
    return channelsDb.getBoardPostVoteCount(this.db, postId);
  }
  autoArchiveBoardPosts(daysOld: number, minVotes: number): number {
    return channelsDb.autoArchiveBoardPosts(this.db, daysOld, minVotes);
  }
  getBoardPostScores(postId: number): BoardVoteRow[] {
    return channelsDb.getBoardPostScores(this.db, postId);
  }
  getScoreMatrix(boardId: string): BoardVoteRow[] {
    return channelsDb.getScoreMatrix(this.db, boardId);
  }

  // ─── Group Persistence (delegated to db-channels.ts) ───────────────────

  createGroup(g: {
    id: string;
    name: string;
    description?: string;
    leaderId: string;
    channelId?: string;
    boardId?: string;
  }): void {
    // Durable-keyed leader (migration 118); reads project the live id back.
    channelsDb.createGroup(this.db, { ...g, leaderId: this.durableEntityKey(g.leaderId) });
  }
  getGroup(id: string): GroupRow | undefined {
    return channelsDb.getGroup(this.db, id);
  }
  getGroupByName(name: string): GroupRow | undefined {
    return channelsDb.getGroupByName(this.db, name);
  }
  getAllGroups(): GroupRow[] {
    return channelsDb.getAllGroups(this.db);
  }
  deleteGroup(id: string): void {
    channelsDb.deleteGroup(this.db, id);
  }
  updateGroupChannelAndBoard(groupId: string, channelId: string, boardId: string): void {
    channelsDb.updateGroupChannelAndBoard(this.db, groupId, channelId, boardId);
  }
  // Durable-keyed (migration 117) — see the channel-member delegates above.
  addGroupMember(groupId: string, entityId: string, rank = 0): void {
    channelsDb.addGroupMember(this.db, groupId, this.durableEntityKey(entityId), rank);
  }
  removeGroupMember(groupId: string, entityId: string): void {
    channelsDb.removeGroupMember(this.db, groupId, this.durableEntityKey(entityId));
  }
  getGroupMembers(groupId: string): GroupMemberRow[] {
    return channelsDb.getGroupMembers(this.db, groupId);
  }
  getGroupMember(groupId: string, entityId: string): GroupMemberRow | undefined {
    return channelsDb.getGroupMember(this.db, groupId, this.durableEntityKey(entityId));
  }
  getEntityGroups(entityId: string): GroupRow[] {
    return channelsDb.getEntityGroups(this.db, this.durableEntityKey(entityId));
  }
  updateGroupMemberRank(groupId: string, entityId: string, rank: number): void {
    channelsDb.updateGroupMemberRank(this.db, groupId, this.durableEntityKey(entityId), rank);
  }

  // ─── Crew Persistence (delegated to db-crews.ts) ────────────────────────

  saveCrew(c: Parameters<typeof crewsDb.saveCrew>[1]): void {
    crewsDb.saveCrew(this.db, c);
  }
  getCrew(id: string): import("./db-crews").CrewRow | undefined {
    return crewsDb.getCrew(this.db, id);
  }
  getCrewByName(name: string): import("./db-crews").CrewRow | undefined {
    return crewsDb.getCrewByName(this.db, name);
  }
  getAllCrews(): import("./db-crews").CrewRow[] {
    return crewsDb.getAllCrews(this.db);
  }
  deleteCrew(id: string): void {
    crewsDb.deleteCrew(this.db, id);
  }
  addCrewMember(crewId: string, agentName: string, role: string, joinedAt: number): void {
    crewsDb.addCrewMember(this.db, crewId, agentName, role, joinedAt);
  }
  removeCrewMember(crewId: string, agentName: string): void {
    crewsDb.removeCrewMember(this.db, crewId, agentName);
  }
  getCrewMembers(crewId: string): import("./db-crews").CrewMemberRow[] {
    return crewsDb.getCrewMembers(this.db, crewId);
  }
  saveCrewInvitation(row: import("./db-crews").CrewInvitationRow): void {
    crewsDb.saveCrewInvitation(this.db, row);
  }
  setCrewInvitationStatus(
    crewId: string,
    agentName: string,
    status: import("./db-crews").CrewInvitationRow["status"],
    respondedAt: number,
  ): void {
    crewsDb.setCrewInvitationStatus(this.db, crewId, agentName, status, respondedAt);
  }
  deleteCrewInvitations(crewId: string): void {
    crewsDb.deleteCrewInvitations(this.db, crewId);
  }
  getOpenCrewInvitations(): import("./db-crews").CrewInvitationRow[] {
    return crewsDb.getOpenCrewInvitations(this.db);
  }

  // ─── Durable identity key ───────────────────────────────────────────────
  //
  // Entity ids are transient: an entity evicted after the reconnect grace is
  // hard-deleted and the next name-login mints a fresh id. Reputation ledgers
  // (standing, competence, witness attestations) must therefore be keyed by
  // the durable world account — `users.id`, a stable UUID keyed by name that
  // the durable memory service already binds to. Call sites keep passing
  // entity ids; the delegates below resolve them here (migration 109
  // backfilled legacy rows). Ids with no entity/user row (tests, service
  // principals) pass through unchanged.

  // Bounded LRU: Map iteration order is insertion order, so a hit is refreshed
  // by delete + re-insert and the eviction victim is always the first key.
  // Entity ids re-mint on every name-login, so an unbounded map would grow
  // with the lifetime login count. `deleteUser` still drops every entry that
  // resolved to the deleted account.
  private durableKeyCache = new Map<string, string>();

  durableEntityKey(entityId: string): string {
    const cached = this.durableKeyCache.get(entityId);
    if (cached) {
      this.durableKeyCache.delete(entityId);
      this.durableKeyCache.set(entityId, cached);
      return cached;
    }
    const row = this.db
      .query("SELECT u.id AS id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = ?")
      .get(entityId) as { id: string } | null;
    if (!row) return entityId;
    if (this.durableKeyCache.size >= DURABLE_KEY_CACHE_MAX) {
      const oldest = this.durableKeyCache.keys().next().value;
      if (oldest !== undefined) this.durableKeyCache.delete(oldest);
    }
    this.durableKeyCache.set(entityId, row.id);
    return row.id;
  }

  /** Durable key for a world account by name, or undefined when no account exists. */
  durableKeyForName(name: string): string | undefined {
    return this.getUserByName(name)?.id;
  }

  // ─── Transactions ───────────────────────────────────────────────────────

  /**
   * Run `fn` inside one SQLite transaction (nested calls become savepoints).
   * Managers that compose several delegate writes into one logical change
   * (`TaskManager.approveSubmission`, …) wrap them here so a failure on the
   * last write rolls the earlier ones back.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── Retention primitives (used by src/engine/retention.ts) ─────────────

  tableExists(table: string): boolean {
    return maintenanceDb.tableExists(this.reader, table);
  }

  tableColumns(table: string): string[] {
    return maintenanceDb.tableColumns(this.reader, table);
  }

  /**
   * Delete at most `limit` rows of `table` matching `whereSql`, selected by
   * rowid so the statement stays bounded regardless of table size. Returns the
   * number of rows deleted. `table` and `whereSql` are trusted (policy code),
   * never user input.
   */
  deleteBatch(table: string, whereSql: string, params: (string | number)[], limit: number): number {
    return maintenanceDb.deleteBatch(this.db, table, whereSql, params, limit);
  }

  // ─── Competence Persistence (delegated to db-competence.ts) ─────────────

  getCompetence(entityId: string, gate: string) {
    return competenceDb.getCompetence(this.db, this.durableEntityKey(entityId), gate);
  }
  listCompetenceForEntity(entityId: string) {
    return competenceDb.listCompetenceForEntity(this.db, this.durableEntityKey(entityId));
  }
  recordDemonstration(entityId: string, gate: string, unlockAt: number, now: number): void {
    competenceDb.recordDemonstration(this.db, this.durableEntityKey(entityId), gate, unlockAt, now);
  }
  grantCompetence(entityId: string, gate: string): void {
    competenceDb.grantCompetence(this.db, this.durableEntityKey(entityId), gate);
  }
  // ─── Witness ledger (delegated to db-witness.ts) ─────────────────────

  createWitnessRow(input: Parameters<typeof witnessDb.createWitnessRow>[1]) {
    return witnessDb.createWitnessRow(this.db, {
      ...input,
      entityId: this.durableEntityKey(input.entityId),
    });
  }
  getWitnessRow(id: number) {
    return witnessDb.getWitnessRow(this.reader, id);
  }
  getOpenSupervisionWindow(entityId: string, gate: string, now?: number) {
    return witnessDb.getOpenWindow(this.db, this.durableEntityKey(entityId), gate, now);
  }
  consumeSupervisionWindow(entityId: string, gate: string, now?: number) {
    return witnessDb.consumeWindow(this.db, this.durableEntityKey(entityId), gate, now);
  }
  resolveWitnessRow(
    id: number,
    status: Parameters<typeof witnessDb.resolveWitnessRow>[2],
    input?: Parameters<typeof witnessDb.resolveWitnessRow>[3],
  ) {
    return witnessDb.resolveWitnessRow(this.db, id, status, input);
  }
  listOpenWitnessRows(opts?: Parameters<typeof witnessDb.listOpenWitnessRows>[1]) {
    return witnessDb.listOpenWitnessRows(
      this.db,
      opts?.entityId ? { ...opts, entityId: this.durableEntityKey(opts.entityId) } : opts,
    );
  }
  countAttestedDemonstrations(entityId: string, gate: string) {
    return witnessDb.countAttested(this.reader, this.durableEntityKey(entityId), gate);
  }

  revokeCompetence(entityId: string, gate: string): void {
    competenceDb.revokeCompetence(this.db, this.durableEntityKey(entityId), gate);
  }

  // ─── Standing Persistence (delegated to db-standing.ts) ─────────────────

  appendStandingEvent(row: Parameters<typeof standingDb.appendStandingEvent>[1]): void {
    standingDb.appendStandingEvent(this.db, {
      ...row,
      entityId: this.durableEntityKey(row.entityId),
    });
  }
  computeStanding(entityId: string, halfLifeMs: number, horizonMs: number, now: number): number {
    return standingDb.computeStanding(
      this.db,
      this.durableEntityKey(entityId),
      halfLifeMs,
      horizonMs,
      now,
    );
  }
  countStandingEvents(entityId: string, kind: string, since: number): number {
    return standingDb.countStandingEvents(this.db, this.durableEntityKey(entityId), kind, since);
  }
  getStandingCache(entityId: string) {
    return standingDb.getStandingCache(this.db, this.durableEntityKey(entityId));
  }
  setStandingCache(entityId: string, standing: number, now: number): void {
    standingDb.setStandingCache(this.db, this.durableEntityKey(entityId), standing, now);
  }
  listStandingEntities(): string[] {
    return standingDb.listStandingEntities(this.db);
  }
  staleStandingEntities(cutoff: number): string[] {
    return standingDb.staleStandingEntities(this.db, cutoff);
  }
  standingLeaderboard(limit: number) {
    return standingDb.standingLeaderboard(this.db, limit);
  }
  ledgerForEntity(entityId: string, limit: number) {
    return standingDb.ledgerForEntity(this.db, this.durableEntityKey(entityId), limit);
  }

  // ─── Task Persistence (delegated to db-tasks.ts) ────────────────────────

  createTask(task: {
    groupId?: string;
    title: string;
    description?: string;
    creatorId: string;
    creatorName: string;
    validationMode?: string;
    standing?: number;
    parentTaskId?: number;
    priority?: number;
  }): number {
    // Durable-keyed creator (migration 118); reads project the live id back.
    return tasksDb.createTask(this.db, {
      ...task,
      creatorId: this.durableEntityKey(task.creatorId),
    });
  }

  updateTaskProgress(id: number, progress: number): void {
    tasksDb.updateTaskProgress(this.db, id, progress);
  }

  updateTaskPriority(id: number, priority: number): void {
    tasksDb.updateTaskPriority(this.db, id, priority);
  }

  getTask(id: number): TaskRow | undefined {
    return tasksDb.getTask(this.db, id);
  }

  listTasks(opts?: {
    status?: string;
    groupId?: string;
    parentId?: number;
    limit?: number;
    orderByStanding?: boolean;
  }): TaskRow[] {
    return tasksDb.listTasks(this.db, opts);
  }

  countTasks(opts?: { status?: string; groupId?: string; parentId?: number }): number {
    return tasksDb.countTasks(this.db, opts);
  }

  updateTaskStatus(id: number, status: string): void {
    tasksDb.updateTaskStatus(this.db, id, status);
  }

  createTaskClaim(
    taskId: number,
    entityId: string,
    entityName: string,
    leaseExpiresAt?: number,
  ): void {
    tasksDb.createTaskClaim(this.db, taskId, entityId, entityName, leaseExpiresAt);
  }

  getTaskClaim(taskId: number, entityId: string): TaskClaimRow | undefined {
    return tasksDb.getTaskClaim(this.db, taskId, entityId);
  }

  listTasksClaimedBy(entityId: string): TaskRow[] {
    return tasksDb.listTasksClaimedBy(this.db, entityId);
  }

  getTaskClaims(taskId: number): TaskClaimRow[] {
    return tasksDb.getTaskClaims(this.db, taskId);
  }

  updateTaskClaimStatus(
    taskId: number,
    entityId: string,
    status: string,
    submissionText?: string,
  ): void {
    tasksDb.updateTaskClaimStatus(this.db, taskId, entityId, status, submissionText);
  }

  renewTaskClaim(taskId: number, entityId: string, leaseExpiresAt: number): boolean {
    return tasksDb.renewTaskClaim(this.db, taskId, entityId, leaseExpiresAt);
  }

  recoverExpiredTaskClaims(now = Date.now()): TaskClaimRow[] {
    return tasksDb.recoverExpiredTaskClaims(this.db, now);
  }

  // ─── Durable direct-message receipts ─────────────────────────────────

  createDirectMessage(message: {
    correlationId: string;
    dedupeKey: string;
    senderId: string;
    senderName: string;
    targetId: string;
    targetName: string;
    content: string;
    deadlineAt?: number;
  }): DirectMessageRow {
    return directMessagesDb.createDirectMessage(this.db, message);
  }

  getDirectMessage(id: number): DirectMessageRow | undefined {
    return directMessagesDb.getDirectMessage(this.db, id);
  }

  listDirectMessageInbox(targetId: string, limit = 20): DirectMessageRow[] {
    return directMessagesDb.listDirectMessageInbox(this.db, targetId, limit);
  }

  acknowledgeDirectMessage(id: number, targetId: string, replyMessageId?: number): boolean {
    return directMessagesDb.acknowledgeDirectMessage(this.db, id, targetId, replyMessageId);
  }

  expireDirectMessages(now = Date.now()): number {
    return directMessagesDb.expireDirectMessages(this.db, now);
  }

  getChildTaskCount(parentId: number): { total: number; completed: number } {
    return tasksDb.getChildTaskCount(this.db, parentId);
  }

  setTaskParent(taskId: number, parentTaskId: number): void {
    tasksDb.setTaskParent(this.db, taskId, parentTaskId);
  }

  searchTasks(
    query: string,
    opts?: { status?: string; limit?: number },
  ): (TaskRow & { score: number })[] {
    return tasksDb.searchTasks(this.db, query, opts);
  }

  recordStandingEarned(entityId: string, entityName: string, taskId: number, amount: number): void {
    tasksDb.recordStandingEarned(this.db, entityId, entityName, taskId, amount);
  }

  getEntityStanding(entityId: string): number {
    return tasksDb.getEntityStanding(this.db, entityId);
  }

  getStandingLeaderboard(limit = 10): { entityName: string; total: number; taskCount: number }[] {
    return tasksDb.getStandingLeaderboard(this.db, limit);
  }

  rejectAllOtherClaims(taskId: number, winnerEntityId: string): void {
    tasksDb.rejectAllOtherClaims(this.db, taskId, winnerEntityId);
  }

  // ─── Macro Persistence ────────────────────────────────────────────────────
  // `author_id` is durable-keyed (migration 119): writes and `author_id = ?`
  // lookups resolve `durableEntityKey()`, every read projects the live entity
  // id back so `MacroManager` keeps comparing against the caller's entity id.

  createMacro(name: string, authorId: string, command: string): number {
    return macrosDb.createMacro(this.db, this.durableEntityKey(authorId), name, command);
  }

  getMacro(id: number): MacroRow | undefined {
    return macrosDb.getMacro(this.db, id);
  }

  getMacroByName(name: string, authorId: string): MacroRow | undefined {
    return macrosDb.getMacroByName(this.db, this.durableEntityKey(authorId), name);
  }

  listMacros(authorId?: string): MacroRow[] {
    return macrosDb.listMacros(this.db, authorId ? this.durableEntityKey(authorId) : undefined);
  }

  updateMacro(id: number, command: string): void {
    macrosDb.updateMacro(this.db, id, command);
  }

  deleteMacro(id: number): void {
    macrosDb.deleteMacro(this.db, id);
  }

  // ─── Room Source Persistence ─────────────────────────────────────────────

  saveRoomSource(opts: {
    roomId: string;
    source: string;
    authorId: string;
    authorName: string;
    valid?: boolean;
  }): number {
    return roomsDb.saveRoomSource(this.db, opts);
  }

  getRoomSource(roomId: string, version?: number): RoomSourceRow | undefined {
    return roomsDb.getRoomSource(this.db, roomId, version);
  }

  getRoomSourceHistory(roomId: string, limit = 20): RoomSourceRow[] {
    return roomsDb.getRoomSourceHistory(this.db, roomId, limit);
  }

  getLatestRoomSourceVersion(roomId: string): number {
    return roomsDb.getLatestRoomSourceVersion(this.db, roomId);
  }

  getAllRoomSourceIds(): string[] {
    return roomsDb.getAllRoomSourceIds(this.db);
  }

  markRoomSourceValid(roomId: string, version: number): void {
    roomsDb.markRoomSourceValid(this.db, roomId, version);
  }

  deleteRoomSources(roomId: string): void {
    roomsDb.deleteRoomSources(this.db, roomId);
  }

  // ─── Room Template Persistence ──────────────────────────────────────────

  saveRoomTemplate(opts: {
    name: string;
    source: string;
    authorId: string;
    authorName: string;
    description?: string;
  }): void {
    roomsDb.saveRoomTemplate(this.db, opts);
  }

  getRoomTemplate(name: string): RoomTemplateRow | undefined {
    return roomsDb.getRoomTemplate(this.db, name);
  }

  getAllRoomTemplates(): RoomTemplateRow[] {
    return roomsDb.getAllRoomTemplates(this.db);
  }

  deleteRoomTemplate(name: string): void {
    roomsDb.deleteRoomTemplate(this.db, name);
  }

  // ─── User Persistence ───────────────────────────────────────────────────

  createUser(user: { id: string; name: string; rank?: number }): void {
    usersDb.createUser(this.db, user);
  }

  getUser(id: string): UserRow | undefined {
    return usersDb.getUser(this.db, id);
  }

  getUserByName(name: string): UserRow | undefined {
    return usersDb.getUserByName(this.db, name);
  }

  /** All user rows, name-ordered. For maintenance/admin tooling. */
  listUsers(): UserRow[] {
    return usersDb.listUsers(this.db);
  }

  updateUserLastLogin(id: string): void {
    usersDb.updateUserLastLogin(this.db, id);
  }

  updateUserRank(id: string, rank: number): void {
    usersDb.updateUserRank(this.db, id, rank);
  }

  /** Look up the named user bound to a verified external-identity subject. */
  getUserByAuthSubject(subject: string): UserRow | undefined {
    return usersDb.getUserByAuthSubject(this.db, subject);
  }

  /** Bind a verified identity (subject + email) to an existing named user. */
  bindAuthSubject(id: string, subject: string, email: string): void {
    usersDb.bindAuthSubject(this.db, id, subject, email);
  }

  updateUserProperties(id: string, properties: Record<string, unknown>): void {
    usersDb.updateUserProperties(this.db, id, properties);
  }

  deleteUser(id: string): void {
    usersDb.deleteUser(this.db, id);
    this.durableKeyCache.forEach((value, key) => {
      if (value === id) this.durableKeyCache.delete(key);
    });
  }

  // ─── Ban Persistence ──────────────────────────────────────────────────

  addBan(name: string, bannedBy: string, reason = ""): void {
    usersDb.addBan(this.db, name, bannedBy, reason);
  }

  removeBan(name: string): boolean {
    return usersDb.removeBan(this.db, name);
  }

  isBanned(name: string): boolean {
    return usersDb.isBanned(this.db, name);
  }

  getBan(name: string): BanRow | undefined {
    return usersDb.getBan(this.db, name);
  }

  listBans(): BanRow[] {
    return usersDb.listBans(this.db);
  }

  // ─── Adapter Link Persistence ──────────────────────────────────────────

  linkAdapter(adapter: string, externalId: string, userId: string): void {
    usersDb.linkAdapter(this.db, adapter, externalId, userId);
  }

  getLinkedUser(adapter: string, externalId: string): AdapterLinkRow | undefined {
    return usersDb.getLinkedUser(this.db, adapter, externalId);
  }

  getUserLinks(userId: string): AdapterLinkRow[] {
    return usersDb.getUserLinks(this.db, userId);
  }

  unlinkAdapter(adapter: string, externalId: string): boolean {
    return usersDb.unlinkAdapter(this.db, adapter, externalId);
  }

  // ─── Adapter User Mappings ────────────────────────────────────────────────

  saveAdapterUserMapping(platform: string, platformUserId: string, entityName: string): void {
    usersDb.saveAdapterUserMapping(this.db, platform, platformUserId, entityName);
  }

  getAdapterUserMapping(
    platform: string,
    platformUserId: string,
  ): AdapterUserMappingRow | undefined {
    return usersDb.getAdapterUserMapping(this.db, platform, platformUserId);
  }

  getAdapterUserMappings(platform: string): AdapterUserMappingRow[] {
    return usersDb.getAdapterUserMappings(this.db, platform);
  }

  deleteAdapterUserMapping(platform: string, platformUserId: string): boolean {
    return usersDb.deleteAdapterUserMapping(this.db, platform, platformUserId);
  }

  // ─── Notes Persistence (delegated to db-notes.ts) ───────────────────────

  createNote(
    entityName: string,
    content: string,
    roomId?: string,
    opts?: {
      importance?: number;
      noteType?: string;
      poolId?: string;
      supersedesId?: number;
      tier?: NoteTier;
      skipDedup?: boolean;
      confidence?: number;
      verificationStatus?: string;
      claimKey?: string;
    },
  ): number {
    return notesDb.createNote(this.db, entityName, content, roomId, opts);
  }

  getNotesByEntity(entityName: string, limit = 50): NoteRow[] {
    return notesDb.getNotesByEntity(this.db, entityName, limit);
  }

  getNotesByType(entityName: string, noteType: string, limit = 100): NoteRow[] {
    return notesDb.getNotesByType(this.db, entityName, noteType, limit);
  }

  createNoteWithLinks(
    entityName: string,
    content: string,
    opts: { importance?: number; noteType?: string },
    links: { target: number; relationship: string }[],
  ): number {
    return notesDb.createNoteWithLinks(this.db, entityName, content, opts, links);
  }

  reviseNote(
    entityName: string,
    noteId: number,
    content: string,
    opts?: { importance?: number; noteType?: string },
  ): number | undefined {
    return notesDb.reviseNote(this.db, entityName, noteId, content, opts);
  }

  getNotesByRoom(roomId: string, limit = 50): NoteRow[] {
    return notesDb.getNotesByRoom(this.db, roomId, limit);
  }

  searchNotes(entityName: string, query: string): NoteRow[] {
    return notesDb.searchNotes(this.db, entityName, query);
  }

  deleteNote(id: number, entityName: string): boolean {
    return notesDb.deleteNote(this.db, id, entityName);
  }

  getNote(id: number): NoteRow | undefined {
    return notesDb.getNote(this.db, id);
  }

  getNotes(ids: number[]): NoteRow[] {
    return notesDb.getNotes(this.db, ids);
  }

  addNoteSource(noteId: number, source: notesDb.NoteSourceInput): number {
    return notesDb.addNoteSource(this.db, noteId, source);
  }
  getNoteSources(noteId: number): notesDb.NoteSourceRow[] {
    return notesDb.getNoteSources(this.db, noteId);
  }
  getNotesBySourceUrl(url: string, entityName?: string, limit?: number): NoteRow[] {
    return notesDb.getNotesBySourceUrl(this.db, url, entityName, limit);
  }
  recordNoteVerification(
    noteId: number,
    verifier: string,
    status: "unverified" | "verified" | "disputed",
    confidence: number,
    rationale?: string,
    evidenceSourceId?: number,
  ): number {
    return notesDb.recordNoteVerification(
      this.db,
      noteId,
      verifier,
      status,
      confidence,
      rationale,
      evidenceSourceId,
    );
  }
  getNoteVerifications(noteId: number): notesDb.NoteVerificationRow[] {
    return notesDb.getNoteVerifications(this.db, noteId);
  }
  refreshContradictionCases(): number {
    return notesDb.refreshContradictionCases(this.db);
  }
  getContradictionCase(id: number): notesDb.ContradictionCaseRow | undefined {
    return notesDb.getContradictionCase(this.db, id);
  }
  listContradictionCases(
    status?: "open" | "resolved",
    limit = 100,
  ): notesDb.ContradictionCaseRow[] {
    return notesDb.listContradictionCases(this.db, status, limit);
  }
  resolveContradictionCase(
    id: number,
    resolution: "left" | "right" | "both" | "neither",
    resolvedBy: string,
    rationale: string,
  ): boolean {
    return notesDb.resolveContradictionCase(this.db, id, resolution, resolvedBy, rationale);
  }
  updateNoteQuality(
    id: number,
    entityName: string,
    confidence: number,
    verification: string,
  ): boolean {
    return notesDb.updateNoteQuality(this.db, id, entityName, confidence, verification);
  }
  findMemoryContradictions(entityName: string): notesDb.ContradictionCandidate[] {
    return notesDb.findMemoryContradictions(this.db, entityName);
  }
  consolidateNotes(entityName: string, keeperId: number, duplicateIds: number[]): number {
    return notesDb.consolidateNotes(this.db, entityName, keeperId, duplicateIds);
  }
  getMemoryQualitySummary(entityName?: string): {
    total: number;
    unverified: number;
    disputed: number;
    superseded: number;
    staleSources: number;
    contradictions: number;
  } {
    return notesDb.getMemoryQualitySummary(this.db, entityName);
  }

  upsertOperationalAlert(alert: {
    key: string;
    severity: "critical" | "warning" | "info";
    category: string;
    title: string;
    detail: string;
    remedy: string;
    kind?: string;
    sourceEntity?: string;
    targetEntity?: string;
    assignedTo?: string;
    actionLabel?: string;
    actionRef?: string;
    metadata?: Record<string, unknown>;
    deadlineAt?: number;
  }): OperationalAlertRow {
    return alertsDb.upsertOperationalAlert(this.db, alert);
  }
  listOperationalAlerts(
    status?: "open" | "acknowledged" | "resolved",
    limit = 100,
  ): OperationalAlertRow[] {
    return alertsDb.listOperationalAlerts(this.db, status, limit);
  }
  setOperationalAlertStatus(id: number, status: "acknowledged" | "resolved"): boolean {
    return alertsDb.setOperationalAlertStatus(this.db, id, status);
  }
  snoozeOperationalAlert(id: number, until: number): boolean {
    return alertsDb.snoozeOperationalAlert(this.db, id, until);
  }
  resolveOperationalAlertsExcept(category: string, activeKeys: string[]): number {
    return alertsDb.resolveOperationalAlertsExcept(this.db, category, activeKeys);
  }

  startProductivitySession(
    entityId: string,
    entityName: string,
    taskId: number,
    startedAt: number,
    toolCalls = 0,
    promptVersion?: string,
    inputTokens = 0,
    outputTokens = 0,
    costUsd = 0,
  ): void {
    telemetryDb.startProductivitySession(
      this.db,
      entityId,
      entityName,
      taskId,
      startedAt,
      toolCalls,
      promptVersion,
      inputTokens,
      outputTokens,
      costUsd,
    );
  }
  finishProductivitySession(
    entityId: string,
    entityName: string,
    taskId: number,
    outcome: "approved" | "rejected" | "expired",
    completedAt: number,
    endToolCalls = 0,
    endInputTokens = 0,
    endOutputTokens = 0,
    endCostUsd = 0,
  ): boolean {
    return telemetryDb.finishProductivitySession(
      this.db,
      entityId,
      entityName,
      taskId,
      outcome,
      completedAt,
      endToolCalls,
      endInputTokens,
      endOutputTokens,
      endCostUsd,
    );
  }
  getProductivitySummary(entityName?: string): ProductivitySummary {
    return telemetryDb.getProductivitySummary(this.db, entityName);
  }
  getProductivityLeaderboard(limit = 20): ProductivitySummary[] {
    return telemetryDb.getProductivityLeaderboard(this.db, limit);
  }
  getProductivityTrend(entityName?: string, days = 14): ProductivityTrendPoint[] {
    return telemetryDb.getProductivityTrend(this.db, entityName, days);
  }

  recordPrimitiveUsage(input: {
    actorId?: string;
    actorName: string;
    actorKind: string;
    source: "command" | "agent_tool";
    primitive: string;
    action: string;
    safeLabel: string;
    toolName?: string;
    success?: boolean;
    meaningful?: boolean;
    worldAction?: boolean;
    communication?: boolean;
    latencyMs?: number;
    promptVersion?: string;
    riskClass?: "read" | "communicate" | "mutate" | "consequential";
    trustSources?: string[];
    createdAt?: number;
  }): number {
    return telemetryDb.recordPrimitiveUsage(this.db, input);
  }

  finishAgentToolUsage(
    actorName: string,
    toolName: string,
    success: boolean,
    at = Date.now(),
  ): void {
    telemetryDb.finishAgentToolUsage(this.db, actorName, toolName, success, at);
  }

  getPrimitiveUsageSummary(entityName?: string, days = 7): PrimitiveUsageSummary {
    return telemetryDb.getPrimitiveUsageSummary(this.db, entityName, days);
  }

  getPromptOutcomeSummaries(days = 30): PromptOutcomeSummary[] {
    return telemetryDb.getPromptOutcomeSummaries(this.db, days);
  }

  recordAutonomyPulse(pulse: telemetryDb.AutonomyPulseInput): void {
    telemetryDb.recordAutonomyPulse(this.db, pulse);
  }

  listAutonomyPulse(sinceMs: number): telemetryDb.AutonomyPulseRow[] {
    return telemetryDb.listAutonomyPulse(this.reader, sinceMs);
  }

  addDailySpend(day: string, source: string, usd: number): void {
    telemetryDb.addDailySpend(this.db, day, source, usd);
  }

  getDailySpend(day: string): telemetryDb.DailySpendRow[] {
    return telemetryDb.getDailySpend(this.db, day);
  }

  getPrimitiveUsageLeaderboard(limit = 20): PrimitiveUsageSummary[] {
    return telemetryDb.getPrimitiveUsageLeaderboard(this.db, limit);
  }

  touchNote(id: number): void {
    notesDb.touchNote(this.db, id);
  }

  recallNotes(
    entityName: string,
    query: string,
    opts?: {
      weightImportance?: number;
      weightRecency?: number;
      weightRelevance?: number;
      includeProcess?: boolean;
    },
  ): ScoredNoteRow[] {
    return notesDb.recallNotes(this.db, entityName, query, opts);
  }

  recallNotesWithType(
    entityName: string,
    query: string,
    noteType: string,
    opts?: { weightImportance?: number; weightRecency?: number; weightRelevance?: number },
  ): ScoredNoteRow[] {
    return notesDb.recallNotesWithType(this.db, entityName, query, noteType, opts);
  }

  /** Find existing notes similar to content (for auto-linking) */
  findSimilarNotes(entityName: string, content: string, excludeId?: number): NoteRow[] {
    return notesDb.findSimilarNotes(this.db, entityName, content, excludeId);
  }

  /** Count total and fading matches for a query (beyond the top-20 recall returns) */
  countMatchingNotes(entityName: string, query: string): { total: number; fading: number } {
    return notesDb.countMatchingNotes(this.db, entityName, query);
  }

  /** Boost importance for frequently-recalled notes, decay for stale ones.
   *  Structural awareness: well-linked notes (3+ links) decay slower,
   *  bridge notes (connecting different clusters) are protected. */
  adjustNoteImportance(): { boosted: number; decayed: number } {
    return notesDb.adjustNoteImportance(this.db);
  }
  calibrateMemoryConfidence(): number {
    return notesDb.calibrateMemoryConfidence(this.db);
  }

  // ─── Entity Activity Tracking (delegated to db-entities.ts) ─────────────

  trackActivity(
    entityName: string,
    activityType: string,
    activityKey: string,
    success?: boolean,
  ): void {
    entitiesDb.trackActivity(this.db, entityName, activityType, activityKey, success);
  }

  getActivityStats(entityName: string): {
    roomsVisited: number;
    uniqueCommands: number;
    entitiesInteracted: number;
    totalActions: number;
  } {
    return entitiesDb.getActivityStats(this.db, entityName);
  }

  getLastActivityAt(entityName: string): number | null {
    return entitiesDb.getLastActivityAt(this.db, entityName);
  }

  getRoomVisitCount(entityName: string, roomId: string): number {
    return entitiesDb.getRoomVisitCount(this.db, entityName, roomId);
  }

  getActivityByType(
    entityName: string,
    activityType: string,
    limit = 20,
  ): { key: string; count: number; successCount: number; failCount: number; lastSeen: number }[] {
    return entitiesDb.getActivityByType(this.db, entityName, activityType, limit);
  }

  // ─── Core Memory Persistence (delegated to db-notes.ts) ─────────────────

  setCoreMemory(entityName: string, key: string, value: string): void {
    notesDb.setCoreMemory(this.db, entityName, key, value);
  }

  getCoreMemory(entityName: string, key: string): CoreMemoryRow | undefined {
    return notesDb.getCoreMemory(this.db, entityName, key);
  }

  listCoreMemory(entityName: string): CoreMemoryRow[] {
    return notesDb.listCoreMemory(this.db, entityName);
  }

  deleteCoreMemory(entityName: string, key: string): boolean {
    return notesDb.deleteCoreMemory(this.db, entityName, key);
  }

  getCoreMemoryHistory(entityName: string, key: string, limit = 10): CoreMemoryHistoryRow[] {
    return notesDb.getCoreMemoryHistory(this.db, entityName, key, limit);
  }

  // ─── Note Links (delegated to db-notes.ts) ────────────────────────────

  createNoteLink(sourceId: number, targetId: number, relationship: string): number {
    return notesDb.createNoteLink(this.db, sourceId, targetId, relationship);
  }

  getNoteLinks(noteId: number): NoteLinkRow[] {
    return notesDb.getNoteLinks(this.db, noteId);
  }

  searchAllNotes(query: string, limit = 20): NoteRow[] {
    return notesDb.searchAllNotes(this.db, query, limit);
  }

  removeNoteLink(sourceId: number, targetId: number, relationship: string): boolean {
    return notesDb.removeNoteLink(this.db, sourceId, targetId, relationship);
  }

  getGraphSnapshot(limit = 500): { notes: NoteRow[]; links: NoteLinkRow[] } {
    return notesDb.getGraphSnapshot(this.db, limit);
  }

  // ─── Feed Events (delegated to db-feed.ts) ────────────────────────────

  insertFeedEvent(event: feedDb.InsertFeedEvent): number {
    return feedDb.insertFeedEvent(this.db, event);
  }

  queryFeedEvents(q: feedDb.FeedQuery = {}): feedDb.FeedEventRow[] {
    return feedDb.queryFeedEvents(this.reader, q);
  }

  trimFeedEvents(keepMs: number): number {
    return feedDb.trimFeedEvents(this.db, keepMs);
  }

  // ─── Judge observations (delegated to db-decisions.ts) ──────────────────

  recordJudgeObservation(row: decisionsDb.JudgeObservationInput): number {
    return decisionsDb.recordJudgeObservation(this.db, row);
  }

  listJudgeObservations(
    opts: { evaluator?: string; limit?: number } = {},
  ): decisionsDb.JudgeObservationRow[] {
    return decisionsDb.listJudgeObservations(this.reader, opts);
  }

  // ─── Social Simulation Arena (delegated to db-arena.ts) ─────────────────

  insertArenaSubmission(row: arenaDb.InsertArenaSubmission): number {
    return arenaDb.insertArenaSubmission(this.db, row);
  }

  updateArenaSubmission(
    id: number,
    update: { status: arenaDb.ArenaSubmissionStatus; httpStatus?: number; response?: string },
  ): void {
    arenaDb.updateArenaSubmission(this.db, id, update);
  }

  latestArenaSubmission(entrant: string, roundId: string): arenaDb.ArenaSubmissionRow | undefined {
    return arenaDb.latestArenaSubmission(this.reader, entrant, roundId);
  }

  listArenaSubmissions(
    opts: { entrant?: string; limit?: number } = {},
  ): arenaDb.ArenaSubmissionRow[] {
    return arenaDb.listArenaSubmissions(this.reader, opts);
  }

  recordArenaShadow(row: {
    roundId: string;
    forecaster: string;
    forecast: string;
    detail: string;
    costUsd: number;
  }): boolean {
    return arenaDb.recordArenaShadow(this.db, row);
  }

  listArenaShadow(opts: { forecaster?: string; limit?: number } = {}): arenaDb.ArenaShadowRow[] {
    return arenaDb.listArenaShadow(this.reader, opts);
  }

  // ─── Chronicle (delegated to db-chronicle.ts) ──────────────────────────
  // The canonical, append-only record of the Marina. See docs/chronicle.md.

  appendChronicle(entry: chronicleDb.InsertChronicle): number {
    return chronicleDb.appendChronicle(this.db, entry);
  }

  queryChronicle(q: chronicleDb.ChronicleQuery = {}): chronicleDb.ChronicleEntry[] {
    return chronicleDb.queryChronicle(this.reader, q);
  }

  getChronicleEntry(id: number): chronicleDb.ChronicleEntry | undefined {
    return chronicleDb.getChronicleEntry(this.reader, id);
  }

  getChronicleCorrectionsFor(id: number): chronicleDb.ChronicleEntry[] {
    return chronicleDb.getCorrectionsFor(this.reader, id);
  }

  getChronicleCount(): number {
    return chronicleDb.getChronicleCount(this.reader);
  }

  // ─── Benchmark Runs (inline — small surface, no dedicated module) ─────

  insertBenchmarkRun(row: {
    id: string;
    benchmark: string;
    config_hash: string;
    config_json: string;
    status: string;
    agent_id?: string;
    started_at: number;
  }): void {
    benchmarksDb.insertBenchmarkRun(this.db, row);
  }

  completeBenchmarkRun(
    id: string,
    data: {
      score: number | null;
      breakdown_json: string | null;
      answered: number;
      total: number;
      status: string;
      completed_at: number;
      duration_ms: number;
    },
  ): void {
    benchmarksDb.completeBenchmarkRun(this.db, id, data);
  }

  getBenchmarkRun(id: string): BenchmarkRunRow | undefined {
    return benchmarksDb.getBenchmarkRun(this.reader, id);
  }

  queryBenchmarkRuns(q: {
    benchmark?: string;
    status?: string;
    agentId?: string;
    limit?: number;
  }): BenchmarkRunRow[] {
    return benchmarksDb.queryBenchmarkRuns(this.reader, q);
  }

  leaderboardBenchmark(benchmark: string, limit = 20): BenchmarkRunRow[] {
    return benchmarksDb.leaderboardBenchmark(this.reader, benchmark, limit);
  }

  traceNoteGraph(
    noteId: number,
    depth = 2,
    include?: (note: NoteRow) => boolean,
  ): { note: NoteRow; links: NoteLinkRow[]; depth: number }[] {
    return notesDb.traceNoteGraph(this.db, noteId, depth, include);
  }

  /** Count total note links for an entity's notes */
  countNoteLinks(entityName: string): number {
    return notesDb.countNoteLinks(this.db, entityName);
  }

  /** Count links for a specific note */
  countLinksForNote(noteId: number): number {
    return notesDb.countLinksForNote(this.db, noteId);
  }

  // ─── Memory Pools (delegated to db-notes.ts) ───────────────────────────

  createMemoryPool(id: string, name: string, createdBy: string, groupId?: string): void {
    notesDb.createMemoryPool(this.db, id, name, createdBy, groupId);
  }

  setMemoryPoolGroup(poolId: string, groupId: string | null): void {
    notesDb.setMemoryPoolGroup(this.db, poolId, groupId);
  }

  getMemoryPool(name: string): MemoryPoolRow | undefined {
    return notesDb.getMemoryPool(this.db, name);
  }

  getMemoryPoolById(id: string): MemoryPoolRow | undefined {
    return notesDb.getMemoryPoolById(this.db, id);
  }

  listMemoryPools(): MemoryPoolRow[] {
    return notesDb.listMemoryPools(this.db);
  }

  addPoolNote(
    poolId: string,
    entityName: string,
    content: string,
    importance?: number,
    noteType?: string,
    opts?: Parameters<typeof notesDb.addPoolNote>[6],
  ): number {
    return notesDb.addPoolNote(this.db, poolId, entityName, content, importance, noteType, opts);
  }

  getPoolNotes(poolId: string, limit = 100): NoteRow[] {
    return notesDb.getPoolNotes(this.db, poolId, limit);
  }

  countPoolNotes(poolId: string): number {
    return notesDb.countPoolNotes(this.db, poolId);
  }

  recallPoolNotes(
    poolId: string,
    query: string,
    opts?: {
      weightImportance?: number;
      weightRecency?: number;
      weightRelevance?: number;
      includeProcess?: boolean;
    },
  ): ScoredNoteRow[] {
    return notesDb.recallPoolNotes(this.db, poolId, query, opts);
  }

  // ─── Memory API Keys (delegated to db-notes.ts) ────────────────────────

  memoryRepository(): memoryServiceDb.MemoryRepository {
    return memoryServiceDb.memoryRepository(this.db);
  }
  admitMemoryImport() {
    return admitMemoryImport(this.db);
  }
  isServiceMemoryNote(id: number): boolean {
    return memoryServiceDb.isServiceMemoryNote(this.db, id);
  }
  issueMemoryCredential(
    ...args: Parameters<typeof principalsDb.issueMemoryCredential> extends [unknown, ...infer R]
      ? R
      : never
  ) {
    return principalsDb.issueMemoryCredential(this.db, ...args);
  }
  verifyMemoryCredential(token: string) {
    return principalsDb.verifyMemoryCredential(this.db, token);
  }

  createMemApiKey(id: string, secret: string, agentName: string): void {
    notesDb.createMemApiKey(this.db, id, secret, agentName);
  }

  validateMemApiKey(secret: string): MemApiKeyRow | undefined {
    return notesDb.validateMemApiKey(this.db, secret);
  }

  listMemApiKeys(): MemApiKeyRow[] {
    return notesDb.listMemApiKeys(this.db);
  }

  deleteMemApiKey(id: string): boolean {
    return notesDb.deleteMemApiKey(this.db, id);
  }

  /** Aggregate stats for an agent's memory namespace */
  getMemStats(agentName: string): {
    notes: number;
    links: number;
    coreKeys: number;
    pools: number;
  } {
    return notesDb.getMemStats(this.db, agentName);
  }

  /** Count personal notes (excluding pool notes) for an entity, optionally filtered by type. */
  countNotes(entityName: string, noteType?: string): number {
    return notesDb.countNotes(this.db, entityName, noteType);
  }

  /** Count completed tasks created by an entity. */
  countCompletedTasks(entityName: string): number {
    return tasksDb.countCompletedTasks(this.db, entityName);
  }

  countApprovedTaskClaims(entityId: string): number {
    return tasksDb.countApprovedTaskClaims(this.db, entityId);
  }

  // ─── Project Persistence (delegated to db-tasks.ts) ────────────────────

  createProject(project: {
    id: string;
    name: string;
    description?: string;
    bundleId?: number;
    poolId?: string;
    groupId?: string;
    orchestration?: string;
    memoryArch?: string;
    createdBy: string;
  }): void {
    tasksDb.createProject(this.db, project);
  }

  getProject(id: string): ProjectRow | undefined {
    return tasksDb.getProject(this.db, id);
  }

  getProjectByName(name: string): ProjectRow | undefined {
    return tasksDb.getProjectByName(this.db, name);
  }

  listProjects(status?: string): ProjectRow[] {
    return tasksDb.listProjects(this.db, status);
  }

  updateProjectStatus(id: string, status: string): void {
    tasksDb.updateProjectStatus(this.db, id, status);
  }

  updateProjectOrchestration(id: string, orchestration: string): void {
    tasksDb.updateProjectOrchestration(this.db, id, orchestration);
  }

  updateProjectMemoryArch(id: string, memoryArch: string): void {
    tasksDb.updateProjectMemoryArch(this.db, id, memoryArch);
  }

  updateProjectBudget(
    id: string,
    budget: { tokens?: number | null; cost?: number | null; durationMs?: number | null },
  ): void {
    tasksDb.updateProjectBudget(this.db, id, budget);
  }

  addProjectUsage(id: string, tokens: number, cost: number): void {
    tasksDb.addProjectUsage(this.db, id, tokens, cost);
  }

  resetProjectTasks(bundleId: number): number {
    return tasksDb.resetProjectTasks(this.db, bundleId);
  }

  // ─── Dynamic Command Persistence ─────────────────────────────────────

  saveCommandSource(opts: { id: string; name: string; source: string; createdBy: string }): void {
    commandsDb.saveCommandSource(this.db, opts);
  }

  getCommand(id: string): CommandSourceRow | undefined {
    return commandsDb.getCommand(this.db, id);
  }

  getCommandByName(name: string): CommandSourceRow | undefined {
    return commandsDb.getCommandByName(this.db, name);
  }

  listCommands(): CommandSourceRow[] {
    return commandsDb.listCommands(this.db);
  }

  markCommandValid(name: string): void {
    commandsDb.markCommandValid(this.db, name);
  }

  deleteCommand(name: string): void {
    commandsDb.deleteCommand(this.db, name);
  }

  getCommandHistory(name: string, limit = 20): CommandHistoryRow[] {
    return commandsDb.getCommandHistory(this.db, name, limit);
  }

  getAllValidCommandNames(): string[] {
    return commandsDb.getAllValidCommandNames(this.db);
  }

  // ─── Connector Persistence ──────────────────────────────────────────────

  createConnector(conn: {
    id: string;
    name: string;
    transport: string;
    url?: string;
    command?: string;
    args?: string;
    createdBy: string;
  }): void {
    connectorsDb.createConnector(this.db, conn);
  }

  getConnector(id: string): ConnectorRow | undefined {
    return connectorsDb.getConnector(this.db, id);
  }

  getConnectorByName(name: string): ConnectorRow | undefined {
    return connectorsDb.getConnectorByName(this.db, name);
  }

  listConnectors(status?: string): ConnectorRow[] {
    return connectorsDb.listConnectors(this.db, status);
  }

  updateConnectorStatus(id: string, status: string): void {
    connectorsDb.updateConnectorStatus(this.db, id, status);
  }

  updateConnectorAuth(id: string, authType: string, authData: string): void {
    connectorsDb.updateConnectorAuth(this.db, id, authType, authData);
  }

  deleteConnector(id: string): void {
    connectorsDb.deleteConnector(this.db, id);
  }

  // ─── Gateway Persistence ──────────────────────────────────────────────

  createGateway(opts: { id: string; name: string; url: string; createdBy: string }): void {
    gatewaysDb.createGateway(this.db, opts);
  }

  getGatewayByName(name: string): GatewayRow | undefined {
    return gatewaysDb.getGatewayByName(this.db, name);
  }

  listGateways(status?: string): GatewayRow[] {
    return gatewaysDb.listGateways(this.db, status);
  }

  updateGatewayStatus(id: string, status: string): void {
    gatewaysDb.updateGatewayStatus(this.db, id, status);
  }

  deleteGateway(id: string): void {
    gatewaysDb.deleteGateway(this.db, id);
  }

  addGatewayBridge(gatewayId: string, channel: string): void {
    gatewaysDb.addGatewayBridge(this.db, gatewayId, channel);
  }

  removeGatewayBridge(gatewayId: string, channel: string): void {
    gatewaysDb.removeGatewayBridge(this.db, gatewayId, channel);
  }

  listGatewayBridges(gatewayId: string): string[] {
    return gatewaysDb.listGatewayBridges(this.db, gatewayId);
  }

  // ─── Optional Flywheel Workspace Bindings ──────────────────────────────

  saveFlywheelBinding(opts: {
    entityId: EntityId;
    sessionId: string;
    sandboxId: string;
    image: string;
    keepAlive: boolean;
    state: FlywheelBindingState;
    lifecycleExpiresAt?: number;
  }): void {
    flywheelDb.saveFlywheelBinding(this.db, this.durableEntityKey(opts.entityId), opts);
  }

  // flywheel_bindings / coding_projects / coding_services are keyed by the
  // durable account id (migration 117). Reads project the live entity id back
  // so `row.entity_id === entity.id` comparisons in callers keep working.
  listFlywheelBindings(): FlywheelBindingRow[] {
    return flywheelDb.listFlywheelBindings(this.reader);
  }

  /** The binding owned by this entity's account (indexed PK lookup, not a scan). */
  getFlywheelBinding(entityId: EntityId): FlywheelBindingRow | undefined {
    return flywheelDb.getFlywheelBinding(this.reader, this.durableEntityKey(entityId));
  }

  updateFlywheelBinding(
    entityId: EntityId,
    fields: {
      state?: FlywheelBindingState;
      publishedUrl?: string | null;
      lastError?: string | null;
      reconciledAt?: number | null;
      activeProjectId?: string | null;
      guestCwd?: string | null;
      networkProfile?: string;
      networkProfileEnforced?: boolean;
      lastActivityAt?: number;
      lifecycleExpiresAt?: number | null;
      hibernatedReason?: string | null;
    },
  ): void {
    flywheelDb.updateFlywheelBinding(this.db, this.durableEntityKey(entityId), fields);
  }

  deleteFlywheelBinding(entityId: EntityId): void {
    flywheelDb.deleteFlywheelBinding(this.db, this.durableEntityKey(entityId));
  }

  createCodingProject(project: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    name: string;
    sourceType: "empty" | "git" | "archive";
    sourceLocator?: string;
    guestPath: string;
    activeBranch?: string;
    baseRevision?: string;
  }): CodingProjectRow {
    return flywheelDb.createCodingProject(
      this.db,
      this.reader,
      this.durableEntityKey(project.entityId),
      project,
    );
  }

  getCodingProject(id: string): CodingProjectRow | null {
    return flywheelDb.getCodingProject(this.reader, id);
  }

  getCodingProjectForEntity(entityId: EntityId, selector: string): CodingProjectRow | null {
    return flywheelDb.getCodingProjectForEntity(
      this.reader,
      this.durableEntityKey(entityId),
      selector,
    );
  }

  listCodingProjects(entityId: EntityId): CodingProjectRow[] {
    return flywheelDb.listCodingProjects(this.reader, this.durableEntityKey(entityId));
  }

  deleteCodingProjectsForSandbox(entityId: EntityId, sandboxId: string): void {
    flywheelDb.deleteCodingProjectsForSandbox(this.db, this.durableEntityKey(entityId), sandboxId);
  }

  deleteCodingProject(entityId: EntityId, projectId: string, sandboxId: string): void {
    flywheelDb.deleteCodingProject(this.db, this.durableEntityKey(entityId), projectId, sandboxId);
  }

  updateCodingProject(
    id: string,
    fields: Partial<{
      activeBranch: string | null;
      baseRevision: string | null;
      dirty: boolean;
      hasUnexportedChanges: boolean;
      exportedFingerprint: string | null;
      lastStatusAt: number | null;
      lastExportedAt: number | null;
    }>,
  ): void {
    flywheelDb.updateCodingProject(this.db, id, fields);
  }

  createCodingService(service: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    projectId?: string;
    sessionId: string;
    name: string;
    command: string[];
    guestCwd: string;
    logPath: string;
    pid: number;
    processIdentity: string;
    port?: number;
  }): CodingServiceRow {
    return flywheelDb.createCodingService(
      this.db,
      this.reader,
      this.durableEntityKey(service.entityId),
      service,
    );
  }

  getCodingService(id: string): CodingServiceRow | null {
    return flywheelDb.getCodingService(this.reader, id);
  }

  getCodingServiceForEntity(entityId: EntityId, selector: string): CodingServiceRow | null {
    return flywheelDb.getCodingServiceForEntity(
      this.reader,
      this.durableEntityKey(entityId),
      selector,
    );
  }

  listCodingServices(entityId: EntityId): CodingServiceRow[] {
    return flywheelDb.listCodingServices(this.reader, this.durableEntityKey(entityId));
  }

  listExpiredCodingServicePublications(now = Date.now()): CodingServiceRow[] {
    return flywheelDb.listExpiredCodingServicePublications(this.reader, now);
  }

  hasRunningCodingServices(entityId: EntityId, sandboxId: string): boolean {
    return flywheelDb.hasRunningCodingServices(
      this.reader,
      this.durableEntityKey(entityId),
      sandboxId,
    );
  }

  recordFlywheelOperation(operation: {
    entityId?: EntityId;
    operation: string;
    outcome: "success" | "failure" | "blocked";
    durationMs: number;
    byteCount?: number;
    detail?: string;
  }): void {
    flywheelDb.recordFlywheelOperation(this.db, operation);
  }

  pruneFlywheelOperations(before: number): number {
    return flywheelDb.pruneFlywheelOperations(this.db, before);
  }

  getFlywheelOperationSummary(
    since = Date.now() - 24 * 60 * 60 * 1000,
  ): FlywheelOperationSummary[] {
    return flywheelDb.getFlywheelOperationSummary(this.reader, since);
  }

  updateCodingService(
    id: string,
    fields: Partial<{
      pid: number | null;
      processIdentity: string | null;
      status: string;
      publishedUrl: string | null;
      publishedSubdomain: string | null;
      publicationExpiresAt: number | null;
      lastError: string | null;
      startedAt: number | null;
      stoppedAt: number | null;
    }>,
  ): void {
    flywheelDb.updateCodingService(this.db, id, fields);
  }

  stopCodingServicesForSandbox(entityId: EntityId, sandboxId: string, reason: string): void {
    flywheelDb.stopCodingServicesForSandbox(
      this.db,
      this.durableEntityKey(entityId),
      sandboxId,
      reason,
    );
  }

  markCodingServicesUnknownForSandbox(entityId: EntityId, sandboxId: string, reason: string): void {
    flywheelDb.markCodingServicesUnknownForSandbox(
      this.db,
      this.durableEntityKey(entityId),
      sandboxId,
      reason,
    );
  }

  createCodingServiceProbe(probe: {
    serviceId: string;
    entityId: EntityId;
    sandboxId: string;
    path: string;
    httpStatus?: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }): CodingServiceProbeRow {
    return flywheelDb.createCodingServiceProbe(this.db, probe);
  }

  listCodingServiceProbes(serviceId: string, limit = 20): CodingServiceProbeRow[] {
    return flywheelDb.listCodingServiceProbes(this.reader, serviceId, limit);
  }

  saveFlywheelCredentialBinding(binding: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    profileName: string;
    purpose: string;
    state: string;
    expiresAt?: number;
    lastError?: string;
  }): void {
    flywheelDb.saveFlywheelCredentialBinding(this.db, binding);
  }

  listFlywheelCredentialBindings(entityId: EntityId): FlywheelCredentialBindingRow[] {
    return flywheelDb.listFlywheelCredentialBindings(this.reader, entityId);
  }

  // ─── Experiment Persistence ────────────────────────────────────────────

  createExperiment(opts: {
    name: string;
    description?: string;
    config?: Record<string, unknown>;
    creatorName: string;
    requiredAgents?: number;
    timeLimit?: number;
  }): number {
    return experimentsDb.createExperiment(this.db, opts);
  }

  getExperiment(id: number): ExperimentRow | undefined {
    return experimentsDb.getExperiment(this.db, id);
  }

  getExperimentByName(name: string): ExperimentRow | undefined {
    return experimentsDb.getExperimentByName(this.db, name);
  }

  listExperiments(status?: string): ExperimentRow[] {
    return experimentsDb.listExperiments(this.db, status);
  }

  updateExperimentStatus(id: number, status: string): void {
    experimentsDb.updateExperimentStatus(this.db, id, status);
  }

  startExperiment(id: number): void {
    experimentsDb.startExperiment(this.db, id);
  }

  completeExperiment(id: number): void {
    experimentsDb.completeExperiment(this.db, id);
  }

  addParticipant(experimentId: number, entityName: string): void {
    experimentsDb.addParticipant(this.db, experimentId, entityName);
  }

  getParticipants(experimentId: number): ExperimentParticipantRow[] {
    return experimentsDb.getParticipants(this.db, experimentId);
  }

  isParticipant(experimentId: number, entityName: string): boolean {
    return experimentsDb.isParticipant(this.db, experimentId, entityName);
  }

  recordResult(
    experimentId: number,
    entityName: string,
    metricName: string,
    metricValue: number,
    arm = "",
  ): void {
    experimentsDb.recordResult(this.db, experimentId, entityName, metricName, metricValue, arm);
  }

  getResults(experimentId: number): ExperimentResultRow[] {
    return experimentsDb.getResults(this.db, experimentId);
  }

  // ─── Native Evolution Protocols ───────────────────────────────────────

  createEvolutionSession(opts: {
    experimentId: number;
    objective: string;
    protocol?: object;
    createdBy: string;
  }): number {
    return evolutionDb.createEvolutionSession(this.db, opts);
  }

  getEvolutionSession(id: number): EvolutionSessionRow | undefined {
    return evolutionDb.getEvolutionSession(this.db, id);
  }

  getEvolutionSessionByExperiment(experimentId: number): EvolutionSessionRow | undefined {
    return evolutionDb.getEvolutionSessionByExperiment(this.db, experimentId);
  }

  listEvolutionSessions(status?: EvolutionSessionStatus): EvolutionSessionRow[] {
    return evolutionDb.listEvolutionSessions(this.db, status);
  }

  listActiveEvolutionSessionsForParticipant(entityName: string): EvolutionSessionRow[] {
    return evolutionDb.listActiveEvolutionSessionsForParticipant(this.db, entityName);
  }

  getEvolutionActivity(
    experimentId: number,
    startedAt: number,
    endedAt = Date.now(),
  ): EvolutionActivitySummary {
    return evolutionDb.getEvolutionActivity(this.db, experimentId, startedAt, endedAt);
  }

  updateEvolutionSessionStatus(id: number, status: EvolutionSessionStatus): void {
    evolutionDb.updateEvolutionSessionStatus(this.db, id, status);
  }

  createEvolutionRun(opts: {
    sessionId: number;
    hypothesis: string;
    candidateRef: string;
    proposedBy: string;
    parentRunId?: number;
  }): number {
    return evolutionDb.createEvolutionRun(this.db, opts);
  }

  getEvolutionRun(id: number): EvolutionRunRow | undefined {
    return evolutionDb.getEvolutionRun(this.db, id);
  }

  listEvolutionRuns(sessionId: number): EvolutionRunRow[] {
    return evolutionDb.listEvolutionRuns(this.db, sessionId);
  }

  evaluateEvolutionRun(id: number, evaluatorName: string, evidence: string): void {
    evolutionDb.evaluateEvolutionRun(this.db, id, evaluatorName, evidence);
  }

  decideEvolutionRun(
    id: number,
    reviewerName: string,
    decision: "accept" | "reject" | "inconclusive",
  ): void {
    evolutionDb.decideEvolutionRun(this.db, id, reviewerName, decision);
  }

  // ─── Event Queries (delegated to db-entities.ts) ────────────────────────

  getEventsByEntity(
    entityId: string,
    limit = 20,
  ): { type: string; input?: string; timestamp: number }[] {
    return entitiesDb.getEventsByEntity(this.db, entityId, limit);
  }

  getEntityCommandCount(entityId: string): number {
    return entitiesDb.getEntityCommandCount(this.db, entityId);
  }

  getLastActivity(
    entityId: string,
  ): { type: string; timestamp: number; input?: string } | undefined {
    return entitiesDb.getLastActivity(this.db, entityId);
  }

  getActiveEntities(
    sinceMs: number,
  ): { entityId: string; commandCount: number; lastActivity: number }[] {
    return entitiesDb.getActiveEntities(this.db, sinceMs);
  }

  // ─── Global Search (delegated to db-channels.ts) ────────────────────────

  globalSearch(query: string): GlobalSearchResult[] {
    return channelsDb.globalSearch(this.db, query);
  }

  // ─── Assets ─────────────────────────────────────────────────────────────

  createAsset(asset: {
    id: string;
    entityName: string;
    filename: string;
    mimeType: string;
    size: number;
    storageKey: string;
    metadata?: Record<string, unknown>;
  }): void {
    assetsDb.createAsset(this.db, asset);
  }

  getAsset(id: string): AssetRow | undefined {
    return assetsDb.getAsset(this.db, id);
  }

  getAssetsByEntity(entityName: string, limit = 50): AssetRow[] {
    return assetsDb.getAssetsByEntity(this.db, entityName, limit);
  }

  listAssets(opts?: { limit?: number; mime?: string }): AssetRow[] {
    return assetsDb.listAssets(this.db, opts);
  }

  deleteAsset(id: string): boolean {
    return assetsDb.deleteAsset(this.db, id);
  }

  // ─── Media Jobs ──────────────────────────────────────────────────────────

  createMediaJob(job: {
    id: string;
    type: mediaDb.MediaJobType;
    entityName: string;
    entityId: string | null;
    provider: string;
    model: string;
    prompt: string;
    options: Record<string, unknown>;
    costEstimate?: number | null;
    providerJobId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): void {
    mediaDb.insertMediaJob(this.db, job);
  }

  updateMediaJob(
    id: string,
    patch: Partial<{
      status: mediaDb.MediaJobStatus;
      assetId: string | null;
      error: string | null;
      costEstimate: number | null;
      providerJobId: string | null;
      metadata: Record<string, unknown> | null;
      options: Record<string, unknown>;
      completedAt: number | null;
    }>,
  ): void {
    mediaDb.updateMediaJob(this.db, id, patch);
  }

  getMediaJob(id: string): mediaDb.MediaJobRow | undefined {
    return mediaDb.getMediaJob(this.db, id);
  }

  listMediaJobs(opts: { limit?: number; entityName?: string } = {}): mediaDb.MediaJobRow[] {
    return mediaDb.listMediaJobs(this.db, opts);
  }

  countMediaJobsSince(opts: {
    entityName?: string;
    type?: mediaDb.MediaJobType;
    since: number;
  }): number {
    return mediaDb.countMediaJobsSince(this.db, opts);
  }

  // ─── Canvases ──────────────────────────────────────────────────────────

  createCanvas(canvas: {
    id: string;
    name: string;
    description?: string;
    scope?: string;
    scopeId?: string;
    creatorName: string;
  }): void {
    canvasDb.createCanvas(this.db, canvas);
  }

  getCanvas(id: string): CanvasRow | undefined {
    return canvasDb.getCanvas(this.db, id);
  }

  getCanvasByName(name: string): CanvasRow | undefined {
    return canvasDb.getCanvasByName(this.db, name);
  }

  listCanvases(opts?: { scope?: string; limit?: number }): CanvasRow[] {
    return canvasDb.listCanvases(this.db, opts);
  }

  /** Look up the per-entity workspace canvas, if one exists. */
  getEntityCanvas(entityId: string): CanvasRow | undefined {
    return canvasDb.getEntityCanvas(this.db, entityId);
  }

  /**
   * Return the entity's canvas, lazily creating it on first access. Canvas
   * names have a UNIQUE constraint, so we try `"{name}'s canvas"` first and
   * fall back to an id-qualified name on collision. Per-entity addressing
   * always goes through scope lookup (`getEntityCanvas`), so the name is
   * mostly a human-readable label shown in the breadcrumb.
   */
  ensureEntityCanvas(entityId: string, entityName: string, creatorName: string): CanvasRow {
    return canvasDb.ensureEntityCanvas(this.db, entityId, entityName, creatorName);
  }

  deleteCanvas(id: string): boolean {
    return canvasDb.deleteCanvas(this.db, id);
  }

  // ─── Canvas Nodes ─────────────────────────────────────────────────────

  createNode(node: {
    id: string;
    canvasId: string;
    type: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    assetId?: string;
    data?: Record<string, unknown>;
    creatorName: string;
    parentNodeId?: string;
  }): void {
    canvasDb.createNode(this.db, node);
  }

  getNode(id: string): CanvasNodeRow | undefined {
    return canvasDb.getNode(this.db, id);
  }

  getNodesByCanvas(canvasId: string): CanvasNodeRow[] {
    return canvasDb.getNodesByCanvas(this.db, canvasId);
  }

  /**
   * Delete all but the most recent `max` nodes on a canvas. Returns the
   * number of rows deleted. Used by FeedPublisher to bound the feed canvas
   * (without this, every event adds a permanent node — thousands over a
   * day, enough to hang the dashboard when it loads the canvas).
   */
  trimCanvasNodes(canvasId: string, max: number): number {
    return canvasDb.trimCanvasNodes(this.db, canvasId, max);
  }

  /** Trim old canvas nodes and return their ids so live clients can converge. */
  trimCanvasNodesWithIds(canvasId: string, max: number): string[] {
    return canvasDb.trimCanvasNodesWithIds(this.db, canvasId, max);
  }

  updateNode(
    id: string,
    updates: { x?: number; y?: number; width?: number; height?: number; data?: string },
  ): boolean {
    return canvasDb.updateNode(this.db, id, updates);
  }

  listCanvasIntents(options?: {
    statuses?: CanvasIntentStatus[];
    canvasName?: string;
    limit?: number;
    expireActiveMs?: number;
    now?: number;
  }): CanvasIntentSummary[] {
    return canvasDb.listCanvasIntents(this.db, options);
  }

  expireCanvasIntentClaims(timeoutMs: number, now = Date.now()): number {
    return canvasDb.expireCanvasIntentClaims(this.db, timeoutMs, now);
  }

  claimCanvasIntent(
    idOrPrefix: string,
    claimantName: string,
    now = Date.now(),
  ): CanvasIntentClaimResult {
    return canvasDb.claimCanvasIntent(this.db, idOrPrefix, claimantName, now);
  }

  completeCanvasIntent(
    idOrPrefix: string,
    params: {
      result: string;
      resultType?: string;
      resultData?: Record<string, unknown>;
      completerName: string;
      now?: number;
    },
  ): CanvasIntentCompleteResult {
    return canvasDb.completeCanvasIntent(this.db, idOrPrefix, params);
  }

  failCanvasIntent(idOrPrefix: string, reason: string, now = Date.now()): CanvasIntentFailResult {
    return canvasDb.failCanvasIntent(this.db, idOrPrefix, reason, now);
  }

  resolveCanvasNode(idOrPrefix: string): CanvasNodeRow | undefined {
    return canvasDb.resolveCanvasNode(this.db, idOrPrefix);
  }

  getChildNodes(parentNodeId: string): CanvasNodeRow[] {
    return canvasDb.getChildNodes(this.db, parentNodeId);
  }

  getRootNodes(canvasId: string): CanvasNodeRow[] {
    return canvasDb.getRootNodes(this.db, canvasId);
  }

  deleteNode(id: string): boolean {
    return canvasDb.deleteNode(this.db, id);
  }

  // ─── Canvas Edges ─────────────────────────────────────────────────────

  createCanvasEdge(edge: {
    id: string;
    canvasId: string;
    sourceId: string;
    targetId: string;
    relationship: string;
    data?: Record<string, unknown>;
    creatorName: string;
  }): void {
    canvasDb.createCanvasEdge(this.db, edge);
  }

  getCanvasEdges(canvasId: string): CanvasEdgeRow[] {
    return canvasDb.getCanvasEdges(this.db, canvasId);
  }

  getCanvasEdge(id: string): CanvasEdgeRow | undefined {
    return canvasDb.getCanvasEdge(this.db, id);
  }

  deleteCanvasEdge(id: string): boolean {
    return canvasDb.deleteCanvasEdge(this.db, id);
  }

  // ─── Meta Key-Value ────────────────────────────────────────────────────

  getMetaValue(key: string): string | undefined {
    return metaDb.getMetaValue(this.db, key);
  }

  setMetaValue(key: string, value: string): void {
    metaDb.setMetaValue(this.db, key, value);
  }

  clearDynamicRooms(): void {
    roomsDb.clearDynamicRooms(this.db);
  }

  clearDynamicCommands(): void {
    commandsDb.clearDynamicCommands(this.db);
  }

  // ─── Shell ─────────────────────────────────────────────────────────────

  getShellAllowlist(): string[] {
    return shellDb.getShellAllowlist(this.db);
  }

  isShellAllowed(binary: string): boolean {
    return shellDb.isShellAllowed(this.db, binary);
  }

  addToShellAllowlist(binary: string, addedBy: string): void {
    shellDb.addToShellAllowlist(this.db, binary, addedBy);
  }

  removeFromShellAllowlist(binary: string): boolean {
    return shellDb.removeFromShellAllowlist(this.db, binary);
  }

  logShellExec(
    entityId: string,
    binary: string,
    args: string,
    exitCode: number | null,
    outputLength: number,
  ): void {
    shellDb.logShellExec(this.db, entityId, binary, args, exitCode, outputLength);
  }

  getShellHistory(entityId: string, limit = 10): ShellLogRow[] {
    return shellDb.getShellHistory(this.db, entityId, limit);
  }

  getShellLog(entityId: string | null, limit = 10): ShellLogRow[] {
    return shellDb.getShellLog(this.db, entityId, limit);
  }

  /** Drop shell_log rows older than `keepMs`. Returns rows removed. Mirrors
   *  trimFeedEvents — bounds the gated-exec audit trail so it can't grow
   *  unbounded for the life of the DB. (idx_shell_log_created makes this cheap.) */
  trimShellLog(keepMs: number): number {
    return shellDb.trimShellLog(this.db, keepMs);
  }

  // ─── Coding Sessions ───────────────────────────────────────────────────

  createCodingSession(session: {
    id: string;
    title: string;
    workspaceRoot: string;
    status?: string;
    mode?: string;
    createdBy: string;
  }): CodingSessionRow {
    return codingDb.createCodingSession(this.db, session);
  }

  getCodingSession(id: string): CodingSessionRow | null {
    return codingDb.getCodingSession(this.db, id);
  }

  listCodingSessions(createdBy?: string, limit = 10): CodingSessionRow[] {
    return codingDb.listCodingSessions(this.db, createdBy, limit);
  }

  updateCodingSession(
    id: string,
    patch: Partial<{
      status: string;
      mode: string;
      title: string;
      writer: string | null;
      agent: string | null;
      driver: string | null;
      executionTarget: "local" | "flywheel";
      worktreePath: string | null;
      worktreeBranch: string | null;
    }>,
  ): void {
    codingDb.updateCodingSession(this.db, id, patch);
  }

  createCodingEvent(event: {
    id?: string;
    sessionId: string;
    actor: string;
    kind: string;
    payload: unknown;
  }): CodingEventRow {
    return codingDb.createCodingEvent(this.db, event);
  }

  listCodingEvents(sessionId: string, limit = 50): CodingEventRow[] {
    return codingDb.listCodingEvents(this.db, sessionId, limit);
  }

  createCodingArtifact(artifact: {
    id?: string;
    sessionId: string;
    kind: string;
    title: string;
    status?: string;
    contentText: string;
    metadata?: unknown;
    createdBy: string;
  }): CodingArtifactRow {
    return codingDb.createCodingArtifact(this.db, artifact);
  }

  listCodingRuns(query: codingDb.CodingRunQuery = {}): CodingArtifactRow[] {
    return codingDb.listCodingRuns(this.db, query);
  }

  listCodingRunArtifacts(runId: string): CodingArtifactRow[] {
    return codingDb.listCodingRunArtifacts(this.db, runId);
  }

  getCodingArtifact(id: string): CodingArtifactRow | null {
    return codingDb.getCodingArtifact(this.db, id);
  }

  listCodingArtifacts(sessionId: string, limit = 20): CodingArtifactRow[] {
    return codingDb.listCodingArtifacts(this.db, sessionId, limit);
  }

  updateCodingArtifact(
    id: string,
    patch: Partial<{
      appliedAt: number | null;
      appliedBy: string | null;
      metadata: unknown;
      status: string;
    }>,
  ): void {
    codingDb.updateCodingArtifact(this.db, id, patch);
  }

  // ─── Entity Migration (delegated to db-entities.ts) ─────────────────────

  migrateEntityId(oldId: string, newId: string): void {
    entitiesDb.migrateEntityId(this.db, oldId, newId);
  }

  migrateTaskClaimsByName(entityName: string, newId: string): void {
    entitiesDb.migrateTaskClaimsByName(this.db, entityName, newId);
  }

  /** Get active task claims for an entity by name. */
  getActiveClaimsByName(entityName: string): {
    task_id: number;
    title: string;
    status: string;
    priority: number;
    progress: number;
    claimed_at: number;
  }[] {
    return entitiesDb.getActiveClaimsByName(this.db, entityName);
  }

  /** Get recent activity entries for an entity. */
  getRecentActivity(
    entityName: string,
    limit = 5,
  ): { activity_type: string; activity_key: string; count: number; last_seen: number }[] {
    return entitiesDb.getRecentActivity(this.db, entityName, limit);
  }

  // ─── Markets ───────────────────────────────────────────────────────────

  createMarket(market: { id: string; roomId: string; question: string; category?: string }): void {
    marketsDb.createMarket(this.db, market);
  }

  getMarket(id: string): MarketRow | undefined {
    return marketsDb.getMarket(this.db, id);
  }

  getMarketByRoom(roomId: string): MarketRow | undefined {
    return marketsDb.getMarketByRoom(this.db, roomId);
  }

  listMarkets(opts?: { status?: string; category?: string; limit?: number }): MarketRow[] {
    return marketsDb.listMarkets(this.db, opts);
  }

  searchMarkets(query: string): MarketRow[] {
    return marketsDb.searchMarkets(this.db, query);
  }

  upsertPosition(
    marketId: string,
    entityName: string,
    direction: string,
    confidence: number,
    reasoning: string,
  ): void {
    marketsDb.upsertPosition(this.db, marketId, entityName, direction, confidence, reasoning);
  }

  getMarketPositions(marketId: string): MarketPositionRow[] {
    return marketsDb.getMarketPositions(this.db, marketId);
  }

  resolveMarket(marketId: string, outcome: string, resolvedBy: string): void {
    marketsDb.resolveMarket(this.db, marketId, outcome, resolvedBy);
  }

  recordMarketScore(
    marketId: string,
    entityName: string,
    brierScore: number,
    correct: boolean,
  ): void {
    marketsDb.recordMarketScore(this.db, marketId, entityName, brierScore, correct);
  }

  getCalibrationLeaderboard(
    limit = 20,
  ): { entity_name: string; avg_brier: number; markets_scored: number; correct_count: number }[] {
    return marketsDb.getCalibrationLeaderboard(this.db, limit);
  }

  getEntityMarketScore(
    entityName: string,
  ): { avg_brier: number; markets_scored: number; correct_count: number } | undefined {
    return marketsDb.getEntityMarketScore(this.db, entityName);
  }

  // ─── Traits (delegated to db-agents.ts) ──────────────────────────────────

  saveTrait(opts: {
    name: string;
    category: string;
    prompt: string;
    capabilities?: TraitCapabilities;
    createdBy: string;
  }): void {
    agentsDb.saveTrait(this.db, opts);
  }
  getTrait(name: string): TraitRow | undefined {
    return agentsDb.getTrait(this.db, name);
  }
  getAllTraits(): TraitRow[] {
    return agentsDb.getAllTraits(this.db);
  }
  getTraitsByCategory(category: string): TraitRow[] {
    return agentsDb.getTraitsByCategory(this.db, category);
  }
  deleteTrait(name: string): void {
    agentsDb.deleteTrait(this.db, name);
  }

  // ─── Roles (delegated to db-agents.ts) ─────────────────────────────────

  saveRole(opts: {
    name: string;
    description?: string;
    traits?: string[];
    guidelines?: string[];
    focus?: string[];
    tone?: string;
    origin?: string;
    createdBy: string;
  }): void {
    agentsDb.saveRole(this.db, opts);
  }
  getRole(name: string): RoleRow | undefined {
    return agentsDb.getRole(this.db, name);
  }
  getAllRoles(): RoleRow[] {
    return agentsDb.getAllRoles(this.db);
  }
  deleteRole(name: string): void {
    agentsDb.deleteRole(this.db, name);
  }

  getTraitHistory(name: string, limit = 10): EditHistoryRow[] {
    return agentsDb.getTraitHistory(this.db, name, limit);
  }

  getRoleHistory(name: string, limit = 10): EditHistoryRow[] {
    return agentsDb.getRoleHistory(this.db, name, limit);
  }

  // ─── Agent Configs (delegated to db-agents.ts) ─────────────────────────

  saveAgentConfig(opts: {
    name: string;
    model: string;
    role?: string;
    goal?: string;
    keyName?: string;
    room?: string;
    spawnedBy: string;
    supports?: AgentSupports;
    /** Reasoning depth (migration 120). `undefined` keeps the stored value. */
    thinkingLevel?: AgentThinkingLevel;
  }): void {
    agentsDb.saveAgentConfig(this.db, opts);
    const parent =
      principalsDb.getPrincipal(this.reader, "agent", opts.spawnedBy) ??
      principalsDb.getPrincipal(this.reader, "human", opts.spawnedBy);
    principalsDb.ensurePrincipal(this.db, {
      type: "agent",
      displayName: opts.name,
      ownerPrincipalId: parent?.principal_id,
      lineageParentId: parent?.principal_type === "agent" ? parent.principal_id : null,
    });
  }
  getAgentConfig(name: string): AgentConfigRow | undefined {
    return agentsDb.getAgentConfig(this.db, name);
  }
  getAllAgentConfigs(): AgentConfigRow[] {
    return agentsDb.getAllAgentConfigs(this.db);
  }

  ensurePrincipal(
    input: Parameters<typeof principalsDb.ensurePrincipal>[1],
  ): principalsDb.PrincipalRow {
    return principalsDb.ensurePrincipal(this.db, input);
  }

  getPrincipal(
    type: principalsDb.PrincipalType,
    displayName: string,
    homeWorld = "local",
  ): principalsDb.PrincipalRow | undefined {
    return principalsDb.getPrincipal(this.reader, type, displayName, homeWorld);
  }

  listPrincipals(): principalsDb.PrincipalRow[] {
    return principalsDb.listPrincipals(this.reader);
  }

  setPrincipalStatus(principalId: string, status: principalsDb.PrincipalStatus): boolean {
    return principalsDb.setPrincipalStatus(this.db, principalId, status);
  }

  issueWorkloadCredential(
    principalId: string,
    ttlMs?: number,
  ): principalsDb.IssuedWorkloadCredential {
    return principalsDb.issueWorkloadCredential(this.db, principalId, ttlMs);
  }

  verifyWorkloadCredential(token: string): principalsDb.PrincipalRow | undefined {
    return principalsDb.verifyWorkloadCredential(this.reader, token);
  }

  revokeWorkloadCredential(credentialId: string): boolean {
    return principalsDb.revokeWorkloadCredential(this.db, credentialId);
  }

  createWorldVariant(
    input: Parameters<typeof worldVariantsDb.createWorldVariant>[1],
  ): worldVariantsDb.WorldVariantRow {
    return worldVariantsDb.createWorldVariant(this.db, input);
  }

  getWorldVariant(id: string): worldVariantsDb.WorldVariantRow | undefined {
    return worldVariantsDb.getWorldVariant(this.reader, id);
  }

  listWorldVariants(): worldVariantsDb.WorldVariantRow[] {
    return worldVariantsDb.listWorldVariants(this.reader);
  }

  updateWorldVariant(
    id: string,
    patch: Parameters<typeof worldVariantsDb.updateWorldVariant>[2],
  ): worldVariantsDb.WorldVariantRow | undefined {
    return worldVariantsDb.updateWorldVariant(this.db, id, patch);
  }

  promoteWorldVariant(
    id: string,
    input: Parameters<typeof worldVariantsDb.promoteWorldVariant>[2],
  ): worldVariantsDb.WorldVariantRow | undefined {
    return this.db.transaction(() => {
      const promoted = worldVariantsDb.promoteWorldVariant(this.db, id, input);
      if (promoted?.promoted_at) {
        evidenceDb.appendEvidenceReceipt(this.db, {
          eventType: "world_variant_promoted",
          ref: `world-variant:${id}`,
          payload: {
            variantId: id,
            rationale: input.rationale,
            evidenceRefs: input.evidenceRefs,
            promotedBy: input.promotedBy,
            promotedAt: promoted.promoted_at,
          },
          createdAt: promoted.promoted_at,
        });
      }
      return promoted;
    })();
  }

  getOrCreateWorldId(): string {
    const existing = agentsDb.getSetting(this.db, "federation.world_id");
    if (existing) return existing;
    const worldId = crypto.randomUUID();
    agentsDb.setSetting(this.db, "federation.world_id", worldId);
    return worldId;
  }

  upsertFederationPeer(
    input: Parameters<typeof federationDb.upsertFederationPeer>[1],
  ): federationDb.FederationPeerRow {
    return federationDb.upsertFederationPeer(this.db, input);
  }

  getFederationPeer(worldId: string): federationDb.FederationPeerRow | undefined {
    return federationDb.getFederationPeer(this.reader, worldId);
  }

  listFederationPeers(): federationDb.FederationPeerRow[] {
    return federationDb.listFederationPeers(this.reader);
  }

  setFederationTrust(
    worldId: string,
    trust: federationDb.FederationTrust,
  ): federationDb.FederationPeerRow | undefined {
    return federationDb.setFederationTrust(this.db, worldId, trust);
  }
  getAgentConfigsBySpawnedBy(spawnedBy: string): AgentConfigRow[] {
    return agentsDb.getAgentConfigsBySpawnedBy(this.db, spawnedBy);
  }
  deleteAgentConfig(name: string): void {
    agentsDb.deleteAgentConfig(this.db, name);
  }
  updateAttentionPolicy(
    name: string,
    mode: "focused" | "balanced" | "open",
    threshold?: number,
  ): boolean {
    return agentsDb.updateAttentionPolicy(this.db, name, mode, threshold);
  }
  recordAttentionFeedback(name: string, feedback: "useful" | "noise"): AgentConfigRow | undefined {
    return agentsDb.recordAttentionFeedback(this.db, name, feedback);
  }
  recordAutomaticAttentionOutcome(
    name: string,
    outcome: "success" | "failure",
  ): AgentConfigRow | undefined {
    return agentsDb.recordAutomaticAttentionOutcome(this.db, name, outcome);
  }

  // ─── Settings (delegated to db-agents.ts) ──────────────────────────────

  getSetting(key: string): string | undefined {
    return agentsDb.getSetting(this.db, key);
  }
  setSetting(key: string, value: string): void {
    agentsDb.setSetting(this.db, key, value);
  }
  deleteSetting(key: string): void {
    agentsDb.deleteSetting(this.db, key);
  }
  listSettingsByPrefix(prefix: string): { key: string; value: string }[] {
    return agentsDb.listSettingsByPrefix(this.db, prefix);
  }
  /** Effective default model — DB `default_model` setting, else MARINA_DEFAULT_MODEL. */
  getDefaultModel(): string {
    return agentsDb.getDefaultModel(this.db);
  }

  // ─── API Keys (delegated to db-agents.ts) ──────────────────────────────

  saveApiKey(opts: {
    name: string;
    provider: string;
    encryptedValue: string;
    isEncrypted?: boolean;
    setBy: string;
  }): void {
    agentsDb.saveApiKey(this.db, opts);
  }
  getApiKey(name: string): ApiKeyRow | undefined {
    return agentsDb.getApiKey(this.db, name);
  }
  getApiKeysByProvider(provider: string): ApiKeyRow[] {
    return agentsDb.getApiKeysByProvider(this.db, provider);
  }
  getAllApiKeys(): ApiKeyRow[] {
    return agentsDb.getAllApiKeys(this.db);
  }
  deleteApiKey(name: string): void {
    agentsDb.deleteApiKey(this.db, name);
  }
  /** Encrypt any plaintext API-key rows once MARINA_KEY_SECRET is set. */
  migrateApiKeysToEncrypted(): number {
    return agentsDb.migrateApiKeysToEncrypted(this.db);
  }
  /** Count encrypted vs. currently-undecryptable API-key rows. */
  auditEncryptedKeys(): { encrypted: number; unreadable: number } {
    return agentsDb.auditEncryptedKeys(this.db);
  }

  // ─── Adapters (delegated to db-agents.ts) ──────────────────────────────

  saveAdapter(opts: { platform: string; config: string; status: string; setBy: string }): void {
    agentsDb.saveAdapter(this.db, opts);
  }
  getAdapter(platform: string): AdapterRow | undefined {
    return agentsDb.getAdapter(this.db, platform);
  }
  getAllAdapters(): AdapterRow[] {
    return agentsDb.getAllAdapters(this.db);
  }
  updateAdapterStatus(platform: string, status: string): void {
    agentsDb.updateAdapterStatus(this.db, platform, status);
  }
  deleteAdapter(platform: string): void {
    agentsDb.deleteAdapter(this.db, platform);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Checkpoint WAL file to reduce its size */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  /**
   * Clone the live database into a self-contained file at `targetPath` using
   * SQLite's VACUUM INTO. The WAL is checkpointed first so the snapshot
   * reflects committed state. Returns summary counts for metadata.
   *
   * Fails if `targetPath` already exists (VACUUM INTO refuses to overwrite).
   */
  snapshot(targetPath: string): {
    notes: number;
    pools: number;
    benchmarkRuns: number;
    entities: number;
    bytes: number;
  } {
    return maintenanceDb.snapshot(this.db, this.reader, targetPath);
  }

  /**
   * Clone + prune. Produces a compacted snapshot at `targetPath` by first
   * VACUUM-ing into the target, then running safe pruning passes on the
   * target file (never touching the live DB), then VACUUM-ing again to
   * reclaim freed pages.
   *
   * Why: during the 2026-04-23 Gen-1 saturation investigation we found that
   * a warm snapshot accumulated 4945 `[compaction]` summary notes averaging
   * 150KB each — **99.8% of the DB's note content was compaction chaff**.
   * FTS5 recall had to scan that bulk on every turn. Pruning transient
   * metadata gives the snapshot a fighting chance to be faster than its
   * predecessor instead of slower. Generational memory with a compaction
   * discipline, not an accumulation race.
   *
   * What's dropped (opts control the thresholds):
   *  - `[compaction]`-prefixed notes (transient per-turn metadata written
   *    by the context manager's onBeforeCompact callback; capped at 2KB
   *    for new writes but legacy ones can be 100KB+)
   *  - Orphaned note_links (source or target note no longer exists after
   *    pruning)
   *  - entity_activity rows older than a cutoff (default 30 days)
   *
   * What's NEVER dropped:
   *  - Skills (note_type = 'skill')
   *  - Reflections (note_type = 'reflection')
   *  - High-importance notes (importance >= 7)
   *  - Pool notes with pool_id set (shared knowledge)
   *  - Core memory, agent_configs, entities, benchmark_runs,
   *    canvas/feed/session/auth data (schema-wise untouched)
   *
   * Dry-run mode (opts.dryRun=true) writes nothing — runs the counting
   * queries against a throwaway in-memory copy and returns what would
   * happen. Useful for `admin snapshot --compact --dry-run`.
   *
   * Returns a CompactionStats record: before / after / dropped counts +
   * disk-size delta.
   */
  snapshotCompacted(targetPath: string, opts?: CompactionOpts): CompactionStats {
    return maintenanceDb.snapshotCompacted(this.db, targetPath, opts);
  }

  close(): void {
    try {
      this.reader.close();
    } catch {
      /* already closed */
    }
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.close();
    } catch {
      /* already closed */
    }
  }
  // External routing participants (durable account ids; independent of world sessions).
  joinRoutingSession(ownerId: string, input: RoutingJoin): RoutingSession {
    return routingDb.joinRoutingSession(this.db, ownerId, input);
  }
  getRoutingSession(id: string): RoutingSession | null {
    return routingDb.getRoutingSession(this.db, id);
  }
  listRoutingSessions(ownerId: string, after: string, limit: number): RoutingSessionPage {
    return routingDb.listRoutingSessions(this.db, ownerId, after, limit);
  }
  setRoutingSessionState(id: string, state: "active" | "left"): RoutingSession {
    return routingDb.setRoutingSessionState(this.db, id, state);
  }
  appendRoutingEvents(sessionId: string, events: RoutingEventInput[]): RoutingEvent[] {
    return routingDb.appendRoutingEvents(this.db, sessionId, events);
  }
  listRoutingEvents(sessionId: string, after: number, limit: number): RoutingEventPage {
    return routingDb.listRoutingEvents(this.db, sessionId, after, limit);
  }
  sendRoutingMessage(sourceId: string, input: RoutingSend): RoutingMessage {
    return routingDb.sendRoutingMessage(this.db, sourceId, input);
  }
  listRoutingInbox(sessionId: string, limit: number, controlsFirst = false): RoutingMessage[] {
    return routingDb.listRoutingInbox(this.db, sessionId, limit, controlsFirst);
  }
  getRoutingMessage(id: string): RoutingMessage | null {
    return routingDb.getRoutingMessage(this.db, id);
  }
  acknowledgeRoutingMessage(sessionId: string, id: string): RoutingMessage | null {
    return routingDb.acknowledgeRoutingMessage(this.db, sessionId, id);
  }
  getRoutingChannelAccess(
    ownerId: string,
    channelId: string,
  ): { canRead: boolean; canWrite: boolean } {
    return routingDb.getRoutingChannelAccess(this.db, ownerId, channelId);
  }
  listRoutingChannelMessages(channelId: string, after: number, limit: number): RoutingChannelPage {
    return routingDb.listRoutingChannelMessages(this.db, channelId, after, limit);
  }
  publishRoutingChannelMessage(
    sessionId: string,
    clientMessageId: string,
    channelId: string,
    senderId: string,
    senderName: string,
    content: string,
  ): RoutingChannelReceipt {
    return routingDb.publishRoutingChannelMessage(
      this.db,
      sessionId,
      clientMessageId,
      channelId,
      senderId,
      senderName,
      content,
    );
  }
  listRoutingDeliveries(sessionId: string, limit: number): RoutingMessage[] {
    return routingDb.listRoutingDeliveries(this.db, sessionId, limit);
  }
  getRoutingRuntimeState(sessionId: string): unknown | null {
    return routingDb.getRoutingRuntimeState(this.db, sessionId);
  }
}
