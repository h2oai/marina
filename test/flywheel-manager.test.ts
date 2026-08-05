import { describe, expect, test } from "bun:test";
import {
  FlywheelExecutionTimeoutError,
  FlywheelManager,
} from "../src/integrations/flywheel-manager";
import { MarinaDB } from "../src/persistence/database";
import { entityId } from "../src/types";
import { cleanupDb } from "./helpers";

describe("FlywheelManager", () => {
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
          return Response.json({ url: "https://app.example" });
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
    expect(calls.filter((call) => call.method === "MintCapability")).toHaveLength(2);
    expect(calls.findLast((call) => call.method === "Publish")?.authorization).toBe(
      "Bearer agent-cap-2",
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
