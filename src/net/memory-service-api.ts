// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { RateLimiter } from "../auth/rate-limiter";
import { createMemoryPlan, executeMemoryPlan } from "../memory/planning";
import type { MemorySearchInput, MemoryService } from "../memory/service";
import {
  integer,
  MemoryError,
  memoryTerm,
  object,
  recordInput,
  textValue,
} from "../memory/service-types";
import type { MemoryActor } from "../persistence/db-principals";

const limiters = new WeakMap<MemoryService, RateLimiter>();
const headers = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
function includeStale(body: Record<string, unknown>): boolean | undefined {
  if (body.include_stale !== undefined && typeof body.include_stale !== "boolean")
    throw new MemoryError(400, "invalid_input", "include_stale must be boolean");
  return body.include_stale as boolean | undefined;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) throw new MemoryError(400, "invalid_json", "A JSON body is required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new MemoryError(413, "body_too_large", "JSON body exceeds 2 MiB");
      }
      chunks.push(value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(400, "invalid_json", "Invalid JSON body");
  } finally {
    reader.releaseLock();
  }
}

function searchInput(body: Record<string, unknown>): MemorySearchInput {
  const query = textValue(body.query, "query", 8192);
  const limit = body.limit === undefined ? 10 : integer(body.limit, "limit", 1, 100);
  if (body.mode !== undefined && body.mode !== "lexical" && body.mode !== "hybrid")
    throw new MemoryError(400, "invalid_input", "mode must be lexical or hybrid");
  if (body.allow_degraded !== undefined && typeof body.allow_degraded !== "boolean")
    throw new MemoryError(400, "invalid_input", "allow_degraded must be boolean");
  for (const key of ["subject", "type", "tier"] as const)
    if (body[key] !== undefined) textValue(body[key], key, 256);
  return {
    include_stale: includeStale(body),
    query,
    limit,
    mode: body.mode as MemorySearchInput["mode"],
    allow_degraded: body.allow_degraded as boolean | undefined,
    subject: body.subject as string | undefined,
    type: body.type as string | undefined,
    tier: body.tier as string | undefined,
  };
}

