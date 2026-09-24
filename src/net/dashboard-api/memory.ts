// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory routes in three dispatch-ordered groups: the observability surface
// (`/api/memory/overview|hygiene*|jobs*|graph|quality|contradictions*`), the
// graph snapshots (`/api/graph`, `/api/memory/graph/:name`) and the per-entity
// note surface (`/api/memory/notes|core/:name`, `/api/notes/:id`,
// `/api/memory/pools`). They are separate exports because other groups are
// interleaved between them and that precedence is load-bearing.

import { getErrorMessage } from "../../engine/errors";
import type { MarinaDB } from "../../persistence/database";
import { OPEN_API_ENTITY_ID } from "../auth-middleware";
import {
  buildMemoryGraph,
  buildMemoryOverview,
  cancelMemoryJob,
  getMemoryJob,
  listMemoryJobs,
  memoryHygieneHistory,
  memoryHygieneRatios,
  memoryObserverScope,
  snapshotMemoryHygiene,
} from "../memory-observability";
import { authorizeEntityRead, type DashboardRouteContext, json } from "./shared";

function getMemoryCore(db: MarinaDB, entityName: string): Response {
  return json(db.listCoreMemory(entityName));
}

/** Observer-scoped memory observability — overview, hygiene, jobs, graph. */
export async function handleMemoryObservabilityRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { callerId, db, engine, memory, method, req, url } = ctx;
  // ─── Memory observability (src/net/memory-observability.ts) ──────────────
  // Observer-scoped: operators / sovereigns / desktop token / dev-open see
  // everything; a resident sees only its own jobs, spaces, notes and credits.
  if (url.pathname === "/api/memory/overview" && method === "GET" && db) {
    return json(buildMemoryOverview(engine, memoryObserverScope(engine, callerId)));
  }
  // The continuous-hygiene ratios alone (also embedded in the overview) —
  // for scripts, benchmarks and readiness-style checks.
  if (url.pathname === "/api/memory/hygiene" && method === "GET" && db) {
    return json(memoryHygieneRatios(engine, memoryObserverScope(engine, callerId)));
  }
  // Ratio history (hourly snapshots, 30-day retention). The series is the
  // operator-scope aggregate, so it is privileged-only — a resident's own
  // ratios are always available live at /api/memory/hygiene.
  if (url.pathname === "/api/memory/hygiene/history" && method === "GET" && db) {
    if (!memory.privilegedRead) return json({ error: "Operator read capability required" }, 403);
    const hoursParam = Number.parseInt(url.searchParams.get("hours") ?? "", 10);
    return json(memoryHygieneHistory(engine, Number.isFinite(hoursParam) ? hoursParam : undefined));
  }
  // On-demand snapshot (tests, dashboards): writes one `scope="all"` sample now.
  if (url.pathname === "/api/memory/hygiene/snapshot" && method === "POST" && db) {
    if (!memory.privilegedRead) return json({ error: "Operator read capability required" }, 403);
    // The dev-open sentinel authorizes reads only; a snapshot is a write.
    if (callerId === OPEN_API_ENTITY_ID)
      return json({ error: "Operator credential required" }, 403);
    const sample = snapshotMemoryHygiene(engine);
    return sample ? json(sample) : json({ error: "No database" }, 503);
  }
  if (url.pathname === "/api/memory/jobs" && method === "GET" && db) {
    const stateParam = url.searchParams.get("state");
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    try {
      return json(
        listMemoryJobs(db, memoryObserverScope(engine, callerId), {
          state: stateParam === "all" ? "all" : "open",
          role: url.searchParams.get("role") ?? undefined,
          entity: url.searchParams.get("entity") ?? undefined,
          limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50,
          cursor: url.searchParams.get("cursor"),
        }),
      );
    } catch (cause) {
      return json({ error: getErrorMessage(cause) }, 400);
    }
  }
  const memoryJobMatch = url.pathname.match(/^\/api\/memory\/jobs\/([^/]+)(\/cancel)?$/);
  if (memoryJobMatch && db) {
    const jobId = decodeURIComponent(memoryJobMatch[1]!);
    const scope = memoryObserverScope(engine, callerId);
    if (!memoryJobMatch[2] && method === "GET") {
      const job = getMemoryJob(db, scope, jobId);
      return job ? json(job) : json({ error: "Job not found" }, 404);
    }
    if (memoryJobMatch[2] && method === "POST") {
      // The dev-open sentinel authorizes reads only; cancelling is a write.
      if (callerId === OPEN_API_ENTITY_ID)
        return json({ error: "Operator credential or requester session required" }, 403);
      const result = await cancelMemoryJob(db, scope, jobId);
      return result.ok ? json(result.job) : json({ error: result.error }, result.status);
    }
  }
  if (url.pathname === "/api/memory/graph" && method === "GET" && db) {
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    return json(
      buildMemoryGraph(engine, memoryObserverScope(engine, callerId), {
        entity: url.searchParams.get("entity") ?? undefined,
        limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 400,
      }),
    );
  }

  if (url.pathname === "/api/memory/quality" && method === "GET" && db) {
    const entity = url.searchParams.get("entity") ?? memory.entity?.name;
    if (!memory.privilegedRead && entity !== memory.entity?.name)
      return json({ error: "Not authorized" }, 403);
    return json(db.getMemoryQualitySummary(entity));
  }
  if (url.pathname === "/api/memory/contradictions" && method === "GET" && db) {
    db.refreshContradictionCases();
    const status = url.searchParams.get("status") === "resolved" ? "resolved" : "open";
    return json(
      db
        .listContradictionCases(status, 100)
        .filter(
          (conflict) =>
            memory.read(db.getNote(conflict.left_note_id)) &&
            memory.read(db.getNote(conflict.right_note_id)),
        )
        .map((conflict) => ({
          ...conflict,
          left: db.getNote(conflict.left_note_id),
          right: db.getNote(conflict.right_note_id),
        })),
    );
  }
  const contradictionResolveMatch = url.pathname.match(
    /^\/api\/memory\/contradictions\/(\d+)\/resolve$/,
  );
  if (contradictionResolveMatch && method === "POST" && db) {
    const body = (await req.json().catch(() => null)) as {
      resolution?: string;
      rationale?: string;
    } | null;
    const resolution = body?.resolution;
    if (
      !resolution ||
      !["left", "right", "both", "neither"].includes(resolution) ||
      !body?.rationale
    )
      return json({ error: "resolution and rationale required" }, 400);
    const conflict = db.getContradictionCase(Number(contradictionResolveMatch[1]));
    if (
      !conflict ||
      !memory.write(db.getNote(conflict.left_note_id)) ||
      !memory.write(db.getNote(conflict.right_note_id))
    )
      return json({ error: "Open case not found" }, 404);
    const actor = engine.entities.get(callerId)?.name ?? String(callerId);
    const ok = db.resolveContradictionCase(
      Number(contradictionResolveMatch[1]),
      resolution as "left" | "right" | "both" | "neither",
      actor,
      body.rationale,
    );
    return ok ? json({ ok: true }) : json({ error: "Open case not found" }, 404);
  }

  return undefined;
}

