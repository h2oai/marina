// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The authenticated instance surface: logout, world/entities/events/system
// snapshots, the trace + log reads, the evidence chain, principals, world
// collective variants, federation peers and the security posture report. This
// is the first route group after the session gate, so its internal order is
// the dispatcher's order.

import type { Engine } from "../../engine/engine";
import { getErrorMessage } from "../../engine/errors";
import type { MarinaDB } from "../../persistence/database";
import type { WorldVariantRow } from "../../persistence/db-world-variants";
import { isKeyEncryptionEnabled } from "../../persistence/key-crypto";
import { collectiveManager } from "../../world/world-collective-manager";
import {
  federationSigningAvailable,
  signFederationDocument,
  verifyFederationDocument,
} from "../federation-crypto";
import type { memoryObserver } from "../memory-visibility";
import { authorizePrivileged, type DashboardRouteContext, json, readJsonBody } from "./shared";
import { getLogs, getTraces } from "./traces";

function serializeWorldVariant(variant: WorldVariantRow) {
  return {
    id: variant.id,
    name: variant.name,
    world_template: variant.world_template,
    hypothesis: variant.hypothesis,
    status: variant.status,
    parent_variant_id: variant.parent_variant_id,
    ws_port: variant.ws_port,
    pid: variant.pid,
    created_by: variant.created_by,
    created_at: variant.created_at,
    updated_at: variant.updated_at,
    promoted_at: variant.promoted_at,
    promotion_rationale: variant.promotion_rationale,
    promotion_evidence: variant.promotion_evidence,
    promoted_by: variant.promoted_by,
    last_error: variant.last_error,
  };
}

