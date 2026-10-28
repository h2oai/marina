// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /api/orchestration — read-only catalogue of the built-in orchestration
 * patterns, single-sourced from the formation catalogue
 * (`src/orchestration/formations/catalogue.ts`).
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

import { FORMATIONS } from "../../orchestration/formations/catalogue";
import {
  ORCHESTRATION_PATTERNS,
  type OrchestrationPattern,
  PATTERN_FIT,
} from "../../world/templates/orchestration";
import { corsHeaders } from "../cors";

export interface OrchestrationPatternView {
  id: string;
  name: string;
  description: string;
  /** Comma-joined coordination shapes the pattern fits (absent for `freeform`). */
  fit?: string;
}

const PREFIX = "/api/orchestration";

/** A pattern as the route serves it: the catalogue's title, summary and fit. */
function describe(id: OrchestrationPattern): OrchestrationPatternView {
  const entry = FORMATIONS[id];
  if (id === "freeform") return { id, name: entry.title, description: entry.summary };
  const fit = PATTERN_FIT[id];
  return { id, name: entry.title, description: fit.why, fit: fit.shapes.join(", ") };
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
