// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Per-domain store interfaces for the MarinaDB facade. Each mirrors the
// facade's delegate methods for one `db-*.ts` domain, so consumers can type a
// dependency as (say) `NotesStore` instead of the whole class and tests can
// implement one with a plain object. `MarinaDB implements MarinaStores`;
// `STORE_METHOD_MANIFEST` is the runtime mirror the drift test checks.

export type { AgentsStore } from "./agents-store";
export type { AlertsStore } from "./alerts-store";
export type { ArenaStore } from "./arena-store";
export type { AssetsStore } from "./assets-store";
export type { AssociationsStore } from "./associations-store";
export type { BenchmarksStore } from "./benchmarks-store";
export type { CanvasStore } from "./canvas-store";
export type { ChannelsStore } from "./channels-store";
export type { ChronicleStore } from "./chronicle-store";
export type { CodingStore } from "./coding-store";
export type { CognitiveEventsStore } from "./cognitive-events-store";
export type { CommandsStore } from "./commands-store";
export type { CompetenceStore } from "./competence-store";
export type { ConnectorsStore } from "./connectors-store";
export type { CoreStore } from "./core-store";
export type { CrewsStore } from "./crews-store";
export type { DirectMessagesStore } from "./direct-messages-store";
export type { EconomicsStore } from "./economics-store";
export type { EntitiesStore } from "./entities-store";
export type { EvidenceStore } from "./evidence-store";
export type { EvolutionStore } from "./evolution-store";
export type { ExperimentsStore } from "./experiments-store";
export type { FederationStore } from "./federation-store";
export type { FeedStore } from "./feed-store";
export type { FlywheelStore } from "./flywheel-store";
export type { GatewaysStore } from "./gateways-store";
export type { IntellectsStore } from "./intellects-store";
export type { JourneysStore } from "./journeys-store";
export type { LogsStore } from "./logs-store";
export type { MacrosStore } from "./macros-store";
export type { MaintenanceStore } from "./maintenance-store";
export type { MarketsStore } from "./markets-store";
export type { MediaStore } from "./media-store";
export type { MemoryServiceStore } from "./memory-service-store";
export type { MeshesStore } from "./meshes-store";
export type { MutationsStore } from "./mutations-store";
export type { NotesStore } from "./notes-store";
export type { PrincipalsStore } from "./principals-store";
export type { ReproductionStore } from "./reproduction-store";
export type { RoomsStore } from "./rooms-store";
export type { RoutingStore } from "./routing-store";
export type { SettingsStore } from "./settings-store";
export type { ShellStore } from "./shell-store";
export type { SimulationsStore } from "./simulations-store";
export type { StandingStore } from "./standing-store";
export type { TasksStore } from "./tasks-store";
export type { TelemetryStore } from "./telemetry-store";
export type { UsersStore } from "./users-store";
export type { WitnessStore } from "./witness-store";
export type { WorldVariantsStore } from "./world-variants-store";

