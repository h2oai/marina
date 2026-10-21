// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../../engine/engine";
import type { MarinaDB } from "../../persistence/database";
import type { SupervisionCredential } from "../../persistence/db-principals";
import { RoutingError } from "../../routing/errors";
import {
  ResidentService,
  type ResidentWorld,
  supervisedResidentsEnabled,
} from "../../routing/residents";
import { RoutingService, routingLimit } from "../../routing/service";
import type { EntityId, RoomId } from "../../types";
import { isSentinelPrincipal } from "../auth-middleware";
import { corsHeaders } from "../cors";
import { authorizePrivileged, type DashboardRouteContext, json } from "./shared";

const SUPERVISION_PREFIX = "marina-routing-";
const SUPERVISION_REFUSED =
  /^\/api\/routing\/sessions\/[^/]+\/(?:control|messages|channels\/[^/]+\/messages)$/;

/**
 * A supervision credential (`marina-routing-…`, supervised residents on) as the
 * caller: the person it was issued to, on the routing API only. Returns
 * undefined for any other bearer (and for every bearer while the switch is
 * off, so the normal session check answers exactly as before).
 */
export function authenticateSupervision(
  req: Request,
  url: URL,
  engine: Engine,
  db: MarinaDB | undefined,
): { entityId: EntityId; credential: SupervisionCredential } | { error: Response } | undefined {
  const bearer = req.headers.get("Authorization");
  if (!bearer?.startsWith(`Bearer ${SUPERVISION_PREFIX}`) || !supervisedResidentsEnabled())
    return undefined;
  const refuse = (error: string) => ({
    error: Response.json(
      { error, code: "unauthorized" },
      { status: 401, headers: corsHeaders(req.headers.get("Origin")) },
    ),
  });
  if (!url.pathname.startsWith("/api/routing/"))
    return refuse("A supervision credential is valid only for the routing API");
  const credential = db?.verifySupervisionCredential(bearer.slice(7));
  if (!credential) return refuse("Invalid or expired supervision credential");
  const name = credential.principal.display_name;
  if (db!.isBanned(name) || db!.getUserByName(name)?.id !== credential.principal.principal_id)
    return refuse("The supervision credential's account is not available");
  // The person's live entity when connected; otherwise the durable account id
  // itself (an offline person's entity is evicted), which every routing, gate
  // and ownership lookup resolves to the same account.
  const live = engine.entities.findAgentByName(name);
  const entityId = (
    live && live.name === name ? live.id : credential.principal.principal_id
  ) as EntityId;
  return { entityId, credential };
}

/**
 * Supervision credential lifecycle: issue (from a person's world session),
 * renew and revoke (with the credential itself). Routing-only, 24 h at most.
 */
function supervisionRoutes(ctx: DashboardRouteContext, action: string): Response {
  const { db, callerId, req, supervision } = ctx;
  const reply = (value: unknown, status = 200) =>
    json(value, status, req.headers.get("Origin") ?? undefined);
  const account = db!.getUser(db!.durableEntityKey(callerId));
  if (!account) throw new RoutingError(403, "account_required", "Log in with a Marina account");
  if (!action) {
    if (supervision)
      throw new RoutingError(403, "session_required", "Issue supervision from a world session");
    // People supervise. An agent account (config or principal) is refused.
    if (db!.getAgentConfig(account.name) || db!.getPrincipal("agent", account.name))
      throw new RoutingError(403, "person_required", "Only a person may supervise agents");
    const principal = db!.getPrincipal("human", account.name);
    if (!principal || principal.principal_id !== account.id)
      throw new RoutingError(403, "person_required", "Only a person may supervise agents");
    return reply(publicCredential(db!.issueSupervisionCredential(principal.principal_id)));
  }
  if (!supervision)
    throw new RoutingError(403, "supervision_required", "Present the supervision credential");
  if (action === "renew") {
    const issued = db!.transaction(() => {
      if (!db!.revokeSupervisionCredential(supervision.credentialId))
        throw new RoutingError(401, "unauthorized", "Invalid or expired supervision credential");
      return db!.issueSupervisionCredential(supervision.principal.principal_id);
    });
    return reply(publicCredential(issued));
  }
  return reply({ revoked: db!.revokeSupervisionCredential(supervision.credentialId) });
}

