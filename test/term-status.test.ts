// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { termCaps } from "../scripts/term-caps";
import { findPanel } from "../scripts/term-panels";
import { httpBase, WorldStatus } from "../scripts/term-status";
import { createTheme } from "../scripts/term-theme";

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
        entities: [{ name: "Rowan", room: "h/dock", kind: "person", rank: 1 }],
      }),
    "/api/entity/Rowan/profile": () =>
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
    "/api/challenges/mine": () =>
      json({
        answerable: [
          {
            token: "t1",
            kind: "gate",
            requester: "Ada",
            summary: "spawn",
            reason: "r",
            expiresAt: 1,
          },
        ],
        raised: [],
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
    const status = new WorldStatus("http://x", () => "tok", "Rowan", fetcher);
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
    const status = new WorldStatus("http://x", () => undefined, "Rowan", fetcher);
    await status.refresh(true, ["health"]);
    up = false;
    await status.refresh(true, ["health"]);
    expect(status.snapshot.health?.connections).toBe(9);
  });

  test("parts are only re-read when due", async () => {
    const { calls, fetcher } = server();
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    await status.refresh(true);
    const first = calls.length;
    await status.refresh(false);
    expect(calls.length).toBe(first);
  });

  test("reads the caller's own held actions", async () => {
    const { fetcher } = server();
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    await status.refresh(true, ["challenges"]);
    expect(status.snapshot.challenges?.answerable[0]).toMatchObject({
      token: "t1",
      requester: "Ada",
    });
    expect(status.snapshot.challenges?.raised).toEqual([]);
  });

  test("a refused part is marked denied, its old data dropped, and asked again rarely", async () => {
    let allowed = true;
    const { calls, fetcher } = server({
      "/api/operations/alerts": () =>
        allowed ? json([{ status: "open", severity: "warning", title: "A" }]) : json({}, 403),
    });
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    await status.refresh(true, ["alerts"]);
    expect(status.snapshot.alerts).toHaveLength(1);
    allowed = false;
    await status.refresh(true, ["alerts"]);
    expect(status.snapshot.denied?.alerts).toBe(true);
    expect(status.snapshot.alerts).toBeUndefined();
    const before = calls.filter((c) => c.path === "/api/operations/alerts").length;
    await status.refresh(false);
    expect(calls.filter((c) => c.path === "/api/operations/alerts").length).toBe(before);
  });

  test("listeners hear about a successful read", async () => {
    const { fetcher } = server();
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    let heard = 0;
    status.onChange(() => heard++);
    await status.refresh(true, ["health"]);
    expect(heard).toBe(1);
  });

  test("streams and tasks are read only while something on screen wants them", async () => {
    const { calls, fetcher } = server({
      "/api/routing/overview": () =>
        json({
          total: 3,
          items: [
            {
              session: { id: "s1", label: "idle-pi", kind: "pi", lastSeenAt: 3 },
              runtime: { status: "idle", adapter: "pi" },
              owned: true,
            },
            {
              session: { id: "s2", label: "claude-1", kind: "claude", lastSeenAt: 1 },
              runtime: { status: "waiting", adapter: "claude", request: { id: "q" } },
              owned: true,
            },
            {
              session: { id: "s3", label: "codex-1", kind: "codex", lastSeenAt: 2 },
              runtime: { status: "failed", adapter: "codex", error: "exit 1" },
              owned: false,
            },
          ],
        }),
      "/api/coordination/tasks": () =>
        json({
          total: 3,
          items: [
            { id: 1, title: "open one", status: "open", creator_name: "Ada" },
            { id: 2, title: "review me", status: "open", creator_name: "Ada", submitted: 1 },
            { id: 3, title: "finished", status: "completed", creator_name: "Ada" },
          ],
        }),
    });
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    await status.refresh(true);
    expect(calls.some((c) => c.path.startsWith("/api/routing"))).toBe(false);
    expect(calls.some((c) => c.path.startsWith("/api/coordination"))).toBe(false);
    status.want(["streams", "tasks"]);
    await status.refresh(true);
    expect(status.snapshot.streams?.items.map((r) => r.asking)).toEqual([false, true, false]);
    expect(status.snapshot.tasks?.total).toBe(3);

    const theme = createTheme(termCaps({ isTTY: true, columns: 100 }, { NO_COLOR: "1" }));
    const context = { theme, name: "Rowan", connected: true, snapshot: status.snapshot, queued: 0 };
    const streams = findPanel("streams")!.render(context).join("\n");
    // Whoever needs you comes first: asking, then failing, then the rest.
    expect(streams.indexOf("claude-1")).toBeLessThan(streams.indexOf("codex-1"));
    expect(streams.indexOf("codex-1")).toBeLessThan(streams.indexOf("idle-pi"));
    expect(streams).toContain("asking you");
    expect(streams).toContain("exit 1");
    expect(streams).toContain("3 · 1 asking");
    const tasks = findPanel("tasks")!.render(context).join("\n");
    expect(tasks.indexOf("review me")).toBeLessThan(tasks.indexOf("open one"));
    expect(tasks).not.toContain("finished");
    expect(tasks).toContain("2 open · 1 to review");

    // Wanting nothing stops the polling.
    status.want([]);
    const before = calls.length;
    await status.refresh(true);
    expect(calls.slice(before).some((c) => c.path.startsWith("/api/routing"))).toBe(false);
  });

  test("a session without a world account is told why Streams is empty", async () => {
    const { fetcher } = server({ "/api/routing/overview": () => json({}, 403) });
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    await status.refresh(true, ["streams"]);
    const theme = createTheme(termCaps({ isTTY: true, columns: 100 }, { NO_COLOR: "1" }));
    const out = findPanel("streams")!
      .render({ theme, name: "Rowan", connected: true, snapshot: status.snapshot, queued: 0 })
      .join("\n");
    expect(out).toContain("signed-in world account");
  });

  test("memory mode reads dreams and memory health as counts, proposals first", async () => {
    const now = Date.now();
    const { fetcher } = server({
      "/api/memory/dreams": () =>
        json({
          mode: "observe",
          guarded: ["Fern"],
          dreams: [
            {
              id: 7,
              entity: "Rowan",
              state: "observed",
              createdAt: now - 60_000,
              ops: { applied: 0, rejected: 1, pendingProposals: 0 },
            },
            {
              id: 6,
              entity: "Rowan",
              state: "applied",
              createdAt: now - 120_000,
              ops: { applied: 3, rejected: 0, pendingProposals: 2 },
            },
          ],
        }),
      "/api/memory/overview": () =>
        json({
          ratios: {
            scope: "own",
            unresolvedContradictionRate: { value: 0.5, numerator: 1, denominator: 2 },
            stalenessRatio: { value: 0, numerator: 0, denominator: 40 },
            redundancy: { value: null, numerator: 0, denominator: 0 },
            provenanceCoverage: { value: 0.25, numerator: 10, denominator: 40 },
          },
          jobs: { open: 2 },
          resolutions: [{}],
        }),
    });
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    status.want(["dreams", "memory"]);
    await status.refresh(true);
    const theme = createTheme(termCaps({ isTTY: true, columns: 100 }, { NO_COLOR: "1" }));
    const context = { theme, name: "Rowan", connected: true, snapshot: status.snapshot, queued: 0 };
    const dreams = findPanel("dreams")!.render(context).join("\n");
    expect(dreams.indexOf("#6")).toBeLessThan(dreams.indexOf("#7"));
    expect(dreams).toContain("2 to adopt");
    expect(dreams).toContain("memory dream adopt|dismiss");
    expect(dreams).toContain("guard tripped: Fern");
    expect(dreams).toContain("1 waiting · dreaming observe");
    const memory = findPanel("memory")!.render(context).join("\n");
    expect(memory).toContain("1 of 2");
    expect(memory).toContain("note conflicts");
    expect(memory).toContain("10 of 40");
    expect(memory).toContain("2 open");
    expect(memory).toContain("yours");
  });

  test("investigate reads traces failures first, and says why when it may not", async () => {
    const now = Date.now();
    const { fetcher } = server({
      "/api/traces": () =>
        json({
          traces: [
            {
              traceId: "t-ok",
              status: "completed",
              startedAt: now - 5_000,
              durationMs: 1200,
              spans: [{ attributes: { model: "claude-opus-5-5" } }],
              evaluation: { checks: [{ id: "terminal_outcome", result: "passed" }] },
            },
            {
              traceId: "t-bad",
              status: "completed",
              startedAt: now - 60_000,
              durationMs: 800,
              spans: [{ attributes: {} }, { attributes: {} }],
              evaluation: { checks: [{ id: "tool_results", result: "failed" }] },
            },
          ],
        }),
      "/api/feed": () =>
        json([
          {
            kind: "task_created",
            entity: "Ada",
            summary: "Fix the parser",
            timestamp: now - 1_000,
          },
        ]),
    });
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    status.want(["traces", "feed"]);
    await status.refresh(true);
    const theme = createTheme(termCaps({ isTTY: true, columns: 100 }, { NO_COLOR: "1" }));
    const context = { theme, name: "Rowan", connected: true, snapshot: status.snapshot, queued: 0 };
    const traces = findPanel("traces")!.render(context).join("\n");
    expect(traces.indexOf("t-bad")).toBeLessThan(traces.indexOf("t-ok"));
    expect(traces).toContain("tool_results");
    expect(traces).toContain("claude-opus-5-5");
    expect(traces).toContain("1 failed of 2");
    expect(findPanel("feed")!.render(context).join("\n")).toContain("Fix the parser");

    const denied = server({ "/api/traces": () => json({}, 403) });
    const resident = new WorldStatus("http://x", () => "t", "Rowan", denied.fetcher);
    await resident.refresh(true, ["traces"]);
    expect(
      findPanel("traces")!
        .render({ ...context, snapshot: resident.snapshot })
        .join("\n"),
    ).toContain("traces need operator read");
  });

  test("forecast opens only the newest cases, running first, with answers and scores", async () => {
    const now = Date.now();
    const cases = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      kind: i === 2 ? "research" : "prediction",
      question: `question ${i}`,
      updatedAt: now - i * 60_000,
    }));
    const snapshots: Record<string, unknown> = {
      c0: {
        attempt: {
          state: "completed",
          result: { estimate: { type: "binary", probability: 0.63 } },
        },
      },
      c1: { attempt: { state: "running" } },
      c2: { attempt: { state: "failed" } },
      c3: {
        attempt: { state: "completed", result: { estimate: { type: "binary", probability: 0.2 } } },
        resolution: { at: 1, value: false, loss: 0.04 },
      },
      c4: { attempt: { state: "queued" } },
    };
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/api/investigations") return json({ cases });
      const id = path.split("/").pop()!;
      return snapshots[id] ? json(snapshots[id]) : json({}, 404);
    };
    const status = new WorldStatus("http://x", () => "t", "Rowan", fetcher);
    status.want(["forecasts"]);
    await status.refresh(true, ["forecasts"]);
    // One list and the five newest cases, never the rest.
    expect(calls.filter((c) => c.startsWith("/api/investigations/"))).toHaveLength(5);
    const theme = createTheme(termCaps({ isTTY: true, columns: 100 }, { NO_COLOR: "1" }));
    const out = findPanel("forecasts")!
      .render({ theme, name: "Rowan", connected: true, snapshot: status.snapshot, queued: 0 })
      .join("\n");
    expect(out.indexOf("question 1")).toBeLessThan(out.indexOf("question 0"));
    expect(out.indexOf("question 4")).toBeLessThan(out.indexOf("question 0"));
    expect(out).toContain("63% chance");
    expect(out).toContain("resolved · loss 0.040");
    expect(out).toContain("7 · 2 running");
    expect(out).not.toContain("question 6");
  });
  test("admin shows the setup without key values, and errors before warnings", async () => {
    const now = Date.now();
    const routes = (keys: () => Response) => async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/security-status")
        return json({
          authRequired: false,
          openApi: false,
          keyEncryption: false,
          unreadableKeys: 2,
        });
      if (u.pathname === "/api/default-model")
        return json({ model: "openrouter/anthropic/claude-sonnet-5.5", configured: null });
      if (u.pathname === "/api/keys") return keys();
      if (u.pathname === "/api/roles") return json([{ name: "coder" }, { name: "judge" }]);
      if (u.pathname === "/api/logs") {
        const level = u.searchParams.get("level");
        return json({
          logs:
            level === "error"
              ? [
                  {
                    level: "error",
                    category: "db",
                    message: "disk  full",
                    timestamp: now - 600_000,
                  },
                ]
              : [
                  {
                    level: "warn",
                    category: "agents",
                    message: "slow turn",
                    timestamp: now - 1_000,
                  },
                ],
        });
      }
      return json({}, 404);
    };
    const status = new WorldStatus(
      "http://x",
      () => "t",
      "Rowan",
      routes(() =>
        json([
          {
            name: "openrouter",
            provider: "openrouter",
            masked: "sk-…abcd",
            setBy: "Jo",
            updatedAt: now - 3_600_000,
          },
        ]),
      ),
    );
    // On demand: nothing is read until the mode wants it.
    await status.refresh(true);
    expect(status.snapshot.setup).toBeUndefined();
    status.want(["setup", "logs"]);
    await status.refresh(true);
    const theme = createTheme(termCaps({ isTTY: true, columns: 100 }, { NO_COLOR: "1" }));
    const context = { theme, name: "Rowan", connected: true, snapshot: status.snapshot, queued: 0 };
    const setup = findPanel("setup")!.render(context).join("\n");
    expect(setup).toContain("not required");
    expect(setup).toContain("plaintext");
    expect(setup).toContain("2 stored key(s) do not decrypt");
    expect(setup).toContain("claude-sonnet-5.5");
    expect(setup).toContain("from the environment");
    expect(setup).toContain("set by Jo");
    expect(setup).not.toContain("abcd");
    expect(findPanel("admin")).toBe(findPanel("setup"));
    const logs = findPanel("logs")!.render(context).join("\n");
    // The older error still comes first; whitespace runs collapse to one line.
    expect(logs.indexOf("disk full")).toBeLessThan(logs.indexOf("slow turn"));
    expect(logs).toContain("1 error · 1 warning");

    const resident = new WorldStatus(
      "http://x",
      () => "t",
      "Rowan",
      routes(() => json({}, 403)),
    );
    resident.want(["setup"]);
    await resident.refresh(true, ["setup"]);
    expect(
      findPanel("setup")!
        .render({ ...context, snapshot: resident.snapshot })
        .join("\n"),
    ).toContain("operators only");
  });
});
