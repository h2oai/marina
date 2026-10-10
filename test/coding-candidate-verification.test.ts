// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "../src/coding/local-workspace";
import {
  assessCodingVerification,
  beginCodingRun,
  codingRunMetadata,
  codingVerificationUnchanged,
} from "../src/coding/task-run";
import { VerificationRunner } from "../src/coding/verification-runner";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { grant, revoke } from "../src/engine/safety-gates";
import type { CodingArtifactRow } from "../src/persistence/database";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { git as gitIn } from "./git-helpers";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

describe("candidate-bound coding verification", () => {
  let f: ReturnType<typeof createTestEngine>;
  let owner: ReturnType<typeof f.login>;
  let root: string;
  let state: DisposableStack;
  let output: Perception[];
  let run: CodingArtifactRow;
  let protocol: "websocket" | "telnet";
  // Hermetic git (test/git-helpers.ts): no host config, no background maintenance.
  const git = (...args: string[]) => gitIn(root, ...args);
  beforeEach(() => {
    state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
    });
    root = mkdtempSync(join(tmpdir(), "marina-candidate-check-"));
    git("init", "--quiet", "--template=");
    writeFileSync(join(root, "source.txt"), "base\n");
    writeFileSync(
      join(root, "check.ts"),
      'if (await Bun.file("source.txt").text() !== "base\\n") process.exit(1); console.log("checked captured source");',
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "bun check.ts" } }),
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    f = createTestEngine();
    owner = f.login("Owner");
    const actor = f.engine.entities.get(owner.entityId)!;
    grant(f.db, actor.id, "code.exec");
    f.db.createCodingSession({
      id: "s",
      title: "Coding",
      workspaceRoot: root,
      createdBy: actor.name,
    });
    actor.properties.coding_session_id = "s";
    actor.properties.active_modal = "code";
    const workspace = new LocalWorkspace(root);
    const registry = new WorkspaceRegistry({ roots: [root] });
    registry.workspaceForRoot = () => workspace;
    protocol = "websocket";
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        workspace,
        workspaceRegistry: registry,
        verificationRunner: new VerificationRunner(f.db, (pending) =>
          f.engine.trackBackgroundCommand(pending),
        ),
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        getConnectionProtocol: () => protocol,
      }),
    );
    run = beginCodingRun(f.db, {
      session: f.db.getCodingSession("s")!,
      owner: actor,
      worker: actor,
      prompt: "Check source",
      profile: "marina",
    });
    output = [];
    owner.connection.send = (p) => output.push(p);
  });
  afterEach(async () => {
    await f.dispose();
    rmSync(root, { recursive: true, force: true });
    state.dispose();
  });
  const send = (command: string) =>
    f.engine.processCommand(owner.entityId, command, {
      codingTarget: { sessionId: "s", runId: run.id },
    });
  const artifact = (kind: string) =>
    f.db.listCodingRunArtifacts(run.id).find((a) => a.kind === kind)!;
  const current = () => f.db.getCodingArtifact(run.id)!;
  const meta = () => codingRunMetadata(current());
  async function verify(options = "") {
    await send(`code verify candidate${options ? ` ${options}` : ""}`);
    await f.engine.drainCommands();
    const receipt = artifact("verification_request");
    expect(receipt).toBeDefined();
    if (!artifact("verification")) throw new Error(receipt.metadata_json);
  }

  it("runs a dependency-free saved recipe in a candidate when preparation is explicitly disabled", async () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "not-installed": "1.0.0" } }),
    );
    writeFileSync(
      join(root, "unit.test.ts"),
      'import { expect, test } from "bun:test"; test("real check", () => expect(2 + 2).toBe(4));',
    );
    mkdirSync(join(root, ".qualification"));
    const acceptance = join(root, ".qualification", "acceptance.test.ts");
    writeFileSync(
      acceptance,
      'import { expect, test } from "bun:test"; test("HIDDEN_ACCEPTANCE_SENTINEL", () => expect(false).toBe(true));',
    );
    await send(
      "code recipe save default bun test ./.qualification/acceptance.test.ts ./unit.test.ts",
    );
    await verify("dependencies:none");
    expect(artifact("verification").content_text).toContain("failed");
    expect(artifact("verification").content_text).toContain("HIDDEN_ACCEPTANCE_SENTINEL");
    await send(`code show ${artifact("verification_request").id}`);
    expect(output.at(-1)?.data.text).toContain("HIDDEN_ACCEPTANCE_SENTINEL");
    writeFileSync(
      acceptance,
      'import { expect, test } from "bun:test"; test("HIDDEN_ACCEPTANCE_SENTINEL", () => expect(true).toBe(true));',
    );
    await verify("dependencies:none");
    expect(artifact("verification").content_text).toContain("passed");
    expect(artifact("verification").content_text).not.toContain("Check output");
    expect(output.map((p) => p.data.text).join("\n")).toContain("Candidate verification: passed.");
    expect(output.map((p) => p.data.text).join("\n")).toContain(
      "Any later source or test edit requires fresh candidate verification",
    );
    expect(artifact("command_output").content_text).toContain("2 pass");
    expect(artifact("command_output").content_text).toContain(".qualification/acceptance.test.ts:");
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    // A source change invalidates that candidate, and the retry retains the
    // explicit no-preparation setting rather than reverting to check.
    requireCandidate();
    writeFileSync(join(root, "source.txt"), "changed after verification\n");
    await send("code summary premature submission");
    expect(current().status).toBe("active");
    expect(output.at(-1)?.data.text).toContain("code verify candidate dependencies:none");
  });

  function requireCandidate() {
    f.db.updateCodingArtifact(run.id, {
      metadata: { ...meta(), verificationRequirement: "candidate" },
    });
  }
  it("distinguishes artifact receipts from files without leaking another session's artifacts", async () => {
    await verify();
    const id = artifact("verification_request").id;
    output.length = 0;
    await send(`code read ${id}`);
    expect(output.at(-1)?.data.text).toContain(`action=show, artifactId=${id}`);
    expect(output.at(-1)?.data.text).toContain("not a workspace file");
    // A genuine file with the same name still reads as a file.
    writeFileSync(join(root, id), "real file with artifact-shaped name");
    await send(`code read ${id}`);
    expect(output.at(-1)?.data.text).toContain("real file with artifact-shaped name");
    f.db.createCodingSession({
      id: "private",
      title: "Private",
      workspaceRoot: root,
      createdBy: "Other",
    });
    const hidden = f.db.createCodingArtifact({
      sessionId: "private",
      kind: "observation",
      title: "Secret",
      status: "complete",
      contentText: "private data",
      createdBy: "Other",
    });
    await send(`code read ${hidden.id}`);
    expect(output.at(-1)?.data.text).not.toContain("action=show");
    expect(output.at(-1)?.data.text).not.toContain("private data");
  });

  it("keeps early, live and stale summaries active, then submits the same attempt after current checks", async () => {
    requireCandidate();
    await send("code summary First progress");
    expect(current().status).toBe("active");
    expect(meta().verification).toBe("missing");
    await send("code verify");
    await send("code summary Live checks");
    expect(current().status).toBe("active");
    expect(meta().verification).toBe("unbound");
    await verify();
    writeFileSync(join(root, "extra.ts"), "export const changed = true;");
    await send("code summary Source edited after checks");
    expect(current().status).toBe("active");
    expect(meta().verification).toBe("stale");
    await send("code status");
    expect(
      output.findLast(
        (p) => (p.data.code as { event?: string } | undefined)?.event === "session_status",
      )?.data.code,
    ).toMatchObject({ metadata: { runId: run.id, verificationReadiness: "needs-attention" } });
    await verify();
    await send("code summary Fresh candidate ready");
    expect(current().status).toBe("submitted");
    expect(meta().verification).toBe("passed");
    expect(f.db.listCodingRuns()).toHaveLength(1);
    expect(f.db.getTaskClaim(meta().taskId, owner.entityId)?.status).toBe("submitted");
  });

  it("withholds submission and ordinary approval on failed required checks; owner can explicitly accept without falsifying evidence", async () => {
    requireCandidate();
    writeFileSync(join(root, "check.ts"), "process.exit(1);");
    await verify();
    await send("code summary Tests fail; preserving work");
    expect(current().status).toBe("active");
    expect(meta().verification).toBe("failed");
    await send(`code review approve ${run.id}`);
    expect(f.db.getTaskClaim(meta().taskId, owner.entityId)?.status).toBe("claimed");
    await send(`code review accept-unverified ${run.id}`);
    expect(current().status).toBe("active");
    await send(`code review accept-unverified ${run.id} Reviewed manually; follow-up tests needed`);
    expect(current().status).toBe("submitted");
    expect(meta().verification).toBe("failed");
    expect(meta().unverifiedAcceptance?.reason).toContain("Reviewed manually");
    expect(f.db.getTaskClaim(meta().taskId, owner.entityId)?.status).toBe("approved");
    expect(f.db.listCodingEvents("s").some((e) => e.kind === "task_run_accepted_unverified")).toBe(
      true,
    );
  });

  it("reports a blocker, releases the claim and leaves progress without a success event", async () => {
    requireCandidate();
    await send("code summary Cannot install private dependency");
    await send("code blocked Private registry credentials unavailable");
    expect(current().status).toBe("interrupted");
    expect(meta().verification).toBe("missing");
    expect(meta().reason).toContain("Blocked:");
    expect(artifact("handoff").content_text).toContain("Private registry");
    expect(f.db.getTask(meta().taskId)?.status).toBe("open");
    expect(f.db.listCodingEvents("s").some((e) => e.kind === "task_run_submitted")).toBe(false);
  });

  it.each([true, false])(
    "prepares locked workspace dependencies only in the candidate (root dependencies: %s)",
    async (rootDependencies) => {
      mkdirSync(join(root, "dependency"));
      writeFileSync(
        join(root, "dependency/package.json"),
        JSON.stringify({
          name: "fixture-dep",
          version: "1.0.0",
          exports: "./index.ts",
          scripts: { postinstall: "touch DANGER" },
        }),
      );
      writeFileSync(join(root, "dependency/index.ts"), "export const answer = 42;");
      mkdirSync(join(root, "consumer"));
      writeFileSync(
        join(root, "consumer/package.json"),
        JSON.stringify({
          name: "fixture-consumer",
          version: "1.0.0",
          dependencies: { "fixture-dep": "workspace:*" },
        }),
      );
      writeFileSync(join(root, "consumer/index.ts"), 'export { answer } from "fixture-dep";');
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "fixture",
          workspaces: ["dependency", "consumer"],
          ...(rootDependencies ? { dependencies: { "fixture-dep": "workspace:*" } } : {}),
          trustedDependencies: ["fixture-dep"],
          scripts: { preinstall: "touch DANGER", test: "bun check.ts" },
        }),
      );
      writeFileSync(
        join(root, "bun.lock"),
        JSON.stringify({
          lockfileVersion: 2,
          configVersion: 1,
          workspaces: {
            "": {
              name: "fixture",
              ...(rootDependencies ? { dependencies: { "fixture-dep": "workspace:*" } } : {}),
            },
            dependency: { name: "fixture-dep", version: "1.0.0" },
            consumer: {
              name: "fixture-consumer",
              version: "1.0.0",
              dependencies: { "fixture-dep": "workspace:*" },
            },
          },
          trustedDependencies: ["fixture-dep"],
          packages: {
            "fixture-dep": ["fixture-dep@workspace:dependency"],
            "fixture-consumer": ["fixture-consumer@workspace:consumer"],
          },
        }),
      );
      writeFileSync(
        join(root, "bunfig.toml"),
        '[install]\nregistry = "http://127.0.0.1:9"\n[install.security]\nscanner = "./scanner.ts"\n',
      );
      writeFileSync(join(root, "scanner.ts"), 'await Bun.write("DANGER", "scanner ran");');
      writeFileSync(
        join(root, "check.ts"),
        'import { answer } from "./consumer/index.ts"; if (answer !== 42 || await Bun.file("DANGER").exists() || await Bun.file("dependency/DANGER").exists()) process.exit(1); console.log("locked dependency imported; no scripts");',
      );
      const index = readFileSync(join(root, ".git/index"));
      const head = git("rev-parse", "HEAD");
      const lock = readFileSync(join(root, "bun.lock"));
      await verify("dependencies:bun");
      const evidence = JSON.parse(artifact("verification").metadata_json);
      expect(artifact("verification").status, artifact("verification").content_text).toBe(
        "complete",
      );
      expect(evidence).toMatchObject({
        freshness: "current",
        preparation: { policy: "bun-frozen-public-no-scripts-v1", status: "complete" },
      });
      expect(evidence.preparation.lockfileSha256).toHaveLength(64);
      const prep = f.db.getCodingArtifact(evidence.preparationArtifactId)!;
      expect(JSON.parse(prep.metadata_json)).toMatchObject({
        phase: "dependency-preparation",
        candidateId: evidence.candidateId,
      });
      expect(JSON.parse(prep.metadata_json).command).toContain("--ignore-scripts");
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      expect(existsSync(join(root, "DANGER"))).toBe(false);
      expect(readFileSync(join(root, "bun.lock"))).toEqual(lock);
      expect(readFileSync(join(root, ".git/index"))).toEqual(index);
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(artifact("verification").content_text).toContain("Install scripts disabled");
      await send("code summary Locked dependencies verified");
      expect(meta().verification).toBe("passed");
    },
  );

  it("records unmet dependency prerequisites as not run (never a failure) and runs no checks", async () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "1.3.0" }, scripts: { test: "bun check.ts" } }),
    );
    await verify("--dependencies bun");
    expect(artifact("verification").status).toBe("not_run");
    expect(artifact("verification").content_text).not.toContain("Verification passed");
    expect(artifact("verification").content_text).toContain("Checks were not run");
    const evidence = JSON.parse(artifact("verification").metadata_json);
    expect(evidence.outcome).toBe("not_run");
    expect(evidence.commands).toEqual([]);
    expect(evidence.preparation.status).toBe("failed");
    expect(evidence.preparation.outcome).toBe("not_run");
    expect(f.db.getCodingArtifact(evidence.preparationArtifactId)!.content_text).toContain(
      "bun.lock",
    );
    await send("code summary Preparation failed");
    expect(meta().verification).toBe("not_run");
    expect(meta().verificationReason).toContain("Dependency preparation failed");
  });

  it("rejects unknown preparation, scope and type-check modes", async () => {
    for (const command of [
      "code verify candidate dependencies:brew",
      "code verify scope:sideways",
      "code verify start typecheck:maybe",
    ])
      await send(command);
    expect(artifact("verification_request")).toBeUndefined();
    expect(artifact("candidate")).toBeUndefined();
    expect(output.filter((p) => String(p.data.text).includes("Usage: code verify"))).toHaveLength(
      3,
    );
  });

  it("submits immutable evidence, then detects a direct edit at review and withholds approval", async () => {
    const index = readFileSync(join(root, ".git/index"));
    const head = git("rev-parse", "HEAD");
    await verify();
    expect(artifact("verification").status).toBe("complete");
    const evidence = JSON.parse(artifact("verification").metadata_json);
    expect(evidence).toMatchObject({
      candidateId: artifact("candidate").id,
      freshness: "current",
      executionLocation: "candidate-materialization",
      recipeType: "configured-checks",
    });
    const command = JSON.parse(artifact("command_output").metadata_json);
    expect(command.candidateId).toBe(evidence.candidateId);
    expect(command.cwd).not.toBe(root);
    expect(existsSync(command.cwd)).toBe(false);
    await send("code summary Captured checks passed");
    expect(meta().verification).toBe("passed");
    expect(current().status).toBe("submitted");
    expect(f.db.listTasks()).toHaveLength(1);
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(git("rev-parse", "HEAD")).toBe(head);
    const eventId = meta().workspaceEventId;
    writeFileSync(join(root, "source.txt"), "direct edit, no event\n");
    await f.engine.processCommand(owner.entityId, `code review ${run.id}`, {
      codingTarget: { sessionId: "s" },
    });
    expect(meta().verification).toBe("stale");
    expect(meta().workspaceEventId).toBe(eventId);
    await f.engine.processCommand(owner.entityId, `code review approve ${run.id}`, {
      codingTarget: { sessionId: "s" },
    });
    expect(f.db.getTaskClaim(meta().taskId, owner.entityId)?.status).toBe("submitted");
    expect(output.some((p) => String(p.data.text).includes("approval withheld"))).toBe(true);
    expect(artifact("verification").status).toBe("complete"); // historical evidence is immutable
  });

  it("closes the original counterexample at submission without relying on workspace events", async () => {
    await verify();
    const eventId = meta().workspaceEventId;
    writeFileSync(join(root, "source.txt"), "changed after checks\n");
    await send("code summary Source changed outside Marina");
    expect(meta().workspaceEventId).toBe(eventId);
    expect(meta().verification).toBe("stale");
    expect(meta().verificationReason).toContain("Included source changed");
  });

  it("keeps live checks usable but never treats their output as candidate-bound evidence", async () => {
    await send("code verify");
    expect(artifact("verification").status).toBe("complete");
    expect(artifact("candidate")).toBeUndefined();
    await send("code summary Live check complete");
    expect(meta().verification).toBe("unbound");
  });

  it("captures a successor when checks modify source without modifying the operator's files", async () => {
    writeFileSync(
      join(root, "check.ts"),
      'await Bun.write("source.txt", "formatter changed source\\n");',
    );
    await verify();
    const evidence = JSON.parse(artifact("verification").metadata_json);
    expect(evidence.freshness).toBe("stale");
    expect(evidence.successorCandidateId).toBeString();
    const successor = f.db.getCodingArtifact(evidence.successorCandidateId)!;
    expect(JSON.parse(successor.metadata_json).supersedesCandidateId).toBe(evidence.candidateId);
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("base\n");
    await send("code summary Formatter changed isolated source");
    expect(meta().verification).toBe("stale");
  });

  it("runs checks against captured bytes while world messages continue and original source changes A → B → A", async () => {
    requireCandidate();
    const start = join(root, ".git", "check-started");
    const finish = join(root, ".git", "check-finish");
    writeFileSync(
      join(root, "check.ts"),
      `await Bun.write(${JSON.stringify(start)}, "started");
while (!(await Bun.file(${JSON.stringify(finish)}).exists())) await Bun.sleep(5);
if (await Bun.file("source.txt").text() !== "base\\n") process.exit(1);
console.log("snapshot stayed stable");`,
    );
    try {
      await send("code verify candidate");
      await until(() => existsSync(start), { timeoutMs: 3000 });
      writeFileSync(join(root, "source.txt"), "changed during check\n");
      await f.engine.processCommand(owner.entityId, "say still in the world", {
        bypassModal: true,
      });
      expect(output.some((p) => String(p.data.text).includes("still in the world"))).toBe(true);
      expect(artifact("verification_request").status).toBe("running");
      await send("code summary Submitted while checks run");
      expect(current().status).toBe("active");
      expect(meta().verificationReason).toContain("still running");
      writeFileSync(join(root, "source.txt"), "base\n");
    } finally {
      writeFileSync(finish, "finish");
      await f.engine.drainCommands();
    }
    expect(artifact("verification").status).toBe("complete");
    expect(artifact("command_output").content_text).toContain("snapshot stayed stable");
    await send("code summary Snapshot checked");
    expect(meta().verification).toBe("passed");
  });

  it("never accepts whitespace-only snapshot checks as completed task validation", async () => {
    f.db.updateCodingArtifact(run.id, {
      metadata: { ...meta(), verificationRequirement: "candidate" },
    });
    rmSync(join(root, "package.json"));
    await verify();
    expect(artifact("verification").status).toBe("complete");
    await send("code summary Whitespace is clean");
    expect(current().status).toBe("active");
    expect(meta().verification).toBe("not_run");
    expect(meta().verificationReason).toContain("Whitespace");
  });

  it("checks staged snapshot whitespace against its base rather than an empty working diff", async () => {
    rmSync(join(root, "package.json"));
    writeFileSync(join(root, "source.txt"), "trailing whitespace   \n");
    await verify();
    expect(artifact("verification").status).toBe("failed");
    const evidence = JSON.parse(artifact("verification").metadata_json);
    expect(evidence.recipeType).toBe("whitespace-only");
    expect(evidence.commands).toEqual([["git", "diff", "--cached", "--check"]]);
  });

  it("fails closed for unavailable source and transport, target or authority changes", async () => {
    await verify();
    expect((await assessCodingVerification(f.db, current(), false)).verification).toBe(
      "unavailable",
    );
    f.db.updateCodingSession("s", { executionTarget: "flywheel" });
    expect((await assessCodingVerification(f.db, current())).verification).toBe("unavailable");
    f.db.updateCodingSession("s", { executionTarget: "local" });
    rmSync(join(root, ".git"), { recursive: true });
    expect((await assessCodingVerification(f.db, current())).verification).toBe("unavailable");
    revoke(f.db, owner.entityId, "code.exec");
    await send("code verify candidate");
    expect(f.db.listCodingRunArtifacts(run.id).filter((a) => a.kind === "candidate")).toHaveLength(
      1,
    );
    protocol = "telnet";
    grant(f.db, owner.entityId, "code.exec");
    await send("code verify candidate");
    expect(f.db.listCodingRunArtifacts(run.id).filter((a) => a.kind === "candidate")).toHaveLength(
      1,
    );
  });

  it("rejects stale asynchronous assessments after an attempt transition", async () => {
    await verify();
    const initial = current();
    const assessed = await assessCodingVerification(f.db, initial);
    expect(codingVerificationUnchanged(f.db, initial, assessed.verificationId)).toBe(true);
    f.db.updateCodingArtifact(run.id, { status: "interrupted" });
    expect(codingVerificationUnchanged(f.db, initial, assessed.verificationId)).toBe(false);
  });

  it("will not reuse evidence whose retained Git object was retired", async () => {
    await verify();
    const candidate = JSON.parse(artifact("candidate").metadata_json);
    git("update-ref", "-d", candidate.ref, candidate.commit);
    expect((await assessCodingVerification(f.db, current())).verification).toBe("unavailable");
  });

  it("requires revalidation when the base changes even if included file bytes do not", async () => {
    await verify();
    git("commit", "--allow-empty", "-m", "new base");
    const observed = await assessCodingVerification(f.db, current());
    expect(observed.verification).toBe("unavailable");
    expect(observed.verificationReason).toContain("base commit changed");
  });

  it("retains failed check attribution and refuses candidate approval", async () => {
    writeFileSync(join(root, "check.ts"), "process.exit(1);");
    await verify();
    await send("code summary The check failed");
    expect(meta().verification).toBe("failed");
    expect(meta().candidateId).toBe(artifact("candidate").id);
    await f.engine.processCommand(owner.entityId, `code review approve ${run.id}`, {
      codingTarget: { sessionId: "s" },
    });
    expect(f.db.getTaskClaim(meta().taskId, owner.entityId)?.status).toBe("submitted");
    expect(output.some((p) => String(p.data.text).includes("approval withheld"))).toBe(true);
  });

  it("records an explicit owner's approval against the exact candidate and verification", async () => {
    await verify();
    await send("code summary Ready for review");
    await f.engine.processCommand(owner.entityId, `code review approve ${run.id}`, {
      codingTarget: { sessionId: "s" },
    });
    expect(f.db.getTaskClaim(meta().taskId, owner.entityId)?.status).toBe("approved");
    const review = f.db.listCodingEvents("s").find((event) => event.kind === "task_run_approved")!;
    expect(JSON.parse(review.payload_json)).toMatchObject({
      candidateId: artifact("candidate").id,
      verificationId: artifact("verification").id,
      reviewerKey: f.db.durableEntityKey(owner.entityId),
      verification: "passed",
    });
  });
});