/** Knowledge-graph snapshots — global, then per-entity. */
export async function handleMemoryGraphRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { callerId, db, engine, memory, method, url } = ctx;
  // ─── Knowledge Graph API ───────────────────────────────────────────────
  // Global snapshot for the live graph overlay — bounded set of recent notes + links.
  if (url.pathname === "/api/graph" && method === "GET" && db) {
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 2000 ? limitParam : 500;
    const snapshot = db.getGraphSnapshot(limit);
    return json({
      notes: snapshot.notes
        .filter((n) => memory.read(db.getNote(n.id)))
        .map((n) => ({
          id: n.id,
          entityName: n.entity_name,
          content: n.content.length > 240 ? `${n.content.slice(0, 240)}…` : n.content,
          importance: n.importance,
          noteType: n.note_type,
          createdAt: n.created_at,
          lastAccessed: n.last_accessed,
          roomId: n.room_id,
          poolId: n.pool_id,
        })),
      links: snapshot.links
        .filter((l) => memory.read(db.getNote(l.source_id)) && memory.read(db.getNote(l.target_id)))
        .map((l) => ({
          sourceId: l.source_id,
          targetId: l.target_id,
          relationship: l.relationship,
        })),
    });
  }

  const graphMatch = url.pathname.match(/^\/api\/memory\/graph\/([^/]+)$/);
  if (graphMatch && method === "GET" && db) {
    const entityName = decodeURIComponent(graphMatch[1]!);
    const denied = authorizeEntityRead(engine, db, callerId, entityName);
    if (denied) return denied;
    const notes = db.getNotesByEntity(entityName, 50).filter(memory.read);
    const graph: {
      noteId: number;
      content: string;
      importance: number;
      noteType: string;
      links: { targetId: number; relationship: string }[];
    }[] = [];
    for (const note of notes) {
      const links = memory.links(note.id);
      if (links.length > 0) {
        graph.push({
          noteId: note.id,
          content: note.content.slice(0, 200),
          importance: note.importance,
          noteType: note.note_type,
          links: links.map((l) => ({
            targetId: l.source_id === note.id ? l.target_id : l.source_id,
            relationship: l.relationship,
          })),
        });
      }
    }
    return json(graph);
  }

  return undefined;
}

