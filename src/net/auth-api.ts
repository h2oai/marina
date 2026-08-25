// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bridge between the optional better-auth identity layer and Marina's named
 * entities. Three concerns:
 *   - GET  /api/auth-status   → tells the client whether sign-in is required
 *                               (works even when auth is OFF → required:false).
 *   - POST /api/auth-session  → exchange a verified identity for a Marina
 *                               session token bound to a NAMED entity (handle).
 *   - /api/auth/*             → delegated to better-auth's own handler.
 *
 * The named entity is the in-world identity; better-auth only gates who may
 * claim/resume a handle. Agents never touch this path — they use session tokens.
 */

import { getStanding } from "../agent/standing";
import type { MarinaAuthProvider } from "../auth/better-auth-provider";
import type { Engine } from "../engine/engine";
import { sanitizeEntityName } from "../engine/entity-name";
import type { MarinaDB } from "../persistence/database";
import type { Connection, EntityId, Perception } from "../types";
import { corsHeaders } from "./cors";

let authConnCounter = 0;

/**
 * Standing above this (in a rank-0 row) counts as "elevated" for the handle-
 * claim guard — small so any meaningful accrued reputation trips it, while a
 * fresh entity (standing 0) still claims normally. Rank > 0 is the primary,
 * restart-durable signal; standing is a secondary check for the online case.
 */
const ELEVATED_STANDING_THRESHOLD = 1;

/** True when the verified identity is an explicitly-authorized operator by
 *  email (MARINA_AUTH_ADMIN_EMAILS) — the only identity allowed to adopt a
 *  pre-existing elevated handle. Mirrors the engine's admin-by-email gate. */
function isAuthorizedOperator(identity: { email: string; emailVerified: boolean }): boolean {
  if (!identity.emailVerified) return false;
  const adminEmails = new Set(
    (process.env.MARINA_AUTH_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return adminEmails.has(identity.email.toLowerCase());
}

/** True when a pre-existing handle's entity carries elevated rank or standing —
 *  i.e. adopting it would inherit privilege. */
function isElevatedHandle(
  engine: Engine,
  db: MarinaDB,
  user: { name: string; rank: number },
): boolean {
  if (user.rank > 0) return true;
  // Standing is keyed by the (transient) entity id, so it's only checkable when
  // the entity is currently resident. rank is the durable primary signal.
  const entity = engine.entities.findAgentByName(user.name);
  if (entity && getStanding(db, entity.id) > ELEVATED_STANDING_THRESHOLD) return true;
  return false;
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

// Handles become entity names — share the login path's canonical sanitizer.
const sanitizeHandle = sanitizeEntityName;

/**
 * Route an /api/auth* request. Returns a Response, or undefined to let the
 * normal dispatch ladder continue (so unrelated paths fall through).
 */
export async function handleAuthApi(
  req: Request,
  url: URL,
  method: string,
  engine: Engine,
  db: MarinaDB | undefined,
  provider: MarinaAuthProvider | undefined,
): Promise<Response | undefined> {
  const origin = req.headers.get("Origin");

  // Status is always available — when auth is off the client sees required:false
  // and behaves exactly as today (name login).
  if (url.pathname === "/api/auth-status" && method === "GET") {
    return json(
      {
        required: !!provider,
        methods: provider?.methods ?? [],
        socialProviders: provider?.socialProviders ?? [],
      },
      200,
      origin,
    );
  }

  // The remaining routes require an active provider.
  if (!provider) return undefined;

  // Delegate better-auth's own endpoints (sign-up/in/out, social callbacks, …).
  if (url.pathname.startsWith("/api/auth/")) {
    return provider.handler(req);
  }

  // Exchange a verified identity for a Marina session token bound to a handle.
  if (url.pathname === "/api/auth-session" && method === "POST") {
    return exchangeForMarinaSession(req, engine, db, provider, origin);
  }

  return undefined;
}

async function exchangeForMarinaSession(
  req: Request,
  engine: Engine,
  db: MarinaDB | undefined,
  provider: MarinaAuthProvider,
  origin: string | null,
): Promise<Response> {
  const identity = await provider.getIdentity(req.headers);
  if (!identity) {
    return json({ error: "Not authenticated. Sign in first." }, 401, origin);
  }

  // Resolve the in-world handle for this identity.
  let name: string | undefined;
  const bound = db?.getUserByAuthSubject(identity.subject);
  if (bound) {
    // Established binding — the handle is fixed to this identity.
    name = bound.name;
  } else {
    // First login for this identity: claim a handle.
    let requested: string | undefined;
    try {
      const body = (await req.json()) as { handle?: string };
      requested = typeof body.handle === "string" ? body.handle : undefined;
    } catch {
      /* no/!json body — fall back to email local-part below */
    }
    const candidate = sanitizeHandle(requested ?? identity.email.split("@")[0] ?? "");
    if (candidate.length < 2) {
      return json(
        { error: "needsHandle", message: "Choose a handle (2–20 letters/numbers)." },
        400,
        origin,
      );
    }
    // Reject claiming a handle already owned by a different verified identity.
    const taken = db?.getUserByName(candidate);
    if (taken?.auth_subject && taken.auth_subject !== identity.subject) {
      return json(
        { error: "handleTaken", message: "That handle is already claimed." },
        409,
        origin,
      );
    }
    // Refuse silently adopting a pre-existing ELEVATED entity (rank > 0 or
    // standing-bearing) via a name claim — a new verified user must not inherit
    // an existing privileged entity's rank/standing. Only an explicitly
    // authorized operator (MARINA_AUTH_ADMIN_EMAILS) may link such a handle.
    // A fresh/unprivileged handle (rank 0, no standing) claims normally.
    if (taken && db && isElevatedHandle(engine, db, taken) && !isAuthorizedOperator(identity)) {
      return json(
        {
          error: "handleElevated",
          message: "that handle maps to a privileged entity; operator linking required",
        },
        403,
        origin,
      );
    }
    name = candidate;
  }

  // Mint a Marina session via a transient connection (mirrors /api/command
  // ingress). engine.login with `identity` bypasses the passwordless guard,
  // binds the subject/email, and applies admin-by-email.
  const connId = `auth_${++authConnCounter}_${crypto.randomUUID().slice(0, 8)}`;
  const conn: Connection = {
    id: connId,
    protocol: "websocket",
    entity: null,
    connectedAt: Date.now(),
    send(_p: Perception) {},
    close() {
      engine.removeConnection(connId);
    },
  };
  engine.addConnection(conn);
  try {
    const result = engine.login(connId, name, undefined, {
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified,
    });
    if ("error" in result) {
      return json({ error: result.error }, 400, origin);
    }
    return json(
      { token: result.token, name: result.name, entityId: result.entityId as EntityId },
      200,
      origin,
    );
  } finally {
    engine.removeConnection(connId);
  }
}
