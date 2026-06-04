/**
 * /api/probe — external resolver dispatch.
 *
 * Exposes the Marina resolver registry to external callers (notebooks,
 * other services, the dashboard, peer Marinas). Every caller — agent,
 * watcher, MCP client, HTTP client — converges on the same resolver
 * primitive and produces the same Sample shape. This is what makes
 * Marina an integration substrate: the resolver is the contract.
 *
 * Auth mirrors /mem: MEM_API_KEYS for keyed mode, MARINA_OPEN_API for
 * dev-mode open access. Per-agent rate limiting via the shared
 * memRateLimiter (probes are read-mostly + bounded by upstream rate
 * limits anyway).
 *
 * POST /api/probe
 *   body: { kind: string, args: Record<string, string>, watch?: number }
 *   returns: { sample: Sample, noteId: number }
 *
 * GET /api/probe
 *   returns: { resolvers: [{kind, description}, ...] } — discovery
 */

import type { RateLimiter } from "../auth/rate-limiter";
import type { MarinaDB } from "../persistence/database";
import { getResolver, listResolvers } from "../resolvers/registry";
import { findLatestSample, writeSample } from "../resolvers/sample-writer";
import type { ResolverOutput, Sample } from "../resolvers/types";
import { getActiveWatch, retireWatchNote } from "../resolvers/watch-spec";
import type { EngineEvent } from "../types";
import { corsHeaders } from "./cors";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(null) });
}

function errorRes(status: number, message: string): Response {
  return json({ error: message }, status);
}

// ─── Auth (mirrors mem-api, intentionally duplicated for clarity) ───────────

function getEnvKeys(): Map<string, string> | null {
  const raw = process.env.MEM_API_KEYS;
  if (!raw) return null;
  const keys = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [secret, agent] = pair.trim().split(":");
    if (secret && agent) keys.set(secret.trim(), agent.trim());
  }
  return keys.size > 0 ? keys : null;
}

function isOpenApiMode(): boolean {
  return process.env.MARINA_OPEN_API === "true";
}

function authenticate(req: Request, db: MarinaDB): { agent: string } | { error: Response } {
  const envKeys = getEnvKeys();
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (envKeys) {
      const agent = envKeys.get(token);
      if (agent) return { agent };
    }
    const dbKey = db.validateMemApiKey(token);
    if (dbKey) return { agent: dbKey.agent_name };
    return { error: errorRes(401, "Invalid API key") };
  }
  if (envKeys) {
    return { error: errorRes(401, "Missing Authorization header. Use: Bearer <key>") };
  }
  if (!isOpenApiMode()) {
    return {
      error: errorRes(
        401,
        "Probe API requires authentication. Set MEM_API_KEYS or MARINA_OPEN_API=true.",
      ),
    };
  }
  const agentName = req.headers.get("X-Agent-Name");
  if (!agentName) {
    return {
      error: errorRes(
        400,
        "X-Agent-Name header required (or set MEM_API_KEYS and use Bearer auth)",
      ),
    };
  }
  return { agent: agentName };
}

// ─── Routing ────────────────────────────────────────────────────────────────

export async function handleProbeApi(
  url: URL,
  method: string,
  req: Request,
  db: MarinaDB,
  emitEvent: (event: EngineEvent) => void,
  rateLimiter?: RateLimiter,
): Promise<Response | undefined> {
  if (url.pathname !== "/api/probe") return undefined;

  // Discovery — GET /api/probe lists registered kinds. No auth required;
  // the listing is a development aid + dashboard surface, not sensitive.
  if (method === "GET") {
    const resolvers = listResolvers().map((r) => ({
      kind: r.kind,
      description: r.description,
      closesOn: r.closesOn,
    }));
    return json({ resolvers });
  }

  if (method !== "POST") {
    return errorRes(405, "Method not allowed (POST or GET)");
  }

  // Auth
  const auth = authenticate(req, db);
  if ("error" in auth) return auth.error;
  const agent = auth.agent;

  // Rate limit (per-agent; probes hit upstream APIs so over-eager callers
  // would be filtered upstream too, but this is the first line of defense).
  if (rateLimiter && !rateLimiter.consume(`probe:${agent}`)) {
    return errorRes(429, "Rate limited. Please slow down.");
  }

  // Parse body
  let body: { kind?: unknown; args?: unknown; watch?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorRes(400, "Invalid JSON body");
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!kind) return errorRes(400, "kind is required (string)");
  const resolver = getResolver(kind);
  if (!resolver) {
    return errorRes(
      404,
      `Unknown resolver kind: ${kind}. Registered: ${listResolvers()
        .map((r) => r.kind)
        .join(", ")}`,
    );
  }

  // args is Record<string, string> (mirrors in-world probe command parsing).
  // Coerce non-string values to strings so callers can send {ticker: 123}.
  const argsRaw: Record<string, string> = {};
  if (body.args && typeof body.args === "object" && !Array.isArray(body.args)) {
    for (const [k, v] of Object.entries(body.args as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      argsRaw[k] = typeof v === "string" ? v : String(v);
    }
  }

  const parsed = resolver.parseArgs(argsRaw);
  if (!parsed.ok) return errorRes(400, parsed.error);

  const id = resolver.idFromArgs(parsed.args);
  const previous = findLatestSample(db, kind, id);

  let output: ResolverOutput;
  try {
    output = await resolver.resolve({
      args: parsed.args,
      previousSample: previous?.sample,
      ctx: { db },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[probe] resolver ${kind} threw: ${message}`);
    output = { status: "error", reason: "resolver error" };
  }

  const sample = buildSample(kind, id, output, previous?.sample);

  // Optional watch:<id> linkage (matches the in-world probe command flag).
  let watchSpecNoteId: number | undefined;
  const watchId = typeof body.watch === "number" ? body.watch : undefined;
  if (watchId !== undefined) {
    const watch = getActiveWatch(db, watchId);
    if (watch) watchSpecNoteId = watch.noteId;
  }

  const { noteId } = writeSample({
    db,
    sample,
    authorName: agent,
    watchSpecNoteId,
    previousSampleNoteId: previous?.noteId,
    emitEvent,
  });

  // Auto-retirement (mirrors in-world probe handler).
  if (watchSpecNoteId !== undefined) {
    const watch = getActiveWatch(db, watchSpecNoteId);
    if (watch && shouldRetire(resolver.closesOn, watch.spec.retirement.kind, sample.status)) {
      retireWatchNote(db, watch.noteId, agent, sample.status);
    }
  }

  return json({ sample, noteId });
}

function buildSample(
  kind: string,
  id: string,
  output: ResolverOutput,
  previous: Sample | undefined,
): Sample {
  const ts = Date.now();
  const base = { kind, id, ts };
  switch (output.status) {
    case "resolved":
    case "changed":
      return {
        ...base,
        status: output.status,
        value: output.value,
        source: output.source,
        rawHash: output.rawHash,
      };
    case "no-change":
      return { ...base, status: "no-change", source: output.source };
    case "error":
      return {
        ...base,
        status: "error",
        source: previous?.source ?? "(unknown)",
        reason: output.reason,
      };
  }
}

function shouldRetire(
  closesOn: readonly Sample["status"][],
  retirementKind: string,
  sampleStatus: Sample["status"],
): boolean {
  if (retirementKind !== "resolved") return false;
  return closesOn.includes(sampleStatus);
}
