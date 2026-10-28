// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import { WorkspaceGateway } from "../src/coding/workspace-gateway";
import { ProtoMessage, ProtoWriter } from "../src/integrations/openshell/protobuf";
import {
  decodePolicyChunk,
  OpenShellProvider,
  phaseState,
  sandboxName,
} from "../src/integrations/openshell/provider";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";

describe("protobuf codec", () => {
  it("round-trips the field kinds the client uses, negative int32 included", () => {
    const bytes = new ProtoWriter()
      .string(1, "name")
      .uint(2, 7)
      .uint(3, -2)
      .bytesField(4, new Uint8Array([0, 255]))
      .repeatedString(5, ["a", "b"])
      .stringMap(6, { k: "v" })
      .message(7, new ProtoWriter().string(1, "inner"))
      .message(8, new ProtoWriter())
      .uint(9, 0)
      .bytes();
    const m = ProtoMessage.decode(bytes);
    expect(m.string(1)).toBe("name");
    expect(m.uint(2)).toBe(7);
    expect(m.int32(3)).toBe(-2);
    expect([...m.bytes(4)]).toEqual([0, 255]);
    expect(m.stringMap(6)).toEqual({ k: "v" });
    expect(m.message(7)?.string(1)).toBe("inner");
    expect(m.has(8)).toBe(true);
    expect(m.has(9)).toBe(false);
    expect(() => ProtoMessage.decode(new Uint8Array([0x0a, 0x05, 1]))).toThrow("Truncated");
  });
});

describe("OpenShell mapping", () => {
  it("names sandboxes within OpenShell's 19-character limit and maps phases", () => {
    expect(sandboxName("e_abc")).toMatch(/^marina-[0-9a-f]{12}$/);
    expect(sandboxName("e_abc")).toHaveLength(19);
    expect(sandboxName("e_abc")).toBe(sandboxName("e_abc"));
    expect([1, 2, 3, 6, 7, 8].map(phaseState)).toEqual([
      "creating",
      "running",
      "unavailable",
      "stopping",
      "hibernated",
      "creating",
    ]);
  });

  it("decodes a pending rule into what an approver sees", () => {
    const chunk = new ProtoWriter()
      .string(1, "chunk-1")
      .string(3, "allow_example_com_443")
      .message(
        4,
        new ProtoWriter()
          .message(2, new ProtoWriter().string(1, "example.com").uint(2, 443))
          .message(3, new ProtoWriter().string(1, "/usr/bin/curl")),
      )
      .string(5, "observed denial")
      .string(20, "review-token");
    expect(decodePolicyChunk(ProtoMessage.decode(chunk.bytes()))).toEqual({
      id: "chunk-1",
      reviewToken: "review-token",
      ruleName: "allow_example_com_443",
      binary: "/usr/bin/curl",
      endpoints: ["example.com:443"],
      rationale: "observed denial",
    });
  });

  it("requires the full mTLS bundle for a real gateway", () => {
    expect(OpenShellProvider.fromEnv({})).toBeUndefined();
    expect(() => OpenShellProvider.fromEnv({ MARINA_OPENSHELL_URL: "https://gw:17670" })).toThrow(
      "MARINA_OPENSHELL_CA",
    );
    expect(() => new OpenShellProvider({ url: "http://gw.example:17670" })).toThrow("https");
  });
});

/** A fake OpenShell gateway: gRPC over cleartext HTTP/2 on loopback. */
class FakeGateway {
  server!: Http2Server;
  port = 0;
  calls: { method: string; body: ProtoMessage }[] = [];
  phase = 2;
  exitCode = 4;
  timedOut = false;
  failCreate = "";
  drafts: ProtoWriter[] = [];
  approved: string[] = [];

