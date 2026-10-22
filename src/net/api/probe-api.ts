// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /api/probe — external resolver dispatch.
 *
 * Exposes the Marina resolver registry to external callers (notebooks,
 * other services, the dashboard, peer Marinas). Every caller — agent,
 * watcher, MCP client, HTTP client — converges on the same resolver
 * primitive and produces the same Sample shape. This is what makes
 * Marina an integration substrate: the resolver is the contract.
 *
 * Auth is the /mem path (`authenticateMemCaller`): MEM_API_KEYS for keyed
 * mode, MARINA_OPEN_API for dev-mode open access, the failed-auth throttle
 * and a bounded body. Per-agent rate limiting via the shared
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

import type { RateLimiter } from "../../auth/rate-limiter";
import { Logger } from "../../engine/logger";
import type { MarinaDB } from "../../persistence/database";
import { getResolver, listResolvers } from "../../resolvers/registry";
import { findLatestSample, writeSample } from "../../resolvers/sample-writer";
import type { ResolverOutput, Sample } from "../../resolvers/types";
import { getActiveWatch, retireWatchNote } from "../../resolvers/watch-spec";
import type { EngineEvent } from "../../types";
import { corsHeaders } from "../cors";
import {
  authFailuresExhausted,
  clientIp,
  type PeerAddressSource,
  readJsonBody,
  recordAuthFailure,
} from "../http-utils";
import { authenticateMemCaller } from "./mem-api";

/** Module logger: probe HTTP route — resolver failures. */
const logger = new Logger();

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(null) });
}

function errorRes(status: number, message: string): Response {
  return json({ error: message }, status);
}

// ─── Auth: the same path as /mem (authenticateMemCaller) ────────────────────

/** Probe request bodies are a kind, a few string args and a watch id. */
const PROBE_MAX_BODY_BYTES = 64 * 1024;

// ─── Routing ────────────────────────────────────────────────────────────────

export async function handleProbeApi(
  url: URL,
  method: string,
  req: Request,
  db: MarinaDB,
  emitEvent: (event: EngineEvent) => void,
  rateLimiter?: RateLimiter,
  opts: { peer?: PeerAddressSource | string | null } = {},
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

  // Auth. A caller that has spent its failed-credential budget is refused
  // before its credential is compared.
  const ip = clientIp(req, opts.peer);
  if (authFailuresExhausted(ip)) {
    return errorRes(429, "Too many failed authentication attempts. Please slow down.");
  }
  const auth = authenticateMemCaller(req, db, "Probe API");
  if ("error" in auth) {
    if (auth.credentialRejected) recordAuthFailure(ip);
    return auth.error;
  }
  const agent = auth.agent;

  // Rate limit (per-agent; probes hit upstream APIs so over-eager callers
  // would be filtered upstream too, but this is the first line of defense).
  if (rateLimiter && !rateLimiter.consume(`probe:${agent}`)) {
    return errorRes(429, "Rate limited. Please slow down.");
  }

  // Parse body
  const read = await readJsonBody(req, {
    maxBytes: PROBE_MAX_BODY_BYTES,
    errorResponse: (status, _code, message) => errorRes(status, message),
  });
  if (!read.ok) return read.response;
  const body = read.body as { kind?: unknown; args?: unknown; watch?: unknown };

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
    logger.warn("probe", `resolver ${kind} threw: ${message}`, { kind, error: message });
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
