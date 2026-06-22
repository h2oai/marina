import { describe, expect, it } from "bun:test";
import { detectTaskShapes, suggestPatterns } from "../src/world/templates/orchestration";

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

    it("suggests debate/nsed for a contested goal", () => {
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
});