  async start(): Promise<void> {
    this.server = createServer();
    this.server.on("stream", (raw, headers) => {
      const stream = raw as ServerHttp2Stream;
      const method = String(headers[":path"]).split("/").pop()!;
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const frame = Buffer.concat(chunks);
        const body = ProtoMessage.decode(new Uint8Array(frame.subarray(5)));
        this.calls.push({ method, body });
        this.reply(stream, method, body);
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", () => done()));
    this.port = (this.server.address() as { port: number }).port;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }

  private send(stream: ServerHttp2Stream, messages: ProtoWriter[], status = 0, message = "") {
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () =>
      stream.sendTrailers({ "grpc-status": String(status), "grpc-message": message }),
    );
    for (const m of messages) {
      const bytes = m.bytes();
      const frame = Buffer.alloc(5 + bytes.length);
      frame.writeUInt32BE(bytes.length, 1);
      frame.set(bytes, 5);
      stream.write(frame);
    }
    stream.end();
  }

  private sandbox(name: string): ProtoWriter {
    return new ProtoWriter().message(
      1,
      new ProtoWriter()
        .message(1, new ProtoWriter().string(1, `id-${name}`).string(2, name))
        .message(3, new ProtoWriter().uint(6, this.phase)),
    );
  }

  private reply(stream: ServerHttp2Stream, method: string, body: ProtoMessage) {
    switch (method) {
      case "CreateSandbox":
        if (this.failCreate) return this.send(stream, [], 3, this.failCreate);
        return this.send(stream, [this.sandbox(body.string(2))]);
      case "GetSandbox":
        return this.send(stream, [this.sandbox(body.string(1))]);
      case "ExecSandbox": {
        return this.send(stream, [
          new ProtoWriter().message(
            1,
            new ProtoWriter().bytesField(1, new TextEncoder().encode("out\n")),
          ),
          new ProtoWriter().message(
            2,
            new ProtoWriter().bytesField(
              1,
              new TextEncoder().encode(
                `err\n${this.timedOut ? "timeout: sending signal TERM to command sh\n" : ""}`,
              ),
            ),
          ),
          new ProtoWriter().message(3, new ProtoWriter().uint(1, this.exitCode)),
        ]);
      }
      case "GetDraftPolicy":
        return this.send(stream, [
          this.drafts.reduce((w, d) => w.message(1, d), new ProtoWriter()),
        ]);
      case "ApproveDraftChunk":
        this.approved.push(body.string(2));
        return this.send(stream, [new ProtoWriter().uint(1, 2)]);
      case "DeleteSandbox":
        return this.send(stream, [new ProtoWriter().uint(2, 1)]);
      default:
        return this.send(stream, [], 12, `unimplemented ${method}`);
    }
  }
}

describe("OpenShellProvider against a fake gateway", () => {
  let gateway: FakeGateway | undefined;
  afterEach(async () => {
    await gateway?.stop();
    gateway = undefined;
  });

  it("persists its own binding without overwriting a Flywheel allocation", async () => {
    gateway = new FakeGateway();
    await gateway.start();
    const db = new MarinaDB(":memory:");
    const entity = "e_owner" as EntityId;
    try {
      db.saveFlywheelBinding({
        entityId: entity,
        sessionId: "fw-session",
        sandboxId: "fw-sandbox",
        image: "fw",
        keepAlive: true,
        state: "running",
      });
      const provider = new OpenShellProvider({ url: `http://127.0.0.1:${gateway.port}`, db });
      const workspace = await provider.create(entity);
      expect(db.getFlywheelBinding(entity, "openshell")).toMatchObject({
        provider_id: "openshell",
        sandbox_id: workspace.sandboxId,
        state: "running",
      });
      expect(db.getFlywheelBinding(entity)?.sandbox_id).toBe("fw-sandbox");
      // The engine accepts commands before its asynchronous inventory refresh.
      // A fresh provider must address the existing guest without another create.
      const restarted = new OpenShellProvider({ url: `http://127.0.0.1:${gateway.port}`, db });
      expect(restarted.status(entity)?.sandboxId).toBe(workspace.sandboxId);
      expect((await restarted.execDetailed(entity, "true")).output).toBe("out\nerr\n");
      expect(gateway.calls.filter((call) => call.method === "CreateSandbox")).toHaveLength(1);
      await restarted.stop(entity);
      expect(db.getFlywheelBinding(entity, "openshell")).toBeUndefined();
      expect(db.getFlywheelBinding(entity)?.sandbox_id).toBe("fw-sandbox");
    } finally {
      db.close();
    }
  });

  it("creates a labelled sandbox, runs a command through the gateway, and deletes it", async () => {
    gateway = new FakeGateway();
    await gateway.start();
    const provider = new OpenShellProvider({
      url: `http://127.0.0.1:${gateway.port}`,
      image: "img",
    });
    const entity = "e_one" as EntityId;
    expect((await provider.create(entity)).state).toBe("running");
    const create = gateway.calls.find((c) => c.method === "CreateSandbox")!.body;
    expect(create.message(7)?.string(1)).toBe("default");
    expect(create.message(1)?.message(6)?.string(1)).toBe("img");
    expect(create.stringMap(3)).toEqual({ "marina.managed": "true", "marina.entity": "e_one" });

    const ran = await provider.execDetailed(entity, "sh", ["-c", "true"], "/sandbox", {
      timeoutMs: 5_000,
    });
    expect(ran.output).toBe("out\nerr\n");
    const exec = gateway.calls.find((c) => c.method === "ExecSandbox")!.body;
    expect(exec.string(1)).toBe(sandboxName("e_one"));
    expect(exec.string(3)).toBe("/sandbox");
    expect(exec.message(105)?.uint(1)).toBe(8);
    expect(exec.strings(2)).toEqual([
      "timeout",
      "--verbose",
      "--signal=TERM",
      "--kill-after=1s",
      "5s",
      "sh",
      "-c",
      "true",
    ]);
    expect(exec.uint(10)).toBe(1);
    await provider.stop(entity);
    expect(provider.status(entity)).toBeUndefined();
    expect(gateway.calls.at(-1)?.method).toBe("DeleteSandbox");
  });

  it("reports the guest process-group timeout as an execution timeout", async () => {
    gateway = new FakeGateway();
    gateway.exitCode = 124;
    gateway.timedOut = true;
    await gateway.start();
    const provider = new OpenShellProvider({ url: `http://127.0.0.1:${gateway.port}` });
    const entity = "e_timeout" as EntityId;
    await provider.create(entity);
    const started = Date.now();
    const failure = await provider
      .execDetailed(entity, "sleep", ["9"], "/sandbox", { timeoutMs: 1000 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("exceeded 1000ms");
    expect(Date.now() - started).toBeLessThan(1000);
    await provider.stop(entity);
  });

  it.each([124, 137])("preserves a completed command's exit status %i", async (exitCode) => {
    gateway = new FakeGateway();
    gateway.exitCode = exitCode;
    gateway.timedOut = false;
    await gateway.start();
    const provider = new OpenShellProvider({ url: `http://127.0.0.1:${gateway.port}` });
    const entity = "e_exit_status" as EntityId;
    await provider.create(entity);
    const result = await provider.execDetailed(entity, "sh", ["-c", `exit ${exitCode}`]);
    expect(result.output).toBe("out\nerr\n");
    expect(result.events).toEqual([{ process: { kind: "exit", exitCode } }]);
    await provider.stop(entity);
  });

  it("raises each pending network rule once, and approval approves it in OpenShell", async () => {
    gateway = new FakeGateway();
    await gateway.start();
    const raised: { summary: string; rerun: () => Promise<string> }[] = [];
    const provider = new OpenShellProvider({
      url: `http://127.0.0.1:${gateway.port}`,
      raise: (input) => {
        raised.push(input);
        return { message: "held" };
      },
    });
    const entity = "e_two" as EntityId;
    await provider.create(entity);
    gateway.drafts = [
      new ProtoWriter()
        .string(1, "c1")
        .string(16, "/usr/bin/python3")
        .message(
          4,
          new ProtoWriter().message(2, new ProtoWriter().string(1, "pypi.org").uint(2, 443)),
        )
        .string(20, "tok"),
    ];
    await provider.maintenance();
    await provider.maintenance();
    expect(raised.map((r) => r.summary)).toEqual([
      `allow /usr/bin/python3 → pypi.org:443 in OpenShell sandbox ${sandboxName("e_two")}`,
    ]);
    expect(await raised[0]!.rerun()).toContain("allows pypi.org:443");
    expect(gateway.approved).toEqual(["c1"]);
  });

  it("surfaces a gateway error status, records it, and never runs on the host", async () => {
    gateway = new FakeGateway();
    gateway.failCreate = "name exceeds maximum length";
    await gateway.start();
    const provider = new OpenShellProvider({ url: `http://127.0.0.1:${gateway.port}` });
    const entity = "e_three" as EntityId;
    await expect(provider.create(entity)).rejects.toThrow("name exceeds maximum length");
    expect(provider.status(entity)).toMatchObject({
      state: "unavailable",
      lastError: "name exceeds maximum length",
    });
    await expect(
      new WorkspaceGateway(undefined, provider).run(entity, "openshell", ["true"]),
    ).rejects.toThrow("the command was not run locally");
    // The failed attempt can be retried.
    gateway.failCreate = "";
    expect((await provider.create(entity)).state).toBe("running");
  });
});
