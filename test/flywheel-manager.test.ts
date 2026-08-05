import { describe, expect, test } from "bun:test";
import { FlywheelManager } from "../src/integrations/flywheel-manager";
import { entityId } from "../src/types";

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
});
