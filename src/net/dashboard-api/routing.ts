// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { RoutingError } from "../../routing/errors";
import { RoutingService, routingLimit } from "../../routing/service";
import { isSentinelPrincipal } from "../auth-middleware";
import { authorizePrivileged, type DashboardRouteContext, json } from "./shared";

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
    const router = new RoutingService(db, db.durableEntityKey(callerId));
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
            if (action === "messages") return reply(router.send(id, await body(req)));
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
