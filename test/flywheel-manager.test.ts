import { describe, expect, test } from "bun:test";
import {
  FlywheelExecutionTimeoutError,
  FlywheelManager,
} from "../src/integrations/flywheel-manager";
import { MarinaDB } from "../src/persistence/database";
import { entityId } from "../src/types";
import { cleanupDb } from "./helpers";

describe("FlywheelManager", () => {
  test("requires authoritative terminal evidence and records digest/byte count for binary reads", async () => {
    const payload = Uint8Array.from([0, 1, 2, 255]);
    let includeTerminal = true;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const method = String(input).split("/").at(-1);
      if (method === "CreateSession") return Response.json({ sessionId: "session-transfer" });
      if (method === "MintCapability") {
        return Response.json({
          token: "capability",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (method === "CreateSandbox") {
        return Response.json({ sandboxId: "sandbox-transfer", keepAlive: true });
      }
      if (method === "Exec") {
        const frames = [
          connectFrame(0, {
            process: {
              data: Buffer.from(payload).toString("base64"),
              kind: "PROCESS_EVENT_KIND_STDOUT",
              running: true,
            },
          }),
          ...(includeTerminal
            ? [
                connectFrame(0, {
                  process: { kind: "PROCESS_EVENT_KIND_STOP", running: false },
                }),
              ]
            : []),
          connectFrame(2, {}),
        ];
        return new Response(joinBytes(frames) as unknown as BodyInit, { status: 200 });
      }
      return Response.json({});
    };
    const manager = new FlywheelManager("http://flywheel/rpc", "operator", "code:latest", fetch);
    const alice = entityId("transfer-owner");
    await manager.create(alice);
    await expect(manager.readFile(alice, "/workspace/file.bin")).resolves.toMatchObject({
      byteLength: payload.length,
      data: payload,
      sha256: new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
    });
    includeTerminal = false;
    await expect(manager.readFile(alice, "/workspace/file.bin")).rejects.toThrow(
      "without authoritative successful status",
    );
  });

  test("binds an attenuated sandbox lifecycle to one Marina identity", async () => {
    const calls: Array<{ method: string; authorization: string; body: Record<string, unknown> }> =
      [];
    let minted = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split("/").at(-1)!;
      calls.push({
        method,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: JSON.parse(String(init?.body)),
      });
      switch (method) {
        case "CreateSession":
          return Response.json({ sessionId: "session-1" });
        case "MintCapability":
          minted++;
          return Response.json({
            token: `agent-cap-${minted}`,
            expiresAt: new Date(0).toISOString(),
          });
        case "CreateSandbox":
          return Response.json({ sandboxId: "sandbox-1", keepAlive: true });
        case "Publish":
          return Response.json({ url: "https://app.example", subdomain: "app" });
        default:
          return Response.json({});
      }
    };
    const manager = new FlywheelManager("http://flywheel/rpc", "operator", "default:latest", fetch);
    const alice = entityId("alice");

    const created = await manager.create(alice);
    expect(created).toMatchObject({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      state: "running",
    });
    expect(calls[0]?.authorization).toBe("Bearer operator");
    expect(calls[1]?.body).toMatchObject({
      sessionId: "session-1",
      ttlSeconds: 600,
      scopes: expect.arrayContaining(["sandbox:exec", "sandbox:hibernate"]),
    });
    expect(calls[2]?.authorization).toBe("Bearer agent-cap-1");

    expect(await manager.publish(alice, 8080)).toBe("https://app.example");
    expect(await manager.publishDetailed(alice, 8081)).toEqual({
      url: "https://app.example",
      subdomain: "app",
    });
    await manager.unpublish(alice, "app");
    expect(calls.findLast((call) => call.method === "Unpublish")?.body).toEqual({
      sessionId: "session-1",
      subdomain: "app",
    });
    expect(calls.filter((call) => call.method === "MintCapability")).toHaveLength(4);
    expect(calls.findLast((call) => call.method === "Publish")?.authorization).toBe(
      "Bearer agent-cap-3",
    );
    await manager.hibernate(alice);
    expect(manager.status(alice)?.state).toBe("hibernated");
    await manager.resume(alice);
    expect(manager.status(alice)?.state).toBe("running");
    await manager.stop(alice);
    expect(manager.status(alice)).toBeUndefined();
  });

  test("does not allow one entity to use another entity's sandbox", async () => {
    const manager = new FlywheelManager(
      "http://flywheel/rpc",
      "operator",
      "default:latest",
      async () => Response.json({}),
    );
    expect(manager.publish(entityId("bob"), 8080)).rejects.toThrow("No Flywheel sandbox");
  });

  test("restores and reconciles a durable binding without storing credentials", async () => {
    const dbPath = `/tmp/marina-flywheel-${crypto.randomUUID()}.db`;
    const alice = entityId("alice");
    const db = new MarinaDB(dbPath);
    try {
      db.saveFlywheelBinding({
        entityId: alice,
        sessionId: "session-persisted",
        sandboxId: "sandbox-persisted",
        image: "code:latest",
        keepAlive: true,
        state: "running",
      });
      const fetch = async (input: string | URL | Request) => {
        const method = String(input).split("/").at(-1);
        if (method === "ListSandboxes") {
          return Response.json({
            sandboxes: [
              {
                id: "sandbox-persisted",
                sessionId: "session-persisted",
                image: "code:latest",
                status: "hibernated",
              },
            ],
          });
        }
        return Response.json({});
      };
      const manager = new FlywheelManager(
        "http://flywheel/rpc",
        "operator-secret",
        "default:latest",
        fetch,
        db,
      );

      expect(manager.status(alice)?.state).toBe("running");
      await manager.reconcile();
      expect(manager.status(alice)?.state).toBe("hibernated");
      expect(db.listFlywheelBindings()[0]).toMatchObject({
        entity_id: "alice",
        state: "hibernated",
      });
      expect(JSON.stringify(db.listFlywheelBindings())).not.toContain("operator-secret");
    } finally {
      db.close();
      cleanupDb(dbPath);
    }
  });

  test("marks unreachable workspaces unavailable and never falls back to host execution", async () => {
    const dbPath = `/tmp/marina-flywheel-${crypto.randomUUID()}.db`;
    const alice = entityId("alice");
    const db = new MarinaDB(dbPath);
    try {
      db.saveFlywheelBinding({
        entityId: alice,
        sessionId: "session-persisted",
        sandboxId: "sandbox-persisted",
        image: "code:latest",
        keepAlive: true,
        state: "running",
      });
      let requests = 0;
      const manager = new FlywheelManager(
        "http://flywheel/rpc",
        "operator",
        "default:latest",
        async () => {
          requests++;
          throw new Error("connection refused");
        },
        db,
      );

      await manager.reconcile();
      expect(manager.status(alice)).toMatchObject({
        state: "unavailable",
        lastError: "connection refused",
      });
      await expect(manager.exec(alice, "echo", ["unsafe-fallback"])).rejects.toThrow(
        "host execution was not attempted",
      );
      expect(requests).toBe(1);
    } finally {
      db.close();
      cleanupDb(dbPath);
    }
  });

  test("enforces standing-neutral admission and hibernates idle allocations recoverably", async () => {
    const dbPath = `/tmp/marina-flywheel-${crypto.randomUUID()}.db`;
    const db = new MarinaDB(dbPath);
    const alice = entityId("alice");
    try {
      db.saveFlywheelBinding({
        entityId: alice,
        sessionId: "session-idle",
        sandboxId: "sandbox-idle",
        image: "code:latest",
        keepAlive: true,
        state: "running",
        lifecycleExpiresAt: Date.now() + 60_000,
      });
      db.updateFlywheelBinding(alice, { lastActivityAt: Date.now() - 10_000 });
      const fetch = async (input: string | URL | Request) => {
        const method = String(input).split("/").at(-1);
        if (method === "MintCapability") {
          return Response.json({
            token: "agent-capability",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
        }
        return Response.json({});
      };
      const manager = new FlywheelManager(
        "http://flywheel/rpc",
        "operator",
        "default:latest",
        fetch,
        db,
        {
          maxSandboxes: 1,
          maxRunningSandboxes: 1,
          idleHibernateMs: 1_000,
          absoluteLifetimeMs: 60_000,
          telemetryRetentionMs: 60_000,
        },
      );

      await expect(manager.create(entityId("bob"))).rejects.toThrow("admission limit");
      expect(manager.inventory()).toEqual([
        expect.objectContaining({ entityId: alice, state: "running", activeServices: false }),
      ]);
      expect(await manager.reclaim(false)).toEqual([
        expect.objectContaining({ entityId: alice, action: "hibernate" }),
      ]);
      await manager.reclaim(true);
      expect(manager.status(alice)).toMatchObject({
        state: "hibernated",
        hibernatedReason: "idle lifecycle reached",
      });
      expect(manager.operationSummary()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "create", outcome: "blocked", count: 1 }),
          expect.objectContaining({ operation: "hibernate", outcome: "success", count: 1 }),
        ]),
      );
    } finally {
      db.close();
      cleanupDb(dbPath);
    }
  });

  test("aborts a timed-out Exec stream so Flywheel can stop the remote process", async () => {
    let aborted = false;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = String(input).split("/").at(-1);
      if (method === "CreateSession") return Response.json({ sessionId: "session-timeout" });
      if (method === "MintCapability") {
        return Response.json({
          token: "capability",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (method === "CreateSandbox") {
        return Response.json({ sandboxId: "sandbox-timeout", keepAlive: true });
      }
      if (method === "Exec") {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return Response.json({});
    };
    const manager = new FlywheelManager("http://flywheel/rpc", "operator", "code:latest", fetch);
    const alice = entityId("alice");
    await manager.create(alice);

    const error = await manager
      .execDetailed(alice, "sleep", ["60"], undefined, { timeoutMs: 5 })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(FlywheelExecutionTimeoutError);
    expect(error.timeoutMs).toBe(5);
    expect(aborted).toBe(true);
  });
});

function connectFrame(flags: number, value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const result = new Uint8Array(payload.length + 5);
  result[0] = flags;
  new DataView(result.buffer).setUint32(1, payload.length);
  result.set(payload, 5);
  return result;
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
