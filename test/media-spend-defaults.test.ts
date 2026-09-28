// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Media generation defaults: per-entity daily job caps (50 images / 5 videos
 * unless configured; 0 = unlimited) and the world's daily spend cap covering
 * priced image/video jobs.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_MAX_IMAGE_JOBS_PER_DAY,
  DEFAULT_MAX_VIDEO_JOBS_PER_DAY,
  MediaManager,
  mediaJobCap,
} from "../src/engine/media/manager";
import { recordSpend, resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import type { EntityId } from "../src/types";

const KEYS = ["MARINA_DAILY_SPEND_CAP_USD", "MAX_IMAGE_JOBS_PER_DAY", "MAX_VIDEO_JOBS_PER_DAY"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  resetSpendLedgerForTests();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetSpendLedgerForTests();
});

function manager(jobsToday = 0) {
  const created: unknown[] = [];
  const db = {
    countMediaJobsSince: () => jobsToday,
    createMediaJob: (row: unknown) => created.push(row),
    updateMediaJob: () => {},
    getMediaJob: () => undefined,
  };
  const m = new MediaManager({
    engine: {} as never,
    db: db as never,
    storage: {} as never,
    resolveApiKey: () => "sk-test",
    logEvent: () => {},
  });
  return { m, created };
}

const params = {
  type: "image" as const,
  entityId: "e_1" as EntityId,
  entityName: "Painter",
  prompt: "a lighthouse",
  model: "openai/gpt-image-2",
};

describe("media job caps", () => {
  it("default to 50 images / 5 videos per entity; 0 is explicitly unlimited", () => {
    expect(DEFAULT_MAX_IMAGE_JOBS_PER_DAY).toBe(50);
    expect(DEFAULT_MAX_VIDEO_JOBS_PER_DAY).toBe(5);
    expect(mediaJobCap("image", {})).toBe(50);
    expect(mediaJobCap("video", {})).toBe(5);
    expect(mediaJobCap("image", { MAX_IMAGE_JOBS_PER_DAY: "0" })).toBe(0);
    expect(mediaJobCap("video", { MAX_VIDEO_JOBS_PER_DAY: "12" })).toBe(12);
    expect(mediaJobCap("image", { MAX_IMAGE_JOBS_PER_DAY: "lots" })).toBe(50);
  });

  it("refuses at the default cap and names the variable to raise", async () => {
    const { m, created } = manager(50);
    await expect(m.startJob(params)).rejects.toThrow(/MAX_IMAGE_JOBS_PER_DAY/);
    expect(created).toHaveLength(0);
  });
});

describe("media and the daily spend cap", () => {
  it("a priced job is refused once the world's cap is reached — before any job is created", async () => {
    process.env.MARINA_DAILY_SPEND_CAP_USD = "1";
    recordSpend("model_api", 2);
    const { m, created } = manager();
    await expect(m.startJob(params)).rejects.toThrow(/daily spend cap reached/);
    expect(created).toHaveLength(0);
  });

  it("a completed job records its estimated price as media spend", () => {
    const { m } = manager();
    (m as unknown as { recordMediaSpend(p: typeof params): void }).recordMediaSpend(params);
    expect(spentTodayUsd()).toBeCloseTo(0.042, 3);
  });
});
