import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { AcpServer } from "../src/net/acp-server";
import type { MarinaAgent } from "../src/sdk/client";
import type { Perception } from "../src/types";

interface StubAgentOptions {
  responses?: Record<string, Perception[]>;
  throwOn?: string;
  delayMs?: number;
}

function makeStubAgent(opts: StubAgentOptions = {}): MarinaAgent {
  const stub: Partial<MarinaAgent> = {
    async command(cmd: string): Promise<Perception[]> {
      if (opts.throwOn && cmd.includes(opts.throwOn)) throw new Error("simulated failure");
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      return (
        opts.responses?.[cmd] ?? [
          {
            kind: "system",
            timestamp: Date.now(),
            data: { message: `echo: ${cmd}` },
          } as Perception,
        ]
      );
    },
  };
  return stub as MarinaAgent;
}

/** Collect all ndjson messages written to stdout. */
async function collectOutput(
  out: PassThrough,
  count: number,
  timeoutMs = 1000,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          try {
            messages.push(JSON.parse(line));
          } catch (err) {
            out.off("data", onData);
            reject(new Error(`bad json: ${line} (${(err as Error).message})`));
            return;
          }
          if (messages.length >= count) {
            out.off("data", onData);
            resolve(messages);
            return;
          }
        }
        idx = buffer.indexOf("\n");
      }
      if (Date.now() > deadline) {
        out.off("data", onData);
        reject(new Error(`timeout waiting for ${count} messages (got ${messages.length})`));
      }
    };
    out.on("data", onData);
    setTimeout(() => {
      out.off("data", onData);
      reject(new Error(`timeout waiting for ${count} messages (got ${messages.length})`));
    }, timeoutMs);
  });
}

function writeRpc(stdin: PassThrough, msg: unknown): void {
  stdin.write(`${JSON.stringify(msg)}\n`);
}

