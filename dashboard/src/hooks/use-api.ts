// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { fetchApi } from "../lib/api";
import type {
  AdapterStatus,
  AgentStatusFull,
  BenchmarkEntry,
  BoardDetail,
  BoardEntry,
  BoardPostEntry,
  BriefData,
  ChannelDetail,
  ChannelEntry,
  ChannelMessage,
  ConnectorEntry,
  ContradictionCase,
  DynamicCommandEntry,
  EntityDetail,
  EntityWorkResponse,
  EnvVar,
  EvidenceReceiptsResponse,
  EvolutionSessionEntry,
  ExperimentEntry,
  FederationPeerEntry,
  GroupDetail,
  GroupEntry,
  KeyStatus,
  LogsResponse,
  MacroEntry,
  MarketEntry,
  McpInfo,
  MediaJob,
  MemoryPool,
  MemoryQualitySummary,
  ModelsResponse,
  NoteGraphEntry,
  OperationalAlert,
  Paged,
  PrincipalEntry,
  ProductivityResponse,
  ProjectEntry,
  ReadinessReport,
  RecipeEntry,
  RoleEntry,
  RoomDetail,
  RoomTemplateEntry,
  SetupStatus,
  SystemData,
  TaskDetail,
  TaskEntry,
  TracesResponse,
  TraitEntry,
  WorldData,
  WorldVariantsResponse,
} from "../lib/types";

export function useSetupStatus() {
  return useQuery({
    queryKey: ["setupStatus"],
    queryFn: () => fetchApi<SetupStatus>("/api/setup-status"),
    staleTime: 30_000,
  });
}

export function useWorld() {
  return useQuery({
    queryKey: ["world"],
    queryFn: () => fetchApi<WorldData>("/api/world"),
    staleTime: 60_000,
  });
}

export function useSystem() {
  // Drifty metrics (memory, uptime) need a periodic heartbeat in
  // addition to event-driven invalidation from
  // useGlobalRealtimeInvalidations. Bumped from 10s → 30s because
  // lifecycle events now refresh the counts the moment they change.
  return useQuery({
    queryKey: ["system"],
    queryFn: () => fetchApi<SystemData>("/api/system"),
    refetchInterval: 30_000,
  });
}

export interface TraceFilters {
  limit?: number;
  cursor?: string;
  status?: "running" | "completed" | "failed";
  q?: string;
  model?: string;
  agent?: string;
  tool?: string;
  since?: number;
  until?: number;
}

export function traceQueryString(filters: TraceFilters): string {
  const params = new URLSearchParams({ limit: String(filters.limit ?? 25) });
  for (const key of ["cursor", "status", "q", "model", "agent", "tool"] as const) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
  }
  if (filters.since !== undefined) params.set("since", String(filters.since));
  if (filters.until !== undefined) params.set("until", String(filters.until));
  return params.toString();
}

export function useTraces(filters: TraceFilters | number = {}) {
  const normalized = typeof filters === "number" ? { limit: filters } : filters;
  const query = traceQueryString(normalized);
  return useQuery({
    queryKey: ["traces", query],
    queryFn: () => fetchApi<TracesResponse>(`/api/traces?${query}`),
    refetchInterval: 5_000,
  });
}

export function useTrace(traceId?: string) {
  return useQuery({
    queryKey: ["traces", "detail", traceId],
    queryFn: () =>
      fetchApi<TracesResponse>(`/api/traces?traceId=${encodeURIComponent(traceId!)}&limit=1`),
    enabled: Boolean(traceId),
    staleTime: 5_000,
  });
}

export interface LogFilters {
  limit?: number;
  cursor?: string;
  level?: "debug" | "info" | "warn" | "error";
  category?: string;
  traceId?: string;
  q?: string;
  since?: number;
  until?: number;
}

export function logQueryString(filters: LogFilters): string {
  const params = new URLSearchParams({ limit: String(filters.limit ?? 100) });
  for (const key of ["cursor", "level", "category", "traceId", "q"] as const) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
  }
  if (filters.since !== undefined) params.set("since", String(filters.since));
  if (filters.until !== undefined) params.set("until", String(filters.until));
  return params.toString();
}

export function useLogs(filters: LogFilters = {}) {
  const query = logQueryString(filters);
  return useQuery({
    queryKey: ["logs", query],
    queryFn: () => fetchApi<LogsResponse>(`/api/logs?${query}`),
    refetchInterval: 5_000,
  });
}

