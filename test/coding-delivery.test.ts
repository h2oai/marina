// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerWorkspace, resolveContainerRunner } from "../src/coding/container-workspace";
import {
  captureDelivery,
  deliveryFingerprint,
  deliveryLimits,
  parseDeliveryManifest,
  prepareDeliveryMount,
  readDeliveryManifest,
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
function declaration(paths = files) {
  return {
    files: paths,
    checks: ["bun test report.test.ts"],
    requirements: [{ text: "the delivered report exports amount 11", checks: [0] }],
  };
}
function manifest(paths = files) {
  writeFileSync(join(root, "delivery.json"), JSON.stringify(declaration(paths)));
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

it("verifies inline declarations without workspace bookkeeping and retains them for review", async () => {
  rmSync(join(root, "delivery.json"));
  const before = readdirSync(root).sort();
  const source = readFileSync(join(root, "report.ts"), "utf8");
  const missing = JSON.stringify(declaration(), null, 2);
  await send(`code verify delivery dependencies:none -- ${missing}`);
  await f.engine.drainCommands();
  expect(checks()[0]?.status, owner.connection.allTextJoined()).toBe("failed");
  expect(JSON.parse(checks()[0]!.metadata_json).delivery.manifestContent).toBe(missing);
  const json = JSON.stringify(declaration([...files, "helper.ts"]), null, 2);
  await send(`code verify delivery dependencies:none -- ${json}`);
  await f.engine.drainCommands();
  const checked = checks()[0]!;
  expect(checked.status, owner.connection.allTextJoined()).toBe("complete");
  const evidence = JSON.parse(checked.metadata_json).delivery;
  expect(evidence.manifestPath).toBeUndefined();
  expect(evidence.manifestContent).toBe(json);
  expect(evidence.files.map((file: { path: string }) => file.path)).toEqual([
    ...files,
    "helper.ts",
  ]);
  expect(evidence.checkedFingerprint).toBe(evidence.fingerprint);
  expect((await assessCodingVerification(f.db, current())).verification).toBe("passed");
  await send(`code show ${checked.id}`);
  expect(owner.connection.allTextJoined()).toContain(`Delivery manifest (declared JSON):\n${json}`);
  const receipt = f.db.listCodingRunArtifacts(run.id, ["verification_request"])[0]!;
  owner.connection.clear();
  await send(`code show ${receipt.id}`);
  expect(owner.connection.allTextJoined()).toContain(`Delivery manifest (declared JSON):\n${json}`);
  expect(readdirSync(root).sort()).toEqual(before);
  expect(readFileSync(join(root, "report.ts"), "utf8")).toBe(source);
  writeFileSync(join(root, "helper.ts"), "export const amount = 12;");
  expect((await assessCodingVerification(f.db, current())).verification).toBe("stale");
  writeFileSync(join(root, "helper.ts"), "export const amount = 11;");
  await send("code summary Inline delivery checked");
  expect(current().status, owner.connection.allTextJoined()).toBe("submitted");
});

it("continues to assess legacy path evidence and explicitly delivered manifest files", async () => {
  manifest([...files, "helper.ts", "delivery.json"]);
  await verify();
  const checked = checks()[0]!;
  expect(checked.status, owner.connection.allTextJoined()).toBe("complete");
  const metadata = JSON.parse(checked.metadata_json);
  expect(metadata.delivery.files.map((file: { path: string }) => file.path)).toContain(
    "delivery.json",
  );
  delete metadata.delivery.manifestContent;
  f.db.updateCodingArtifact(checked.id, { metadata });
  expect((await assessCodingVerification(f.db, current())).verification).toBe("passed");
  manifest();
  expect((await assessCodingVerification(f.db, current())).verification).toBe("stale");
});

it("rejects ambiguous, missing, malformed and non-delivery inline declarations", async () => {
  for (const [command, reason] of [
    ["code verify delivery", "requires inline JSON"],
    [
      `code verify delivery manifest:delivery.json -- ${JSON.stringify(declaration())}`,
      "requires inline JSON",
    ],
    // Candidate takes a requirement list, never a file list.
    [`code verify candidate -- ${JSON.stringify(declaration())}`, "do not list files"],
    [`code verify -- ${JSON.stringify(declaration())}`, "requires inline JSON"],
    ["code verify delivery -- {invalid}", "JSON Parse error"],
    ['code verify delivery -- {"files":["../outside"],"checks":["bun test"]}', "Delivery paths"],
    ['code verify delivery -- {"files":["report.ts"],"checks":[]}', "finite check commands"],
  ]) {
    owner.connection.clear();
    await send(command!);
    expect(owner.connection.allTextJoined(), command).toContain(reason!);
  }
  expect(checks()).toHaveLength(0);
  expect(f.db.listCodingRunArtifacts(run.id, ["verification_request"])).toHaveLength(0);
  await expect(
    readDeliveryManifest(new LocalWorkspace(root), { json: " ".repeat(65537) }),
  ).rejects.toThrow("64 KiB");
});

it("detects changes to path manifests and either form's files during capture", async () => {
  const workspace = new LocalWorkspace(root);
  manifest([...files, "helper.ts"]);
  const captured = await captureDelivery(workspace, "delivery.json", () => {});
  try {
    expect(captured.evidence.manifestContent).toBe(
      readFileSync(join(root, "delivery.json"), "utf8"),
    );
    expect(readdirSync(captured.directory).sort()).toEqual([...files, "helper.ts"].sort());
  } finally {
    await captured.dispose();
  }
  let calls = 0;
  await expect(
    captureDelivery(workspace, "delivery.json", () => {
      if (++calls === 2) manifest();
    }),
  ).rejects.toThrow("changed while being captured");
  for (const source of [
    "delivery.json",
    { json: JSON.stringify(declaration([...files, "helper.ts"])) },
  ]) {
    manifest([...files, "helper.ts"]);
    writeFileSync(join(root, "helper.ts"), "export const amount = 11;");
    calls = 0;
    await expect(
      captureDelivery(workspace, source, () => {
        if (++calls === 2) writeFileSync(join(root, "helper.ts"), "export const amount = 12;");
      }),
    ).rejects.toThrow("changed while being captured");
  }
});

it("captures and rechecks a large binary delivery without the buffered read limit", async () => {
  const size = 186_721_216;
  const fd = openSync(join(root, "model.bin"), "w");
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
  manifest(["model.bin"]);
  const workspace = new LocalWorkspace(root);
  const buffered = workspace.readBytes.bind(workspace);
  workspace.readBytes = (path, maxBytes) => {
    expect(path).not.toBe("model.bin");
    return buffered(path, maxBytes);
  };
  const captured = await captureDelivery(workspace, "delivery.json", () => {});
  try {
    expect(captured.evidence.files[0]?.bytes).toBe(size);
    expect(statSync(join(captured.directory, "model.bin")).size).toBe(size);
    expect(await deliveryFingerprint(new LocalWorkspace(captured.directory), ["model.bin"])).toBe(
      captured.evidence.fingerprint,
    );
  } finally {
    await captured.dispose();
  }
}, 20_000);

it("keeps configured capture limits and rejects changes during streaming reads", async () => {
  expect(() => deliveryLimits({ MARINA_CODE_DELIVERY_MAX_FILE_BYTES: "0" })).toThrow("positive");
  expect(() => deliveryLimits({ MARINA_CODE_DELIVERY_MAX_TOTAL_BYTES: "Infinity" })).toThrow(
    "positive",
  );
  using _limits = scopeProcessState({
    env: {
      MARINA_CODE_DELIVERY_MAX_FILE_BYTES: "12",
      MARINA_CODE_DELIVERY_MAX_TOTAL_BYTES: "16",
    },
  });
  writeFileSync(join(root, "one.bin"), "1234567890");
  writeFileSync(join(root, "two.bin"), "1234567890");
  manifest(["one.bin", "two.bin"]);
  await expect(
    captureDelivery(new LocalWorkspace(root), "delivery.json", () => {}),
  ).rejects.toThrow();
  const iterator = new LocalWorkspace(root).readByteChunks("one.bin", 12)[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.length).toBe(10);
  writeFileSync(join(root, "one.bin"), "changed");
  await expect(iterator.next()).rejects.toThrow("changed while");
});

it("honors dependency preparation for the delivery snapshot without borrowing live dependencies", async () => {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { fixture: "1.0.0" },
      scripts: { test: "bun test report.test.ts" },
    }),
  );
  writeFileSync(
    join(root, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 2,
      workspaces: { "": { dependencies: { fixture: "1.0.0" } } },
      packages: {},
    }),
  );
  manifest([...files, "helper.ts", "package.json", "bun.lock"]);
  // check-only must diagnose the missing captured environment before running any tests.
  await send("code verify delivery manifest:delivery.json dependencies:check");
  await f.engine.drainCommands();
  expect(checks()[0]?.status, owner.connection.allTextJoined()).toBe("not_run");
  const evidence = JSON.parse(checks()[0]!.metadata_json);
  expect(evidence.preparation.reason).toContain("Dependencies are not installed");
  expect(evidence.steps.every((step: { outcome: string }) => step.outcome === "not_run")).toBe(
    true,
  );
});

