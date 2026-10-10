// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginCodingRun, codingRunMetadata } from "../src/coding/task-run";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

it.each(["artifact", "service"] as const)(
  "requires actual %s validation and retains failed evidence before a successful submission",
  async (kind) => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      rateLimitBypass: true,
      env: {
        MARINA_AUTONOMY: "guarded",
        MARINA_CHALLENGES: "off",
        MARINA_CODE_VERIFY_DEPENDENCIES: "check",
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "marina-deliverable-"));
    const root = join(directory, "work");
    const inputs = join(directory, "input");
    const outputs = join(directory, "output");
    for (const path of [root, inputs, outputs]) mkdirSync(path);
    const f = createTestEngine();
    let enabled = false;
    // A local test service stands in for an operator-authorized external system.
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      server =
        kind === "service"
          ? Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                if (request.method === "POST") enabled = true;
                return Response.json({ enabled, revision: enabled ? 2 : 1 });
              },
            })
          : undefined;
      writeFileSync(
        join(inputs, "rows.json"),
        JSON.stringify([
          { id: "a", amount: 7 },
          { id: "b", amount: 4 },
        ]),
      );
      writeFileSync(join(outputs, "result.json"), JSON.stringify({ total: 0, ids: [] }));
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            test: "bun test",
            ...(kind === "service" ? { build: "bun activate.ts" } : {}),
          },
        }),
      );
      const checks =
        kind === "artifact"
          ? `const rows = await Bun.file(${JSON.stringify(join(inputs, "rows.json"))}).json(); const result = await Bun.file(${JSON.stringify(join(outputs, "result.json"))}).json(); expect(result.total).toBe(rows.reduce((sum, row) => sum + row.amount, 0)); expect(result.ids).toEqual(rows.map(row => row.id));`
          : `const result = await (await fetch(${JSON.stringify(server!.url.toString())})).json(); expect(result.enabled).toBe(true); expect(result.revision).toBe(2);`;
      writeFileSync(
        join(root, "deliverable.test.ts"),
        `import { test, expect } from "bun:test"; test("requested deliverable invariants", async () => { ${checks} });`,
      );
      if (server)
        writeFileSync(
          join(root, "activate.ts"),
          `const response = await fetch(${JSON.stringify(server.url.toString())}, { method: "POST" }); if (!response.ok) process.exit(1);`,
        );
      const owner = f.login("Owner");
      const worker = f.login("Worker");
      const ownerEntity = f.engine.entities.get(owner.entityId)!;
      const workerEntity = f.engine.entities.get(worker.entityId)!;
      grant(f.db, owner.entityId, "code.exec");
      grant(f.db, worker.entityId, "code.exec");
      const registry = new WorkspaceRegistry({
        roots: [root],
        inputRoots: [inputs],
        outputRoots: [outputs],
      });
      f.engine.commands.registerBuiltin(
        codeCommand({
          db: f.db,
          workspaceRegistry: registry,
          getEntity: (id) => f.engine.entities.get(id as EntityId),
          getConnectionProtocol: () => "websocket",
        }),
      );
      f.db.createCodingSession({
        id: "s",
        title: kind,
        workspaceRoot: root,
        createdBy: ownerEntity.name,
      });
      f.db.updateCodingSession("s", { agent: workerEntity.name, writer: workerEntity.name });
      const run = beginCodingRun(f.db, {
        session: f.db.getCodingSession("s")!,
        owner: ownerEntity,
        worker: workerEntity,
        profile: "marina",
        prompt: `Validate the ${kind} deliverable`,
        verificationRequirement: "checks",
      });
      const send = (command: string) =>
        f.engine.dispatchCommand(worker.entityId, command, {
          codingTarget: { sessionId: "s", runId: run.id },
        });
      await send("code recipe save default test");
      await send("code verify");
      await send("code summary First check failed");
      expect(f.db.getCodingArtifact(run.id)!.status).toBe("active");
      expect(codingRunMetadata(f.db.getCodingArtifact(run.id)!).verification).toBe("failed");
      if (kind === "artifact") {
        await send(`code write ${join(outputs, "result.json")}\n{"total":11,"ids":["a","b"]}`);
      } else await send("code run build");
      await send("code verify");
      await send("code summary Deliverable validated by the recorded checks");
      const finished = f.db.getCodingArtifact(run.id)!;
      expect(finished.status, worker.connection.allTextJoined()).toBe("submitted");
      expect(codingRunMetadata(finished).verification).toBe("passed");
      const receipts = f.db
        .listCodingRunArtifacts(run.id)
        .filter((row) => row.kind === "verification");
      expect(receipts.map((row) => row.status)).toEqual(["complete", "failed"]);
      expect(f.db.getTask(codingRunMetadata(finished).taskId)!.status).toBe("claimed"); // Owner review remains separate.
    } finally {
      server?.stop(true);
      await f.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