export function useOperationalAlerts() {
  return useQuery({
    queryKey: ["operations", "alerts"],
    queryFn: () => fetchApi<OperationalAlert[]>("/api/operations/alerts"),
    refetchInterval: 15_000,
  });
}

export function useEvidenceReceipts() {
  return useQuery({
    queryKey: ["evidence", "receipts"],
    queryFn: () => fetchApi<EvidenceReceiptsResponse>("/api/evidence/receipts?limit=25"),
    refetchInterval: 30_000,
  });
}

export function usePrincipals() {
  return useQuery({
    queryKey: ["principals"],
    queryFn: () => fetchApi<PrincipalEntry[]>("/api/principals"),
    staleTime: 15_000,
  });
}

export function useWorldVariants() {
  return useQuery({
    queryKey: ["collective", "variants"],
    queryFn: () => fetchApi<WorldVariantsResponse>("/api/collective/variants"),
    refetchInterval: 10_000,
  });
}

export function useFederationPeers() {
  return useQuery({
    queryKey: ["federation", "peers"],
    queryFn: () => fetchApi<FederationPeerEntry[]>("/api/federation/peers"),
    staleTime: 15_000,
  });
}

export function useReadiness() {
  return useQuery({
    queryKey: ["operations", "readiness"],
    queryFn: () => fetchApi<ReadinessReport>("/api/readiness"),
    refetchInterval: 30_000,
  });
}

export function useProductivity() {
  return useQuery({
    queryKey: ["operations", "productivity"],
    queryFn: () => fetchApi<ProductivityResponse>("/api/productivity"),
    refetchInterval: 30_000,
  });
}

export function useMemoryQuality() {
  return useQuery({
    queryKey: ["operations", "memory-quality"],
    queryFn: () => fetchApi<MemoryQualitySummary>("/api/memory/quality"),
    refetchInterval: 30_000,
  });
}

export function useContradictions(status: "open" | "resolved" = "open") {
  return useQuery({
    queryKey: ["operations", "contradictions", status],
    queryFn: () => fetchApi<ContradictionCase[]>(`/api/memory/contradictions?status=${status}`),
    refetchInterval: 30_000,
  });
}

export function useRoomDetail(roomId: string | null) {
  return useQuery({
    queryKey: ["room", roomId],
    queryFn: () => fetchApi<RoomDetail>(`/api/rooms/${encodeURIComponent(roomId!)}`),
    enabled: !!roomId,
  });
}

