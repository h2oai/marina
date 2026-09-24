// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Agent roster and lifecycle over HTTP (`/api/agents*`). Every mutation is
// behind the `agent.spawn` gate via `authorizePrivileged`, and spawn/stop emit
// the same lifecycle events the in-world commands do so dashboards refresh
// live and crew membership stays consistent.

import type { Engine } from "../../engine/engine";
import type { EntityId } from "../../types";
import { authorizePrivileged, type DashboardRouteContext, json } from "./shared";

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

/** Agent roster, spawn, per-agent status, stop, attention and reconfigure. */
export async function handleAgentRoutes(ctx: DashboardRouteContext): Promise<Response | undefined> {
  const { callerId, db, engine, method, req, url } = ctx;
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

  return undefined;
}
