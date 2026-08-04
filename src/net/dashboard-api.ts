import { join, resolve } from "node:path";
import { getStanding } from "../agent/standing";
import { listWorkItems } from "../coordination/work-loop";
import { testKeyConnectivity } from "../engine/commands/key";
import { syncOperationalAlerts } from "../engine/commands/ops";
import { allRecipeNames, getRecipe } from "../engine/commands/usecase";
import type { Engine } from "../engine/engine";
import { getRank } from "../engine/permissions";
import { computeReadiness } from "../engine/readiness";
import { checkGate } from "../engine/safety-gates";
import type { MarinaDB, MediaJobRow } from "../persistence/database";
import { isKeyEncryptionEnabled } from "../persistence/key-crypto";
import type { Connection, EntityId, Perception, RoomId } from "../types";
import { ORCHESTRATION_PATTERNS } from "../world/templates/orchestration";
import { authenticateRequest, OPEN_API_ENTITY_ID } from "./auth-middleware";
import { corsHeaders } from "./cors";
import { formatPerception } from "./formatter";
import { discoverModels } from "./model-discovery";
import { type EndpointConfig, getEndpointConfig, setEndpointConfig } from "./model-endpoint";

const ROOMS_DIR = join(import.meta.dir, "../../rooms");
const PROJECT_ROOT = resolve(import.meta.dir, "../..");

/**
 * Per-IP rate limit for the pre-auth /api/setup-status endpoint. The
 * endpoint reports instance metadata (world, agent count, entity count)
 * used by the dashboard's login screen. Legitimate polling is sparse;
 * this cap is tight enough to frustrate scraping.
 *
 * 20 requests per IP per minute — two orders of magnitude above normal
 * use, two orders below a scraper.
 */
const SETUP_STATUS_WINDOW_MS = 60_000;
const SETUP_STATUS_LIMIT = 20;
const setupStatusHits = new Map<string, { count: number; windowStart: number }>();

function extractIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0]!.trim() : null) ?? req.headers.get("x-real-ip") ?? "unknown";
}

function setupStatusAllowed(ip: string): boolean {
  const now = Date.now();
  const entry = setupStatusHits.get(ip);
  if (!entry || now - entry.windowStart > SETUP_STATUS_WINDOW_MS) {
    setupStatusHits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= SETUP_STATUS_LIMIT) return false;
  entry.count++;
  return true;
}

function json(data: unknown, status = 200, origin?: string | null): Response {
  // Dashboard API is same-origin — CORS headers only needed for allowed origins
  return Response.json(data, {
    status,
    headers: corsHeaders(origin ?? null),
  });
}

interface CommandApiBody {
  command?: unknown;
  query?: unknown;
  name?: unknown;
  token?: unknown;
  render?: unknown;
}

async function readCommandBody(req: Request): Promise<CommandApiBody | { error: Response }> {
  const origin = req.headers.get("Origin");
  try {
    const body = (await req.json()) as CommandApiBody;
    if (!body || typeof body !== "object") {
      return { error: json({ error: "Expected JSON object body" }, 400, origin) };
    }
    return body;
  } catch {
    return { error: json({ error: "Invalid JSON body" }, 400, origin) };
  }
}

