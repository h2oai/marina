// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Everything the world surface still answers, in four dispatch-ordered
// groups: the parameterized coordination/coding/room/canvas/feed/media detail
// routes (deliberately ahead of the list routes whose greedy patterns would
// otherwise swallow them), the per-entity brief/work/detail routes, the
// coordination list routes and the read-only catalog tail (templates, macros,
// experiments, evolution sessions, markets, benchmarks, recipes, project
// orchestration).

import { join, resolve } from "node:path";
import { getStanding } from "../../agent/standing";
import { listWorkItems } from "../../coordination/work-loop";
import { allRecipeNames, getRecipe } from "../../engine/commands/usecase";
import type { Engine } from "../../engine/engine";
import { evolutionBudgetState, parseEvolutionProtocol } from "../../engine/evolution-protocol";
import type { MarinaDB, MediaJobRow } from "../../persistence/database";
import type { EntityId, RoomId } from "../../types";
import { ORCHESTRATION_PATTERNS } from "../../world/templates/orchestration";
import { buildCanvasPrincipal, resolveCanvasHttpPrincipal } from "../canvas-principal";
import { authorizeCanvasSubscription } from "../canvas-ws";
import type { memoryObserver } from "../memory-visibility";
import {
  authorizeEntityRead,
  authorizePrivileged,
  clampLimit,
  type DashboardRouteContext,
  json,
  numberOrNull,
  PROJECT_ROOT,
  ROOMS_DIR,
  safeParse,
} from "./shared";

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

function getEntityDetail(
  engine: Engine,
  db: MarinaDB | undefined,
  name: string,
  memory: ReturnType<typeof memoryObserver>,
): Response {
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
    result.notes = db.getNotesByEntity(entity.name, 10).filter(memory.read);
    result.recentActivity = db.getEventsByEntity(entity.id, 20);
    // Civic standing — surfaced in the entity view now that Entities is the
    // primary observe/control surface.
    result.standing = Math.round(getStanding(db, entity.id) * 10) / 10;
  }

  return json(result);
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

/** Parameterized detail routes — checked before the list routes below. */
export async function handleCoordinationRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { db, engine, method, peerIp, req, url } = ctx;
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

    // A per-entity workspace is a private `scope:"entity"` canvas. This route
    // must apply the SAME owner/operator predicate the canvas WS + HTTP
    // surfaces use (`authorizeCanvasSubscription` via `buildCanvasPrincipal`) —
    // otherwise it both leaks another entity's private canvas metadata and
    // lazily MATERIALIZES their workspace on a non-owner's behalf. Loopback
    // desktop reader → operator-equivalent (zero-config preserved).
    const canvasPrincipal = buildCanvasPrincipal(
      resolveCanvasHttpPrincipal(req, engine, peerIp),
      engine,
      db,
    );
    const existing = db.getEntityCanvas(entity.id);
    if (existing) {
      // 404 (not 403) so a private canvas id isn't confirmable to a non-owner.
      if (!authorizeCanvasSubscription(db, existing.id, canvasPrincipal)) {
        return json({ error: "Entity not found" }, 404);
      }
    } else {
      // Not yet created. Only the owner (caller === this entity) or an operator
      // may trigger lazy creation; a non-owner read returns 404 WITHOUT
      // materializing another entity's canvas. Mirrors the owner/operator branch
      // of `authorizeCanvasSubscription` for scope:"entity" (scope_id = entity.id).
      const ownerOrOperator =
        canvasPrincipal.isOperator === true ||
        (!!canvasPrincipal.entityId && canvasPrincipal.entityId === entity.id);
      if (!ownerOrOperator) return json({ error: "Entity not found" }, 404);
    }
    const canvas = existing ?? db.ensureEntityCanvas(entity.id, entity.name, entity.name);
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

  return undefined;
}

/** Per-entity brief, work items and the entity detail / delete catch-all. */
export async function handleEntityRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { callerId, db, engine, memory, method, url } = ctx;
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
    const pools = db.listMemoryPools().filter(memory.pool);
    const memoryCount = db.listCoreMemory(entityName).length;
    // goal/focus are private core memory. Expose them only to the entity itself
    // or an operator; other authenticated callers still get the (non-sensitive)
    // counts but see goal/focus as null.
    const canReadPrivate = authorizeEntityRead(engine, db, callerId, entityName) === null;
    const goalEntry = canReadPrivate ? db.getCoreMemory(entityName, "goal") : undefined;
    const focusEntry = canReadPrivate ? db.getCoreMemory(entityName, "focus") : undefined;

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
    // Entity detail bundles the entity's private core memory + notes, so it is
    // scoped like the dedicated memory routes below.
    const denied = authorizeEntityRead(engine, db, callerId, entityName);
    if (denied) return denied;
    return getEntityDetail(engine, db, entityName, memory);
  }

  return undefined;
}

/** Coordination list routes (boards, tasks, channels, groups, projects…). */
export async function handleCoordinationListRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { db, url } = ctx;
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

  return undefined;
}

/** Read-only catalog tail plus the project orchestration write. */
export async function handleWorldCatalogRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { db, engine, method, req, url } = ctx;
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
  if (url.pathname === "/api/evolution-sessions" && method === "GET" && db) {
    if (!/^(1|true|on)$/i.test(process.env.MARINA_EVOLUTION_PROTOCOLS ?? "")) {
      return json([]);
    }
    return json(
      db.listEvolutionSessions().map((session) => {
        const experiment = db.getExperiment(session.experiment_id);
        const runs = db.listEvolutionRuns(session.id);
        return {
          ...session,
          experiment_name: experiment?.name ?? null,
          protocol: parseEvolutionProtocol(session.protocol),
          budget: evolutionBudgetState(session, runs.length),
          activity: db.getEvolutionActivity(
            session.experiment_id,
            session.started_at ?? session.created_at,
            session.completed_at ?? Date.now(),
          ),
          runs,
        };
      }),
    );
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

  return undefined;
}
