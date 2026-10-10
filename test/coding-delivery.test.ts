// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerWorkspace, resolveContainerRunner } from "../src/coding/container-workspace";
import {
  captureDelivery,
  parseDeliveryManifest,
  prepareDeliveryMount,
} from "../src/coding/delivery";
import { LocalWorkspace } from "../src/coding/local-workspace";
import {
  assessCodingVerification,
  beginCodingRun,
  codingRunMetadata,
} from "../src/coding/task-run";
import { VerificationRunner } from "../src/coding/verification-runner";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import type { CodingArtifactRow } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

let f: ReturnType<typeof createTestEngine>;
let root: string;
let owner: ReturnType<typeof f.login>;
let run: CodingArtifactRow;
let state: DisposableStack;
const files = ["report.ts", "report.test.ts"];
function manifest(paths = files) {
  writeFileSync(
    join(root, "delivery.json"),
    JSON.stringify({ files: paths, checks: ["bun test report.test.ts"] }),
  );
}
const current = () => f.db.getCodingArtifact(run.id)!;
const send = (command: string) =>
  f.engine.dispatchCommand(owner.entityId, command, {
    codingTarget: { sessionId: "delivery", runId: run.id },
  });
const checks = () => f.db.listCodingRunArtifacts(run.id, ["verification"]);
async function verify() {
  await send("code verify delivery manifest:delivery.json");
  await f.engine.drainCommands();
}

beforeEach(() => {
  state = scopeProcessState({
    trustProfile: "shared",
    rateLimitBypass: true,
    env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
  });
  root = mkdtempSync(join(tmpdir(), "marina-delivery-check-"));
  writeFileSync(join(root, "helper.ts"), "export const amount = 11;");
  writeFileSync(join(root, "report.ts"), 'export { amount } from "./helper";');
  writeFileSync(
    join(root, "report.test.ts"),
    'import {expect,test} from "bun:test"; import {amount} from "./report"; test("delivered report",()=>expect(amount).toBe(11));',
  );
  manifest();
  f = createTestEngine();
  owner = f.login("Owner");
  const actor = f.engine.entities.get(owner.entityId)!;
  grant(f.db, owner.entityId, "code.exec");
  f.db.createCodingSession({
    id: "delivery",
    title: "Delivery",
    workspaceRoot: root,
    createdBy: actor.name,
  });
  f.db.updateCodingSession("delivery", { agent: actor.name, writer: actor.name });
  f.engine.commands.registerBuiltin(
    codeCommand({
      db: f.db,
      workspaceRegistry: new WorkspaceRegistry({ roots: [root] }),
      verificationRunner: new VerificationRunner(f.db, (pending) =>
        f.engine.trackBackgroundCommand(pending),
      ),
      getEntity: (id) => f.engine.entities.get(id as EntityId),
      getConnectionProtocol: () => "websocket",
    }),
  );
  run = beginCodingRun(f.db, {
    session: f.db.getCodingSession("delivery")!,
    owner: actor,
    worker: actor,
    prompt: "Deliver a usable report package",
    profile: "marina",
    verificationRequirement: "delivery",
  });
});
afterEach(async () => {
  await f.dispose();
  rmSync(root, { recursive: true, force: true });
  state.dispose();
});

it("catches a missing companion file despite passing live checks, then validates the repaired delivery", async () => {
  await send("code recipe save default bun test report.test.ts");
  await send("code verify");
  expect(checks()[0]?.status).toBe("complete");
  await send("code summary Live tests passed");
  expect(current().status).toBe("active");
  await verify();
  expect(checks()[0]?.status, owner.connection.allTextJoined()).toBe("failed");
  await send("code summary Package checked");
  expect(current().status).toBe("active");
  manifest([...files, "helper.ts"]);
  await verify();
  expect(checks()[0]?.status, owner.connection.allTextJoined()).toBe("complete");
  const evidence = JSON.parse(checks()[0]!.metadata_json);
  expect(evidence.delivery.files.map((file: { path: string }) => file.path)).toEqual([
    ...files,
    "helper.ts",
  ]);
  expect(evidence.executionLocation).toBe("delivery-materialization");
  expect(evidence.delivery.checkedFingerprint).toBe(evidence.delivery.fingerprint);
  await send("code summary Delivery checked");
  expect(current().status, owner.connection.allTextJoined()).toBe("submitted");
  expect(codingRunMetadata(current()).verification).toBe("passed");
  expect(checks().map((row) => row.status)).toEqual(["complete", "failed", "complete"]);
});

