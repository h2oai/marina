// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  buildFormationBrief,
  CREW_BRIEFS,
  FORMATION_MEDIATORS,
} from "../src/coordination/crew-formations";
import type { CrewFormation } from "../src/types";
import {
  detectTaskShapes,
  ORCHESTRATION_PATTERNS,
  PATTERN_FIT,
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

  describe("patterns added 2026-09", () => {
    const ADDED = [
      "delphi",
      "tournament",
      "verification",
      "auction",
      "ledger",
      "sharding",
    ] as const;

    it("are listed before custom, with fit and unvalidated status", () => {
      const names: readonly string[] = ORCHESTRATION_PATTERNS;
      expect(names[names.length - 1]).toBe("custom");
      for (const pattern of ADDED) {
        expect(names).toContain(pattern);
        expect(PATTERN_FIT[pattern].shapes.length).toBeGreaterThan(0);
        expect(PATTERN_FIT[pattern].why.length).toBeGreaterThan(0);
        expect(PATTERN_VALIDATION[pattern].status).toBe("unvalidated");
      }
    });

    it("detects the verifiable shape and the new contested phrases", () => {
      expect(detectTaskShapes("make the failing tests pass")).toContain("verifiable");
      expect(detectTaskShapes("check it against the reference implementation")).toContain(
        "verifiable",
      );
      expect(detectTaskShapes("compare candidates and pick the best")).toContain("contested");
      expect(detectTaskShapes("gather independent estimates")).toContain("contested");
    });

    // Patterns sharing identical shapes tie on score, so "can surface" is
    // checked against the full ranked list; the distinctive shape combinations
    // are checked at the default limit of 2.
    const all = Object.keys(PATTERN_FIT).length;
    it.each([
      ["delphi", "gather independent estimates and explore the range"],
      ["tournament", "compare candidates in parallel and pick the best"],
      ["verification", "verify each part of the shared document"],
      ["auction", "split into subtasks and run them in parallel"],
      ["ledger", "oversee the work step by step"],
      ["sharding", "fix the failing tests in parallel"],
    ])("suggestPatterns can surface %s", (pattern, goal) => {
      expect(suggestPatterns(goal, all).map((f) => f.pattern)).toContain(pattern);
    });

    it.each([
      ["tournament", "compare candidates in parallel and pick the best"],
      ["ledger", "oversee the work step by step"],
      ["sharding", "fix the failing tests in parallel"],
      ["verification", "verify the shared document and check it against the spec"],
    ])("suggestPatterns ranks %s first when its shape combination is distinctive", (p, goal) => {
      expect(suggestPatterns(goal)[0]?.pattern).toBe(p);
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

  describe("runtime crew briefs", () => {
    it("every formation has a compact, structure-light runtime brief", () => {
      for (const [formation, brief] of Object.entries(CREW_BRIEFS)) {
        expect(brief.length).toBeGreaterThan(40);
        // Structure-light by design (sweep evidence: process-heavy prose
        // displaced the crew's actual work).
        expect(brief.length).toBeLessThan(450);
        expect(formation.length).toBeGreaterThan(0);
      }
    });

    it("every built-in pattern has a runtime brief", () => {
      for (const pattern of ORCHESTRATION_PATTERNS) {
        if (pattern === "custom") continue;
        expect(CREW_BRIEFS[pattern as CrewFormation], pattern).toBeDefined();
      }
    });

    it("mediated formations are a subset of known formations", () => {
      for (const key of Object.keys(FORMATION_MEDIATORS)) {
        expect(Object.keys(CREW_BRIEFS)).toContain(key);
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
        "delphi",
        "tournament",
        "verification",
        "auction",
        "ledger",
        "sharding",
      ];
      for (const f of formations) {
        const brief = buildFormationBrief(f, "test goal");
        expect(brief).toContain("model_request");
        expect(brief).toContain("takes precedence over formation process");
      }
    });
  });
});