/** Compare two base64 keys by decoded bytes (padding/encoding-variance safe). */
function sameBase64Key(a: string, b: string): boolean {
  try {
    return Buffer.from(a.trim(), "base64").equals(Buffer.from(b.trim(), "base64"));
  } catch {
    return false;
  }
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

function getEvents(
  engine: Engine,
  url: URL,
  visible: ReturnType<typeof memoryObserver>["event"],
): Response {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  const events = engine
    .getEventLog()
    .filter((e) => e.type !== "tick" && visible(e))
    .slice(-limit);
  return json(events);
}

/** First authenticated route group — see the module header for the surface. */
export async function handleSystemRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { callerId, db, engine, memory, method, req, url } = ctx;
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
    return getEvents(engine, url, memory.event);
  }
  if (url.pathname === "/api/traces" && method === "GET") {
    return getTraces(engine, url, db);
  }
  if (url.pathname === "/api/evidence/receipts" && method === "GET" && db) {
    const requested = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requested) ? requested : 100;
    return json({
      receipts: db.listEvidenceReceipts(limit),
      verification: db.verifyEvidenceChain(),
      trustBoundary:
        "Local hash chain; export or independently anchor the head hash for external tamper evidence.",
    });
  }
  if (url.pathname === "/api/evidence/checkpoint" && method === "GET" && db) {
    const verification = db.verifyEvidenceChain();
    const checkpoint = {
      schema: federationSigningAvailable()
        ? "marina.evidence.checkpoint.v2"
        : "marina.evidence.checkpoint.v1",
      worldId: db.getOrCreateWorldId(),
      instance: engine.instanceName,
      generatedAt: Date.now(),
      algorithm: "sha256",
      entries: verification.entries,
      headHash: verification.headHash,
      valid: verification.valid,
      trustBoundary: federationSigningAvailable()
        ? "Ed25519 signature authenticates this checkpoint to its world key; an independent anchor supplies external time and persistence."
        : "Unsigned local checkpoint; external storage or anchoring supplies the witness.",
    };
    const exported = federationSigningAvailable() ? signFederationDocument(checkpoint) : checkpoint;
    return Response.json(exported, {
      headers:
        url.searchParams.get("download") === "1"
          ? { "Content-Disposition": 'attachment; filename="marina-evidence-checkpoint.json"' }
          : undefined,
    });
  }
  if (url.pathname === "/api/logs" && method === "GET") {
    return getLogs(engine, url, db);
  }
  if (url.pathname === "/api/system") {
    return getSystem(engine, db);
  }
  if (url.pathname === "/api/principals" && method === "GET" && db) {
    return json(db.listPrincipals());
  }
  const principalStatusMatch = url.pathname.match(/^\/api\/principals\/([^/]+)\/status$/);
  if (principalStatusMatch && method === "POST" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const body = await readJsonBody<{ status?: "active" | "suspended" | "disabled" }>(req);
    if ("error" in body) return body.error;
    if (!body.status || !["active", "suspended", "disabled"].includes(body.status)) {
      return json({ error: "status must be active, suspended, or disabled" }, 400);
    }
    const changed = db.setPrincipalStatus(
      decodeURIComponent(principalStatusMatch[1]!),
      body.status,
    );
    return changed ? json({ ok: true, status: body.status }) : json({ error: "Not found" }, 404);
  }
  if (url.pathname === "/api/collective/variants" && method === "GET" && db) {
    const manager = collectiveManager(db);
    return json({
      sourceAvailable: manager.sourceAvailable(),
      variants: manager.list().map(serializeWorldVariant),
    });
  }
  if (url.pathname === "/api/federation/peers" && method === "GET" && db) {
    return json(db.listFederationPeers());
  }
  if (url.pathname === "/api/federation/peers" && method === "POST" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const body = await readJsonBody<{
      schema?: string;
      worldId?: string;
      name?: string;
      baseUrl?: string;
      publicKey?: string | null;
      signature?: { algorithm?: string; publicKey?: string; keyId?: string; value?: string };
      capabilities?: unknown;
    }>(req);
    if ("error" in body) return body.error;
    if (
      !["marina.federation.manifest.v1", "marina.federation.manifest.v2"].includes(
        body.schema ?? "",
      ) ||
      !body.worldId ||
      body.worldId.length > 100 ||
      !body.name ||
      body.name.length > 100 ||
      !body.baseUrl
    ) {
      return json({ error: "A valid Marina federation manifest is required" }, 400);
    }
    // Key continuity: once a peer has a pinned public key, a manifest signed
    // with (or declaring) a different key is refused — key rotation requires
    // the operator to clear the pin, not a silent re-registration.
    const existingPeer = db.getFederationPeer(body.worldId);
    if (body.schema === "marina.federation.manifest.v2") {
      const verification = verifyFederationDocument(body as Record<string, unknown>, {
        pinnedPublicKey: existingPeer?.public_key,
      });
      if (!verification.valid) {
        return json({ error: verification.error ?? "Manifest signature is invalid" }, 409);
      }
    }
    const incomingKey = body.publicKey ?? body.signature?.publicKey;
    if (
      existingPeer?.public_key &&
      incomingKey &&
      !sameBase64Key(incomingKey, existingPeer.public_key)
    ) {
      return json(
        { error: "Manifest public key differs from the pinned peer key; operator must re-pin" },
        409,
      );
    }
    if (
      JSON.stringify(body).length > 32_768 ||
      (body.publicKey?.length ?? 0) > 8_192 ||
      (body.capabilities !== undefined &&
        (!Array.isArray(body.capabilities) ||
          body.capabilities.length > 100 ||
          body.capabilities.some(
            (capability) => typeof capability !== "string" || capability.length > 200,
          )))
    ) {
      return json({ error: "Federation manifest exceeds the accepted bounds" }, 400);
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(body.baseUrl);
    } catch {
      return json({ error: "baseUrl must be an absolute HTTP(S) URL" }, 400);
    }
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
      return json({ error: "baseUrl must be an HTTP(S) URL without embedded credentials" }, 400);
    }
    return json(
      db.upsertFederationPeer({
        worldId: body.worldId,
        name: body.name,
        baseUrl: baseUrl.origin,
        publicKey: body.publicKey ?? body.signature?.publicKey,
        manifest: body,
      }),
      201,
    );
  }
  const federationTrustMatch = url.pathname.match(/^\/api\/federation\/peers\/([^/]+)\/trust$/);
  if (federationTrustMatch && method === "POST" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const body = await readJsonBody<{ trust?: "unverified" | "trusted" | "blocked" }>(req);
    if ("error" in body) return body.error;
    if (!body.trust || !["unverified", "trusted", "blocked"].includes(body.trust)) {
      return json({ error: "trust must be unverified, trusted, or blocked" }, 400);
    }
    const peer = db.setFederationTrust(decodeURIComponent(federationTrustMatch[1]!), body.trust);
    return peer ? json(peer) : json({ error: "Peer not found" }, 404);
  }
  if (url.pathname === "/api/collective/variants" && method === "POST" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const body = await readJsonBody<{
      name?: string;
      worldTemplate?: string;
      hypothesis?: string;
      parentVariantId?: string;
    }>(req);
    if ("error" in body) return body.error;
    if (!body.name || !body.worldTemplate) {
      return json({ error: "name and worldTemplate are required" }, 400);
    }
    try {
      return json(
        serializeWorldVariant(
          collectiveManager(db).create({
            name: body.name,
            worldTemplate: body.worldTemplate,
            hypothesis: body.hypothesis,
            parentVariantId: body.parentVariantId,
            createdBy: engine.entities.get(callerId)?.name ?? String(callerId),
          }),
        ),
        201,
      );
    } catch (cause) {
      return json({ error: getErrorMessage(cause) }, 400);
    }
  }
  const collectiveActionMatch = url.pathname.match(
    /^\/api\/collective\/variants\/([^/]+)\/(start|stop|promote)$/,
  );
  if (collectiveActionMatch && method === "POST" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const id = decodeURIComponent(collectiveActionMatch[1]!);
    const action = collectiveActionMatch[2]!;
    try {
      const manager = collectiveManager(db);
      let variant: WorldVariantRow;
      if (action === "start") variant = await manager.start(id);
      else if (action === "stop") variant = await manager.stop(id);
      else {
        const body = await readJsonBody<{ rationale?: string; evidenceRefs?: string[] }>(req);
        if ("error" in body) return body.error;
        variant = manager.promote(id, {
          rationale: body.rationale ?? "",
          evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [],
          promotedBy: engine.entities.get(callerId)?.name ?? String(callerId),
        });
      }
      return json(serializeWorldVariant(variant));
    } catch (cause) {
      return json({ error: getErrorMessage(cause) }, 400);
    }
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

  return undefined;
}
