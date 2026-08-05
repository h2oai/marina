import { describe, expect, test } from "bun:test";
import { FlywheelClient, FlywheelError } from "../src/integrations/flywheel";

function frame(flags: number, value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const result = new Uint8Array(payload.length + 5);
  result[0] = flags;
  new DataView(result.buffer).setUint32(1, payload.length);
  result.set(payload, 5);
  return result;
}

describe("FlywheelClient", () => {
  test("sends authenticated unary lifecycle calls", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({ sandboxId: "sb-1", keepAlive: true });
    };
    const client = new FlywheelClient({ baseUrl: "http://flywheel/rpc/", token: "cap", fetch });

    await client.createSandbox({ sessionId: "s-1", image: "marina:latest", keepAlive: true });

    expect(calls[0]?.url).toBe("http://flywheel/rpc/flywheel.v1.APIService/CreateSandbox");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer cap");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId: "s-1",
      image: "marina:latest",
      keepAlive: true,
    });
  });

  test("decodes Connect streaming frames split across chunks", async () => {
    const parts = [
      frame(0, { process: { data: "hello" } }),
      frame(0, { process: { data: " world" } }),
      frame(2, {}),
    ];
    const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.length;
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(all.slice(0, 7));
        controller.enqueue(all.slice(7));
        controller.close();
      },
    });
    const client = new FlywheelClient({
      baseUrl: "http://flywheel/rpc",
      token: "cap",
      fetch: async () => new Response(stream, { status: 200 }),
    });

    const events = [];
    for await (const event of client.exec({ sessionId: "s", sandboxId: "sb", command: "echo" })) {
      events.push(event);
    }
    expect(events).toEqual([{ process: { data: "hello" } }, { process: { data: " world" } }]);
  });

  test("surfaces Connect errors", async () => {
    const client = new FlywheelClient({
      baseUrl: "http://flywheel/rpc",
      token: "bad",
      fetch: async () =>
        Response.json({ code: "permission_denied", message: "denied" }, { status: 403 }),
    });
    expect(client.createSession()).rejects.toEqual(
      new FlywheelError("denied", 403, "permission_denied"),
    );
  });
});
