// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /api/orchestration — read-only catalogue of the built-in orchestration
 * patterns, single-sourced from `src/world/templates/orchestration.ts`.
 *
 * The dashboard bundle cannot import server modules, so before this route it
 * carried a hand-copied pattern list that had to be kept in sync by hand. Now
 * the dashboard fetches the list here and keeps its copy only as a loading
 * fallback.
 *
 * GET /api/orchestration/patterns
 *   returns: { patterns: [{ id, name, description, fit? }, ...] }
 *
 * The data is static, non-sensitive, and world-independent — no auth, no DB.
 * Any other method or path under /api/orchestration answers 404/405; paths
 * outside the prefix return `null` so the caller keeps routing.
 */

import {
  ORCHESTRATION_PATTERNS,
  type OrchestrationPattern,
  PATTERN_FIT,
  PATTERN_VALIDATION,
} from "../world/templates/orchestration";
import { corsHeaders } from "./cors";

export interface OrchestrationPatternView {
  id: string;
  name: string;
  description: string;
  /** Comma-joined coordination shapes the pattern fits (absent for `custom`). */
  fit?: string;
}

const PREFIX = "/api/orchestration";

/** Display name: title-cased id (`mapreduce` → `MapReduce`, `nsed`-style acronyms never appear). */
function displayName(id: string): string {
  if (id === "mapreduce") return "MapReduce";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function describe(id: OrchestrationPattern): OrchestrationPatternView {
  if (id === "custom") {
    return {
      id,
      name: displayName(id),
      description: "Operator-defined conventions — no seeded template",
    };
  }
  const fit = PATTERN_FIT[id];
  const validation = PATTERN_VALIDATION[id];
  const description =
    validation.status === "validated" ? fit.why : `${fit.why} (${validation.status})`;
  return { id, name: displayName(id), description, fit: fit.shapes.join(", ") };
}

/** The pattern catalogue as served by the route — exported for tests and other servers. */
export function listOrchestrationPatterns(): OrchestrationPatternView[] {
  return ORCHESTRATION_PATTERNS.map(describe);
}

function json(data: unknown, status = 200, origin: string | null = null): Response {
  return Response.json(data, {
    status,
    headers: { ...corsHeaders(origin), "Cache-Control": "public, max-age=300" },
  });
}

export function handleOrchestrationApi(req: Request, url: URL): Response | null {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  const origin = req.headers.get("origin");
  if (url.pathname === `${PREFIX}/patterns`) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, { methods: "GET" }) });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: "Method not allowed" }, 405, origin);
    }
    return json({ patterns: listOrchestrationPatterns() }, 200, origin);
  }
  return json({ error: "Not found" }, 404, origin);
}
