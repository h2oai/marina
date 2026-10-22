// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `rescore-selection --file`: the offline selection comparison files through
// the one promotion path (`fileSlotPromotion`) instead of its own verdict.
// Synthetic rows only; no model calls.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FuturexRow } from "../benchmarks/futurex/dataset";
import {
  describeFiled,
  FUTUREX_CONFIG_SLOT,
  fileRescore,
  type SavedRow,
} from "../benchmarks/futurex/rescore-selection";
import { BUILTIN_VARIANTS } from "../benchmarks/futurex/run";
import { forecastConfigFromSlot } from "../src/forecast/defaults";
import { MarinaDB } from "../src/persistence/database";

const prompt =
  'You are an agent that can predict future events. The event to be predicted: "Q? (resolved around 2030-09-14T23:59:59+08:00 (GMT+8)).\nA. the outcome be x\nB. the outcome be y"\nIMPORTANT: End with the selected option letter(s) in \\boxed{...}.';

/** 80 rows where the most confident run (B) is right and the plurality (A) wrong. */
function fixture(): { truth: Map<string, FuturexRow>; rows: SavedRow[] } {
  const truth = new Map<string, FuturexRow>();
  const rows: SavedRow[] = [];
  for (let i = 0; i < 80; i++) {
    const id = `r${i}`;
    truth.set(id, {
      id,
      level: 1 + (i % 2),
      prompt,
      end_time: "2030-01-01",
      ground_truth: "['B']",
    });
    rows.push({
      id,
      level: 1 + (i % 2),
      prediction: "",
      answer: {
        answer: { type: "choice", options: [{ id: "A" }, { id: "B" }] },
        runs: (
          [
            ["A", 0.3],
            ["A", 0.4],
            ["B", 0.95],
          ] as const
        ).map(([v, c], k) => ({
          run: k + 1,
          model: "m",
          status: "ok",
          weight: 1,
          value: v,
          formatted: v,
          confidence: c,
        })),
      },
    } as SavedRow);
  }
  return { truth, rows };
}

describe("rescore-selection --file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-rescore-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records a ledger run per file per mode, seeds the incumbent, then contests it", () => {
    const db = new MarinaDB(":memory:");
    try {
      const { truth, rows } = fixture();
      const filed = fileRescore(db, {
        runs: [rows, rows],
        truth,
        variant: BUILTIN_VARIANTS.cheap!,
        challenger: "confidence",
        incumbent: "agreement",
        minReplicates: 2,
        now: Date.parse("2026-10-20T00:00:00Z"),
      });
      expect(filed.slot).toBe(FUTUREX_CONFIG_SLOT);
      expect(filed.slot).toBe("forecast-config:futurex");
      expect(filed.runs.incumbent).toHaveLength(2);
      expect(filed.runs.challenger).toHaveLength(2);
      const challenger = db.getBenchmarkRun(filed.runs.challenger[0]!)!;
      expect(challenger.benchmark).toBe("futurex-past");
      expect(challenger.replicate_group).toBe("rescore:forecast-config:futurex:cheap:confidence");
      // The target is a full configuration the live surface can read back.
      const config = forecastConfigFromSlot(JSON.parse(challenger.target_json!));
      expect(config?.selection).toBe("confidence");
      expect(config?.analysts).toEqual(BUILTIN_VARIANTS.cheap!.analysts);
      // An empty slot takes the incumbent first; the challenger then contests it.
      expect(filed.seeded?.kind).toBe("seeded");
      expect(filed.filed.kind).toBe("promoted");
      expect(describeFiled(filed.filed)).toContain("PROMOTED");
      expect(db.getBenchmarkDefault(FUTUREX_CONFIG_SLOT)?.incumbent_run_id).toBe(
        filed.runs.challenger[0],
      );

      // A second filing finds the slot taken: no seeding, and the same configuration
      // contesting itself is refused by the one promotion rule.
      const again = fileRescore(db, {
        runs: [rows, rows],
        truth,
        variant: BUILTIN_VARIANTS.cheap!,
        challenger: "confidence",
        incumbent: "agreement",
        minReplicates: 2,
      });
      expect(again.seeded).toBeUndefined();
      expect(again.filed.kind).not.toBe("promoted");
    } finally {
      db.close();
    }
  });

  it("an unreplicated filing is refused before the holdout is read", () => {
    const db = new MarinaDB(":memory:");
    try {
      const { truth, rows } = fixture();
      const filed = fileRescore(db, {
        runs: [rows],
        truth,
        variant: BUILTIN_VARIANTS.cheap!,
        challenger: "confidence",
        incumbent: "agreement",
        minReplicates: 2,
      });
      expect(filed.seeded?.kind).toBe("error");
      expect(filed.filed.kind).toBe("error");
      expect(describeFiled(filed.filed)).toContain("Not replicated");
      expect(db.getBenchmarkDefault(FUTUREX_CONFIG_SLOT)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("the CLI writes nothing without --file, and files with it", async () => {
    const { truth, rows } = fixture();
    const dataset = join(dir, "past.json");
    const answers = join(dir, "answers.json");
    writeFileSync(dataset, JSON.stringify({ rows: [...truth.values()] }));
    writeFileSync(answers, JSON.stringify({ results: rows }));
    const dbPath = join(dir, "world.db");
    const run = async (extra: string[]) => {
      const p = Bun.spawn(
        [
          process.execPath,
          "benchmarks/futurex/rescore-selection.ts",
          "--dataset",
          dataset,
          "--runs",
          `${answers},${answers}`,
          ...extra,
        ],
        { env: { ...process.env, DB_PATH: dbPath }, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out;
    };
    const plain = await run([]);
    expect(plain).toContain("holdout confidence − agreement");
    expect(existsSync(dbPath)).toBe(false);
    const filed = await run(["--file", "--variant", "cheap", "--min-replicates", "2"]);
    expect(filed).toContain("incumbent: seeded forecast-config:futurex");
    expect(filed).toContain("challenger: PROMOTED");
    expect(existsSync(dbPath)).toBe(true);
  }, 30_000);
});