/** Per-entity notes, single-note detail, core memory and the pool listing. */
export async function handleMemoryNoteRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { callerId, db, engine, memory, method, url } = ctx;
  const memNotesMatch = url.pathname.match(/^\/api\/memory\/notes\/(.+)$/);
  if (memNotesMatch && db) {
    const entityName = decodeURIComponent(memNotesMatch[1]!);
    const denied = authorizeEntityRead(engine, db, callerId, entityName);
    if (denied) return denied;
    return json(db.getNotesByEntity(entityName, 50).filter(memory.read));
  }

  // Single-note detail: content, author, links, supersession chain
  const noteDetailMatch = url.pathname.match(/^\/api\/notes\/(\d+)$/);
  if (noteDetailMatch && method === "GET" && db) {
    const id = Number(noteDetailMatch[1]);
    const note = db.getNote(id);
    if (!note) return json({ error: "Note not found" }, 404);
    if (!memory.read(note)) return json({ error: "Not authorized to read this memory." }, 403);
    const links = memory.links(id);
    // Hydrate each link with the other note's brief preview for the UI
    const hydratedLinks = links.map((l) => {
      const otherId = l.source_id === id ? l.target_id : l.source_id;
      const direction = l.source_id === id ? "out" : "in";
      const other = db.getNote(otherId);
      return {
        id: l.id,
        otherId,
        direction,
        relationship: l.relationship,
        otherPreview: other
          ? other.content.length > 80
            ? `${other.content.slice(0, 80)}…`
            : other.content
          : null,
        otherType: other?.note_type ?? null,
      };
    });
    return json({
      id: note.id,
      entityName: note.entity_name,
      content: note.content,
      importance: note.importance,
      noteType: note.note_type,
      createdAt: note.created_at,
      lastAccessed: note.last_accessed,
      roomId: note.room_id,
      poolId: note.pool_id,
      supersedesId:
        note.supersedes_id && memory.read(db.getNote(note.supersedes_id))
          ? note.supersedes_id
          : null,
      confidence: note.confidence ?? 0.5,
      verificationStatus: note.verification_status ?? "unverified",
      claimKey: note.claim_key ?? null,
      sources: memory.sources(id),
      verifications: db.getNoteVerifications(id),
      links: hydratedLinks,
    });
  }

  const memCoreMatch = url.pathname.match(/^\/api\/memory\/core\/(.+)$/);
  if (memCoreMatch && db) {
    const entityName = decodeURIComponent(memCoreMatch[1]!);
    const denied = authorizeEntityRead(engine, db, callerId, entityName);
    if (denied) return denied;
    return getMemoryCore(db, entityName);
  }

  if (url.pathname === "/api/memory/pools" && db) {
    return json(db.listMemoryPools().filter(memory.pool));
  }

  return undefined;
}
