// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `benchmark fetch <name>`: one dataset, downloaded in-world through the
 * harness downloader. Every test uses a fake fetcher — no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DatasetFetcher, datasetSourceKind } from "../src/engine/benchmark-fetch";
import { BENCHMARK_KEYS } from "../src/engine/benchmark-registry";
import { BENCHMARKS, type BenchmarkRunner } from "../src/engine/benchmark-runner";
import { benchmarkCommand } from "../src/engine/commands/benchmark";
import { fenceDecision } from "../src/engine/evidence-fence";
import type { MarinaDB } from "../src/persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext, RoomId } from "../src/types";
import { stripAnsi, until } from "./helpers";

const ROOT = join(import.meta.dir, "..");

function harness(rank: number, fetcher: DatasetFetcher, downloaded: Set<string>) {
  const entity = {
    id: "e_fetch" as EntityId,
    name: "Fetcher",
    properties: { rank },
  } as unknown as Entity;
  const sent: string[] = [];
  const runner = {
    list: () => Object.values(BENCHMARKS),
    datasetReady: (key: string) => {
      const kind = datasetSourceKind(key);
      return kind === "tracked" || kind === "generated" || downloaded.has(key);
    },
  } as unknown as BenchmarkRunner;
  const cmd: CommandDef = benchmarkCommand({
    getEntity: (id) => (id === entity.id ? entity : undefined),
    db: {} as MarinaDB,
    runner,
    listOrchestrations: () => [],
    fetchDataset: fetcher,
  });
  const ctx = {
    send: (_to: EntityId, text: string) => sent.push(stripAnsi(text)),
  } as unknown as RoomContext;
  const run = async (line: string) => {
    const tokens = line.split(/\s+/).filter(Boolean);
    await cmd.handler(ctx, {
      raw: `benchmark ${line}`,
      verb: "benchmark",
      args: line,
      tokens,
      entity: entity.id,
      room: "test/start" as RoomId,
    });
  };
  return { cmd, run, sent };
}

describe("benchmark fetch", () => {
  let calls: string[];
  let downloaded: Set<string>;
  const fake: DatasetFetcher = async (key) => {
    calls.push(key);
    downloaded.add(key);
    return { ok: true, output: `${key} — 10 items` };
  };

  beforeEach(() => {
    calls = [];
    downloaded = new Set();
  });
  afterEach(() => {
    calls = [];
  });

  it("downloads exactly the named dataset in the background and reports when done", async () => {
    const h = harness(4, fake, downloaded);
    await h.run("fetch aime");
    expect(h.sent[0]).toContain("Fetching aime in the background");
    await until(() => h.sent.length >= 2);
    expect(calls).toEqual(["aime"]);
    expect(h.sent[1]).toContain("benchmark fetch aime: done");
  });

  it("reports a failed download with the downloader's output", async () => {
    const h = harness(
      4,
      async () => ({ ok: false, output: "HuggingFace API error 403" }),
      downloaded,
    );
    await h.run("fetch gpqa");
    await until(() => h.sent.length >= 2);
    expect(h.sent[1]).toContain("benchmark fetch gpqa: failed");
    expect(h.sent[1]).toContain("HuggingFace API error 403");
  });

  it("is rank-gated like benchmark runs (shared profile)", async () => {
    const h = harness(0, fake, downloaded);
    await h.run("fetch aime");
    expect(h.sent.join("\n")).toContain("benchmark fetch requires rank 4");
    expect(calls).toEqual([]);
  });

  it("refuses unknown names and has nothing to fetch for tracked or generated sets", async () => {
    const h = harness(4, fake, downloaded);
    await h.run("fetch no-such-bench");
    await h.run("fetch smoke");
    await h.run("fetch retention");
    expect(h.sent[0]).toContain("Unknown benchmark: no-such-bench");
    expect(h.sent[1]).toContain("smoke needs no download: its items are tracked in the checkout");
    expect(h.sent[2]).toContain("retention needs no download: its items are generated in code");
    expect(calls).toEqual([]);
  });

  it("declares its effect and is refused under the as-of fence", () => {
    const h = harness(4, fake, downloaded);
    const form = h.cmd.usage?.find(
      (u) => typeof u !== "string" && u.syntax.startsWith("benchmark fetch"),
    );
    expect(typeof form === "string" ? undefined : form?.effect).toBe("write");
    expect(fenceDecision("benchmark", ["fetch", "aime"])).toBe("refuse");
  });

  it("benchmark list and help say per dataset whether it is ready or needs a fetch", async () => {
    downloaded.add("gsm8k");
    const h = harness(0, fake, downloaded);
    await h.run("list");
    const lines = h.sent[0]!.split("\n");
    const row = (key: string) => lines.find((l) => l.trimStart().startsWith(`${key} `)) ?? "";
    expect(row("smoke")).toContain("tracked (ready)");
    expect(row("retention")).toContain("generated (ready)");
    expect(row("gsm8k")).toContain("downloaded (ready)");
    expect(row("aime")).toContain("needs `benchmark fetch aime`");
    const stated = (key: string) =>
      row(key).includes("(ready)") || row(key).includes(`needs \`benchmark fetch ${key}\``);
    for (const key of BENCHMARK_KEYS) expect(`${key}:${stated(key)}`).toBe(`${key}:true`);
    expect(h.cmd.help).toContain("Ready with no download: smoke (tracked), retention (generated)");
    expect(h.cmd.help).toContain("benchmark fetch <name>");
  });

  it("the downloader's requests go through the SSRF guard", () => {
    const src = readFileSync(join(ROOT, "benchmarks/download.ts"), "utf8");
    expect(src).toContain("guardedFetch(url");
    expect(src.replace(/guardedFetch\(/g, "")).not.toMatch(/\bfetch\(/);
  });
});
