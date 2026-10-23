// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { WorkspaceRuntime } from "../src/coding/local-workspace";
import {
  describeCapabilities,
  SandboxExecutionTimeoutError,
  type SandboxProvider,
  SandboxProviders,
} from "../src/coding/sandbox-provider";
import { WorkspaceGateway } from "../src/coding/workspace-gateway";
import { resolveSandboxProvider } from "../src/engine/commands/code/shared";
import { entityId } from "../src/types";
import { FAKE_SANDBOX_IDENTITY } from "./helpers";

function backend(output: string): SandboxProvider {
  return {
    ...FAKE_SANDBOX_IDENTITY,
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
      throw new SandboxExecutionTimeoutError(25);
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

  test("dispatches by provider id and never falls back for an unknown one", async () => {
    let localRuns = 0;
    const local = {
      async run() {
        localRuns++;
        throw new Error("local must not run");
      },
    } as unknown as WorkspaceRuntime;
    const other: SandboxProvider = {
      ...backend("from other\n__MARINA_EXIT_7f31c9__=0\n"),
      id: "openshell",
      label: "OpenShell",
    };
    const gateway = new WorkspaceGateway(
      local,
      new SandboxProviders([backend("from flywheel\n__MARINA_EXIT_7f31c9__=0\n"), other]),
    );

    expect((await gateway.run(entityId("alice"), "openshell", ["true"])).result.output).toBe(
      "from other",
    );
    expect((await gateway.run(entityId("alice"), "flywheel", ["true"])).result.output).toBe(
      "from flywheel",
    );
    await expect(gateway.run(entityId("alice"), "e2b", ["true"])).rejects.toThrow(
      'Sandbox provider "e2b" execution is unavailable; the command was not run locally',
    );
    expect(localRuns).toBe(0);
  });
});

describe("SandboxProviders", () => {
  test("refuses the reserved and malformed ids and duplicates", () => {
    const providers = new SandboxProviders([backend("")]);
    expect(() => providers.register({ ...backend(""), id: "local" })).toThrow("Invalid");
    expect(() => providers.register({ ...backend(""), id: "Not Valid" })).toThrow("Invalid");
    expect(() => providers.register(backend(""))).toThrow("already registered");
    expect(providers.only()?.id).toBe("flywheel");
    providers.register({ ...backend(""), id: "openshell", label: "OpenShell" });
    expect(providers.only()).toBeUndefined();
    expect(providers.list().map((p) => p.id)).toEqual(["flywheel", "openshell"]);
  });

  test("resolves the named provider, then the session's, then the only one", () => {
    const one = { sandboxes: new SandboxProviders([backend("")]) };
    expect(resolveSandboxProvider({})).toBe("No sandbox provider is configured.");
    expect((resolveSandboxProvider(one) as SandboxProvider).id).toBe("flywheel");
    expect(resolveSandboxProvider(one, { requested: "openshell" })).toContain(
      'Sandbox provider "openshell" is not configured (configured: flywheel)',
    );
    const two = {
      sandboxes: new SandboxProviders([
        backend(""),
        { ...backend(""), id: "openshell", label: "OpenShell" },
      ]),
    };
    expect(resolveSandboxProvider(two, { target: "local" })).toContain(
      "name one with provider:<id>",
    );
    expect((resolveSandboxProvider(two, { target: "openshell" }) as SandboxProvider).id).toBe(
      "openshell",
    );
    expect(
      (
        resolveSandboxProvider(two, {
          requested: "flywheel",
          target: "openshell",
        }) as SandboxProvider
      ).id,
    ).toBe("flywheel");
  });

  test("describes capabilities without claiming what a provider lacks", () => {
    expect(describeCapabilities(FAKE_SANDBOX_IDENTITY.capabilities)).toBe(
      "exec, files, publish, hibernate, no network policy, no credential injection, mounts: volume",
    );
  });
});