import type { AgentsStore } from "./agents-store";
import { AGENTS_STORE_METHODS } from "./agents-store";
import type { AlertsStore } from "./alerts-store";
import { ALERTS_STORE_METHODS } from "./alerts-store";
import type { ArenaStore } from "./arena-store";
import { ARENA_STORE_METHODS } from "./arena-store";
import type { AssetsStore } from "./assets-store";
import { ASSETS_STORE_METHODS } from "./assets-store";
import type { AssociationsStore } from "./associations-store";
import { ASSOCIATIONS_STORE_METHODS } from "./associations-store";
import type { BenchmarksStore } from "./benchmarks-store";
import { BENCHMARKS_STORE_METHODS } from "./benchmarks-store";
import type { CanvasStore } from "./canvas-store";
import { CANVAS_STORE_METHODS } from "./canvas-store";
import type { ChannelsStore } from "./channels-store";
import { CHANNELS_STORE_METHODS } from "./channels-store";
import type { ChronicleStore } from "./chronicle-store";
import { CHRONICLE_STORE_METHODS } from "./chronicle-store";
import type { CodingStore } from "./coding-store";
import { CODING_STORE_METHODS } from "./coding-store";
import type { CognitiveEventsStore } from "./cognitive-events-store";
import { COGNITIVE_EVENTS_STORE_METHODS } from "./cognitive-events-store";
import type { CommandsStore } from "./commands-store";
import { COMMANDS_STORE_METHODS } from "./commands-store";
import type { CompetenceStore } from "./competence-store";
import { COMPETENCE_STORE_METHODS } from "./competence-store";
import type { ConnectorsStore } from "./connectors-store";
import { CONNECTORS_STORE_METHODS } from "./connectors-store";
import type { CoreStore } from "./core-store";
import { CORE_STORE_METHODS } from "./core-store";
import type { CrewsStore } from "./crews-store";
import { CREWS_STORE_METHODS } from "./crews-store";
import type { DirectMessagesStore } from "./direct-messages-store";
import { DIRECT_MESSAGES_STORE_METHODS } from "./direct-messages-store";
import type { EconomicsStore } from "./economics-store";
import { ECONOMICS_STORE_METHODS } from "./economics-store";
import type { EntitiesStore } from "./entities-store";
import { ENTITIES_STORE_METHODS } from "./entities-store";
import type { EvidenceStore } from "./evidence-store";
import { EVIDENCE_STORE_METHODS } from "./evidence-store";
import type { EvolutionStore } from "./evolution-store";
import { EVOLUTION_STORE_METHODS } from "./evolution-store";
import type { ExperimentsStore } from "./experiments-store";
import { EXPERIMENTS_STORE_METHODS } from "./experiments-store";
import type { FederationStore } from "./federation-store";
import { FEDERATION_STORE_METHODS } from "./federation-store";
import type { FeedStore } from "./feed-store";
import { FEED_STORE_METHODS } from "./feed-store";
import type { FlywheelStore } from "./flywheel-store";
import { FLYWHEEL_STORE_METHODS } from "./flywheel-store";
import type { GatewaysStore } from "./gateways-store";
import { GATEWAYS_STORE_METHODS } from "./gateways-store";
import type { IntellectsStore } from "./intellects-store";
import { INTELLECTS_STORE_METHODS } from "./intellects-store";
import type { JourneysStore } from "./journeys-store";
import { JOURNEYS_STORE_METHODS } from "./journeys-store";
import type { LogsStore } from "./logs-store";
import { LOGS_STORE_METHODS } from "./logs-store";
import type { MacrosStore } from "./macros-store";
import { MACROS_STORE_METHODS } from "./macros-store";
import type { MaintenanceStore } from "./maintenance-store";
import { MAINTENANCE_STORE_METHODS } from "./maintenance-store";
import type { MarketsStore } from "./markets-store";
import { MARKETS_STORE_METHODS } from "./markets-store";
import type { MediaStore } from "./media-store";
import { MEDIA_STORE_METHODS } from "./media-store";
import type { MemoryServiceStore } from "./memory-service-store";
import { MEMORY_SERVICE_STORE_METHODS } from "./memory-service-store";
import type { MeshesStore } from "./meshes-store";
import { MESHES_STORE_METHODS } from "./meshes-store";
import type { MutationsStore } from "./mutations-store";
import { MUTATIONS_STORE_METHODS } from "./mutations-store";
import type { NotesStore } from "./notes-store";
import { NOTES_STORE_METHODS } from "./notes-store";
import type { PrincipalsStore } from "./principals-store";
import { PRINCIPALS_STORE_METHODS } from "./principals-store";
import type { ReproductionStore } from "./reproduction-store";
import { REPRODUCTION_STORE_METHODS } from "./reproduction-store";
import type { RoomsStore } from "./rooms-store";
import { ROOMS_STORE_METHODS } from "./rooms-store";
import { ROUTING_STORE_METHODS, type RoutingStore } from "./routing-store";
import type { SettingsStore } from "./settings-store";
import { SETTINGS_STORE_METHODS } from "./settings-store";
import type { ShellStore } from "./shell-store";
import { SHELL_STORE_METHODS } from "./shell-store";
import type { SimulationsStore } from "./simulations-store";
import { SIMULATIONS_STORE_METHODS } from "./simulations-store";
import type { StandingStore } from "./standing-store";
import { STANDING_STORE_METHODS } from "./standing-store";
import type { TasksStore } from "./tasks-store";
import { TASKS_STORE_METHODS } from "./tasks-store";
import type { TelemetryStore } from "./telemetry-store";
import { TELEMETRY_STORE_METHODS } from "./telemetry-store";
import type { UsersStore } from "./users-store";
import { USERS_STORE_METHODS } from "./users-store";
import type { WitnessStore } from "./witness-store";
import { WITNESS_STORE_METHODS } from "./witness-store";
import type { WorldVariantsStore } from "./world-variants-store";
import { WORLD_VARIANTS_STORE_METHODS } from "./world-variants-store";