function publicCredential(issued: { credentialId: string; token: string; expiresAt: number }) {
  return { credentialId: issued.credentialId, token: issued.token, expiresAt: issued.expiresAt };
}

/** Bound streamed bodies too: Content-Length alone is not an admission check. */
async function body(req: Request): Promise<Record<string, unknown>> {
  if (
    !req.headers
      .get("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .match(/^application\/json$/i)
  ) {
    throw new RoutingError(415, "content_type", "Use application/json");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new RoutingError(400, "invalid_input", "JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262_144) {
        await reader.cancel();
        throw new RoutingError(413, "payload_too_large", "Request exceeds 256 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RoutingError(400, "invalid_input", "Malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new RoutingError(400, "invalid_input", "JSON object required");
  return parsed as Record<string, unknown>;
}

/**
 * A route note to a supervised resident's run is a world `tell` from the
 * caller (src/routing/attention-bridge.ts wakes the resident with it), so it is
 * durable, owed and visible like any other tell. The caller must be in the
 * world to speak as themselves; otherwise the note is refused with that hint.
 * Anything else (supervised residents off, other kinds, other targets) is
 * left to the routing service unchanged.
 */
async function residentNoteAsTell(
  ctx: DashboardRouteContext,
  router: RoutingService,
  sessionId: string,
  input: Record<string, unknown>,
): Promise<Response | undefined> {
  const { db, callerId, req } = ctx;
  if (!db || !supervisedResidentsEnabled() || input.kind !== "note") return undefined;
  const targetId = input.targetId;
  if (typeof targetId !== "string") return undefined;
  const resident = db
    .getAllAgentConfigs()
    .find((config) => config.runtime === "supervised" && config.run_session === targetId);
  if (!resident) return undefined;
  const reply = (value: unknown, status = 200) =>
    json(value, status, req.headers.get("Origin") ?? undefined);
  const source = router.get(sessionId);
  if (source.ownerId !== db.durableEntityKey(callerId) || source.state !== "active")
    throw new RoutingError(404, "not_found", "Participant session not found");
  const payload = input.payload as { text?: unknown } | undefined;
  const text = typeof payload?.text === "string" ? payload.text.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > 16000)
    throw new RoutingError(
      400,
      "invalid_input",
      "A note to a resident is text of 1–16000 characters",
    );
  const engine = ctx.engine;
  if (!engine.getConnectionForEntity(callerId as EntityId))
    return reply(
      {
        error: `${resident.name} is a world resident: connect to Marina and \`tell ${resident.name} …\``,
        code: "connect_required",
      },
      409,
    );
  const admitted = await engine.dispatchCommand(
    callerId as EntityId,
    `tell ${resident.name} ${text}`,
  );
  if (!admitted)
    return reply(
      { error: "World command capacity reached; the tell was not sent", code: "busy" },
      503,
    );
  return reply({ deliveredAs: "tell", target: resident.name });
}

export async function handleRoutingRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { req, url, method, db, callerId } = ctx;
  if (!url.pathname.startsWith("/api/routing/")) return undefined;
  const origin = req.headers.get("Origin") ?? undefined;
  const reply = (value: unknown, status = 200) => json(value, status, origin);
  if (!db) return reply({ error: "Routing requires persistent storage" }, 503);
  // Output is private by default, including on dev-open installations. A desktop
  // operator can log in as a world account; never invent an owner for a sentinel.
  if (isSentinelPrincipal(callerId))
    return reply({ error: "Log in to use participant streams", code: "account_required" }, 403);
  try {
    const supervisionMatch = supervisedResidentsEnabled()
      ? url.pathname.match(/^\/api\/routing\/supervision(?:\/(renew|revoke))?$/)
      : null;
    if (supervisionMatch && method === "POST") {
      await body(req);
      return supervisionRoutes(ctx, supervisionMatch[1] ?? "");
    }
    // A supervision credential runs the supervisor's own routing traffic. It
    // never speaks for the person: no controls, sends or channel posts (those
    // come from the person's own session).
    if (ctx.supervision && method === "POST" && SUPERVISION_REFUSED.test(url.pathname))
      return reply(
        {
          error: "A supervision credential cannot send controls or messages",
          code: "supervision_scope",
        },
        403,
      );
    const router = new RoutingService(db, db.durableEntityKey(callerId));
    if (url.pathname === "/api/routing/overview" && method === "GET")
      return reply(
        router.overview(
          url.searchParams.get("after") ?? "",
          routingLimit(url.searchParams.get("limit")),
          url.searchParams.get("attention") === "true",
        ),
      );
    if (url.pathname === "/api/routing/sync" && method === "POST")
      return reply(router.sync(await body(req)));
    const channelMatch = url.pathname.match(
      /^\/api\/routing\/sessions\/([^/]+)\/channels(?:\/([^/]+)\/messages)?$/,
    );
    if (channelMatch) {
      const sessionId = channelMatch[1]!;
      const channelId = channelMatch[2] ? decodeURIComponent(channelMatch[2]) : undefined;
      if (!channelId && method === "GET")
        return reply({
          channels: router
            .channels(sessionId)
            .map((channel) => ({ id: channel.id, name: channel.name })),
        });
      if (channelId && method === "GET")
        return reply(
          router.channelEvents(
            sessionId,
            channelId,
            Number(url.searchParams.get("after") ?? 0),
            routingLimit(url.searchParams.get("limit")),
          ),
        );
      if (channelId && method === "POST") {
        const manager = ctx.engine.channelManager;
        if (!manager) return reply({ error: "World channels unavailable" }, 503);
        const result = router.publishChannel(sessionId, channelId, await body(req));
        if (!result.duplicate) {
          // The conversation lives in the native channel store. Existing humans,
          // agents, channel listeners, feed, Canvas and dashboard see this send.
          manager.deliverStored(result.message, {
            participantId: sessionId,
            messageId: result.message.id,
          });
          ctx.engine.logEvent({
            type: "channel_message",
            entity: callerId,
            messageId: result.message.id,
            channelName: db.getChannel(channelId)!.name,
            content: result.message.content,
            timestamp: result.message.createdAt,
          });
        }
        return reply(result);
      }
    }
    // The Streams room view: the caller's room log (`look log`), readable only
    // by someone present in that room.
    if (url.pathname === "/api/routing/room-log" && method === "GET") {
      const self = ctx.engine.entities.get(callerId as EntityId);
      const room = url.searchParams.get("room") ?? self?.room;
      if (!self || !room || self.room !== room)
        return reply(
          {
            error: "Only those present read a room's log; join the world first",
            code: "not_present",
          },
          403,
        );
      const since = Number(url.searchParams.get("since") ?? 0);
      return reply({
        room,
        entries: db.readRoomLog(
          room,
          Number.isFinite(since) && since > 0 ? since : 0,
          routingLimit(url.searchParams.get("limit")),
        ),
      });
    }
    // Supervised residents (MARINA_SUPERVISED_RESIDENTS=on). Off, these paths
    // fall through to the unknown-endpoint reply exactly as before.
    const residentMatch = supervisedResidentsEnabled()
      ? url.pathname.match(/^\/api\/routing\/residents(?:\/([^/]+)\/(renew|revoke|attention))?$/)
      : null;
    // The Streams residents view: the caller's own residents, their presence
    // and recent wake decisions (refs and reasons, no content).
    if (residentMatch && !residentMatch[1] && method === "GET") {
      const owner = ctx.engine.entities.get(callerId as EntityId)?.name;
      if (!owner)
        return reply({ error: "Join the world to see your residents", code: "not_present" }, 403);
      const residents = db
        .getAgentConfigsBySpawnedBy(owner)
        .filter((config) => config.runtime === "supervised")
        .map((config) => {
          const live = ctx.engine.entities.findAgentByName(config.name);
          return {
            name: config.name,
            vendor: config.vendor ?? "",
            presence: ctx.engine.presence.statusOf(config.name)?.status ?? "offline",
            ...(live && live.name === config.name ? { room: live.room } : {}),
            wakes: db.listAttentionWakes(config.name, 20).map((wake) => ({
              source: wake.source,
              decision: wake.decision,
              reason: wake.reason,
              hop: wake.hop,
              steered: wake.steered === 1,
              at: wake.at,
            })),
          };
        });
      return reply({ residents });
    }
    if (residentMatch && method === "POST") {
      const input = await body(req);
      const engine = ctx.engine;
      const world: ResidentWorld = {
        findLive: (name) => {
          const entity = engine.entities.findAgentByName(name);
          return entity && entity.name === name ? { id: entity.id } : undefined;
        },
        isConnected: (id) => engine.getConnectionForEntity(id as EntityId) !== undefined,
        hasRoom: (room) => !!engine.rooms.get(room as RoomId),
        roomOf: (id) => engine.entities.get(id as EntityId)?.room,
        revokeSessions: (id) => engine.sessionManager?.revokeByEntity(id as EntityId),
        logEvent: (event) => engine.logEvent(event),
      };
      const [, rawName, action] = residentMatch;
      if (!rawName) {
        // Enrolment creates an agent account: the caller's own agent.spawn gate.
        const denied = authorizePrivileged(engine, db, callerId, "agent.spawn");
        if (denied) return denied;
      }
      const residents = new ResidentService(db, db.durableEntityKey(callerId), callerId, world);
      if (!rawName) return reply(residents.enrol(input));
      const name = decodeURIComponent(rawName);
      if (action === "renew") return reply(residents.renew(name, input));
      if (action === "attention") return reply(residents.attention(name, input));
      return reply(residents.revoke(name, input));
    }
    if (url.pathname === "/api/routing/sessions") {
      if (method === "POST") return reply(router.join(await body(req)));
      if (method === "GET")
        return reply(
          router.list(
            url.searchParams.get("after") ?? "",
            routingLimit(url.searchParams.get("limit")),
          ),
        );
    }
    const match = url.pathname.match(
      /^\/api\/routing\/sessions\/([^/]+)(?:\/(events|heartbeat|leave|inbox|messages|deliveries|runtime|control)(?:\/([^/]+)(?:\/(ack))?)?)?$/,
    );
    if (match) {
      const [, id, action, messageId, ack] = match;
      if (id) {
        if (method === "GET" && !action) return reply(router.get(id));
        if (!messageId) {
          if (action === "runtime" && method === "GET") return reply({ state: router.runtime(id) });
          if (action === "control" && method === "POST") {
            const input = await body(req);
            const denied = authorizePrivileged(ctx.engine, db, callerId, "code.exec");
            if (denied) return denied;
            if ((input.control as { action?: string } | undefined)?.action === "launch") {
              const spawnDenied = authorizePrivileged(ctx.engine, db, callerId, "agent.spawn");
              if (spawnDenied) return spawnDenied;
            }
            return reply(router.control(id, input));
          }
          if (action === "events" && method === "GET")
            return reply(
              router.events(
                id,
                Number(url.searchParams.get("after") ?? 0),
                routingLimit(url.searchParams.get("limit")),
              ),
            );
          if (action === "deliveries" && method === "GET")
            return reply({
              messages: router.deliveries(id, routingLimit(url.searchParams.get("limit"))),
            });
          if (action === "inbox" && method === "GET")
            return reply({
              messages: router.inbox(id, routingLimit(url.searchParams.get("limit"))),
            });
          if (method === "POST") {
            if (action === "events")
              return reply({ events: router.publish(id, (await body(req)).events) });
            if (action === "messages") {
              const input = await body(req);
              const asTell = await residentNoteAsTell(ctx, router, id, input);
              return asTell ?? reply(router.send(id, input));
            }
            if (action === "heartbeat") return reply(router.heartbeat(id));
            if (action === "leave") return reply(router.leave(id));
          }
        }
        if (action === "messages" && messageId) {
          if (method === "GET" && !ack) return reply(router.receipt(id, messageId));
          if (method === "POST" && ack) return reply(router.acknowledge(id, messageId));
        }
      }
    }
    return reply({ error: "Unknown routing endpoint or method" }, 404);
  } catch (error) {
    if (error instanceof URIError)
      return reply({ error: "Invalid URL encoding", code: "invalid_input" }, 400);
    if (error instanceof RoutingError)
      return reply({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}
