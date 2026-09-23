// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The lean agent adapter logs through the structured `Logger` (category
 * `lean-agent`, every line tagged `{ agent }`), never `console.*` directly.
 * Static fence + one behavioural probe of the injected logger.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAN_AGENT_LOG_CATEGORY, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { Logger } from "../src/engine/logger";

const ADAPTER_PATH = join(import.meta.dir, "../src/agent/lean-agent-adapter.ts");

type PauseSurface = {
  pause: { kind: string; reason: string; since: number } | null;
  clearPause(note: string): void;
};

function fakeLogger() {
  const calls: Array<{ level: string; category: string; message: string; data?: unknown }> = [];
  const make = (level: string) => (category: string, message: string, data?: unknown) => {
    calls.push({ level, category, message, data });
  };
  const logger = {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  } as unknown as Logger;
  return { logger, calls };
}

describe("lean-agent-adapter logging", () => {
  it("has no direct console.* calls (static fence)", () => {
    const source = readFileSync(ADAPTER_PATH, "utf8");
    const hits = source
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\bconsole\.(log|warn|error|info|debug)\(/.test(line))
      .map(({ n, line }) => `${n}: ${line.trim()}`);
    expect(hits, `console.* found in lean-agent-adapter.ts:\n${hits.join("\n")}`).toEqual([]);
  });

  it("routes a representative path through the injected logger with { agent }", () => {
    const { logger, calls } = fakeLogger();
    // Constructor is I/O-free (MarinaClient connects only in start()).
    const adapter = new LeanAgentAdapter(
      { name: "log-probe" },
      "ws://127.0.0.1:3300",
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      logger,
    );
    const surface = adapter as unknown as PauseSurface;
    surface.pause = { kind: "budget", reason: "probe", since: Date.now() };
    surface.clearPause("resumed after probe");

    expect(surface.pause).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      level: "info",
      category: LEAN_AGENT_LOG_CATEGORY,
      message: "resumed after probe",
      data: { agent: "log-probe" },
    });
    expect(LEAN_AGENT_LOG_CATEGORY).toBe("lean-agent");
  });

  it("falls back to a module Logger when none is injected", () => {
    const spy = spyOn(Logger.prototype, "log").mockImplementation(() => {});
    try {
      const adapter = new LeanAgentAdapter({ name: "log-default" }, "ws://127.0.0.1:3300", null);
      const surface = adapter as unknown as PauseSurface;
      surface.pause = { kind: "budget", reason: "probe", since: Date.now() };
      surface.clearPause("resumed with default logger");
      const entry = spy.mock.calls.find((c) => c[2] === "resumed with default logger");
      expect(entry).toBeDefined();
      expect(entry?.[0]).toBe("info");
      expect(entry?.[1]).toBe(LEAN_AGENT_LOG_CATEGORY);
      expect(entry?.[3]).toEqual({ agent: "log-default" });
    } finally {
      spy.mockRestore();
    }
  });
});
