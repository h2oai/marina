// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Pre-auth ingress: the routes that run BEFORE the dashboard session gate —
// `/api/setup-status`, `/api/ui-config`, `/api/command`, `/api/ask` and the
// public `/api/federation/manifest` discovery document. Each is either
// self-gated (per-IP cap, origin + content-type CSRF fences) or deliberately
// public; nothing here may read authenticated state.

import type { Engine } from "../../engine/engine";
import type { MarinaDB } from "../../persistence/database";
import type { Connection, Perception } from "../../types";
import { federationSigningAvailable, signFederationDocument } from "../federation-crypto";
import { formatPerception } from "../formatter";
import {
  bearerToken,
  type CommandApiBody,
  type DashboardApiOptions,
  extractIp,
  json,
  readCommandBody,
} from "./shared";

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
  peerIp?: string,
): Promise<Response> {
  const origin = req.headers.get("Origin");
  if (!command.trim()) return json({ error: "Command is required" }, 400, origin);

  const ip = extractIp(req, peerIp);
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
    // The REAL socket peer (never a forwarded header), so a loopback caller is
    // recognized exactly as a loopback WebSocket login is — e.g. a parent
    // world driving its child over `world run` — and a remote one is not.
    ...(peerIp ? { peerIp } : {}),
    send(perception: Perception) {
      perceptions.push(perception);
    },
    close() {
      engine.removeConnection(connId);
    },
  };

  engine.addConnection(conn);
  // Track a token freshly minted by an *unauthenticated* login so we can revoke
  // it below. This ingress path is pre-auth: returning (or leaving live) a
  // working session token would let an anonymous caller reuse it against
  // authenticated routes — including cross-entity private-memory reads. A
  // reconnect (caller already holds a valid token) does not mint anything new.
  let freshToken: string | undefined;
  try {
    const session = token ? engine.reconnect(connId, token) : engine.login(connId, name);
    if ("error" in session) {
      return json({ error: session.error }, token ? 401 : 400, origin);
    }
    if (!token) freshToken = session.token;

    if (engine.rateLimiter && !engine.rateLimiter.consume(session.entityId)) {
      return json({ error: "Rate limited. Please slow down." }, 429, origin);
    }

    await engine.processCommand(session.entityId, command);

    // Deliberately omit the session token from the response. Named sessions can
    // still be continued by re-sending `name` (passwordless login re-binds the
    // same entity); the token is never handed to an unauthenticated caller.
    return json(
      {
        entityId: session.entityId,
        name: session.name,
        command,
        perceptions,
        text: formatCommandText(perceptions, body.render),
      },
      200,
      origin,
    );
  } finally {
    if (freshToken) engine.sessionManager?.revoke(freshToken);
    engine.removeConnection(connId);
  }
}

/**
 * Pre-auth route group, dispatched first by `handleDashboardApi` and in the
 * same order as before the split. Returns `undefined` when the path is not one
 * of these, so the caller falls through to the session gate.
 */
export async function handlePreAuthRoutes(
  req: Request,
  url: URL,
  method: string,
  engine: Engine,
  db: MarinaDB | undefined,
  peerIp: string | undefined,
  opts: DashboardApiOptions,
): Promise<Response | undefined> {
  // Pre-auth endpoints (no session required — used by dashboard before login)
  if (url.pathname === "/api/setup-status" && method === "GET") {
    const ip = extractIp(req, peerIp);
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
    const body = await readCommandBody(req, opts);
    if ("error" in body) return body.error;
    if (typeof body.command !== "string") {
      return json({ error: "Field 'command' must be a string" }, 400, req.headers.get("Origin"));
    }
    return handleCommandIngress(req, engine, body.command, body, peerIp);
  }

  // Convenience wrapper for product-shaped ask surfaces. Behavior still lives
  // in the world-native `ask` word, not in this HTTP route.
  if (url.pathname === "/api/ask" && method === "POST") {
    const body = await readCommandBody(req, opts);
    if ("error" in body) return body.error;
    if (typeof body.query !== "string") {
      return json({ error: "Field 'query' must be a string" }, 400, req.headers.get("Origin"));
    }
    return handleCommandIngress(req, engine, `ask ${body.query}`, body, peerIp);
  }

  // Public, non-secret world discovery document. Registration by another
  // Marina remains unverified until its operator explicitly changes trust.
  if (url.pathname === "/api/federation/manifest" && method === "GET" && db) {
    const evidence = db.verifyEvidenceChain();
    const signed = federationSigningAvailable();
    const manifest = {
      schema: signed ? "marina.federation.manifest.v2" : "marina.federation.manifest.v1",
      worldId: db.getOrCreateWorldId(),
      name: engine.instanceName,
      baseUrl: url.origin,
      capabilities: [
        "world-collective.local.v1",
        "traces.read.v1",
        "logs.read.v1",
        "evidence.checkpoint.v1",
        "inheritance.unverified.v1",
        "cognition.reproduction.v1",
        "marina.genome.v1",
        "mesh.transparent.v1",
        "mesh.event.replication.v1",
        "economic.provenance.v1",
        "simulation.manifest.v1",
        "civilization.mutation.v1",
        ...(signed ? ["federation.signed-envelope.v1"] : []),
      ],
      evidenceCheckpoint: {
        algorithm: "sha256",
        entries: evidence.entries,
        headHash: evidence.headHash,
        locallyValid: evidence.valid,
      },
      trustBoundary: signed
        ? "Ed25519 signature proves document integrity and key possession, not operator trust or claim truth."
        : "Unsigned discovery manifest. Registration does not authenticate this world or its claims.",
    };
    return json(signed ? signFederationDocument(manifest) : { ...manifest, publicKey: null });
  }

  return undefined;
}
