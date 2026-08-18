// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /mem — Agent Memory as a Service
 *
 * Exposes Marina's memory systems (notes, recall, core memory, pools, knowledge graph)
 * as a REST API for external agents. Any agent, any framework, any language.
 *
 * Auth modes:
 *   - MEM_API_KEYS not set → open access, agent name from X-Agent-Name header (dev mode)
 *   - MEM_API_KEYS set → Bearer token auth, key maps to agent namespace
 *   - DB-managed keys → created via POST /mem/keys (requires admin secret)
 */

import type { RateLimiter } from "../auth/rate-limiter";
import type { MarinaDB, ScoredNoteRow } from "../persistence/database";
import { corsHeaders } from "./cors";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(null) });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

const VALID_NOTE_TYPES = new Set([
  "observation",
  "fact",
  "decision",
  "inference",
  "skill",
  "episode",
  "principle",
]);

const VALID_RELATIONSHIPS = new Set([
  "supports",
  "contradicts",
  "caused_by",
  "related_to",
  "part_of",
  "supersedes",
]);

// ─── API Description (returned at GET /mem for agent discovery) ──────────────

const API_DESCRIPTION = {
  name: "Marina Memory API",
  version: 1,
  description:
    "Persistent memory for AI agents. Store notes, recall with intelligent scoring, " +
    "build knowledge graphs, manage mutable state, and share memory across agents.",
  auth: {
    open_mode:
      "When MARINA_OPEN_API=true and MEM_API_KEYS is not set, pass X-Agent-Name header to identify your namespace.",
    keyed_mode:
      "When MEM_API_KEYS is set, use Authorization: Bearer <key>. Key maps to agent namespace.",
    default:
      "By default, authentication is required. Set MEM_API_KEYS or MARINA_OPEN_API=true for development.",
  },
  endpoints: {
    notes: {
      "POST /mem/notes": {
        description: "Create a note",
        body: {
          content: "string (required)",
          importance: "number 1-10 (default 5)",
          type: "observation | fact | decision | inference | skill | episode | principle",
          links: "[{target: number, relationship: string}] (optional)",
        },
      },
      "GET /mem/notes": {
        description: "List your notes (newest first)",
        params: { limit: "number (default 50, max 200)" },
      },
      "GET /mem/notes/:id": { description: "Get a note and its knowledge graph links" },
      "DELETE /mem/notes/:id": { description: "Delete a note" },
    },
    recall: {
      "GET /mem/recall": {
        description:
          "Scored retrieval with 3-factor weighting (importance × recency × relevance) " +
          "and knowledge graph spreading activation. Auto-detects query intent.",
        params: {
          q: "string (required) — search query",
          wi: "number — importance weight override (0-1)",
          wr: "number — recency weight override (0-1)",
          wrel: "number — relevance weight override (0-1)",
        },
        intent_detection: {
          episodic: "when did, recently, yesterday → recency-heavy",
          procedural: "how to, steps, procedure → relevance-heavy",
          decision: "should I, trade-off, choice → importance-heavy",
          semantic: "what is, define, explain → balanced",
        },
      },
    },
    knowledge_graph: {
      "POST /mem/notes/:id/link": {
        description: "Link two notes",
        body: {
          target: "number (required) — target note ID",
          relationship: "supports | contradicts | caused_by | related_to | part_of | supersedes",
        },
      },
      "GET /mem/notes/:id/trace": {
        description: "BFS traversal of knowledge graph from a note",
        params: { depth: "number (default 2, max 5)" },
      },
    },
    core_memory: {
      "PUT /mem/core/:key": {
        description: "Set a mutable key-value pair (versioned with history)",
        body: { value: "string (required)" },
      },
      "GET /mem/core": { description: "List all core memory keys" },
      "GET /mem/core/:key": { description: "Get value, version, and timestamps" },
      "DELETE /mem/core/:key": { description: "Delete a key" },
      "GET /mem/core/:key/history": {
        description: "Version history (old → new values)",
        params: { limit: "number (default 10, max 100)" },
      },
    },
    pools: {
      "POST /mem/pools": {
        description: "Create a shared memory pool",
        body: { name: "string (required)" },
      },
      "GET /mem/pools": { description: "List all pools" },
      "GET /mem/pools/:name": { description: "Pool info with note count" },
      "POST /mem/pools/:name/notes": {
        description: "Add a note to a pool",
        body: {
          content: "string (required)",
          importance: "number 1-10 (default 5)",
          type: "observation | fact | decision | inference | skill | episode | principle",
        },
      },
      "GET /mem/pools/:name/notes": { description: "List pool notes" },
      "GET /mem/pools/:name/recall": {
        description: "Scored retrieval from a pool",
        params: { q: "string (required)" },
      },
    },
    meta: {
      "GET /mem": { description: "This API description (no auth required)" },
      "GET /mem/health": { description: "Health check (no auth required)" },
      "GET /mem/stats": { description: "Your memory namespace stats" },
    },
  },
  note_types: ["observation", "fact", "decision", "inference", "skill", "episode", "principle"],
  relationships: ["supports", "contradicts", "caused_by", "related_to", "part_of", "supersedes"],
  features: [
    "3-factor weighted recall (importance × recency × FTS5 relevance)",
    "Intent-adaptive scoring (episodic/procedural/decision/semantic queries auto-reweight)",
    "Knowledge graph with spreading activation (serendipitous discovery)",
    "Structural decay (well-linked notes survive longer, orphans fade)",
    "Shared pools for multi-agent collaborative memory",
    "Core memory with version history",
    "Note evolution via supersession chains",
  ],
};