it("rechecks output bytes and the manifest at submission even without a Marina write event", async () => {
  manifest([...files, "helper.ts"]);
  await verify();
  writeFileSync(join(root, "helper.ts"), "export const amount = 12;");
  await send("code summary Ready");
  expect(current().status).toBe("active");
  expect(codingRunMetadata(current()).verification).toBe("stale");
  expect(checks()[0]!.status).toBe("complete");
  writeFileSync(join(root, "helper.ts"), "export const amount = 11;");
  manifest();
  expect((await assessCodingVerification(f.db, current())).verification).toBe("stale");
});

it("keeps older verification available after hundreds of later observations", async () => {
  manifest([...files, "helper.ts"]);
  await verify();
  for (let i = 0; i < 505; i++)
    f.db.createCodingArtifact({
      sessionId: "delivery",
      kind: "observation",
      title: "progress",
      contentText: String(i),
      createdBy: "Owner",
      metadata: { runId: run.id },
    });
  await send("code summary Done");
  expect(current().status).toBe("submitted");
});

it("reports a recovered interrupted check as unknown execution, without replaying it", async () => {
  const receipt = f.db.createCodingArtifact({
    sessionId: "delivery",
    kind: "verification_request",
    title: "Interrupted check",
    status: "running",
    contentText: "bun test",
    createdBy: "Owner",
    metadata: { runId: run.id },
  });
  f.db.recoverCodingVerifications();
  const assessed = await assessCodingVerification(f.db, current());
  expect(assessed.verification).toBe("error");
  expect(assessed.verificationReason).toContain("outcome unknown");
  expect(f.db.getCodingArtifact(receipt.id)?.status).toBe("interrupted");
  expect(checks()).toHaveLength(0);
});

it("refuses traversal, symlinks, missing files and empty checks instead of widening the delivery", async () => {
  expect(() => parseDeliveryManifest({ files: ["../outside"], checks: ["bun test"] })).toThrow(
    "relative",
  );
  expect(() => parseDeliveryManifest({ files: ["report.ts"], checks: [] })).toThrow(
    "check commands",
  );
  symlinkSync(join(root, "helper.ts"), join(root, "linked.ts"));
  manifest(["linked.ts"]);
  await expect(
    captureDelivery(new LocalWorkspace(root), "delivery.json", () => {}),
  ).rejects.toThrow();
  manifest(["missing.ts"]);
  await verify();
  const receipt = f.db.listCodingRunArtifacts(run.id, ["verification_request"])[0]!;
  expect(receipt.status).toBe("error");
  expect(checks()).toHaveLength(0);
});

it.skipIf(!process.env.MARINA_TEST_CONTAINER_IMAGE || !Bun.which("podman"))(
  "runs selected delivery files in the configured real container without the hidden workspace helper",
  async () => {
    writeFileSync(
      join(root, "runtests.py"),
      'import pathlib,os\nassert os.geteuid()!=0\nassert pathlib.Path("result.json").read_text()=="{\\"total\\":11}"\nassert not pathlib.Path("helper.ts").exists()\nprint("isolated delivery checked")\n',
    );
    writeFileSync(join(root, "result.json"), '{"total":11}');
    writeFileSync(
      join(root, "delivery.json"),
      JSON.stringify({ files: ["result.json", "runtests.py"], checks: ["python runtests.py"] }),
    );
    const snapshot = await captureDelivery(new LocalWorkspace(root), "delivery.json", () => {});
    try {
      await prepareDeliveryMount(snapshot.directory, () => {});
      const workspace = new ContainerWorkspace(
        snapshot.directory,
        resolveContainerRunner({
          image: process.env.MARINA_TEST_CONTAINER_IMAGE!,
          runtime: "podman",
          sync: "mount",
          network: false,
        }),
      );
      const result = await workspace.runAllowlisted(["python", "runtests.py"], () => {});
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("isolated delivery checked");
    } finally {
      await snapshot.dispose();
    }
  },
  120_000,
);