function bearerToken(req: Request): string | undefined {
  const auth = req.headers.get("Authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

function formatCommandText(perceptions: Perception[], render: unknown): string {
  const medium = render === "text" || render === "plaintext" ? "plaintext" : "markdown";
  return perceptions
    .map((p) => formatPerception(p, medium))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

async function handleCommandIngress(
  req: Request,
  engine: Engine,
  command: string,
  body: CommandApiBody,
): Promise<Response> {
  const origin = req.headers.get("Origin");
  if (!command.trim()) return json({ error: "Command is required" }, 400, origin);

  const ip = extractIp(req);
  if (engine.rateLimiter && !engine.rateLimiter.consume(`api:${ip}`)) {
    return json({ error: "Rate limited. Please slow down." }, 429, origin);
  }

  const token =
    typeof body.token === "string" && body.token.trim() ? body.token.trim() : bearerToken(req);
  const requestedName =
    typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
  const name = requestedName ?? `Api_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const connId = `api_${crypto.randomUUID().slice(0, 8)}`;
  const perceptions: Perception[] = [];

  const conn: Connection = {
    id: connId,
    protocol: "websocket",
    entity: null,
    connectedAt: Date.now(),
    send(perception: Perception) {
      perceptions.push(perception);
    },
    close() {
      engine.removeConnection(connId);
    },
  };

  engine.addConnection(conn);
  try {
    const session = token ? engine.reconnect(connId, token) : engine.login(connId, name);
    if ("error" in session) {
      return json({ error: session.error }, token ? 401 : 400, origin);
    }

    if (engine.rateLimiter && !engine.rateLimiter.consume(session.entityId)) {
      return json({ error: "Rate limited. Please slow down." }, 429, origin);
    }

    await engine.processCommand(session.entityId, command);

    return json(
      {
        entityId: session.entityId,
        name: session.name,
        token: session.token,
        command,
        perceptions,
        text: formatCommandText(perceptions, body.render),
      },
      200,
      origin,
    );
  } finally {
    engine.removeConnection(connId);
  }
}

/**
 * Authorization gate for privileged dashboard mutations (spawn / stop /
 * reconfigure agents, delete entities, manage keys). The dashboard
 * authenticates the request but historically discarded the identity, so any
 * signed-in user — or, under MARINA_OPEN_API, anyone — could spawn agents,
 * bypassing the `agent.spawn` safety gate the in-world command enforces.
 *
 * Returns null when allowed, or a 403 Response when not. Allowed if: the dev
 * open-API bypass is active (operator opted into MARINA_OPEN_API), OR the
 * caller is a sovereign admin (rank 9), OR the caller has earned/been-granted
 * the relevant safety gate. Mirrors "admin, or granted to a user".
 */
function authorizePrivileged(
  engine: Engine,
  db: MarinaDB | undefined,
  callerId: EntityId,
  gateId: string,
): Response | null {
  if (callerId === OPEN_API_ENTITY_ID) return null; // dev bypass — operator's choice
  const entity = engine.entities.get(callerId);
  if (entity && getRank(entity) >= 9) return null; // sovereign admin
  if (db && checkGate(db, callerId, gateId).ok) return null; // granted / earned the gate
  return json(
    { error: `Not authorized: this action requires an admin or the "${gateId}" capability.` },
    403,
  );
}

export async function handleDashboardApi(
  req: Request,
  url: URL,
  method: string,
  engine: Engine,
  db?: MarinaDB,
): Promise<Response | undefined> {
  // Pre-auth endpoints (no session required — used by dashboard before login)
  if (url.pathname === "/api/setup-status" && method === "GET") {
    const ip = extractIp(req);
    if (!setupStatusAllowed(ip)) {
      return json({ error: "Too many requests" }, 429);
    }
    const hasLlmKey = engine.agentRuntime.isAvailable();
    return json({
      instanceName: engine.instanceName,
      hasLlmKey,
      world: engine.world?.name ?? "Unknown",
      agentCount: engine.agentRuntime.size,
      entityCount: engine.entities.size,
    });
  }

  // Pre-auth UI capability flags. The Unified Canvas is a retired alternate
  // interface — off unless an operator opts in with MARINA_UNIFIED_CANVAS=true.
  if (url.pathname === "/api/ui-config" && method === "GET") {
    return json({ unifiedCanvas: process.env.MARINA_UNIFIED_CANVAS === "true" });
  }

  // Command-native ingress for alternate renderers and external agents.
  // This is intentionally thin: it creates a short-lived connection, logs in
  // or reconnects as a normal entity, executes the raw world command, captures
  // perceptions, and returns the latest session token.
  if (url.pathname === "/api/command" && method === "POST") {
    const body = await readCommandBody(req);
    if ("error" in body) return body.error;
    if (typeof body.command !== "string") {
      return json({ error: "Field 'command' must be a string" }, 400, req.headers.get("Origin"));
    }
    return handleCommandIngress(req, engine, body.command, body);
  }

  // Convenience wrapper for product-shaped ask surfaces. Behavior still lives
  // in the world-native `ask` word, not in this HTTP route.
  if (url.pathname === "/api/ask" && method === "POST") {
    const body = await readCommandBody(req);
    if ("error" in body) return body.error;
    if (typeof body.query !== "string") {
      return json({ error: "Field 'query' must be a string" }, 400, req.headers.get("Origin"));
    }
    return handleCommandIngress(req, engine, `ask ${body.query}`, body);
  }

  // Authenticate — every dashboard API route from this point on requires a
  // valid session token. The pre-auth surface above (`/api/setup-status`,
  // `/api/command`, `/api/ask`) is intentionally open / self-gated and runs
  // before this check.
  const auth = authenticateRequest(req, engine);
  if ("error" in auth) return auth.error;
  const callerId = auth.entityId;

  // Logout: revoke the bearer token used for this request. Only affects the
  // token presented; other sessions for the same entity (e.g. another device)
  // remain valid. Returns 200 even if the token was already gone.
  if (url.pathname === "/api/logout" && method === "POST") {
    const bearer = req.headers.get("Authorization")?.slice(7);
    if (bearer && engine.sessionManager) engine.sessionManager.revoke(bearer);
    return json({ ok: true });
  }

  if (url.pathname === "/api/world") {
    return getWorld(engine);
  }
  if (url.pathname === "/api/entities") {
    return getEntities(engine);
  }
  if (url.pathname === "/api/events") {
    return getEvents(engine, url);
  }
  if (url.pathname === "/api/system") {
    return getSystem(engine, db);
  }
  // Security posture for the Admin → Security panel. Reports the real state of
  // the hardening knobs (never secret values) so the panel can stop guessing.
  if (url.pathname === "/api/security-status" && method === "GET") {
    const audit = db ? db.auditEncryptedKeys() : { encrypted: 0, unreadable: 0 };
    return json({
      authRequired: !!engine.config.authRequired,
      openApi: process.env.MARINA_OPEN_API === "true",
      // Key-at-rest encryption: stored API keys are plaintext unless this is on.
      keyEncryption: isKeyEncryptionEnabled(),
      dbKeyCount: db ? db.getAllApiKeys().length : 0,
      // Encrypted rows that won't decrypt under the current secret — a loud
      // signal the secret is missing/changed and those keys read as gone.
      unreadableKeys: audit.unreadable,
    });
  }
  // Capability readiness — same data as the in-world `status` command. Reports
  // config presence (never secret values) + remediation per capability.
  if (url.pathname === "/api/readiness" && method === "GET") {
    return json(computeReadiness(engine));
  }
  if (url.pathname === "/api/operations/alerts" && method === "GET" && db) {
    if (engine.taskManager)
      syncOperationalAlerts({
        db,
        tasks: engine.taskManager,
        runtime: engine.agentRuntime,
        readiness: () => computeReadiness(engine),
      });
    return json(db.listOperationalAlerts(undefined, 100));
  }
  const opsAlertMatch = url.pathname.match(/^\/api\/operations\/alerts\/(\d+)\/(ack|resolve)$/);
  if (opsAlertMatch && method === "POST" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const ok = db.setOperationalAlertStatus(
      Number(opsAlertMatch[1]),
      opsAlertMatch[2] === "ack" ? "acknowledged" : "resolved",
    );
    return ok ? json({ ok: true }) : json({ error: "Alert not found" }, 404);
  }
  if (url.pathname === "/api/memory/quality" && method === "GET" && db) {
    return json(db.getMemoryQualitySummary(url.searchParams.get("entity") ?? undefined));
  }

  // Parameterized detail routes (check before list routes)
  const taskDetailMatch = url.pathname.match(/^\/api\/coordination\/tasks\/(\d+)$/);
  if (taskDetailMatch && db) {
    return getTaskDetail(db, Number(taskDetailMatch[1]));
  }

  // ─── Coding snapshot API ───────────────────────────────────────────────
  // Read-only snapshots of coding sessions/events/artifacts, mirroring the
  // /api/coordination/* shape. The live transcript flows over WS; these back
  // the StatusOverlay "navigate state that scrolled off" views. The coding
  // rows carry no connection/IP/token fields, so they're returned as-is.
  // Nested /artifacts must precede the bare session/:id matcher below.
  const codingArtifactsMatch = url.pathname.match(/^\/api\/coding\/session\/([^/]+)\/artifacts$/);
  if (codingArtifactsMatch && method === "GET" && db) {
    const sessionId = decodeURIComponent(codingArtifactsMatch[1]!);
    const kind = url.searchParams.get("kind") ?? undefined;
    const limit = clampLimit(url.searchParams.get("limit"), 100);
    const artifacts = db.listCodingArtifacts(sessionId, limit);
    return json(kind ? artifacts.filter((a) => a.kind === kind) : artifacts);
  }

  const codingSessionDetailMatch = url.pathname.match(/^\/api\/coding\/session\/([^/]+)$/);
  if (codingSessionDetailMatch && method === "GET" && db) {
    const sessionId = decodeURIComponent(codingSessionDetailMatch[1]!);
    const session = db.getCodingSession(sessionId);
    if (!session) return json({ error: "Coding session not found" }, 404);
    return json({
      session,
      events: db.listCodingEvents(sessionId, clampLimit(null, 200)),
      artifacts: db.listCodingArtifacts(sessionId, clampLimit(null, 100)),
    });
  }

  if (url.pathname === "/api/coding/sessions" && method === "GET" && db) {
    const createdBy = url.searchParams.get("createdBy") || undefined;
    const limit = clampLimit(url.searchParams.get("limit"), 10);
    const items = db.listCodingSessions(createdBy, limit);
    return json({ items, total: items.length });
  }

  // Paginated nested collections — must precede the greedy detail matchers
  // below (their `(.+)` would otherwise swallow the `/posts` and `/messages`
  // suffixes). `?limit=N` grows the page; response is { items, total }.
  const boardPostsMatch = url.pathname.match(/^\/api\/coordination\/boards\/(.+)\/posts$/);
  if (boardPostsMatch && db) {
    return getBoardPosts(db, decodeURIComponent(boardPostsMatch[1]!), url);
  }

  const channelMessagesMatch = url.pathname.match(
    /^\/api\/coordination\/channels\/(.+)\/messages$/,
  );
  if (channelMessagesMatch && db) {
    return getChannelMessages(db, decodeURIComponent(channelMessagesMatch[1]!), url);
  }

  const boardDetailMatch = url.pathname.match(/^\/api\/coordination\/boards\/(.+)$/);
  if (boardDetailMatch && db) {
    return getBoardDetail(db, decodeURIComponent(boardDetailMatch[1]!));
  }

  const groupDetailMatch = url.pathname.match(/^\/api\/coordination\/groups\/(.+)$/);
  if (groupDetailMatch && db) {
    return getGroupDetail(db, decodeURIComponent(groupDetailMatch[1]!));
  }

  const channelDetailMatch = url.pathname.match(/^\/api\/coordination\/channels\/(.+)$/);
  if (channelDetailMatch && db) {
    return getChannelDetail(db, decodeURIComponent(channelDetailMatch[1]!));
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/(.+)$/);
  if (roomMatch) {
    return await getRoomDetail(engine, db, decodeURIComponent(roomMatch[1]!));
  }

  // ─── Per-entity canvas resolution (lazy-creates on first access) ──────
  // GET /api/entities/:name/canvas — resolves (and creates if missing) the
  // canvas that belongs to the entity with the given display name. Response
  // shape matches GET /api/canvases/:id so the dashboard can treat it the
  // same as any other canvas once resolved.
  const entityCanvasMatch = url.pathname.match(/^\/api\/entities\/([^/]+)\/canvas$/);
  if (entityCanvasMatch && method === "GET" && db) {
    const entityName = decodeURIComponent(entityCanvasMatch[1]!);
    const entity = engine.findEntityGlobal(entityName);
    if (!entity) return json({ error: "Entity not found" }, 404);
    const canvas = db.ensureEntityCanvas(entity.id, entity.name, entity.name);
    return json({
      id: canvas.id,
      name: canvas.name,
      description: canvas.description,
      scope: canvas.scope,
      scopeId: canvas.scope_id,
      createdBy: canvas.creator_name,
      createdAt: canvas.created_at,
      updatedAt: canvas.updated_at,
      entityId: entity.id,
      entityName: entity.name,
    });
  }

  // ─── Feed timeline API ─────────────────────────────────────────────────
  // Queryable history of feed events — the dashboard primes the timeline
  // from this on connect and receives live updates via the feed_event WS type.
  if (url.pathname === "/api/feed" && method === "GET" && db) {
    const since = Number.parseInt(url.searchParams.get("since") ?? "", 10);
    const until = Number.parseInt(url.searchParams.get("until") ?? "", 10);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const kind = url.searchParams.get("kind") ?? undefined;
    const entity = url.searchParams.get("entity") ?? undefined;
    const events = db.queryFeedEvents({
      since: Number.isFinite(since) ? since : undefined,
      until: Number.isFinite(until) ? until : undefined,
      kind,
      entity,
      limit: Number.isFinite(limit) ? limit : 200,
    });
    return json(
      events.map((e) => ({
        id: e.id,
        kind: e.kind,
        entity: e.entity,
        ref: e.ref,
        summary: e.summary,
        payload: e.payload ? JSON.parse(e.payload) : null,
        timestamp: e.created_at,
      })),
    );
  }

  if (url.pathname === "/api/media-jobs" && method === "GET" && db) {
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const entity = url.searchParams.get("entity") ?? undefined;
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 100;
    const jobs = db.listMediaJobs({
      limit,
      entityName: entity ?? undefined,
    });
    return json(jobs.map((job) => serializeMediaJob(job, engine)));
  }

  const mediaRetryMatch = url.pathname.match(/^\/api\/media-jobs\/([^/]+)\/retry$/);
  if (mediaRetryMatch && method === "POST" && db) {
    if (!engine.mediaManager) return json({ error: "Media pipeline not configured" }, 503);
    const jobId = decodeURIComponent(mediaRetryMatch[1]!);
    const job = db.getMediaJob(jobId);
    if (!job) return json({ error: "Job not found" }, 404);
    try {
      const options = safeParse(job.options) as Record<string, unknown> | null;
      const metadata = safeParse(job.metadata) as Record<string, unknown> | null;
      const canvasId = typeof options?.canvasId === "string" ? options.canvasId : undefined;
      const entityId = (job.entity_id ?? job.entity_name) as EntityId;
      let next: MediaJobRow;
      if (job.type === "image") {
        next = await engine.mediaManager.startJob({
          type: "image",
          entityId,
          entityName: job.entity_name,
          prompt: job.prompt,
          model: job.model,
          canvasId,
          metadata: metadata ?? undefined,
          width: numberOrNull(options?.width),
          height: numberOrNull(options?.height),
          style: typeof options?.style === "string" ? (options.style as string) : undefined,
        });
      } else {
        next = await engine.mediaManager.startJob({
          type: "video",
          entityId,
          entityName: job.entity_name,
          prompt: job.prompt,
          model: job.model,
          canvasId,
          metadata: metadata ?? undefined,
          duration: numberOrNull(options?.duration),
          fps: numberOrNull(options?.fps),
          referenceImage:
            typeof options?.referenceImage === "string"
              ? (options.referenceImage as string)
              : undefined,
          aspectRatio:
            typeof options?.aspectRatio === "string" ? (options.aspectRatio as string) : undefined,
        });
      }
      return json(serializeMediaJob(next, engine), next.status === "succeeded" ? 200 : 202);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 400);
    }
  }

  // ─── Knowledge Graph API ───────────────────────────────────────────────
  // Global snapshot for the live graph overlay — bounded set of recent notes + links.
  if (url.pathname === "/api/graph" && method === "GET" && db) {
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 2000 ? limitParam : 500;
    const snapshot = db.getGraphSnapshot(limit);
    return json({
      notes: snapshot.notes.map((n) => ({
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
      links: snapshot.links.map((l) => ({
        sourceId: l.source_id,
        targetId: l.target_id,
        relationship: l.relationship,
      })),
    });
  }

  const graphMatch = url.pathname.match(/^\/api\/memory\/graph\/([^/]+)$/);
  if (graphMatch && method === "GET" && db) {
    const entityName = decodeURIComponent(graphMatch[1]!);
    const notes = db.getNotesByEntity(entityName, 50);
    const graph: {
      noteId: number;
      content: string;
      importance: number;
      noteType: string;
      links: { targetId: number; relationship: string }[];
    }[] = [];
    for (const note of notes) {
      const links = db.getNoteLinks(note.id);
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

  // ─── Entity Brief API ─────────────────────────────────────────────────
  // Must be checked before the generic /api/entities/:name catch-all
  const briefMatch = url.pathname.match(/^\/api\/entities\/([^/]+)\/brief$/);
  if (briefMatch && method === "GET" && db) {
    const entityName = decodeURIComponent(briefMatch[1]!);
    const entity = engine.findEntityGlobal(entityName);
    if (!entity) return json({ error: "Entity not found" }, 404);

    const onlineCount = engine.entities.all().filter((e) => e.id !== entity.id).length;
    const projects = db.listProjects("active");
    const openTasks = db.listTasks({ status: "open", limit: 100 });
    const myClaims = db.getActiveClaimsByName(entityName);
    const pools = db.listMemoryPools();
    const memoryCount = db.listCoreMemory(entityName).length;
    const goalEntry = db.getCoreMemory(entityName, "goal");
    const focusEntry = db.getCoreMemory(entityName, "focus");

    const pendingIntents = db.listCanvasIntents({
      statuses: ["pending"],
      expireActiveMs: 5 * 60 * 1000,
    }).length;

    return json({
      onlineCount,
      projectCount: projects.length,
      openTaskCount: openTasks.length,
      claimedTaskCount: myClaims.length,
      pendingIntents,
      poolCount: pools.length,
      memoryCount,
      goal: goalEntry?.value ?? null,
      focus: focusEntry?.value ?? null,
      topTask: myClaims[0]
        ? {
            id: myClaims[0].task_id,
            title: myClaims[0].title,
            progress: myClaims[0].progress,
          }
        : null,
    });
  }

  const workMatch = url.pathname.match(/^\/api\/entities\/([^/]+)\/work$/);
  if (workMatch && method === "GET" && db) {
    const entityName = decodeURIComponent(workMatch[1]!);
    const entity = engine.findEntityGlobal(entityName);
    if (!entity) return json({ error: "Entity not found" }, 404);

    return json({
      items: listWorkItems(entity, {
        db,
        taskManager: engine.taskManager,
        crewManager: engine.crewManager,
        quests: engine.world?.quests ?? [],
        startRoom: engine.config.startRoom,
        peers: engine.entities.inRoom(entity.room),
      }),
    });
  }

  const entityMatch = url.pathname.match(/^\/api\/entities\/(.+)$/);
  if (entityMatch) {
    const entityName = decodeURIComponent(entityMatch[1]!);
    if (method === "DELETE") {
      return (
        authorizePrivileged(engine, db, callerId, "admin.destructive") ??
        deleteEntity(engine, entityName)
      );
    }
    return getEntityDetail(engine, db, entityName);
  }

  const memNotesMatch = url.pathname.match(/^\/api\/memory\/notes\/(.+)$/);
  if (memNotesMatch && db) {
    return getMemoryNotes(db, decodeURIComponent(memNotesMatch[1]!));
  }

  // Single-note detail: content, author, links, supersession chain
  const noteDetailMatch = url.pathname.match(/^\/api\/notes\/(\d+)$/);
  if (noteDetailMatch && method === "GET" && db) {
    const id = Number(noteDetailMatch[1]);
    const note = db.getNote(id);
    if (!note) return json({ error: "Note not found" }, 404);
    const links = db.getNoteLinks(id);
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
      supersedesId: note.supersedes_id,
      confidence: note.confidence ?? 0.5,
      verificationStatus: note.verification_status ?? "unverified",
      claimKey: note.claim_key ?? null,
      sources: db.getNoteSources(id),
      links: hydratedLinks,
    });
  }

  const memCoreMatch = url.pathname.match(/^\/api\/memory\/core\/(.+)$/);
  if (memCoreMatch && db) {
    return getMemoryCore(db, decodeURIComponent(memCoreMatch[1]!));
  }

  if (url.pathname === "/api/memory/pools" && db) {
    return json(db.listMemoryPools());
  }
  if (url.pathname === "/api/coordination/boards" && db) {
    return getBoards(db);
  }
  if (url.pathname === "/api/coordination/tasks" && db) {
    // Paginated variant: `?paged=1&limit=N` returns { items, total } so the
    // Coordination panel can "load more" without silently dropping rows.
    // Without `paged`, returns a bare array (back-compat for other consumers).
    if (url.searchParams.get("paged")) {
      const limit = clampLimit(url.searchParams.get("limit"), 50);
      return json({ items: db.listTasks({ limit }), total: db.countTasks() });
    }
    return json(db.listTasks({ limit: 50 }));
  }
  if (url.pathname === "/api/coordination/channels" && db) {
    return getChannels(db);
  }
  if (url.pathname === "/api/coordination/groups" && db) {
    return getGroups(db);
  }
  if (url.pathname === "/api/coordination/projects" && db) {
    return getProjects(db);
  }
  if (url.pathname === "/api/connectors" && db) {
    return getConnectors(db);
  }
  if (url.pathname === "/api/commands" && db) {
    return getCommands(db);
  }

  // ─── Agent API ────────────────────────────────────────────────────────
  if (url.pathname === "/api/agents" && method === "GET") {
    return json(engine.agentRuntime.list());
  }
  if (url.pathname === "/api/agents/spawn" && method === "POST") {
    return (
      authorizePrivileged(engine, db, callerId, "agent.spawn") ?? handleAgentSpawn(req, engine)
    );
  }
  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const name = decodeURIComponent(agentMatch[1]!);
    if (method === "GET") {
      const agent = engine.agentRuntime.get(name);
      if (!agent) return json({ error: "Agent not found" }, 404);
      return json(agent.getStatus());
    }
  }
  const agentStopMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (agentStopMatch && method === "POST") {
    return (
      authorizePrivileged(engine, db, callerId, "agent.spawn") ??
      handleAgentStop(decodeURIComponent(agentStopMatch[1]!), engine)
    );
  }
  const agentAttentionMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/attention$/);
  if (agentAttentionMatch && method === "POST") {
    return (
      authorizePrivileged(engine, db, callerId, "agent.spawn") ??
      handleAgentAttention(req, decodeURIComponent(agentAttentionMatch[1]!), engine)
    );
  }
  const agentConfigMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/config$/);
  if (agentConfigMatch && method === "POST") {
    return (
      authorizePrivileged(engine, db, callerId, "agent.spawn") ??
      handleAgentConfig(req, decodeURIComponent(agentConfigMatch[1]!), engine)
    );
  }

  // ─── Key API ──────────────────────────────────────────────────────────
  if (url.pathname === "/api/keys" && method === "GET" && db) {
    const keys = db.getAllApiKeys().map((k) => ({
      name: k.name,
      provider: k.provider,
      masked: maskKey(k.encrypted_value),
      setBy: k.set_by,
      updatedAt: k.updated_at,
    }));
    return json(keys);
  }
  if (url.pathname === "/api/keys" && method === "POST" && db) {
    return authorizePrivileged(engine, db, callerId, "key.manage") ?? handleKeyAdd(req, db);
  }
  const keyDeleteMatch = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (keyDeleteMatch && method === "DELETE" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "key.manage");
    if (denied) return denied;
    const name = decodeURIComponent(keyDeleteMatch[1]!);
    const key = db.getApiKey(name);
    if (!key) return json({ error: "Key not found" }, 404);
    db.deleteApiKey(name);
    return json({ ok: true });
  }
  const keyTestMatch = url.pathname.match(/^\/api\/keys\/([^/]+)\/test$/);
  if (keyTestMatch && method === "POST" && db) {
    return handleKeyTest(decodeURIComponent(keyTestMatch[1]!), db);
  }

  // ─── Default model API ─────────────────────────────────────────────────
  // The model marina/default routes to and that new agents spawn with —
  // changeable at runtime (persisted in app_settings). `configured` is null when
  // falling back to the MARINA_DEFAULT_MODEL env/built-in value.
  if (url.pathname === "/api/default-model" && method === "GET" && db) {
    return json({
      model: db.getDefaultModel(),
      configured: db.getSetting("default_model") ?? null,
    });
  }
  if (url.pathname === "/api/default-model" && method === "PUT" && db) {
    const body = (await req.json().catch(() => ({}))) as { model?: string };
    const model = body.model?.trim();
    if (!model) return json({ error: "model is required" }, 400);
    if (!/^[\w.-]+\/[\w./:-]+$/.test(model)) {
      return json(
        { error: 'model must be "provider/model-id" (e.g. openrouter/openai/gpt-4o)' },
        400,
      );
    }
    db.setSetting("default_model", model);
    return json({ ok: true, model: db.getDefaultModel(), configured: model });
  }
  if (url.pathname === "/api/default-model" && method === "DELETE" && db) {
    db.deleteSetting("default_model");
    return json({ ok: true, model: db.getDefaultModel(), configured: null });
  }

  // ─── Model Endpoint API ────────────────────────────────────────────────
  // How Marina behaves when consumed as an LLM (passthru / agents / open / panel).
  if (url.pathname === "/api/model-endpoint" && method === "GET" && db) {
    return json(getEndpointConfig(db));
  }
  if (url.pathname === "/api/model-endpoint" && method === "PUT" && db) {
    const body = (await req.json().catch(() => ({}))) as Partial<EndpointConfig>;
    const result = setEndpointConfig(db, body);
    if ("error" in result) return json({ error: result.error }, 400);
    return json(result.config);
  }

  // ─── Model Discovery API ───────────────────────────────────────────────
  if (url.pathname === "/api/models" && method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    const result = await discoverModels(db, { refresh });
    return json(result);
  }

  // ─── Adapter API ──────────────────────────────────────────────────────
  if (url.pathname === "/api/adapters" && method === "GET" && db) {
    return getAdaptersWithEnv(db, engine);
  }
  if (url.pathname === "/api/adapters" && method === "POST" && db) {
    return handleAdapterSave(req, db, engine);
  }
  const adapterMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)$/);
  if (adapterMatch && method === "PATCH" && db) {
    return handleAdapterUpdate(req, decodeURIComponent(adapterMatch[1]!), db, engine);
  }
  if (adapterMatch && method === "DELETE" && db) {
    return handleAdapterDelete(decodeURIComponent(adapterMatch[1]!), db, engine);
  }

  // ─── Roles & Traits API ───────────────────────────────────────────────
  if (url.pathname === "/api/roles" && method === "GET" && db) {
    return json(db.getAllRoles());
  }
  if (url.pathname === "/api/traits" && method === "GET" && db) {
    return json(db.getAllTraits());
  }

  // ─── MCP Info API ────────────────────────────────────────────────────
  if (url.pathname === "/api/mcp" && method === "GET") {
    return json(getMcpInfo(req));
  }

  // ─── Env Config API ────────────────────────────────────────────────────
  if (url.pathname === "/api/env" && method === "GET") {
    return handleEnvGet();
  }
  if (url.pathname === "/api/env" && method === "PUT") {
    return handleEnvPut(req);
  }

  // ─── Room Templates, Macros, Experiments, Markets, Benchmarks ──────────
  if (url.pathname === "/api/room-templates" && method === "GET" && db) {
    return json(db.getAllRoomTemplates());
  }
  if (url.pathname === "/api/macros" && method === "GET" && db) {
    return json(db.listMacros());
  }
  if (url.pathname === "/api/experiments" && method === "GET" && db) {
    return json(db.listExperiments());
  }
  if (url.pathname === "/api/markets" && method === "GET" && db) {
    return json(db.listMarkets());
  }
  if (url.pathname === "/api/benchmarks" && method === "GET") {
    const benchmarks: { entity: string; scores: Record<string, number> }[] = [];
    for (const entity of engine.entities.all()) {
      const scores: Record<string, number> = {};
      for (const [key, val] of Object.entries(entity.properties)) {
        if (key.startsWith("bench_") && key.endsWith("_best") && typeof val === "number") {
          scores[key.replace("bench_", "").replace("_best", "")] = val;
        }
      }
      if (Object.keys(scores).length > 0) {
        benchmarks.push({ entity: entity.name, scores });
      }
    }
    return json(benchmarks);
  }

  // ─── Recipe API ───────────────────────────────────────────────────────
  if (url.pathname === "/api/recipes" && method === "GET") {
    const names = allRecipeNames();
    const recipes = names
      .map((name) => {
        const factory = getRecipe(name);
        if (!factory) return null;
        const sample = factory("<topic>");
        return {
          name: sample.name,
          description: sample.description,
          orchestration: sample.orchestration,
          taskCount: sample.tasks.length,
          agentCount: sample.agentCount,
          agentRole: sample.agentRole ?? null,
        };
      })
      .filter(Boolean);
    return json(recipes);
  }

  // ─── Project Orchestration API ───────────────────────────────────────
  const orchMatch = url.pathname.match(/^\/api\/coordination\/projects\/([^/]+)\/orchestration$/);
  if (orchMatch && method === "POST" && db) {
    const projectId = decodeURIComponent(orchMatch[1]!);
    const body = (await req.json()) as { orchestration?: string };
    if (!body.orchestration) return json({ error: "orchestration is required" }, 400);
    const validPatterns = ORCHESTRATION_PATTERNS as readonly string[];
    if (!validPatterns.includes(body.orchestration)) {
      return json({ error: `Invalid orchestration. Valid: ${validPatterns.join(", ")}` }, 400);
    }
    const project = db.getProject(projectId);
    if (!project) return json({ error: "Project not found" }, 404);
    db.updateProjectOrchestration(projectId, body.orchestration);
    return json({ ok: true, orchestration: body.orchestration });
  }

  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Not found" }, 404);
  }

  return undefined;
}

function getWorld(engine: Engine): Response {
  const rooms = engine.rooms.all().map((r) => {
    const district = r.id.split("/")[0] ?? "";
    const entities = engine.entities.inRoom(r.id);
    return {
      id: r.id,
      short: r.module.short,
      district,
      exits: r.module.exits ?? {},
      entityCount: entities.length,
    };
  });

  const entities = engine.entities.all().map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    room: e.room,
    rank: (e.properties.rank as number) ?? 0,
  }));

  return json({
    worldName: engine.world?.name ?? "Unknown",
    startRoom: engine.config.startRoom,
    rooms,
    entities,
  });
}

async function getRoomDetail(
  engine: Engine,
  db: MarinaDB | undefined,
  roomIdStr: string,
): Promise<Response> {
  const room = engine.rooms.get(roomIdStr as RoomId);
  if (!room) return json({ error: "Room not found" }, 404);

  const entities = engine.entities.inRoom(room.id).map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
  }));

  const longText = typeof room.module.long === "string" ? room.module.long : "[dynamic]";

  const items: Record<string, string> = {};
  if (room.module.items) {
    for (const [key, val] of Object.entries(room.module.items)) {
      items[key] = typeof val === "string" ? val : "[dynamic]";
    }
  }

  // Resolve source: DB → individual file → inline in world definition files
  let source: string | undefined;
  if (db) {
    const src = db.getRoomSource(roomIdStr);
    if (src) source = src.source;
  }
  if (!source) {
    // Try individual room files
    const filePaths = [
      engine.world?.roomsDir ? join(engine.world.roomsDir, `${roomIdStr}.ts`) : null,
      join(ROOMS_DIR, `${roomIdStr}.ts`),
      engine.world?.roomsDir
        ? join(engine.world.roomsDir, `${roomIdStr.split("/").pop()}.ts`)
        : null,
    ].filter(Boolean) as string[];

    for (const filePath of filePaths) {
      try {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          source = await file.text();
          break;
        }
      } catch {
        /* continue */
      }
    }
  }
  if (!source) {
    // Room is likely defined inline in a world .ts file — search worlds/ directory
    try {
      const worldsDir = resolve(PROJECT_ROOT, "worlds");
      const glob = new Bun.Glob("**/*.ts");
      for await (const path of glob.scan({ cwd: worldsDir, absolute: true })) {
        try {
          const content = await Bun.file(path).text();
          // Look for the room ID as a key in a rooms object (e.g. "bench/collaboration": ROOM_...)
          if (content.includes(`"${roomIdStr}"`)) {
            // Extract the room module definition — serialize what we have from the engine
            const mod = room.module;
            source = `// Defined inline in ${path.replace(`${PROJECT_ROOT}/`, "")}\n// Room: ${roomIdStr}\n\nconst room: RoomModule = {\n  short: ${JSON.stringify(mod.short)},\n  long: ${JSON.stringify(typeof mod.long === "string" ? mod.long : "[dynamic]")},\n  exits: ${JSON.stringify(room.module.exits ?? {}, null, 2).replace(/\n/g, "\n  ")},\n${
              mod.items
                ? `  items: ${JSON.stringify(mod.items, null, 2).replace(/\n/g, "\n  ")},\n`
                : ""
            }${mod.onEnter ? "  onEnter: [function],\n" : ""}${mod.onTick ? "  onTick: [function],\n" : ""}${mod.commands ? `  commands: [${Object.keys(mod.commands).join(", ")}],\n` : ""}};\n`;
            break;
          }
        } catch {
          /* continue */
        }
      }
    } catch {
      /* ignore */
    }
  }

  return json({
    id: room.id,
    short: room.module.short,
    long: longText,
    exits: room.module.exits ?? {},
    items,
    entities,
    source,
  });
}

function getEntities(engine: Engine): Response {
  const entities = engine.entities.all().map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    room: e.room,
    rank: (e.properties.rank as number) ?? 0,
  }));
  return json(entities);
}

function getEntityDetail(engine: Engine, db: MarinaDB | undefined, name: string): Response {
  const entity = engine.findEntityGlobal(name);
  if (!entity) return json({ error: "Entity not found" }, 404);

  const result: Record<string, unknown> = {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    room: entity.room,
    rank: (entity.properties.rank as number) ?? 0,
    properties: entity.properties,
    inventory: entity.inventory,
  };

  if (db) {
    result.coreMemory = db.listCoreMemory(entity.name);
    result.notes = db.getNotesByEntity(entity.name, 10);
    result.recentActivity = db.getEventsByEntity(entity.id, 20);
    // Civic standing — surfaced in the entity view now that Entities is the
    // primary observe/control surface.
    result.standing = Math.round(getStanding(db, entity.id) * 10) / 10;
  }

  return json(result);
}

function getSystem(engine: Engine, db?: MarinaDB): Response {
  const entities = engine.entities.all();
  const agents = entities.filter((e) => e.kind === "agent");
  const npcs = entities.filter((e) => e.kind === "npc");
  const roomPops: Record<string, number> = {};
  for (const e of agents) {
    roomPops[e.room] = (roomPops[e.room] ?? 0) + 1;
  }

  const result: Record<string, unknown> = {
    status: "ok",
    uptime: engine.getUptime(),
    connections: engine.getConnections().size,
    rooms: engine.rooms.size,
    entities: {
      total: entities.length,
      agents: agents.length,
      npcs: npcs.length,
    },
    roomPopulations: roomPops,
    memory: {
      heapUsed: process.memoryUsage().heapUsed,
      rss: process.memoryUsage().rss,
    },
  };

  if (db) {
    const allTasks = db.listTasks({ limit: 1000 });
    const taskCounts = { open: 0, claimed: 0, submitted: 0, completed: 0 };
    for (const t of allTasks) {
      if (t.status in taskCounts) {
        taskCounts[t.status as keyof typeof taskCounts]++;
      }
    }
    result.tasks = taskCounts;
    result.projectCount = db.listProjects().length;
    result.connectorCount = db.listConnectors().length;
    result.commandCount = db.listCommands().length;
  }

  return json(result);
}

function getEvents(engine: Engine, url: URL): Response {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  const events = engine
    .getEventLog()
    .filter((e) => e.type !== "tick")
    .slice(-limit);
  return json(events);
}

function getMemoryNotes(db: MarinaDB, entityName: string): Response {
  return json(db.getNotesByEntity(entityName, 50));
}

function getMemoryCore(db: MarinaDB, entityName: string): Response {
  return json(db.listCoreMemory(entityName));
}

function getBoards(db: MarinaDB): Response {
  const boards = db.getAllBoards().map((b) => {
    const posts = db.listBoardPosts(b.id, { limit: 1000 });
    return { ...b, postCount: posts.length };
  });
  return json(boards);
}

function getChannels(db: MarinaDB): Response {
  const channels = db.getAllChannels().map((c) => {
    return { ...c, messageCount: String(db.countChannelMessages(c.id)) };
  });
  return json(channels);
}

function getGroups(db: MarinaDB): Response {
  const groups = db.getAllGroups().map((g) => {
    const members = db.getGroupMembers(g.id);
    return { ...g, memberCount: members.length };
  });
  return json(groups);
}

async function deleteEntity(engine: Engine, name: string): Promise<Response> {
  const entity = engine.findEntityGlobal(name);
  if (!entity) {
    return json({ error: "Entity not found" }, 404);
  }
  const result = await engine.removeEntity(entity.id);
  if ("error" in result) {
    return json({ error: result.error }, 500);
  }
  return json({ ok: true, name: result.name });
}

// --- New drill-down endpoints ---

function getProjects(db: MarinaDB): Response {
  const projects = db.listProjects().map((p) => {
    let bundleProgress:
      | { total: number; done: number; recoveries: number; meanTaskCycleMs?: number }
      | undefined;
    if (p.bundle_id) {
      const children = db.listTasks({ parentId: p.bundle_id, limit: 200 });
      const done = children.filter((t) => t.status === "completed").length;
      const claims = children.flatMap((task) => db.getTaskClaims(task.id));
      const resolvedMs = claims
        .filter((claim) => claim.resolved_at !== null)
        .map((claim) => claim.resolved_at! - claim.claimed_at)
        .filter((duration) => duration >= 0);
      bundleProgress = {
        total: children.length,
        done,
        recoveries: claims.filter((claim) => claim.release_reason === "lease_expired").length,
        ...(resolvedMs.length > 0
          ? {
              meanTaskCycleMs: Math.round(
                resolvedMs.reduce((a, b) => a + b, 0) / resolvedMs.length,
              ),
            }
          : {}),
      };
    }
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      orchestration: p.orchestration,
      memory_arch: p.memory_arch,
      status: p.status,
      bundle_id: p.bundle_id,
      pool_id: p.pool_id,
      group_id: p.group_id,
      created_by: p.created_by,
      budget_tokens: p.budget_tokens,
      budget_cost: p.budget_cost,
      budget_duration_ms: p.budget_duration_ms,
      used_tokens: p.used_tokens,
      used_cost: p.used_cost,
      created_at: p.created_at,
      bundleProgress,
    };
  });
  return json(projects);
}

function getConnectors(db: MarinaDB): Response {
  const connectors = db.listConnectors().map((c) => ({
    id: c.id,
    name: c.name,
    transport: c.transport,
    url: c.url,
    status: c.status,
    auth_type: c.auth_type,
    created_by: c.created_by,
  }));
  return json(connectors);
}

function getCommands(db: MarinaDB): Response {
  const commands = db.listCommands().map((c) => ({
    id: c.id,
    name: c.name,
    version: c.version,
    valid: c.valid,
    created_by: c.created_by,
    created_at: c.created_at,
  }));
  return json(commands);
}

function getTaskDetail(db: MarinaDB, taskId: number): Response {
  const task = db.getTask(taskId);
  if (!task) return json({ error: "Task not found" }, 404);

  const children = db.listTasks({ parentId: taskId, limit: 50 }).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    creator_name: t.creator_name,
    created_at: t.created_at,
  }));

  return json({
    id: task.id,
    title: task.title,
    status: task.status,
    description: task.description,
    creator_name: task.creator_name,
    parent_task_id: task.parent_task_id,
    created_at: task.created_at,
    children: children.length > 0 ? children : undefined,
  });
}

function getBoardDetail(db: MarinaDB, boardName: string): Response {
  const boards = db.getAllBoards();
  const board = boards.find((b) => b.name === boardName);
  if (!board) return json({ error: "Board not found" }, 404);

  const posts = db.listBoardPosts(board.id, { limit: 5 }).map((p) => ({
    id: p.id,
    title: p.title,
    body: p.body,
    author_name: p.author_name,
    created_at: p.created_at,
  }));

  return json({
    id: board.id,
    name: board.name,
    scope_type: board.scope_type,
    postCount: db.countBoardPosts(board.id),
    created_at: board.created_at,
    posts,
  });
}

/** Clamp a `?limit=` query param into a sane range (default `dflt`, max 1000). */
function clampLimit(raw: string | null, dflt: number): number {
  const n = raw ? Number(raw) : dflt;
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), 1000);
}

function getBoardPosts(db: MarinaDB, boardName: string, url: URL): Response {
  const board = db.getAllBoards().find((b) => b.name === boardName);
  if (!board) return json({ error: "Board not found" }, 404);
  const limit = clampLimit(url.searchParams.get("limit"), 25);
  const items = db.listBoardPosts(board.id, { limit }).map((p) => ({
    id: p.id,
    title: p.title,
    body: p.body,
    author_name: p.author_name,
    created_at: p.created_at,
  }));
  return json({ items, total: db.countBoardPosts(board.id) });
}

function getChannelMessages(db: MarinaDB, channelName: string, url: URL): Response {
  const channel = db.getAllChannels().find((c) => c.name === channelName);
  if (!channel) return json({ error: "Channel not found" }, 404);
  const limit = clampLimit(url.searchParams.get("limit"), 25);
  const items = db.getChannelHistory(channel.id, limit).map((m) => ({
    sender_name: m.sender_name,
    content: m.content,
    created_at: m.created_at,
  }));
  return json({ items, total: db.countChannelMessages(channel.id) });
}

function getGroupDetail(db: MarinaDB, groupName: string): Response {
  const groups = db.getAllGroups();
  const group = groups.find((g) => g.name === groupName);
  if (!group) return json({ error: "Group not found" }, 404);

  const members = db.getGroupMembers(group.id);

  return json({
    id: group.id,
    name: group.name,
    description: group.description,
    leader_id: group.leader_id,
    memberCount: members.length,
    members: members.map((m) => ({
      entity_id: m.entity_id,
      rank: m.rank,
      joined_at: m.joined_at,
    })),
  });
}

function getChannelDetail(db: MarinaDB, channelName: string): Response {
  const channels = db.getAllChannels();
  const channel = channels.find((c) => c.name === channelName);
  if (!channel) return json({ error: "Channel not found" }, 404);

  const messages = db.getChannelHistory(channel.id, 5).map((m) => ({
    sender_name: m.sender_name,
    content: m.content,
    created_at: m.created_at,
  }));

  return json({
    id: channel.id,
    name: channel.name,
    type: channel.type,
    messageCount: String(db.countChannelMessages(channel.id)),
    messages,
  });
}

// ─── Agent API Handlers ─────────────────────────────────────────────────────

async function handleAgentSpawn(req: Request, engine: Engine): Promise<Response> {
  try {
    const body = (await req.json()) as {
      name?: string;
      model?: string;
      role?: string;
      goal?: string;
      keyName?: string;
    };
    if (!body.name) return json({ error: "name is required" }, 400);

    const handle = await engine.agentRuntime.spawn({
      name: body.name,
      model: body.model,
      role: body.role,
      goal: body.goal,
      keyName: body.keyName,
      // Mark operator/dashboard launches distinctly so the roster can tell them
      // apart from world-seeded ("system") agents. (Crew sub-agents record the
      // spawning agent's name.)
      spawnedBy: "operator",
    });

    const status = handle.getStatus();
    // Broadcast the lifecycle event so every connected dashboard refreshes its
    // agent list live. Without this, the HTTP spawn path (used by the dashboard
    // launch form) never triggers the ["agents"] realtime invalidation, so a
    // freshly launched agent doesn't appear until the 60s heartbeat or a manual
    // refetch (e.g. flipping the card). Mirrors the in-world `agent spawn`.
    engine.logEvent({
      type: "agent_spawn",
      entity: (status.entityId ?? "") as EntityId,
      name: body.name,
      model: status.model,
      role: status.role ?? "",
      timestamp: Date.now(),
    });

    return json(status);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function handleAgentStop(name: string, engine: Engine): Promise<Response> {
  try {
    // Snapshot the entity id before stopping (getStatus is unavailable once the
    // handle is gone), then emit the lifecycle event — same as the in-world
    // `agent stop`. Besides refreshing dashboards live, logEvent routes
    // agent_stop to crewManager.onAgentStopped, so an HTTP-path stop also makes
    // the agent depart its crew (which the old direct-stop path skipped).
    const status = engine.agentRuntime.get(name)?.getStatus();
    await engine.agentRuntime.stop(name);
    engine.logEvent({
      type: "agent_stop",
      entity: (status?.entityId ?? "") as EntityId,
      name,
      reason: "manual",
      timestamp: Date.now(),
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function handleAgentAttention(req: Request, name: string, engine: Engine): Promise<Response> {
  const agent = engine.agentRuntime.get(name);
  if (!agent) return json({ error: "Agent not found" }, 404);

  const body = (await req.json()) as { message?: string };
  if (!body.message) return json({ error: "message is required" }, 400);

  await agent.sendAttention(body.message);
  return json({ ok: true });
}

async function handleAgentConfig(req: Request, name: string, engine: Engine): Promise<Response> {
  const agent = engine.agentRuntime.get(name);
  if (!agent) return json({ error: "Agent not found" }, 404);

  const body = (await req.json()) as { model?: string; role?: string; key?: string };
  await engine.agentRuntime.reconfigure(name, {
    model: body.model,
    role: body.role,
    keyName: body.key,
  });
  return json(agent.getStatus());
}

// ─── Key API Handlers ───────────────────────────────────────────────────────

async function handleKeyAdd(req: Request, db: MarinaDB): Promise<Response> {
  const body = (await req.json()) as { name?: string; provider?: string; value?: string };
  if (!body.name || !body.provider || !body.value) {
    return json({ error: "name, provider, and value are required" }, 400);
  }

  db.saveApiKey({
    name: body.name,
    provider: body.provider,
    encryptedValue: body.value,
    isEncrypted: false,
    setBy: "dashboard",
  });

  return json({ ok: true, name: body.name, provider: body.provider });
}

function getMcpInfo(req: Request): object {
  const host = req.headers.get("Host") ?? "localhost:3300";
  const bare = host.replace(/:\d+$/, "");
  const mcpPort = Number(process.env.MCP_PORT) || 3301;

  return {
    url: `http://${bare}:${mcpPort}/mcp`,
    port: mcpPort,
    tools: {
      bootstrap: [
        { name: "login", description: "Log in with a character name" },
        { name: "auth", description: "Reconnect with a session token" },
      ],
      cognition: [
        { name: "think", description: "Notes, recall, reflect" },
        { name: "memory", description: "Core memory (set/get/list)" },
        { name: "next", description: "Context-aware guidance" },
        { name: "brief", description: "World orientation signal" },
        { name: "quest", description: "Tutorial & quest tracking" },
      ],
      world: [
        { name: "look", description: "Examine current room" },
        { name: "move", description: "Navigate between rooms" },
        { name: "say", description: "Speak to the room" },
        { name: "tell", description: "Private message" },
        { name: "who", description: "List online entities" },
        { name: "examine", description: "Inspect entity or item" },
      ],
      coordination: [
        { name: "channel", description: "Async messaging channels" },
        { name: "board", description: "Post to bulletin boards" },
        { name: "group", description: "Manage groups" },
        { name: "task", description: "Task management" },
      ],
      canvas: [{ name: "canvas", description: "Publish media, feeds, and interactive UIs" }],
      building: [{ name: "build", description: "Create rooms and exits" }],
      escape: [
        { name: "command", description: "Run any engine command" },
        { name: "batch", description: "Run multiple commands" },
      ],
      session: [
        { name: "help", description: "List available tools" },
        { name: "quit", description: "Disconnect session" },
      ],
    },
  };
}

