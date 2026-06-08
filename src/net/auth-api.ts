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

import type { MarinaAuthProvider } from "../auth/better-auth-provider";
import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import type { Connection, EntityId, Perception } from "../types";
import { corsHeaders } from "./cors";

let authConnCounter = 0;

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

const sanitizeHandle = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20);

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