export async function handleMemoryServiceApi(
  req: Request,
  service: MemoryService,
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (path === "/v1/memory/health" && req.method === "GET") {
      const healthy = service.repository.healthy();
      return json(
        { status: healthy ? "ok" : "unavailable", service: "marina-memory", version: 1 },
        healthy ? 200 : 503,
      );
    }
    const token = req.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
    const actor = token ? service.db.verifyMemoryCredential(token) : undefined;
    if (!actor)
      throw new MemoryError(
        401,
        "invalid_credential",
        "A scoped Marina memory credential is required",
      );
    let limiter = limiters.get(service);
    if (!limiter) {
      limiter = new RateLimiter({ maxTokens: 100, refillRate: 25 });
      limiters.set(service, limiter);
    }
    limiter.cleanup();
    if (!limiter.consume(actor.principalId))
      return new Response(
        JSON.stringify({
          error: { code: "rate_limited", message: "Memory request budget exhausted" },
        }),
        {
          status: 429,
          headers: { ...headers, "Content-Type": "application/json", "Retry-After": "1" },
        },
      );
    const key = req.headers.get("Idempotency-Key") ?? "";
    if (
      ["POST", "PATCH", "DELETE"].includes(req.method) &&
      !path.endsWith("/search") &&
      !path.endsWith("/context") &&
      !path.endsWith("/query") &&
      !path.endsWith("/graph") &&
      !path.endsWith("/source_search") &&
      !path.endsWith("/plan") &&
      !path.endsWith("/execute_plan") &&
      (!key || key.length > 128)
    )
      throw new MemoryError(
        400,
        "idempotency_required",
        "An Idempotency-Key of 1–128 characters is required",
      );
    const repo = service.repository;
    if (path === "/v1/memory" && req.method === "GET") return json(service.capabilities());
    if (path === "/v1/memory/me" && req.method === "GET")
      return json({
        principal_id: actor.principalId,
        credential_id: actor.credentialId,
        scopes: actor.scopes,
      });
    if (path === "/v1/memory/spaces") {
      if (req.method === "GET") return json({ spaces: repo.spaces(actor) });
      if (req.method === "POST") {
        const body = await readBody(req);
        return json(repo.createSpace(actor, textValue(body.name, "name", 256), key), 201);
      }
    }
    const match = path.match(/^\/v1\/memory\/spaces\/([^/]+)(?:\/(.*))?$/);
    if (!match) throw new MemoryError(404, "route_not_found", "Memory route not found");
    const space = decodeURIComponent(match[1]!);
    const rest = match[2] ?? "";
    if (!rest && req.method === "GET") return json(repo.authorize(actor, space));
    if (rest === "plan" && req.method === "POST")
      return json(await createMemoryPlan(service, actor, space, await readBody(req)));
    if (rest === "execute_plan" && req.method === "POST")
      return json(await executeMemoryPlan(service, actor, space, await readBody(req)));
    if (rest === "vocabulary") {
      if (req.method === "GET")
        return json(
          repo.vocabulary(
            actor,
            space,
            url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined,
          ),
        );
      if (req.method === "POST") {
        const body = await readBody(req);
        return json(
          repo.saveVocabulary(
            actor,
            space,
            integer(body.expected_version, "expected_version", 0, Number.MAX_SAFE_INTEGER),
            body.definition,
            key,
          ),
        );
      }
    }
    if (rest === "source_search" && req.method === "POST") {
      const body = await readBody(req);
      return json(
        repo.sourceSearch(actor, space, {
          query: textValue(body.query, "query", 8192),
          match: body.match as "all" | "any" | "phrase" | undefined,
          session_id:
            body.session_id === undefined
              ? undefined
              : textValue(body.session_id, "session_id", 256),
          limit: body.limit === undefined ? 10 : integer(body.limit, "limit", 1, 100),
        }),
      );
    }
    const source = rest.match(/^sources\/([^/]+)$/);
    if (source && req.method === "GET")
      return json(
        repo.sourceRange(
          actor,
          space,
          decodeURIComponent(source[1]!),
          Number(url.searchParams.get("start") ?? 0),
          url.searchParams.has("end") ? Number(url.searchParams.get("end")) : undefined,
          url.searchParams.get("text_hash") ?? undefined,
        ),
      );
    if (rest === "query" && req.method === "POST") {
      const body = await readBody(req);
      const optional = (name: string, max = 256) =>
        body[name] === undefined ? undefined : textValue(body[name], name, max);
      return json(
        repo.query(actor, space, {
          include_stale: includeStale(body),
          subject: optional("subject"),
          predicate: optional("predicate"),
          type: optional("type"),
          tier: optional("tier"),
          object: body.object === undefined ? undefined : memoryTerm(body.object),
          limit: body.limit === undefined ? 20 : integer(body.limit, "limit", 1, 100),
          cursor: optional("cursor", 2048),
          valid_at:
            body.valid_at === undefined
              ? undefined
              : integer(body.valid_at, "valid_at", 0, Number.MAX_SAFE_INTEGER),
        }),
      );
    }
    if (rest === "graph" && req.method === "POST") {
      const body = await readBody(req);
      if (
        body.direction !== undefined &&
        (typeof body.direction !== "string" || !["out", "in", "both"].includes(body.direction))
      )
        throw new MemoryError(400, "invalid_input", "direction must be out, in or both");
      if (
        body.predicates !== undefined &&
        (!Array.isArray(body.predicates) || body.predicates.length > 16)
      )
        throw new MemoryError(
          400,
          "invalid_input",
          "predicates must be an array of at most 16 symbols",
        );
      return json(
        repo.graph(actor, space, {
          include_stale: includeStale(body),
          subject: textValue(body.subject, "subject", 256),
          valid_at:
            body.valid_at === undefined
              ? undefined
              : integer(body.valid_at, "valid_at", 0, Number.MAX_SAFE_INTEGER),
          predicates: (body.predicates as unknown[] | undefined)?.map((p) =>
            textValue(p, "predicate", 256),
          ),
          direction: body.direction as "out" | "in" | "both" | undefined,
          max_depth: body.max_depth === undefined ? 2 : integer(body.max_depth, "max_depth", 1, 5),
          limit: body.limit === undefined ? 50 : integer(body.limit, "limit", 1, 200),
        }),
      );
    }
    if (rest === "reindex" && req.method === "POST") {
      const body = await readBody(req);
      if (!service.embeddings)
        throw new MemoryError(
          503,
          "embedding_unavailable",
          "Configure an embedding provider first",
        );
      return json(
        repo.reindex(
          actor,
          space,
          integer(body.expected_generation, "expected_generation", 0, Number.MAX_SAFE_INTEGER),
          service.embeddings.id,
          key,
        ),
        202,
      );
    }
    // Route methods enforce write/share scope in the repository, after reading
    // the body and again inside their transaction. A body cannot confer rights.
    if (rest === "grants" && req.method === "POST") {
      const body = await readBody(req);
      const principal = textValue(body.principal_id, "principal_id", 128);
      if (!["reader", "writer", null].includes(body.role as string | null))
        throw new MemoryError(400, "invalid_input", "role must be reader, writer or null");
      return json(
        repo.grant(actor, space, principal, body.role as "reader" | "writer" | null, key),
      );
    }
    if (rest === "records" && req.method === "POST") {
      const body = await readBody(req);
      if (body.mode !== undefined && body.mode !== "verbatim")
        throw new MemoryError(
          400,
          "unsupported_extraction",
          "This version accepts verbatim memories; automatic extraction is not configured",
        );
      return json(repo.remember(actor, space, recordInput(body), key, service.embeddings?.id), 201);
    }
    const record = rest.match(/^records\/([^/]+)$/);
    if (record) {
      const id = decodeURIComponent(record[1]!);
      if (req.method === "GET") {
        const raw = url.searchParams.get("version");
        return json(
          repo.read(
            actor,
            space,
            id,
            raw === null ? undefined : integer(Number(raw), "version", 1, Number.MAX_SAFE_INTEGER),
          ),
        );
      }
      if (req.method === "PATCH") {
        const body = await readBody(req);
        return json(
          repo.revise(
            actor,
            space,
            id,
            integer(body.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER),
            recordInput(body),
            key,
            service.embeddings?.id,
          ),
        );
      }
    }
    if ((rest === "search" || rest === "context") && req.method === "POST") {
      const body = await readBody(req);
      const input = searchInput(body);
      return json(
        rest === "search"
          ? await service.search(actor, space, input)
          : await service.context(actor, space, {
              ...input,
              budget_tokens: integer(body.budget_tokens ?? 2048, "budget_tokens", 32, 32768),
            }),
      );
    }
    if (rest === "sources/batch" && req.method === "POST") {
      const body = await readBody(req);
      return json(repo.captureBatch(actor, space, body.items, key), 201);
    }
    if (rest === "sources") {
      if (req.method === "POST") {
        const body = await readBody(req);
        if (body.content === undefined)
          throw new MemoryError(400, "invalid_input", "content is required");
        const session =
          body.session_id === undefined ? undefined : textValue(body.session_id, "session_id", 256);
        return json(repo.capture(actor, space, body.content, session, key), 201);
      }
      if (req.method === "GET") {
        const after = integer(
          Number(url.searchParams.get("after") ?? 0),
          "after",
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const limit = integer(Number(url.searchParams.get("limit") ?? 100), "limit", 1, 1000);
        const sources = repo.sources(actor, space, after, limit);
        return json({ sources, next_cursor: sources.at(-1)?.seq ?? after });
      }
    }
    const checkpoint = rest.match(/^checkpoints\/([^/]+)$/);
    if (checkpoint) {
      const name = textValue(decodeURIComponent(checkpoint[1]!), "name", 256);
      if (req.method === "GET") return json(repo.getCheckpoint(actor, space, name));
      if (req.method === "POST") {
        const body = await readBody(req);
        return json(
          repo.checkpoint(
            actor,
            space,
            name,
            integer(body.expected_version, "expected_version", 0, Number.MAX_SAFE_INTEGER),
            object(body.data),
            integer(body.source_cursor ?? 0, "source_cursor", 0, Number.MAX_SAFE_INTEGER),
            key,
            body.source_ids as string[] | undefined,
          ),
        );
      }
    }
    const job = rest.match(/^jobs\/([^/]+)$/);
    if (job && req.method === "GET")
      return json(repo.job(actor, space, decodeURIComponent(job[1]!)));
    if (rest === "forget" && req.method === "POST") {
      const body = await readBody(req);
      for (const field of ["record_ids", "source_ids"] as const)
        if (
          body[field] !== undefined &&
          (!Array.isArray(body[field]) ||
            body[field].length > 100 ||
            body[field].some((id) => typeof id !== "string" || !id || id.length > 128))
        )
          throw new MemoryError(
            400,
            "invalid_input",
            `${field} must contain at most 100 identifiers`,
          );
      if (body.all !== undefined && typeof body.all !== "boolean")
        throw new MemoryError(400, "invalid_input", "all must be boolean");
      if (
        !body.all &&
        !(body.record_ids as unknown[] | undefined)?.length &&
        !(body.source_ids as unknown[] | undefined)?.length
      )
        throw new MemoryError(400, "invalid_input", "Choose records, sources, or the entire space");
      return json(
        repo.forget(
          actor,
          space,
          {
            record_ids: body.record_ids as string[] | undefined,
            source_ids: body.source_ids as string[] | undefined,
            all: body.all as boolean | undefined,
            expected_generation: body.all
              ? integer(body.expected_generation, "expected_generation", 0, Number.MAX_SAFE_INTEGER)
              : undefined,
          },
          key,
        ),
      );
    }
    if (rest === "export" && req.method === "GET") return json(repo.export(actor, space));
    throw new MemoryError(404, "route_not_found", "Memory route not found");
  } catch (error) {
    if (error instanceof MemoryError)
      return json({ error: { code: error.code, message: error.message } }, error.status);
    // Never echo SQL, provider bodies or caller content through generic errors.
    return json({ error: { code: "internal_error", message: "Memory operation failed" } }, 500);
  }
}

export type { MemoryActor };