/** Every store the facade implements, as one structural type. */
export interface MarinaStores
  extends AgentsStore,
    AlertsStore,
    ArenaStore,
    AssetsStore,
    AssociationsStore,
    BenchmarksStore,
    CanvasStore,
    ChannelsStore,
    ChronicleStore,
    CodingStore,
    CognitiveEventsStore,
    CommandsStore,
    CompetenceStore,
    ConnectorsStore,
    CoreStore,
    CrewsStore,
    DirectMessagesStore,
    EconomicsStore,
    EntitiesStore,
    EvidenceStore,
    EvolutionStore,
    ExperimentsStore,
    FederationStore,
    FeedStore,
    FlywheelStore,
    GatewaysStore,
    IntellectsStore,
    JourneysStore,
    LogsStore,
    MacrosStore,
    MaintenanceStore,
    MarketsStore,
    MediaStore,
    MemoryServiceStore,
    MeshesStore,
    MutationsStore,
    NotesStore,
    PrincipalsStore,
    ReproductionStore,
    RoomsStore,
    RoutingStore,
    SettingsStore,
    ShellStore,
    SimulationsStore,
    StandingStore,
    TasksStore,
    TelemetryStore,
    UsersStore,
    WitnessStore,
    WorldVariantsStore {}

/** Interface name → the method names it declares. */
export const STORE_METHOD_MANIFEST: Readonly<Record<string, readonly string[]>> = {
  AgentsStore: AGENTS_STORE_METHODS,
  AlertsStore: ALERTS_STORE_METHODS,
  ArenaStore: ARENA_STORE_METHODS,
  AssetsStore: ASSETS_STORE_METHODS,
  AssociationsStore: ASSOCIATIONS_STORE_METHODS,
  BenchmarksStore: BENCHMARKS_STORE_METHODS,
  CanvasStore: CANVAS_STORE_METHODS,
  ChannelsStore: CHANNELS_STORE_METHODS,
  ChronicleStore: CHRONICLE_STORE_METHODS,
  CodingStore: CODING_STORE_METHODS,
  CognitiveEventsStore: COGNITIVE_EVENTS_STORE_METHODS,
  CommandsStore: COMMANDS_STORE_METHODS,
  CompetenceStore: COMPETENCE_STORE_METHODS,
  ConnectorsStore: CONNECTORS_STORE_METHODS,
  CoreStore: CORE_STORE_METHODS,
  CrewsStore: CREWS_STORE_METHODS,
  DirectMessagesStore: DIRECT_MESSAGES_STORE_METHODS,
  EconomicsStore: ECONOMICS_STORE_METHODS,
  EntitiesStore: ENTITIES_STORE_METHODS,
  EvidenceStore: EVIDENCE_STORE_METHODS,
  EvolutionStore: EVOLUTION_STORE_METHODS,
  ExperimentsStore: EXPERIMENTS_STORE_METHODS,
  FederationStore: FEDERATION_STORE_METHODS,
  FeedStore: FEED_STORE_METHODS,
  FlywheelStore: FLYWHEEL_STORE_METHODS,
  GatewaysStore: GATEWAYS_STORE_METHODS,
  IntellectsStore: INTELLECTS_STORE_METHODS,
  JourneysStore: JOURNEYS_STORE_METHODS,
  LogsStore: LOGS_STORE_METHODS,
  MacrosStore: MACROS_STORE_METHODS,
  MaintenanceStore: MAINTENANCE_STORE_METHODS,
  MarketsStore: MARKETS_STORE_METHODS,
  MediaStore: MEDIA_STORE_METHODS,
  MemoryServiceStore: MEMORY_SERVICE_STORE_METHODS,
  MeshesStore: MESHES_STORE_METHODS,
  MutationsStore: MUTATIONS_STORE_METHODS,
  NotesStore: NOTES_STORE_METHODS,
  PrincipalsStore: PRINCIPALS_STORE_METHODS,
  ReproductionStore: REPRODUCTION_STORE_METHODS,
  RoomsStore: ROOMS_STORE_METHODS,
  RoutingStore: ROUTING_STORE_METHODS,
  SettingsStore: SETTINGS_STORE_METHODS,
  ShellStore: SHELL_STORE_METHODS,
  SimulationsStore: SIMULATIONS_STORE_METHODS,
  StandingStore: STANDING_STORE_METHODS,
  TasksStore: TASKS_STORE_METHODS,
  TelemetryStore: TELEMETRY_STORE_METHODS,
  UsersStore: USERS_STORE_METHODS,
  WitnessStore: WITNESS_STORE_METHODS,
  WorldVariantsStore: WORLD_VARIANTS_STORE_METHODS,
};