// ─── Adapter API Handlers ──────────────────────────────────────────────────

const ADAPTER_ENV_MAP: Record<string, string> = {
  telegram: "TELEGRAM_TOKEN",
  discord: "DISCORD_TOKEN",
};

function getAdaptersWithEnv(db: MarinaDB, engine: Engine): Response {
  const dbAdapters = db.getAllAdapters();
  const mgr = engine.adapterManager;
  const result: Array<Record<string, unknown>> = [];

  // DB-stored adapters
  for (const a of dbAdapters) {
    result.push({ ...a, source: "db", running: mgr?.isRunning(a.platform) ?? false });
  }

  // Env-detected adapters (only add if not already in DB)
  const dbPlatforms = new Set(dbAdapters.map((a) => a.platform));
  for (const [platform, envVar] of Object.entries(ADAPTER_ENV_MAP)) {
    if (process.env[envVar] && !dbPlatforms.has(platform)) {
      result.push({
        platform,
        config: "{}",
        status: "active",
        set_by: "env",
        source: "env",
        envVar,
        running: mgr?.isRunning(platform) ?? false,
        created_at: 0,
        updated_at: 0,
      });
    }
  }

  return json(result);
}

async function handleAdapterSave(req: Request, db: MarinaDB, engine: Engine): Promise<Response> {
  const body = (await req.json()) as { platform?: string; config?: string };
  if (!body.platform) return json({ error: "platform is required" }, 400);

  const allowedPlatforms = ["telegram", "discord"];
  if (!allowedPlatforms.includes(body.platform)) {
    return json({ error: `Invalid platform. Allowed: ${allowedPlatforms.join(", ")}` }, 400);
  }

  db.saveAdapter({
    platform: body.platform,
    config: body.config ?? "{}",
    status: "active",
    setBy: "dashboard",
  });

  // Hot-start the adapter
  const mgr = engine.adapterManager;
  if (mgr && !mgr.isRunning(body.platform)) {
    try {
      await mgr.start(body.platform);
    } catch (err) {
      return json({
        ok: true,
        platform: body.platform,
        running: false,
        startError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return json({ ok: true, platform: body.platform, running: true });
}

async function handleAdapterUpdate(
  req: Request,
  platform: string,
  db: MarinaDB,
  engine: Engine,
): Promise<Response> {
  const dbAdapter = db.getAdapter(platform);
  // Allow updating env-sourced adapters that aren't in DB yet
  const envVar = ADAPTER_ENV_MAP[platform];
  if (!dbAdapter && !(envVar && process.env[envVar])) {
    return json({ error: "Adapter not found" }, 404);
  }

  const body = (await req.json()) as { status?: string };
  if (!body.status) return json({ error: "status is required" }, 400);

  const allowedStatuses = ["active", "disabled"];
  if (!allowedStatuses.includes(body.status)) {
    return json({ error: `Invalid status. Allowed: ${allowedStatuses.join(", ")}` }, 400);
  }

  // Persist to DB
  if (dbAdapter) {
    db.updateAdapterStatus(platform, body.status);
  }

  // Hot-start or hot-stop the adapter
  const mgr = engine.adapterManager;
  if (mgr) {
    try {
      if (body.status === "active" && !mgr.isRunning(platform)) {
        await mgr.start(platform);
      } else if (body.status === "disabled" && mgr.isRunning(platform)) {
        await mgr.stop(platform);
      }
    } catch (err) {
      return json({
        ok: true,
        platform,
        status: body.status,
        running: mgr.isRunning(platform),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return json({ ok: true, platform, status: body.status, running: mgr?.isRunning(platform) });
}

async function handleAdapterDelete(
  platform: string,
  db: MarinaDB,
  engine: Engine,
): Promise<Response> {
  const adapter = db.getAdapter(platform);
  if (!adapter) return json({ error: "Adapter not found" }, 404);

  // Hot-stop if running
  const mgr = engine.adapterManager;
  if (mgr?.isRunning(platform)) {
    try {
      await mgr.stop(platform);
    } catch {
      // Best effort — remove config regardless
    }
  }

  db.deleteAdapter(platform);
  return json({ ok: true, platform });
}

// ─── Key Test Handler ──────────────────────────────────────────────────────

async function handleKeyTest(name: string, db: MarinaDB): Promise<Response> {
  const key = db.getApiKey(name);
  if (!key) return json({ error: "Key not found" }, 404);

  const result = await testKeyConnectivity(key.provider, key.encrypted_value);
  return json({ name, provider: key.provider, ...result });
}

// ─── Env Config Handlers ───────────────────────────────────────────────────

const SECRET_PATTERNS = [
  "API_KEY",
  "TOKEN",
  "PASSWORD",
  "SECRET",
  "MEM_API_KEYS",
  "MODEL_API_KEYS",
];

function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((p) => key.includes(p));
}

function maskEnvValue(key: string, value: string): string {
  if (!isSecretKey(key) || !value) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}${"*".repeat(4)}${value.slice(-4)}`;
}

interface EnvEntry {
  key: string;
  value: string;
  description: string;
  category: string;
  isSecret: boolean;
  isSet: boolean;
  /** False when the value comes from the live process environment (shell/docker)
   * rather than our managed .env file — editing it here can't override it. */
  editable: boolean;
  source: "env" | "file" | "unset";
}

function parseEnvExample(): Array<{ key: string; description: string; category: string }> {
  const examplePath = join(PROJECT_ROOT, ".env.example");
  let content: string;
  try {
    content = require("node:fs").readFileSync(examplePath, "utf-8");
  } catch {
    return [];
  }

  const result: Array<{ key: string; description: string; category: string }> = [];
  let currentCategory = "General";
  let pendingComments: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Section headers: # ─── Category ───
    const sectionMatch = trimmed.match(/^#\s*─+\s*(.+?)\s*─+$/);
    if (sectionMatch) {
      currentCategory = sectionMatch[1]!.trim();
      pendingComments = [];
      continue;
    }

    // Comment lines (accumulate as description for next var)
    if (trimmed.startsWith("#") && !sectionMatch) {
      pendingComments.push(trimmed.replace(/^#\s?/, ""));
      continue;
    }

    // Env var lines (KEY=value or # KEY=value for commented-out defaults)
    const varMatch = trimmed.match(/^#?\s*([A-Z_][A-Z0-9_]*)=/);
    if (varMatch) {
      result.push({
        key: varMatch[1]!,
        description: pendingComments.join(" ").trim(),
        category: currentCategory,
      });
      pendingComments = [];
      continue;
    }

    // Blank lines reset pending comments
    if (!trimmed) {
      pendingComments = [];
    }
  }

  return result;
}

function parseEnvFile(): Map<string, string> {
  const envPath = join(PROJECT_ROOT, ".env");
  let content: string;
  try {
    content = require("node:fs").readFileSync(envPath, "utf-8");
  } catch {
    return new Map();
  }

  const vars = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars.set(key, value);
  }
  return vars;
}

function handleEnvGet(): Response {
  const schema = parseEnvExample();
  const fileVars = parseEnvFile();

  const entries: EnvEntry[] = schema.map((s) => {
    const inFile = fileVars.has(s.key);
    const procVal = process.env[s.key];
    const inProc = procVal !== undefined && procVal !== "";

    // A value present in the live environment but NOT in our managed .env file
    // is set out-of-band (shell export, docker-compose, systemd). The panel
    // edits .env, but that external value shadows whatever we'd write — so
    // report it as set-but-read-only, with its live (masked) value, instead of
    // pretending it's unset and offering a futile editable field.
    const externallySet = inProc && !inFile;
    const rawValue = inFile ? (fileVars.get(s.key) ?? "") : (procVal ?? "");

    return {
      key: s.key,
      value: maskEnvValue(s.key, rawValue),
      description: s.description,
      category: s.category,
      isSecret: isSecretKey(s.key),
      isSet: inFile || inProc,
      editable: !externallySet,
      source: externallySet ? "env" : inFile ? "file" : "unset",
    };
  });

  return json(entries);
}

// Env vars that are read live from process.env on each access (safe to hot-reload)
const HOT_RELOADABLE_VARS = new Set([
  "ALLOWED_ORIGINS",
  "MODEL_API_KEYS",
  "MEM_API_KEYS",
  "DASHBOARD_PASSWORD",
  "MARINA_ADMINS",
  "START_ROOM",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TELEGRAM_TOKEN",
  "DISCORD_TOKEN",
  "DISCORD_CHANNEL_IDS",
  "TAVILY_API_KEY",
  "SEARXNG_URL",
  "AGENT_AUTORESPAWN",
  "MAX_AGENTS",
  "MAX_AGENT_UPTIME_MS",
]);

async function handleEnvPut(req: Request): Promise<Response> {
  const body = (await req.json()) as { vars?: Record<string, string> };
  if (!body.vars || typeof body.vars !== "object") {
    return json({ error: "vars object is required" }, 400);
  }

  // Validate against .env.example schema
  const schema = parseEnvExample();
  const allowedKeys = new Set(schema.map((s) => s.key));
  const invalid = Object.keys(body.vars).filter((k) => !allowedKeys.has(k));
  if (invalid.length > 0) {
    return json({ error: `Unknown env vars: ${invalid.join(", ")}` }, 400);
  }

  // Read current .env to preserve masked values and unmodified vars
  const currentVars = parseEnvFile();

  // Track what actually changed
  const reloaded: string[] = [];
  const restartRequired: string[] = [];

  // Merge: if value contains only mask characters, keep existing value
  const merged = new Map(currentVars);
  for (const [key, value] of Object.entries(body.vars)) {
    // Skip vars set in the live environment but not in our .env file: writing
    // .env would be shadowed by the external value, so accepting the edit would
    // be misleading. The UI disables these, this is the server-side backstop.
    if (process.env[key] !== undefined && !currentVars.has(key)) {
      continue;
    }

    if (/^\*+$/.test(value) || /^.{4}\*{4}.{4}$/.test(value)) {
      // Masked value — keep existing
      continue;
    }

    const oldValue = currentVars.get(key) ?? "";
    if (value === oldValue) continue; // No change

    if (value === "") {
      merged.delete(key);
    } else {
      merged.set(key, value);
    }

    // Apply to process.env if hot-reloadable
    if (HOT_RELOADABLE_VARS.has(key)) {
      if (value === "") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
      reloaded.push(key);
    } else {
      restartRequired.push(key);
    }
  }

  // Write atomically
  const envPath = join(PROJECT_ROOT, ".env");
  const tmpPath = join(PROJECT_ROOT, ".env.tmp");
  const lines: string[] = [];

  // Preserve structure from .env.example
  for (const entry of schema) {
    const val = merged.get(entry.key);
    if (val !== undefined) {
      lines.push(`${entry.key}=${val}`);
    }
  }

  // Append any vars in current .env that aren't in schema (preserve custom vars)
  for (const [key, value] of merged) {
    if (!allowedKeys.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  const fs = require("node:fs");
  try {
    fs.writeFileSync(tmpPath, `${lines.join("\n")}\n`, "utf-8");
    fs.renameSync(tmpPath, envPath);
  } catch (err) {
    return json({ error: `Failed to write .env: ${err}` }, 500);
  }

  return json({ ok: true, reloaded, restartRequired });
}

function serializeMediaJob(job: MediaJobRow, engine: Engine): Record<string, unknown> {
  const options = safeParse(job.options) as Record<string, unknown> | null;
  const metadata = safeParse(job.metadata) as Record<string, unknown> | null;
  const asset =
    job.asset_id && engine.db ? (engine.db.getAsset(job.asset_id) ?? undefined) : undefined;
  const assetUrl = asset && engine.storage ? engine.storage.resolve(asset.storage_key) : null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    provider: job.provider,
    model: job.model,
    prompt: job.prompt,
    entityName: job.entity_name,
    costEstimate: job.cost_estimate,
    error: job.error,
    assetId: job.asset_id,
    assetUrl,
    options,
    metadata,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
  };
}

function numberOrNull(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function maskKey(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
