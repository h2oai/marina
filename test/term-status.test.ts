// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { httpBase, WorldStatus } from "../scripts/term-status";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(overrides: Record<string, () => Response> = {}) {
  const calls: { path: string; auth: string | null }[] = [];
  const routes: Record<string, () => Response> = {
    "/health": () =>
      json({
        status: "ok",
        uptime: 5000,
        connections: 2,
        agents: 1,
        tick: { agoMs: 10, errors: 0 },
      }),
    "/api/system": () =>
      json({ rooms: 3, entities: { total: 2, agents: 1, npcs: 0 }, tasks: { open: 4 } }),
    "/api/world": () =>
      json({
        worldName: "Harbor",
        rooms: [{ id: "h/dock", short: "Dock", entityCount: 2 }],
        entities: [{ name: "Jeff", room: "h/dock", kind: "person", rank: 1 }],
      }),
    "/api/entity/Jeff/profile": () =>
      json({ identity: { rank: 1, standing: 6.5 }, stats: { total_actions: 3 } }),
    "/api/ops/overview": () =>
      json({ scope: "resident", agents: [], spend: { daily: { spentUsd: 1.5, capUsd: 50 } } }),
    "/api/operations/alerts": () =>
      json([
        { status: "open", severity: "warning", title: "A", attention_kind: "approval" },
        { status: "resolved", severity: "critical", title: "B" },
      ]),
    "/api/readiness": () =>
      json({
        trustProfile: { profile: "local" },
        checks: [{ label: "x", status: "ok", detail: "" }],
      }),
    ...overrides,
  };
  const fetcher = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, auth: new Headers(init?.headers).get("authorization") });
    return routes[path]?.() ?? json({ error: "nope" }, 404);
  };
  return { calls, fetcher };
}

describe("live world status for the CLI", () => {
  test("ws URLs map to the HTTP origin", () => {
    expect(httpBase("ws://localhost:3300")).toBe("http://localhost:3300");
    expect(httpBase("wss://marina.example/")).toBe("https://marina.example");
  });

  test("reads every part with the session's own bearer token", async () => {
    const { calls, fetcher } = server();
    const status = new WorldStatus("http://x", () => "tok", "Jeff", fetcher);
    await status.refresh(true);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    const s = status.snapshot;
    expect(s.health?.connections).toBe(2);
    expect(s.system?.tasks).toEqual({ open: 4, claimed: 0, submitted: 0, completed: 0 });
    expect(s.profile?.standing).toBe(6.5);
    expect(s.ops?.spend).toMatchObject({ todayUsd: 1.5, capUsd: 50 });
    expect(s.alerts).toHaveLength(1); // resolved alerts are not attention
    expect(s.readiness?.profile).toBe("local");
    expect(status.room()).toBe("Dock");
    expect(status.roomPopulation()).toBe(2);
  });

  test("a failing endpoint keeps the last good value and never throws", async () => {
    let up = true;
    const { fetcher } = server({
      "/health": () => (up ? json({ status: "ok", connections: 9 }) : json({}, 503)),
    });
    const status = new WorldStatus("http://x", () => undefined, "Jeff", fetcher);
    await status.refresh(true, ["health"]);
    up = false;
    await status.refresh(true, ["health"]);
    expect(status.snapshot.health?.connections).toBe(9);
  });

  test("parts are only re-read when due", async () => {
    const { calls, fetcher } = server();
    const status = new WorldStatus("http://x", () => "t", "Jeff", fetcher);
    await status.refresh(true);
    const first = calls.length;
    await status.refresh(false);
    expect(calls.length).toBe(first);
  });

  test("listeners hear about a successful read", async () => {
    const { fetcher } = server();
    const status = new WorldStatus("http://x", () => "t", "Jeff", fetcher);
    let heard = 0;
    status.onChange(() => heard++);
    await status.refresh(true, ["health"]);
    expect(heard).toBe(1);
  });
});