export function useEntityDetail(name: string | null) {
  return useQuery({
    queryKey: ["entity", name],
    queryFn: () => fetchApi<EntityDetail>(`/api/entities/${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
}

export function useEntityWork(name: string | null) {
  return useQuery({
    queryKey: ["entityWork", name],
    queryFn: () => fetchApi<EntityWorkResponse>(`/api/entities/${encodeURIComponent(name!)}/work`),
    enabled: !!name,
    staleTime: 10_000,
  });
}

export function useBoards() {
  return useQuery({
    queryKey: ["boards"],
    queryFn: () => fetchApi<BoardEntry[]>("/api/coordination/boards"),
    staleTime: 30_000,
  });
}

export function useTasks() {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetchApi<TaskEntry[]>("/api/coordination/tasks"),
    staleTime: 30_000,
  });
}

export function useChannels() {
  return useQuery({
    queryKey: ["channels"],
    queryFn: () => fetchApi<ChannelEntry[]>("/api/coordination/channels"),
    staleTime: 30_000,
  });
}

export function useGroups() {
  return useQuery({
    queryKey: ["groups"],
    queryFn: () => fetchApi<GroupEntry[]>("/api/coordination/groups"),
    staleTime: 30_000,
  });
}

export function useMemoryPools() {
  return useQuery({
    queryKey: ["pools"],
    queryFn: () => fetchApi<MemoryPool[]>("/api/memory/pools"),
    staleTime: 30_000,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => fetchApi<ProjectEntry[]>("/api/coordination/projects"),
    staleTime: 30_000,
  });
}

export function useConnectors() {
  return useQuery({
    queryKey: ["connectors"],
    queryFn: () => fetchApi<ConnectorEntry[]>("/api/connectors"),
    staleTime: 30_000,
  });
}

export function useDynamicCommands() {
  return useQuery({
    queryKey: ["commands"],
    queryFn: () => fetchApi<DynamicCommandEntry[]>("/api/commands"),
    staleTime: 30_000,
  });
}

export function useTaskDetail(id: number | null) {
  return useQuery({
    queryKey: ["taskDetail", id],
    queryFn: () => fetchApi<TaskDetail>(`/api/coordination/tasks/${id}`),
    enabled: id !== null,
  });
}

export function useBoardDetail(name: string | null) {
  return useQuery({
    queryKey: ["boardDetail", name],
    queryFn: () => fetchApi<BoardDetail>(`/api/coordination/boards/${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
}

export function useGroupDetail(name: string | null) {
  return useQuery({
    queryKey: ["groupDetail", name],
    queryFn: () => fetchApi<GroupDetail>(`/api/coordination/groups/${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
}

export function useChannelDetail(name: string | null) {
  return useQuery({
    queryKey: ["channelDetail", name],
    queryFn: () =>
      fetchApi<ChannelDetail>(`/api/coordination/channels/${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
}

// ─── Paginated coordination collections ("load more") ──────────────────────
// Dedicated paged hooks so the Coordination panel can grow a list without
// silently truncating. Distinct query keys from the unpaged useTasks /
// useChannelDetail / useBoardDetail (which other panels still consume).

export function useTasksPaged(limit: number) {
  return useQuery({
    queryKey: ["tasksPaged", limit],
    queryFn: () => fetchApi<Paged<TaskEntry>>(`/api/coordination/tasks?paged=1&limit=${limit}`),
    staleTime: 30_000,
  });
}

export function useBoardPosts(name: string | null, limit: number) {
  return useQuery({
    queryKey: ["boardPosts", name, limit],
    queryFn: () =>
      fetchApi<Paged<BoardPostEntry>>(
        `/api/coordination/boards/${encodeURIComponent(name!)}/posts?limit=${limit}`,
      ),
    enabled: !!name,
  });
}

export function useChannelMessages(name: string | null, limit: number) {
  return useQuery({
    queryKey: ["channelMessages", name, limit],
    queryFn: () =>
      fetchApi<Paged<ChannelMessage>>(
        `/api/coordination/channels/${encodeURIComponent(name!)}/messages?limit=${limit}`,
      ),
    enabled: !!name,
  });
}

// ─── Agent, Key, Adapter, Role, Trait hooks ─────────────────────────────────

export function useAgents() {
  // Event-driven via useGlobalRealtimeInvalidations (spawn/stop/error/rank).
  // A 60s heartbeat catches drifty fields (uptime, tool counts) that have
  // no event. Dropped from the old 5s poll — polling that fast is the
  // kind of mistake the realtime tenet exists to prevent.
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => fetchApi<AgentStatusFull[]>("/api/agents"),
    refetchInterval: 60_000,
  });
}

export function useKeys() {
  return useQuery({
    queryKey: ["keys"],
    queryFn: () => fetchApi<KeyStatus[]>("/api/keys"),
    staleTime: 30_000,
  });
}

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => fetchApi<ModelsResponse>("/api/models"),
    // Match the server-side 1h cache — dashboard doesn't need to poll more often.
    staleTime: 60 * 60_000,
    gcTime: 2 * 60 * 60_000,
  });
}

export function useMediaJobs(entityName?: string, enabled = true) {
  return useQuery({
    queryKey: ["media-jobs", entityName ?? "all"],
    queryFn: () =>
      fetchApi<MediaJob[]>(
        `/api/media-jobs${entityName ? `?entity=${encodeURIComponent(entityName)}` : ""}`,
      ),
    refetchInterval: enabled ? 15_000 : false,
    enabled,
  });
}

export function useAdapters() {
  return useQuery({
    queryKey: ["adapters"],
    queryFn: () => fetchApi<AdapterStatus[]>("/api/adapters"),
    staleTime: 30_000,
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ["roles"],
    queryFn: () => fetchApi<RoleEntry[]>("/api/roles"),
    staleTime: 60_000,
  });
}

export function useTraits() {
  return useQuery({
    queryKey: ["traits"],
    queryFn: () => fetchApi<TraitEntry[]>("/api/traits"),
    staleTime: 60_000,
  });
}

export function useMcpInfo() {
  return useQuery({
    queryKey: ["mcp"],
    queryFn: () => fetchApi<McpInfo>("/api/mcp"),
    staleTime: 60_000,
  });
}

export function useEnvConfig() {
  return useQuery({
    queryKey: ["env"],
    queryFn: () => fetchApi<EnvVar[]>("/api/env"),
    staleTime: 30_000,
  });
}

// ─── Knowledge Graph & Brief hooks ──────────────────────────────────────────

export function useNoteGraph(entityName: string | null) {
  return useQuery({
    queryKey: ["noteGraph", entityName],
    queryFn: () =>
      fetchApi<NoteGraphEntry[]>(`/api/memory/graph/${encodeURIComponent(entityName!)}`),
    enabled: !!entityName,
    staleTime: 30_000,
  });
}

export interface NoteDetailLink {
  id: number;
  otherId: number;
  direction: "in" | "out";
  relationship: string;
  otherPreview: string | null;
  otherType: string | null;
}

export interface NoteDetail {
  id: number;
  entityName: string;
  content: string;
  importance: number;
  noteType: string;
  createdAt: number;
  lastAccessed: number | null;
  roomId: string | null;
  poolId: string | null;
  supersedesId: number | null;
  confidence: number;
  verificationStatus: "unverified" | "verified" | "disputed" | "superseded";
  claimKey: string | null;
  sources: Array<{
    id: number;
    url: string;
    source_type: string;
    source_note_id: number | null;
    source_entity: string | null;
    captured_by: string | null;
    excerpt: string | null;
    credibility: number;
    observed_at: number | null;
    retrieved_at: number;
  }>;
  verifications: Array<{
    id: number;
    verifier: string;
    status: string;
    confidence: number;
    rationale: string | null;
    created_at: number;
  }>;
  links: NoteDetailLink[];
}

export function useNoteDetail(noteId: number | null) {
  return useQuery({
    queryKey: ["note", noteId],
    queryFn: () => fetchApi<NoteDetail>(`/api/notes/${noteId}`),
    enabled: noteId !== null,
    staleTime: 5_000,
  });
}

export function useEntityBrief(entityName: string | null) {
  // Event-driven: ContextPanel.CompassSection invalidates on task /
  // note / intent / agent lifecycle events that affect this entity.
  // Heartbeat catches slow drift (uptime fields, etc.).
  return useQuery({
    queryKey: ["entityBrief", entityName],
    queryFn: () => fetchApi<BriefData>(`/api/entities/${encodeURIComponent(entityName!)}/brief`),
    enabled: !!entityName,
    refetchInterval: 60_000,
  });
}

// ─── Room Templates, Macros, Experiments, Markets, Benchmarks ─────────────

export function useRoomTemplates() {
  return useQuery({
    queryKey: ["roomTemplates"],
    queryFn: () => fetchApi<RoomTemplateEntry[]>("/api/room-templates"),
    staleTime: 60_000,
  });
}

export function useMacros() {
  return useQuery({
    queryKey: ["macros"],
    queryFn: () => fetchApi<MacroEntry[]>("/api/macros"),
    staleTime: 30_000,
  });
}

export function useExperiments() {
  return useQuery({
    queryKey: ["experiments"],
    queryFn: () => fetchApi<ExperimentEntry[]>("/api/experiments"),
    staleTime: 30_000,
  });
}

export function useEvolutionSessions() {
  return useQuery({
    queryKey: ["evolutionSessions"],
    queryFn: () => fetchApi<EvolutionSessionEntry[]>("/api/evolution-sessions"),
    refetchInterval: 10_000,
  });
}

export function useMarkets() {
  return useQuery({
    queryKey: ["markets"],
    queryFn: () => fetchApi<MarketEntry[]>("/api/markets"),
    staleTime: 10_000,
  });
}

export function useBenchmarks() {
  return useQuery({
    queryKey: ["benchmarks"],
    queryFn: () => fetchApi<BenchmarkEntry[]>("/api/benchmarks"),
    staleTime: 30_000,
  });
}

export function useRecipes() {
  return useQuery({
    queryKey: ["recipes"],
    queryFn: () => fetchApi<RecipeEntry[]>("/api/recipes"),
    staleTime: 60_000,
  });
}
