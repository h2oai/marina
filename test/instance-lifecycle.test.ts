// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityTracker,
  type EndpointInfo,
  endpointFilePath,
  OpenTurns,
  parseIdleShutdown,
  parseParentPid,
  readEndpointFile,
  removeEndpointFile,
  startIdleShutdown,
  watchParent,
  writeEndpointFile,
} from "../src/net/instance-lifecycle";
import { until } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "marina-lifecycle-"));
  dirs.push(d);
  return d;
}

const info = (pid = process.pid): EndpointInfo => ({
  url: "http://127.0.0.1:43117",
  mcpUrl: "http://127.0.0.1:43117/mcp",
  pid,
  apiKey: "mk_local_test",
  version: "0.0.0",
  world: "empty",
  startedAt: new Date(0).toISOString(),
  idleShutdownMs: 0,
});

describe("MARINA_IDLE_SHUTDOWN / MARINA_PARENT_PID parsing", () => {
  test("durations, zero and unset", () => {
    expect(parseIdleShutdown(undefined)).toBe(0);
    expect(parseIdleShutdown("")).toBe(0);
    expect(parseIdleShutdown("0")).toBe(0);
    expect(parseIdleShutdown("15m")).toBe(15 * 60_000);
    expect(parseIdleShutdown("900s")).toBe(900_000);
    expect(() => parseIdleShutdown("soon")).toThrow(/MARINA_IDLE_SHUTDOWN/);
    expect(() => parseIdleShutdown("900")).toThrow(/MARINA_IDLE_SHUTDOWN/);
  });

  test("parent pid", () => {
    expect(parseParentPid(undefined)).toBeUndefined();
    expect(parseParentPid("4242")).toBe(4242);
    expect(() => parseParentPid("-1")).toThrow(/MARINA_PARENT_PID/);
    expect(() => parseParentPid("abc")).toThrow(/MARINA_PARENT_PID/);
  });
});

describe("idle shutdown", () => {
  test("fires once after the idle window with nothing in flight or busy", async () => {
    let clock = 1_000;
    const activity = new ActivityTracker(() => clock);
    let busy = false;
    let fired = 0;
    const stop = startIdleShutdown({
      idleMs: 100,
      activity,
      now: () => clock,
      isBusy: () => busy,
      onIdle: () => fired++,
      checkEveryMs: 5,
    });
    try {
      const end = activity.begin();
      clock += 500;
      await Bun.sleep(20);
      expect(fired).toBe(0); // a request is in flight
      end();
      clock += 50;
      await Bun.sleep(20);
      expect(fired).toBe(0); // inside the window since it ended
      busy = true;
      clock += 500;
      await Bun.sleep(20);
      expect(fired).toBe(0); // an agent turn or background job is running
      busy = false;
      await until(() => fired === 1, { timeoutMs: 1000 });
      clock += 5_000;
      await Bun.sleep(20);
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });

  test("0 never starts a timer", () => {
    let fired = false;
    startIdleShutdown({ idleMs: 0, isBusy: () => false, onIdle: () => (fired = true) })();
    expect(fired).toBe(false);
  });

  test("open turns postpone; only request-origin turns count as activity", () => {
    let clock = 0;
    const activity = new ActivityTracker(() => clock);
    const turns = new OpenTurns(activity);
    turns.observe({ type: "agent_turn_start", name: "a" });
    turns.observe({ type: "agent_turn_start", name: "b" });
    expect(turns.count).toBe(2);
    clock = 10;
    turns.observe({ type: "agent_turn_end", name: "a", origin: "autonomous" });
    expect(activity.lastActivityAt).toBe(0);
    clock = 20;
    turns.observe({ type: "agent_turn_end", name: "b", origin: "request" });
    expect(activity.lastActivityAt).toBe(20);
    expect(turns.count).toBe(0);
  });
});

describe("endpoint.json", () => {
  test("lives in the data directory; none without one (opt-in)", () => {
    expect(endpointFilePath("/data/marina")).toBe("/data/marina/endpoint.json");
    expect(endpointFilePath(undefined)).toBeUndefined();
  });

  test("written 0600, read back while the pid lives, removed only by its owner", () => {
    const path = join(tmp(), "endpoint.json");
    writeEndpointFile(path, info());
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readEndpointFile(path)?.apiKey).toBe("mk_local_test");
    removeEndpointFile(path, process.pid + 1);
    expect(existsSync(path)).toBe(true);
    removeEndpointFile(path);
    expect(existsSync(path)).toBe(false);
  });

  test("a dead pid or a malformed file reads as absent", () => {
    const dir = tmp();
    const dead = join(dir, "dead.json");
    writeEndpointFile(dead, info(2 ** 22 + 12345));
    expect(readEndpointFile(dead)).toBeUndefined();
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "{not json");
    expect(readEndpointFile(junk)).toBeUndefined();
    expect(readEndpointFile(join(dir, "missing.json"))).toBeUndefined();
  });
});

test("watchParent fires once when the parent is gone", async () => {
  let alive = true;
  let gone = 0;
  const stop = watchParent(1, () => gone++, { everyMs: 5, alive: () => alive });
  try {
    await Bun.sleep(20);
    expect(gone).toBe(0);
    alive = false;
    await until(() => gone === 1, { timeoutMs: 1000 });
  } finally {
    stop();
  }
});