// ─── Auth ────────────────────────────────────────────────────────────────────

interface MemApiKeySet {
  keys: Map<string, string>; // secret → agent_name
}

let cachedEnvKeys: MemApiKeySet | null | undefined;

function getEnvKeys(): MemApiKeySet | null {
  if (cachedEnvKeys !== undefined) return cachedEnvKeys;
  const raw = process.env.MEM_API_KEYS;
  if (!raw) {
    cachedEnvKeys = null;
    return null;
  }
  const keys = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [secret, agent] = pair.trim().split(":");
    if (secret && agent) {
      keys.set(secret.trim(), agent.trim());
    }
  }
  cachedEnvKeys = keys.size > 0 ? { keys } : null;
  return cachedEnvKeys;
}

function isOpenApiMode(): boolean {
  return process.env.MARINA_OPEN_API === "true";
}

function authenticate(req: Request, db: MarinaDB): { agent: string } | { error: Response } {
  const envKeys = getEnvKeys();

  // Check Bearer token first
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);

    // Check env keys
    if (envKeys) {
      const agent = envKeys.keys.get(token);
      if (agent) return { agent };
    }

    // Check DB keys
    const dbKey = db.validateMemApiKey(token);
    if (dbKey) return { agent: dbKey.agent_name };

    // Token provided but invalid
    return { error: error(401, "Invalid API key") };
  }

  // No token — if env keys are configured, auth is required
  if (envKeys) {
    return { error: error(401, "Missing Authorization header. Use: Bearer <key>") };
  }

  // No keys configured — require MARINA_OPEN_API=true for open access
  if (!isOpenApiMode()) {
    return {
      error: error(
        401,
        "Memory API requires authentication. Set MEM_API_KEYS or MARINA_OPEN_API=true for development.",
      ),
    };
  }

  // Open mode: get agent name from header
  const agentName = req.headers.get("X-Agent-Name");
  if (!agentName) {
    return {
      error: error(400, "X-Agent-Name header required (or set MEM_API_KEYS and use Bearer auth)"),
    };
  }
  return { agent: agentName };
}

// ─── Intent Detection (mirrors recall.ts) ────────────────────────────────────

function detectIntent(query: string): {
  weightImportance: number;
  weightRecency: number;
  weightRelevance: number;
} | null {
  const q = query.toLowerCase();
  if (/\b(when did|last time|yesterday|earlier|recently|just now|today)\b/.test(q)) {
    return { weightImportance: 0.15, weightRecency: 0.6, weightRelevance: 0.25 };
  }
  if (/\b(how to|how do|steps to|procedure|method for|way to|process)\b/.test(q)) {
    return { weightImportance: 0.2, weightRecency: 0.2, weightRelevance: 0.6 };
  }
  if (/\b(should i|decide|decision|choice|option|trade.?off|pros and cons)\b/.test(q)) {
    return { weightImportance: 0.5, weightRecency: 0.15, weightRelevance: 0.35 };
  }
  if (/\b(what is|what are|define|meaning of|explain|tell me about)\b/.test(q)) {
    return { weightImportance: 0.4, weightRecency: 0.1, weightRelevance: 0.5 };
  }
  return null;
}

