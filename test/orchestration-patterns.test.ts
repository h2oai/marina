// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { buildFormationBrief } from "../src/coordination/crew-formations";
import type { CrewFormation } from "../src/types";
import {
  detectTaskShapes,
  ORCHESTRATION_PATTERNS,
  PATTERN_VALIDATION,
  suggestPatterns,
} from "../src/world/templates/orchestration";

describe("emergent orchestration — recognition loop", () => {
  describe("detectTaskShapes", () => {
    it("returns nothing for empty/undefined or plain solo goals", () => {
      expect(detectTaskShapes(undefined)).toEqual([]);
      expect(detectTaskShapes("")).toEqual([]);
      expect(detectTaskShapes("fix the typo in the README")).toEqual([]);
    });

    it("detects a contested shape", () => {
      expect(detectTaskShapes("debate whether to use Rust or Go")).toContain("contested");
      expect(detectTaskShapes("decide between two architectures")).toContain("contested");
    });

    it("detects decomposable / parallel shapes", () => {
      expect(detectTaskShapes("break this down into subtasks across several modules")).toContain(
        "decomposable",
      );
      expect(detectTaskShapes("run the analyses in parallel, independently")).toContain("parallel");
    });

    it("detects sequential and open-ended shapes", () => {
      expect(detectTaskShapes("do this step by step through several stages")).toContain(
        "sequential",
      );
      expect(detectTaskShapes("explore and investigate the design space")).toContain("open-ended");
    });
  });

  describe("suggestPatterns", () => {
    it("stays quiet for solo goals (no coordination shape)", () => {
      expect(suggestPatterns("rename a variable")).toEqual([]);
      expect(suggestPatterns(undefined)).toEqual([]);
    });

    it("suggests debate/deliberation for a contested goal", () => {
      const fits = suggestPatterns("debate which database is better");
      expect(fits.length).toBeGreaterThan(0);
      expect(fits.map((f) => f.pattern)).toContain("debate");
    });

    it("suggests mapreduce/foundry for a decomposable, parallel goal", () => {
      const fits = suggestPatterns(
        "decompose this into independent chunks and run them in parallel",
      );
      expect(fits.map((f) => f.pattern)).toContain("mapreduce");
    });

    it("ranks by shape coverage and caps the list", () => {
      const fits = suggestPatterns(
        "explore the space, break it into parallel subtasks, and debate the tradeoffs",
        2,
      );
      expect(fits.length).toBeLessThanOrEqual(2);
      // Every suggestion carries a one-line rationale.
      for (const f of fits) expect(f.why.length).toBeGreaterThan(0);
    });
  });

  describe("PATTERN_VALIDATION (2026-09 sweep evidence)", () => {
    it("covers every non-custom pattern with a status and evidence line", () => {
      for (const pattern of ORCHESTRATION_PATTERNS) {
        if (pattern === "custom") continue;
        const v = PATTERN_VALIDATION[pattern];
        expect(v).toBeDefined();
        expect(["validated", "partial", "unvalidated"]).toContain(v.status);
        expect(v.evidence.length).toBeGreaterThan(0);
      }
    });
  });

  describe("formation brief protocol priority", () => {
    it("every formation brief leads with the model_response-over-process rule", () => {
      // Measured 2026-09: process-heavy briefs displaced the response protocol
      // (crew solved the questions but never replied). The preamble is the fix.
      const formations: CrewFormation[] = [
        "freeform",
        "deliberation",
        "chorus",
        "foundry",
        "swarm",
        "pipeline",
        "debate",
        "mapreduce",
        "blackboard",
        "symbiosis",
        "research",
      ];
      for (const f of formations) {
        const brief = buildFormationBrief(f, "test goal");
        expect(brief).toContain("model_request");
        expect(brief).toContain("takes precedence over formation process");
      }
    });
  });
});
