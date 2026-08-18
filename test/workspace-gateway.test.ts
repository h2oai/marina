// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { WorkspaceRuntime } from "../src/coding/local-workspace";
import { WorkspaceGateway } from "../src/coding/workspace-gateway";
import {
  FlywheelExecutionTimeoutError,
  type FlywheelToolBackend,
} from "../src/integrations/flywheel-manager";
import { entityId } from "../src/types";

function backend(output: string): FlywheelToolBackend {
  return {
    async create() {
      throw new Error("not used");
    },
    async exec() {
      throw new Error("not used");
    },
    async execDetailed() {
      return { output, events: [{ process: { kind: "stop" } }] };
    },
    async publish() {
      throw new Error("not used");
    },
    async hibernate() {},
    async resume() {},
    async stop() {},
    status() {
      return {
        sessionId: "session-1",
        sandboxId: "sandbox-1",
        image: "code:latest",
        keepAlive: true,
        state: "running",
      };
    },
  };
}

describe("WorkspaceGateway", () => {
  test("normalizes a non-zero Flywheel exit without changing providers", async () => {
    let localRuns = 0;
    const local = {
      async run() {
        localRuns++;
        throw new Error("local must not run");
      },
    } as unknown as WorkspaceRuntime;
    const gateway = new WorkspaceGateway(
      local,
      backend("failed check\n__MARINA_EXIT_7f31c9__=7\n"),
    );

    const evidence = await gateway.run(entityId("alice"), "flywheel", ["bun", "test"]);
    expect(evidence.result).toMatchObject({
      command: ["bun", "test"],
      exitCode: 7,
      output: "failed check",
      timedOut: false,
    });
    expect(localRuns).toBe(0);
  });

  test("fails unknown Flywheel outcomes closed without local retry", async () => {
    let localRuns = 0;
    const local = {
      async run() {
        localRuns++;
        throw new Error("local must not run");
      },
    } as unknown as WorkspaceRuntime;
    const gateway = new WorkspaceGateway(local, backend("stream ended unexpectedly"));

    await expect(gateway.run(entityId("alice"), "flywheel", ["bun", "test"])).rejects.toThrow(
      "outcome is unknown and was not retried locally",
    );
    expect(localRuns).toBe(0);
  });

  test("records a remote cancellation timeout without local retry", async () => {
    let localRuns = 0;
    const local = {
      async run() {
        localRuns++;
        throw new Error("local must not run");
      },
    } as unknown as WorkspaceRuntime;
    const flywheel = backend("");
    flywheel.execDetailed = async () => {
      throw new FlywheelExecutionTimeoutError(25);
    };
    const gateway = new WorkspaceGateway(local, flywheel);

    const evidence = await gateway.run(entityId("alice"), "flywheel", ["sleep", "60"], 25);
    expect(evidence.result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(evidence.result.output).toContain("remote cancellation was requested");
    expect(localRuns).toBe(0);
  });

  test("redacts remote secret output and refuses credential command arguments", async () => {
    const local = {} as WorkspaceRuntime;
    const gateway = new WorkspaceGateway(
      local,
      backend("OPENAI_API_KEY=sk-secret\n__MARINA_EXIT_7f31c9__=0\n"),
    );
    const evidence = await gateway.run(entityId("alice"), "flywheel", ["printenv"]);
    expect(evidence.result.output).toBe("OPENAI_API_KEY=[redacted]");
    await expect(
      gateway.run(entityId("alice"), "flywheel", ["env", "OPENAI_API_KEY=sk-secret"]),
    ).rejects.toThrow("credential profile");
  });
});