it("runs npm preparation in the captured delivery before checking its unchanged manifest commands", async () => {
  writeFileSync(join(root, "helper.ts"), 'export { amount } from "fixture";');
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { fixture: "1.0.0" },
      scripts: { test: "bun test report.test.ts" },
    }),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: {} }),
  );
  manifest([...files, "helper.ts", "package.json", "package-lock.json"]);
  const prepare = spyOn(
    LocalWorkspace.prototype,
    "prepareCandidateDependencies",
  ).mockImplementation(async function (this: LocalWorkspace, beforeSpawn, manager) {
    beforeSpawn();
    expect(manager).toBe("npm");
    expect(this.root).not.toBe(root);
    mkdirSync(join(this.root, "node_modules/fixture"), { recursive: true });
    writeFileSync(join(this.root, "node_modules/fixture/package.json"), '{"main":"index.js"}');
    writeFileSync(join(this.root, "node_modules/fixture/index.js"), "export const amount = 11;");
    return {
      policy: "fixture-npm",
      result: {
        command: ["npm", "ci"],
        exitCode: 0,
        output: "installed",
        timedOut: false,
        truncated: false,
        durationMs: 1,
      },
    };
  });
  try {
    await send("code verify delivery manifest:delivery.json dependencies:auto");
    await f.engine.drainCommands();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(checks()[0]?.status, owner.connection.allTextJoined()).toBe("complete");
    const evidence = JSON.parse(checks()[0]!.metadata_json);
    expect(evidence.preparation).toMatchObject({ outcome: "installed", policy: "fixture-npm" });
    await send("code summary Delivery dependencies and output checked");
    expect(current().status).toBe("submitted");
    expect(codingRunMetadata(current()).requirements?.verified).toEqual([
      "the delivered report exports amount 11",
    ]);
  } finally {
    prepare.mockRestore();
  }
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