// ─── Spreading Activation ────────────────────────────────────────────────────

function spreadActivation(
  db: MarinaDB,
  initial: ScoredNoteRow[],
  agentName: string,
): ScoredNoteRow[] {
  if (initial.length === 0 || initial.length >= 20) return initial;

  const SPREAD_DAMPING = 0.3;
  const resultIds = new Set(initial.map((r) => r.id));
  const linkedBoosts = new Map<number, number>();

  for (const note of initial.slice(0, 5)) {
    const links = db.getNoteLinks(note.id);
    for (const link of links) {
      const linkedId = link.source_id === note.id ? link.target_id : link.source_id;
      if (!resultIds.has(linkedId)) {
        const boost = note.score * SPREAD_DAMPING;
        linkedBoosts.set(linkedId, Math.max(linkedBoosts.get(linkedId) ?? 0, boost));
      }
    }
  }

  if (linkedBoosts.size === 0) return initial;

  const expanded = [...initial];
  for (const [noteId, boost] of linkedBoosts) {
    const linkedNote = db.getNote(noteId);
    if (linkedNote && linkedNote.entity_name === agentName && !linkedNote.pool_id) {
      expanded.push({ ...linkedNote, score: boost } as ScoredNoteRow);
    }
  }
  expanded.sort((a, b) => b.score - a.score);
  return expanded.slice(0, 20);
}

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function handleMemApi(
  url: URL,
  method: string,
  req: Request,
  db: MarinaDB,
  rateLimiter?: RateLimiter,
): Promise<Response | undefined> {
  const path = url.pathname;

  // Discovery — no auth required. Machine-readable API description.
  if (path === "/mem" && method === "GET") {
    return json(API_DESCRIPTION);
  }

  // Health — no auth required
  if (path === "/mem/health" && method === "GET") {
    return json({ status: "ok", service: "marina-mem", version: 1 });
  }

  // All other routes require auth
  const auth = authenticate(req, db);
  if ("error" in auth) return auth.error;
  const agent = auth.agent;

  // Per-agent rate limiting
  if (rateLimiter && !rateLimiter.consume(`mem:${agent}`)) {
    return error(429, "Rate limited. Please slow down.");
  }

  // ─── Notes ───────────────────────────────────────────────────────────

  // POST /mem/notes — create note
  if (path === "/mem/notes" && method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const content = body.content as string | undefined;
    if (!content || typeof content !== "string") {
      return error(400, "content is required (string)");
    }
    const importance = body.importance as number | undefined;
    if (importance !== undefined && (importance < 1 || importance > 10)) {
      return error(400, "importance must be 1-10");
    }
    const noteType = (body.type as string) ?? "observation";
    if (!VALID_NOTE_TYPES.has(noteType)) {
      return error(400, `Invalid type. Valid: ${[...VALID_NOTE_TYPES].join(", ")}`);
    }

    const id = db.createNote(agent, content, undefined, {
      importance,
      noteType,
    });

    // Auto-link if requested
    const links = body.links as Array<{ target: number; relationship: string }> | undefined;
    if (links && Array.isArray(links)) {
      for (const link of links) {
        if (link.target && VALID_RELATIONSHIPS.has(link.relationship)) {
          try {
            db.createNoteLink(id, link.target, link.relationship);
          } catch {
            // Skip invalid links silently
          }
        }
      }
    }

    const note = db.getNote(id);
    return json({ id, note }, 201);
  }

  // GET /mem/notes — list notes
  if (path === "/mem/notes" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const notes = db.getNotesByEntity(agent, limit);
    return json({ notes, count: notes.length });
  }

  // GET /mem/recall — scored retrieval with spreading activation
  if (path === "/mem/recall" && method === "GET") {
    const q = url.searchParams.get("q");
    if (!q) return error(400, "q parameter required");

    // Weight overrides or auto-detect
    const wi = url.searchParams.get("wi");
    const wr = url.searchParams.get("wr");
    const wrel = url.searchParams.get("wrel");
    let weights: {
      weightImportance: number;
      weightRecency: number;
      weightRelevance: number;
    };

    if (wi || wr || wrel) {
      weights = {
        weightImportance: Number(wi) || 0.33,
        weightRecency: Number(wr) || 0.33,
        weightRelevance: Number(wrel) || 0.34,
      };
    } else {
      weights = detectIntent(q) ?? {
        weightImportance: 0.33,
        weightRecency: 0.33,
        weightRelevance: 0.34,
      };
    }

    let results = db.recallNotes(agent, q, weights);
    results = spreadActivation(db, results, agent);

    // Touch recalled notes
    for (const note of results) {
      db.touchNote(note.id);
    }

    return json({ query: q, weights, results, count: results.length });
  }

  // Note by ID routes: /mem/notes/:id
  const noteIdMatch = path.match(/^\/mem\/notes\/(\d+)$/);
  if (noteIdMatch) {
    const noteId = Number(noteIdMatch[1]);

    // GET /mem/notes/:id
    if (method === "GET") {
      const note = db.getNote(noteId);
      if (!note || note.entity_name !== agent) return error(404, "Note not found");
      const links = db.getNoteLinks(noteId);
      return json({ note, links });
    }

    // DELETE /mem/notes/:id
    if (method === "DELETE") {
      const note = db.getNote(noteId);
      if (!note || note.entity_name !== agent) return error(404, "Note not found");
      db.deleteNote(noteId, agent);
      return json({ ok: true, id: noteId });
    }
  }

  // POST /mem/notes/:id/link — create link between notes
  const linkMatch = path.match(/^\/mem\/notes\/(\d+)\/link$/);
  if (linkMatch && method === "POST") {
    const sourceId = Number(linkMatch[1]);
    const sourceNote = db.getNote(sourceId);
    if (!sourceNote || sourceNote.entity_name !== agent) {
      return error(404, "Source note not found");
    }

    const body = (await req.json()) as Record<string, unknown>;
    const targetId = body.target as number | undefined;
    if (!targetId || typeof targetId !== "number") {
      return error(400, "target (note ID) is required");
    }
    const relationship = body.relationship as string | undefined;
    if (!relationship || !VALID_RELATIONSHIPS.has(relationship)) {
      return error(400, `relationship required. Valid: ${[...VALID_RELATIONSHIPS].join(", ")}`);
    }

    const targetNote = db.getNote(targetId);
    if (!targetNote || targetNote.entity_name !== agent) {
      return error(404, "Target note not found");
    }

    const linkId = db.createNoteLink(sourceId, targetId, relationship);
    return json({ id: linkId, source: sourceId, target: targetId, relationship }, 201);
  }

  // GET /mem/notes/:id/trace — knowledge graph traversal
  const traceMatch = path.match(/^\/mem\/notes\/(\d+)\/trace$/);
  if (traceMatch && method === "GET") {
    const noteId = Number(traceMatch[1]);
    const note = db.getNote(noteId);
    if (!note || note.entity_name !== agent) return error(404, "Note not found");

    const depth = Math.min(Number(url.searchParams.get("depth")) || 2, 5);
    const graph = db.traceNoteGraph(noteId, depth);

    // Filter to only this agent's notes
    const filtered = graph.filter((g) => g.note.entity_name === agent);
    return json({ root: noteId, depth, graph: filtered });
  }

  // ─── Core Memory ─────────────────────────────────────────────────────

  // GET /mem/core — list all keys
  if (path === "/mem/core" && method === "GET") {
    const entries = db.listCoreMemory(agent);
    return json({ entries, count: entries.length });
  }

  // Core key routes: /mem/core/:key
  const coreKeyMatch = path.match(/^\/mem\/core\/([^/]+)$/);
  if (coreKeyMatch) {
    const key = decodeURIComponent(coreKeyMatch[1]!);

    // GET /mem/core/:key
    if (method === "GET") {
      const entry = db.getCoreMemory(agent, key);
      if (!entry) return error(404, "Key not found");
      return json(entry);
    }

    // PUT /mem/core/:key
    if (method === "PUT") {
      const body = (await req.json()) as Record<string, unknown>;
      const value = body.value as string | undefined;
      if (value === undefined || typeof value !== "string") {
        return error(400, "value is required (string)");
      }
      db.setCoreMemory(agent, key, value);
      const entry = db.getCoreMemory(agent, key);
      return json(entry);
    }

    // DELETE /mem/core/:key
    if (method === "DELETE") {
      const deleted = db.deleteCoreMemory(agent, key);
      if (!deleted) return error(404, "Key not found");
      return json({ ok: true, key });
    }
  }

  // GET /mem/core/:key/history
  const coreHistMatch = path.match(/^\/mem\/core\/([^/]+)\/history$/);
  if (coreHistMatch && method === "GET") {
    const key = decodeURIComponent(coreHistMatch[1]!);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 100);
    const history = db.getCoreMemoryHistory(agent, key, limit);
    return json({ key, history, count: history.length });
  }

  // ─── Pools ───────────────────────────────────────────────────────────

  // GET /mem/pools — list pools
  if (path === "/mem/pools" && method === "GET") {
    const pools = db.listMemoryPools();
    return json({ pools, count: pools.length });
  }

  // POST /mem/pools — create pool
  if (path === "/mem/pools" && method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const name = body.name as string | undefined;
    if (!name || typeof name !== "string") {
      return error(400, "name is required (string)");
    }
    const existing = db.getMemoryPool(name);
    if (existing) return error(409, "Pool already exists");

    const poolId = `pool_${crypto.randomUUID().slice(0, 8)}`;
    db.createMemoryPool(poolId, name, agent);
    return json({ id: poolId, name, created_by: agent }, 201);
  }

  // Pool routes: /mem/pools/:name/*
  const poolMatch = path.match(/^\/mem\/pools\/([^/]+)(\/.*)?$/);
  if (poolMatch) {
    const poolName = decodeURIComponent(poolMatch[1]!);
    const sub = poolMatch[2] ?? "";
    const pool = db.getMemoryPool(poolName);
    if (!pool) return error(404, "Pool not found");

    // POST /mem/pools/:name/notes — add note to pool
    if (sub === "/notes" && method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const content = body.content as string | undefined;
      if (!content || typeof content !== "string") {
        return error(400, "content is required (string)");
      }
      const importance = body.importance as number | undefined;
      if (importance !== undefined && (importance < 1 || importance > 10)) {
        return error(400, "importance must be 1-10");
      }
      const noteType = (body.type as string) ?? "observation";
      if (!VALID_NOTE_TYPES.has(noteType)) {
        return error(400, `Invalid type. Valid: ${[...VALID_NOTE_TYPES].join(", ")}`);
      }
      const id = db.addPoolNote(pool.id, agent, content, importance, noteType);
      return json({ id, pool: poolName }, 201);
    }

    // GET /mem/pools/:name/notes — list pool notes
    if (sub === "/notes" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const notes = db.getPoolNotes(pool.id, limit);
      return json({ pool: poolName, notes, count: notes.length });
    }

    // GET /mem/pools/:name/recall — scored retrieval from pool
    if (sub === "/recall" && method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) return error(400, "q parameter required");

      const weights = detectIntent(q) ?? {
        weightImportance: 0.33,
        weightRecency: 0.33,
        weightRelevance: 0.34,
      };

      const results = db.recallPoolNotes(pool.id, q, weights);
      for (const note of results) {
        db.touchNote(note.id);
      }
      return json({ pool: poolName, query: q, weights, results, count: results.length });
    }

    // GET /mem/pools/:name (no sub) — pool info
    if (!sub && method === "GET") {
      return json({ ...pool, note_count: db.countPoolNotes(pool.id) });
    }
  }

  // ─── Stats ───────────────────────────────────────────────────────────

  if (path === "/mem/stats" && method === "GET") {
    const stats = db.getMemStats(agent);
    return json({ agent, ...stats });
  }

  // Not a /mem route we handle
  return undefined;
}