describe("ACP server", () => {
  it("responds to initialize with protocol version 1 and advertises capabilities", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AcpServer({ agent: makeStubAgent(), input: stdin, output: stdout });
    server.start();

    writeRpc(stdin, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 1 },
    });

    const results = (await collectOutput(stdout, 1)) as Array<{
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: number;
        agentInfo: { name: string };
        agentCapabilities: { promptCapabilities: { embeddedContext: boolean } };
        authMethods: unknown[];
      };
    }>;
    const resp = results[0]!;
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(0);
    expect(resp.result.protocolVersion).toBe(1);
    expect(resp.result.agentInfo.name).toBe("marina");
    expect(resp.result.agentCapabilities.promptCapabilities.embeddedContext).toBe(true);
    expect(resp.result.authMethods).toEqual([]);

    server.stop();
  });

  it("creates a session via session/new", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AcpServer({ agent: makeStubAgent(), input: stdin, output: stdout });
    server.start();

    writeRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/test" },
    });
    const results = (await collectOutput(stdout, 1)) as Array<{
      id: number;
      result: { sessionId: string };
    }>;
    const resp = results[0]!;
    expect(resp.id).toBe(1);
    expect(resp.result.sessionId).toMatch(/^sess_/);

    server.stop();
  });

  it("session/prompt streams output via session/update and resolves with end_turn", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AcpServer({
      agent: makeStubAgent({
        responses: {
          "hello world": [
            { kind: "system", timestamp: Date.now(), data: { message: "first" } } as Perception,
            { kind: "system", timestamp: Date.now(), data: { message: "second" } } as Perception,
          ],
        },
      }),
      input: stdin,
      output: stdout,
    });
    server.start();

    // Create session
    writeRpc(stdin, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } });
    const newResults = (await collectOutput(stdout, 1)) as Array<{
      result: { sessionId: string };
    }>;
    const sessionId = newResults[0]!.result.sessionId;

    // Send prompt
    writeRpc(stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "hello world" }] },
    });

    // Expect 2 notifications + 1 final response
    const msgs = await collectOutput(stdout, 3);

    const notifs = msgs.filter(
      (m): m is { method: string; params: { update: { sessionUpdate: string } } } =>
        typeof m === "object" &&
        m !== null &&
        (m as { method?: string }).method === "session/update",
    );
    const final = msgs.find(
      (m): m is { id: number; result: { stopReason: string } } =>
        typeof m === "object" && m !== null && (m as { id?: number }).id === 2,
    );

    expect(notifs).toHaveLength(2);
    for (const n of notifs) {
      expect(n.params.update.sessionUpdate).toBe("agent_message_chunk");
    }
    expect(final?.result.stopReason).toBe("end_turn");

    server.stop();
  });

  it("returns -32601 for unsupported methods", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AcpServer({ agent: makeStubAgent(), input: stdin, output: stdout });
    server.start();

    writeRpc(stdin, { jsonrpc: "2.0", id: 42, method: "session/load", params: {} });
    const results = (await collectOutput(stdout, 1)) as Array<{
      id: number;
      error: { code: number; message: string };
    }>;
    const resp = results[0]!;
    expect(resp.id).toBe(42);
    expect(resp.error.code).toBe(-32601);
    expect(resp.error.message).toContain("Method not found");

    server.stop();
  });

  it("returns -32700 for parse errors", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AcpServer({ agent: makeStubAgent(), input: stdin, output: stdout });
    server.start();

    stdin.write("not json\n");
    const results = (await collectOutput(stdout, 1)) as Array<{
      id: number | null;
      error: { code: number };
    }>;
    const resp = results[0]!;
    expect(resp.id).toBeNull();
    expect(resp.error.code).toBe(-32700);

    server.stop();
  });

  it("session/cancel marks in-flight prompt as cancelled", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AcpServer({
      agent: makeStubAgent({ delayMs: 50 }),
      input: stdin,
      output: stdout,
    });
    server.start();

    // Buffer every message the server emits throughout the test.
    const allMessages: unknown[] = [];
    let bufferStr = "";
    stdout.on("data", (chunk: Buffer) => {
      bufferStr += chunk.toString("utf8");
      let idx = bufferStr.indexOf("\n");
      while (idx !== -1) {
        const line = bufferStr.slice(0, idx).trim();
        bufferStr = bufferStr.slice(idx + 1);
        if (line) allMessages.push(JSON.parse(line));
        idx = bufferStr.indexOf("\n");
      }
    });

    writeRpc(stdin, { jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    // Wait for session/new response
    await new Promise<void>((resolve) => {
      const check = () => {
        if (allMessages.some((m) => (m as { id?: number }).id === 1)) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    const newResp = allMessages.find((m) => (m as { id?: number }).id === 1) as {
      result: { sessionId: string };
    };
    const sessionId = newResp.result.sessionId;

    writeRpc(stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "slow" }] },
    });

    // Cancel before the stub agent returns
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeRpc(stdin, {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    });

    // Wait for the id:2 response
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const check = () => {
        if (allMessages.some((m) => (m as { id?: number }).id === 2)) resolve();
        else if (Date.now() > deadline) reject(new Error("timeout"));
        else setTimeout(check, 5);
      };
      check();
    });
    const final = allMessages.find((m) => (m as { id?: number }).id === 2) as {
      result: { stopReason: string };
    };
    expect(final.result.stopReason).toBe("cancelled");

    server.stop();
  });

  it("session/prompt returns end_turn immediately for empty prompt", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AcpServer({ agent: makeStubAgent(), input: stdin, output: stdout });
    server.start();

    writeRpc(stdin, { jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    const newResults = (await collectOutput(stdout, 1)) as Array<{
      result: { sessionId: string };
    }>;

    writeRpc(stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: newResults[0]!.result.sessionId, prompt: [] },
    });
    const results = (await collectOutput(stdout, 1)) as Array<{
      id: number;
      result: { stopReason: string };
    }>;
    const resp = results[0]!;
    expect(resp.id).toBe(2);
    expect(resp.result.stopReason).toBe("end_turn");

    server.stop();
  });

  it("session/prompt with unknown sessionId returns -32602", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AcpServer({ agent: makeStubAgent(), input: stdin, output: stdout });
    server.start();

    writeRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "sess_nope", prompt: [{ type: "text", text: "hi" }] },
    });
    const results = (await collectOutput(stdout, 1)) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(results[0]!.error.code).toBe(-32602);

    server.stop();
  });
});
