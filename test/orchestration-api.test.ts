// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { handleOrchestrationApi, listOrchestrationPatterns } from "../src/net/orchestration-api";
import { ORCHESTRATION_PATTERNS, PATTERN_FIT } from "../src/world/templates/orchestration";

function call(path: string, method = "GET"): Response | null {
  const url = new URL(`http://localhost${path}`);
  return handleOrchestrationApi(new Request(url, { method }), url);
}

describe("orchestration API", () => {
  it("ignores paths outside its prefix", () => {
    expect(call("/api/coordination/projects")).toBeNull();
    expect(call("/api/orchestrationx")).toBeNull();
  });

  it("serves every canonical pattern, in canonical order, with the fit metadata", async () => {
    const res = call("/api/orchestration/patterns");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      patterns: Array<{ id: string; name: string; description: string; fit?: string }>;
    };
    expect(body.patterns.map((p) => p.id)).toEqual([...ORCHESTRATION_PATTERNS]);
    for (const p of body.patterns) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      if (p.id === "custom") {
        expect(p.fit).toBeUndefined();
      } else {
        const fit = PATTERN_FIT[p.id as keyof typeof PATTERN_FIT];
        expect(p.fit).toBe(fit.shapes.join(", "));
        expect(p.description).toContain(fit.why);
      }
    }
    // Legacy acronyms are normalized upstream and never advertised.
    expect(body.patterns.some((p) => p.id === "nsed")).toBe(false);
    const mapreduce = body.patterns.find((p) => p.id === "mapreduce");
    expect(mapreduce?.name).toBe("MapReduce");
  });

  it("matches the exported catalogue helper", async () => {
    const res = call("/api/orchestration/patterns");
    const body = (await res!.json()) as { patterns: unknown[] };
    expect(body.patterns).toEqual(listOrchestrationPatterns());
  });

  it("answers 405 for writes and 404 for unknown sub-paths", async () => {
    expect(call("/api/orchestration/patterns", "POST")!.status).toBe(405);
    expect(call("/api/orchestration/patterns", "OPTIONS")!.status).toBe(204);
    expect(call("/api/orchestration/nope")!.status).toBe(404);
    expect(call("/api/orchestration")!.status).toBe(404);
  });
});
