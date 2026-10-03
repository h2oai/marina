// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Read adapters, not grants. Every fetch still passes through the resource's own authorization.
 * Keep side-effecting GETs (notably entities/:name/canvas), credentials and arbitrary URLs out.
 * Parameters are encoded as individual path segments; query keys are declared per adapter.
 */
export interface PanelResourceDefinition {
  id: string;
  path: string;
  parameters: readonly string[];
  query: readonly string[];
}

const routes: ReadonlyArray<readonly [string, string, string?]> = [
  ["world", "/api/world"],
  ["entities", "/api/entities"],
  ["entity", "/api/entities/:name"],
  ["entity.brief", "/api/entities/:name/brief"],
  ["entity.work", "/api/entities/:name/work"],
  ["entity.quests", "/api/entities/:name/quests"],
  ["room", "/api/rooms/:id"],
  ["feed", "/api/feed", "limit,kind,entity,since,until"],
  ["events", "/api/events", "limit"],
  ["agents", "/api/agents"],
  ["agent", "/api/agents/:name"],
  ["tasks", "/api/coordination/tasks", "paged,limit"],
  ["task", "/api/coordination/tasks/:id"],
  ["boards", "/api/coordination/boards"],
  ["board", "/api/coordination/boards/:id"],
  ["board.posts", "/api/coordination/boards/:id/posts", "limit"],
  ["channels", "/api/coordination/channels"],
  ["channel", "/api/coordination/channels/:id"],
  ["channel.messages", "/api/coordination/channels/:id/messages", "limit"],
  ["groups", "/api/coordination/groups"],
  ["group", "/api/coordination/groups/:id"],
  ["projects", "/api/coordination/projects"],
  ["project.orchestration", "/api/coordination/projects/:id/orchestration"],
  ["coding.sessions", "/api/coding/sessions", "limit,createdBy"],
  ["coding.session", "/api/coding/session/:id"],
  ["coding.artifacts", "/api/coding/session/:id/artifacts", "limit,kind"],
  ["coding.run", "/api/coding/runs/:id"],
  ["participants", "/api/routing/overview", "after,limit,attention"],
  ["participant.sessions", "/api/routing/sessions", "after,limit"],
  ["participant", "/api/routing/sessions/:id"],
  ["participant.events", "/api/routing/sessions/:id/events", "after,limit"],
  ["participant.inbox", "/api/routing/sessions/:id/inbox", "limit"],
  ["participant.deliveries", "/api/routing/sessions/:id/deliveries", "limit"],
  ["participant.channels", "/api/routing/sessions/:id/channels"],
  ["participant.messages", "/api/routing/sessions/:id/channels/:channel/messages", "after,limit"],
  ["canvases", "/api/canvases", "limit"],
  ["canvas", "/api/canvases/:id"],
  ["canvas.node", "/api/canvases/:canvasId/nodes/:id"],
  ["assets", "/api/assets", "limit,mime"],
  ["media.jobs", "/api/media-jobs", "limit,entity"],
  ["memory.overview", "/api/memory/overview"],
  ["memory.hygiene", "/api/memory/hygiene"],
  ["memory.history", "/api/memory/hygiene/history", "hours"],
  ["memory.jobs", "/api/memory/jobs", "limit,state,role,entity,cursor"],
  ["memory.job", "/api/memory/jobs/:id"],
  ["memory.graph", "/api/memory/graph", "limit,entity"],
  ["memory.quality", "/api/memory/quality", "entity"],
  ["memory.contradictions", "/api/memory/contradictions", "status"],
  ["memory.notes", "/api/memory/notes/:name"],
  ["memory.note", "/api/notes/:id"],
  ["memory.core", "/api/memory/core/:name"],
  ["memory.pools", "/api/memory/pools"],
  ["graph", "/api/graph", "limit"],
  ["readiness", "/api/readiness"],
  ["operations.alerts", "/api/operations/alerts"],
  ["operations.overview", "/api/ops/overview"],
  ["productivity", "/api/productivity"],
  ["system", "/api/system"],
  ["traces", "/api/traces", "limit"],
  ["logs", "/api/logs", "limit"],
  ["federation.peers", "/api/federation/peers"],
  ["capabilities", "/api/command-catalog"],
  ["commands", "/api/commands"],
  ["room.templates", "/api/room-templates"],
  ["macros", "/api/macros"],
  ["experiments", "/api/experiments"],
  ["evolution.sessions", "/api/evolution-sessions"],
  ["markets", "/api/markets"],
  ["benchmarks", "/api/benchmarks"],
  ["recipes", "/api/recipes"],
];

/** The same discovery document is consumed by agents, SDKs and panel editors. */
export const PANEL_RESOURCE_CATALOG: readonly PanelResourceDefinition[] = Object.freeze(
  routes.map(([id, path, query]) =>
    Object.freeze({
      id,
      path,
      parameters: Object.freeze([...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!)),
      query: Object.freeze(query ? query.split(",") : []),
    }),
  ),
);

export interface CatalogPanelSource {
  kind: "resource";
  resource: string;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
}

/** Normalize untrusted authored references before they can reach an authenticated fetch. */
export function parseCatalogPanelSource(input: unknown): CatalogPanelSource | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (r.kind !== "resource") return null;
  const definition = PANEL_RESOURCE_CATALOG.find((d) => d.id === r.resource);
  if (!definition) return null;
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown): v is string =>
    typeof v === "string" &&
    v.length <= 1000 &&
    ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  if (r.params !== undefined && !record(r.params)) return null;
  if (r.query !== undefined && !record(r.query)) return null;
  const params = r.params ?? {};
  const query = r.query ?? {};
  if (
    Object.keys(params).some((key) => !definition.parameters.includes(key)) ||
    definition.parameters.some((key) => {
      const value = (params as Record<string, unknown>)[key];
      return (
        !Object.hasOwn(params, key) || !text(value) || !value || value === "." || value === ".."
      );
    }) ||
    Object.entries(query).some(
      ([key, value]) =>
        !definition.query.includes(key) ||
        !(
          text(value) ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        ),
    )
  )
    return null;
  return {
    kind: "resource",
    resource: definition.id,
    ...(definition.parameters.length ? { params: { ...params } as Record<string, string> } : {}),
    ...(Object.keys(query).length ? { query: { ...query } as CatalogPanelSource["query"] } : {}),
  };
}

/** Throws even for an invalid typed input: SDK consumers can be JavaScript callers. */
export function panelResourcePath(input: CatalogPanelSource): string {
  const source = parseCatalogPanelSource(input);
  if (!source) throw new Error("Unknown or invalid panel resource reference.");
  const definition = PANEL_RESOURCE_CATALOG.find((d) => d.id === source.resource)!;
  const path = definition.path.replace(/:([A-Za-z]+)/g, (_, key) =>
    encodeURIComponent(source.params![key]!),
  );
  const query = new URLSearchParams(
    Object.entries(source.query ?? {}).map(([key, value]) => [key, String(value)]),
  ).toString();
  return query ? `${path}?${query}` : path;
}
