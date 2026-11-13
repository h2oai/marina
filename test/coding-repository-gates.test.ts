// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// "Verified" means the repository's own gates passed: a coder's declared check cannot stand
// in for the project's type-check, lint and full test suite, and Marina verifies a native
// runtime's result the same way.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeVerificationEnd,
  printOutcome,
  printResultJson,
  printTimeoutMs,
  printVerification,
  REQUIREMENTS_NOT_MAPPED,
  repositoryGates,
  terminalCodeLifecycle,
  verifyNativeTurn,
} from "../scripts/code";
import { parseRequirementChecks } from "../src/coding/delivery";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { beginCodingRun, codingRunMetadata } from "../src/coding/task-run";
import { aggregateVerification } from "../src/coding/verification-plan";
import { VerificationRunner } from "../src/coding/verification-runner";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { observeWorkspaceState } from "../src/coding/workspace-state";
import { codeCommand } from "../src/engine/commands/code";
import { parseCodingTask } from "../src/engine/commands/code/driver";
import { shipVerificationRefusal } from "../src/engine/commands/code/ship";
import { grant } from "../src/engine/safety-gates";
import type { CodingArtifactRow } from "../src/persistence/database";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { git as gitIn } from "./git-helpers";
import { scopeProcessState } from "./process-state";

const test = (name: string, body: string) =>
  `import { expect, test } from "bun:test";\nimport { add, label } from "./src";\ntest(${JSON.stringify(name)}, () => { ${body} });\n`;

/** A tiny Bun project in a Git repository: `bun test` is its runner. */
function project(root: string) {
  const git = (...args: string[]) => gitIn(root, ...args);
  git("init", "--quiet", "--template=");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  writeFileSync(
    join(root, "src.ts"),
    'export const add = (a: number, b: number) => a + b;\nexport const label = "ok";\n',
  );
  writeFileSync(join(root, "add.test.ts"), test("add sums", "expect(add(2, 2)).toBe(4);"));
  writeFileSync(join(root, "label.test.ts"), test("label", 'expect(label).toBe("ok");'));
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
}

describe("repository gates", () => {
  let f: ReturnType<typeof createTestEngine>;
  let owner: ReturnType<typeof f.login>;
  let root: string;
  let state: DisposableStack;
  let output: Perception[];
  let run: CodingArtifactRow | undefined;
  let finished: ((p: Perception) => void) | undefined;
  beforeEach(() => {
    state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
    });
    root = mkdtempSync(join(tmpdir(), "marina-gates-"));
    project(root);
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
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        workspace,
        workspaceRegistry: registry,
        verificationRunner: new VerificationRunner(f.db, (pending) =>
          f.engine.trackBackgroundCommand(pending),
        ),
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        getConnectionProtocol: () => "websocket",
        findEntityExact: (name) =>
          name === "Owner" ? f.engine.entities.get(owner.entityId) : undefined,
        notify: (_id, text, metadata) =>
          output.push({ kind: "message", data: { text, ...metadata }, timestamp: Date.now() }),
      }),
    );
    run = undefined;
    output = [];
    finished = undefined;
    owner.connection.send = (p) => {
      output.push(p);
      if ((p.data?.code as { event?: string } | undefined)?.event === "verification_finished")
        finished?.(p);
    };
  });
  afterEach(async () => {
    await f.dispose();
    rmSync(root, { recursive: true, force: true });
    state.dispose();
  });
  const send = (command: string) =>
    f.engine.processCommand(owner.entityId, command, {
      codingTarget: { sessionId: "s", ...(run ? { runId: run.id } : {}) },
    });
  const meta = () => codingRunMetadata(f.db.getCodingArtifact(run!.id)!);
  async function begin(gates: boolean) {
    const actor = f.engine.entities.get(owner.entityId)!;
    run = beginCodingRun(f.db, {
      session: f.db.getCodingSession("s")!,
      owner: actor,
      worker: actor,
      prompt: "Change the code",
      profile: "marina",
      verificationRequirement: "candidate",
      ...(gates ? { verificationGates: "repository" as const } : {}),
      initialWorkspace: await observeWorkspaceState(root),
    });
  }
  async function verify(command: string) {
    await send(command);
    await f.engine.drainCommands();
    const result = f.db
      .listCodingRunArtifacts(run!.id)
      .filter((a) => a.kind === "verification")
      .at(-1);
    if (!result) throw new Error(output.map((p) => p.data?.text).join("\n"));
    return JSON.parse(result.metadata_json) as {
      outcome: string;
      outcomeReason: string;
      gates?: string;
      steps: Array<{ command: string[]; role: string; outcome: string }>;
    };
  }
  const completion = () => output.map(terminalCodeLifecycle).find((p) => p?.phase === "completed");
  const breakLabel = () =>
    writeFileSync(
      join(root, "src.ts"),
      'export const add = (a: number, b: number) => a + b;\nexport const label = "changed";\n',
    );
  const requirementJson = JSON.stringify({
    checks: ["bun test add.test.ts"],
    requirements: [{ text: "add returns the sum", checks: [0] }],
  });

  it("a change that passes its own declared check but breaks another test is not verified", async () => {
    // Without the gates, the coder's own check is all a candidate verification runs.
    await begin(false);
    breakLabel();
    await send("code recipe save default bun test add.test.ts");
    expect((await verify("code verify candidate")).outcome).toBe("passed");
    await send("code summary Done");
    expect(meta().verification).toBe("passed");
    // A gated task runs the repository's suite: the broken test is found and named.
    f.db.updateCodingArtifact(run!.id, { status: "cancelled" });
    gitIn(root, "checkout", "--quiet", "--", "src.ts");
    await begin(true);
    breakLabel();
    const result = await verify(`code verify candidate -- ${requirementJson}`);
    expect(result.gates).toBe("repository");
    expect(result.outcome).toBe("failed");
    // The requirement check ran first and passed; the repository's tests failed after it.
    expect(result.steps[0]).toMatchObject({
      command: ["bun", "test", "add.test.ts"],
      outcome: "passed",
    });
    expect(result.steps.at(-1)?.outcome).toBe("failed");
    await send("code summary Done");
    expect(f.db.getCodingArtifact(run!.id)?.status).toBe("active");
    expect(meta().verification).toBe("failed");
  });

  it("ignores a saved recipe on a gated task", async () => {
    await begin(true);
    breakLabel();
    await send("code recipe save default bun test add.test.ts");
    const result = await verify("code verify candidate");
    expect(result.outcome).toBe("failed");
    expect(result.steps.map((step) => step.command.join(" "))).not.toContain(
      "bun test add.test.ts",
    );
  });

  it("verifies on the gates plus every mapped requirement, and says so in the JSON result", async () => {
    await begin(true);
    writeFileSync(join(root, "src.ts"), `${await Bun.file(join(root, "src.ts")).text()}// tidy\n`);
    const result = await verify(`code verify candidate -- ${requirementJson}`);
    expect(result.outcome).toBe("passed");
    // Relevant tests, then the full suite under its budget.
    expect(result.steps.map((step) => step.role)).toEqual(["tests", "tests", "full-tests"]);
    await send("code summary Done");
    expect(meta()).toMatchObject({
      verification: "passed",
      requirements: {
        listed: true,
        optional: true,
        verified: ["add returns the sum"],
        unverified: [],
      },
    });
    const end = completion();
    const outcome = printOutcome(end);
    expect(outcome).toEqual({ status: "verified", exitCode: 0 });
    expect(printResultJson(outcome, end, [], 1)).toMatchObject({
      status: "verified",
      exitCode: 0,
      verification: "passed",
      requirements: { listed: true, optional: true, verified: ["add returns the sum"] },
    });
  });

  it("verifies on the gates alone without a requirement list, and says requirements were not mapped", async () => {
    await begin(true);
    writeFileSync(join(root, "src.ts"), `${await Bun.file(join(root, "src.ts")).text()}// tidy\n`);
    expect((await verify("code verify candidate")).outcome).toBe("passed");
    await send("code summary Done");
    expect(meta().requirements).toEqual({
      listed: false,
      optional: true,
      verified: [],
      unverified: [],
      notCheckable: [],
    });
    const outcome = printOutcome(completion());
    expect(outcome).toEqual({ status: "verified", exitCode: 0, notice: REQUIREMENTS_NOT_MAPPED });
  });

  it("a requirement mapped to a failing check is not verified", async () => {
    await begin(true);
    writeFileSync(join(root, "src.ts"), `${await Bun.file(join(root, "src.ts")).text()}// tidy\n`);
    const failing = JSON.stringify({
      checks: ["bun test add.test.ts", "bun test missing.test.ts"],
      requirements: [{ text: "has a missing test", checks: [1] }],
    });
    const result = await verify(`code verify candidate -- ${failing}`);
    expect(result.outcome).not.toBe("passed");
  });

  it("refuses a gated task's live checks as its verification", async () => {
    await begin(true);
    writeFileSync(join(root, "src.ts"), `${await Bun.file(join(root, "src.ts")).text()}// tidy\n`);
    await send("code verify");
    await send("code summary Done");
    expect(meta().verification).toBe("unbound");
    expect(meta().verificationReason).toContain("repository's own gates");
  });

  it("parses the requirement list without files and the gated task contract", () => {
    expect(parseRequirementChecks(requirementJson).requirements[0]?.checks).toEqual([0]);
    expect(() => parseRequirementChecks(JSON.stringify({ files: ["a"], checks: ["x"] }))).toThrow(
      "do not list files",
    );
    expect(() => parseRequirementChecks(JSON.stringify({ checks: ["x"] }))).toThrow(
      "List the task's requirements",
    );
    expect(parseCodingTask("verification:candidate gates:repository -- fix it")).toMatchObject({
      verificationRequirement: "candidate",
      verificationGates: "repository",
      prompt: "fix it",
    });
    expect(() => parseCodingTask("verification:delivery gates:repository -- fix it")).toThrow(
      "Usage",
    );
  });

  describe("review findings", () => {
    it("[1] refuses gates when the repository has no test command, even with lint", async () => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "bun -e 0" } }));
      gitIn(root, "commit", "--quiet", "-am", "no test script");
      expect(repositoryGates(root).ok).toBe(false);
      await begin(true);
      breakLabel();
      await send("code verify candidate");
      await f.engine.drainCommands();
      expect(output.map((p) => p.data?.text ?? "").join("\n")).toContain(
        "Repository gates need a detected test runner",
      );
      await send("code summary Done");
      expect(meta().verification).not.toBe("passed");
      // Nor does a requirement check stand in for the repository's tests.
      expect(
        aggregateVerification({
          steps: [
            {
              step: { command: "bun test add.test.ts", role: "tests", requirement: true },
              outcome: { outcome: "passed", reason: "passed" },
            },
            {
              step: { command: "lint", role: "check" },
              outcome: { outcome: "passed", reason: "passed" },
            },
          ],
          testsPlanned: true,
          repositoryGates: true,
        }).outcome,
      ).toBe("not_run");
    });

    it("[4] counts an ignored deliverable as a change under delivery", async () => {
      writeFileSync(join(root, ".gitignore"), "report.txt\n");
      gitIn(root, "add", ".gitignore");
      gitIn(root, "commit", "--quiet", "-m", "ignore");
      const actor = f.engine.entities.get(owner.entityId)!;
      run = beginCodingRun(f.db, {
        session: f.db.getCodingSession("s")!,
        owner: actor,
        worker: actor,
        prompt: "Write report.txt",
        profile: "marina",
        verificationRequirement: "delivery",
        initialWorkspace: await observeWorkspaceState(root),
      });
      writeFileSync(join(root, "report.txt"), "the report\n");
      await send("code summary Report written");
      expect(f.db.getCodingArtifact(run.id)?.status).toBe("active");
      expect(meta().verification).not.toBe("not_applicable");
    });

    it("[10] a gate that already fails on the base is labelled pre-existing; the coder may submit, unverified", async () => {
      // The base itself is red: label.test.ts fails before the task.
      writeFileSync(join(root, "label.test.ts"), test("label", 'expect(label).toBe("other");'));
      gitIn(root, "commit", "--quiet", "-am", "red base");
      await begin(true);
      writeFileSync(
        join(root, "src.ts"),
        `${await Bun.file(join(root, "src.ts")).text()}// tidy\n`,
      );
      const result = await verify("code verify candidate");
      expect(result.outcome).toBe("failed");
      expect(result).toMatchObject({ preexistingOnly: true });
      expect(result.steps.some((step) => (step as { preexisting?: boolean }).preexisting)).toBe(
        true,
      );
      const text = f.db
        .listCodingRunArtifacts(run!.id)
        .filter((a) => a.kind === "verification")
        .at(-1)!.content_text;
      expect(text).toContain("PRE-EXISTING:");
      expect(text).toContain("submit your summary");
      await send("code summary Tidied src.ts; label.test.ts already failed on the base");
      expect(f.db.getCodingArtifact(run!.id)?.status).toBe("submitted");
      expect(meta()).toMatchObject({ verification: "failed", preexistingFailure: true });
      const outcome = printOutcome(completion());
      expect(outcome).toMatchObject({ status: "unverified", exitCode: 3 });
      expect(outcome.notice).toContain("the repository's gates already fail without this change");
    });

    it("[13] names each failing test, and says which also fail on the base and which are new", async () => {
      writeFileSync(join(root, "label.test.ts"), test("label", 'expect(label).toBe("other");'));
      gitIn(root, "commit", "--quiet", "-am", "red base");
      await begin(true);
      // The change breaks add while label was already red: the step is not pre-existing.
      writeFileSync(
        join(root, "src.ts"),
        'export const add = (a: number, b: number) => a - b;\nexport const label = "ok";\n',
      );
      const result = await verify("code verify candidate");
      expect(result.outcome).toBe("failed");
      expect((result as { preexistingOnly?: boolean }).preexistingOnly).toBeFalsy();
      const text = f.db
        .listCodingRunArtifacts(run!.id)
        .filter((a) => a.kind === "verification")
        .at(-1)!.content_text;
      expect(text).toContain("CAUSED BY THIS CHANGE:");
      expect(text).toMatch(/- add sums \(add\.test\.ts:3\) — NEW: does not fail on the base/);
      expect(text).toMatch(/- label \(label\.test\.ts:3\) — also fails on base [0-9a-f]{12}/);
      expect(text).toContain("First error:");
      await send("code summary Done");
      expect(f.db.getCodingArtifact(run!.id)?.status).toBe("active");
    });

    it("[10] a gate that passes on the base is the change's failure", async () => {
      await begin(true);
      breakLabel();
      await verify("code verify candidate");
      const text = f.db
        .listCodingRunArtifacts(run!.id)
        .filter((a) => a.kind === "verification")
        .at(-1)!.content_text;
      expect(text).toContain("CAUSED BY THIS CHANGE:");
      await send("code summary Done");
      expect(f.db.getCodingArtifact(run!.id)?.status).toBe("active");
    });

    it("[R1] a test the change broke is not excused by a same-named test failing elsewhere", async () => {
      writeFileSync(join(root, "a.test.ts"), test("same", 'expect(label).toBe("never");'));
      writeFileSync(join(root, "b.test.ts"), test("same", 'expect(label).toBe("ok");'));
      gitIn(root, "add", ".");
      gitIn(root, "commit", "--quiet", "-m", "a red, b green");
      await begin(true);
      breakLabel();
      const result = await verify("code verify candidate");
      expect((result as { preexistingOnly?: boolean }).preexistingOnly).toBeFalsy();
      const text = f.db
        .listCodingRunArtifacts(run!.id)
        .filter((a) => a.kind === "verification")
        .at(-1)!.content_text;
      expect(text).toContain("CAUSED BY THIS CHANGE");
      expect(text).toContain("b.test.ts::same");
    });

    it("[R5] code ship refuses a pass whose checks repaired the snapshot's source", async () => {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            test: `printf '%s\\n' 'export const add = (a: number, b: number) => a + b;' 'export const label = "ok";' > src.ts && bun test`,
          },
        }),
      );
      gitIn(root, "commit", "--quiet", "-am", "a test script that rewrites source");
      await begin(true);
      breakLabel();
      const result = await verify("code verify candidate");
      expect(result.outcome).toBe("passed");
      const evidence = result as unknown as { tree: string; freshness: string };
      expect(evidence.freshness).toBe("stale");
      expect(shipVerificationRefusal(f.db, "s", evidence.tree)).toContain(
        "changed the snapshot's source",
      );
    });

    it("[R6] code ship reads the latest verification attempt, not an older pass", async () => {
      await begin(true);
      writeFileSync(
        join(root, "src.ts"),
        `${await Bun.file(join(root, "src.ts")).text()}// tidy\n`,
      );
      const passed = await verify("code verify candidate");
      const tree = (passed as unknown as { tree: string }).tree;
      expect(shipVerificationRefusal(f.db, "s", tree)).toBeNull();
      const later = f.db.createCodingArtifact({
        sessionId: "s",
        kind: "verification_request",
        title: "Background verification",
        status: "running",
        contentText: "test",
        metadata: { commands: ["test"] },
        createdBy: "Owner",
      });
      expect(shipVerificationRefusal(f.db, "s", tree)).toContain("still running");
      f.db.updateCodingArtifact(later.id, { status: "error", metadata: { error: "runner lost" } });
      expect(shipVerificationRefusal(f.db, "s", tree)).toContain(
        "ended without a result (runner lost)",
      );
    });

    it("[E] ship takes the attempt that started last, not the result that landed last", () => {
      // A: a background request admitted first; B: a synchronous check that failed after it;
      // then A's result lands, passed.
      const requestA = f.db.createCodingArtifact({
        sessionId: "s",
        kind: "verification_request",
        title: "Background verification",
        status: "running",
        contentText: "test",
        metadata: { commands: ["test"] },
        createdBy: "Owner",
      });
      f.db.createCodingArtifact({
        sessionId: "s",
        kind: "verification",
        title: "Snapshot verification failed",
        status: "failed",
        contentText: "failed",
        metadata: { gates: "repository", outcome: "failed", outcomeReason: "test: exit 1" },
        createdBy: "Owner",
      });
      const resultA = f.db.createCodingArtifact({
        sessionId: "s",
        kind: "verification",
        title: "Snapshot verification passed",
        status: "complete",
        contentText: "passed",
        metadata: {
          gates: "repository",
          outcome: "passed",
          requestId: requestA.id,
          candidateFingerprint: "f",
          materializedFingerprint: "f",
          freshness: "current",
          tree: "t",
        },
        createdBy: "Owner",
      });
      f.db.updateCodingArtifact(requestA.id, {
        status: "complete",
        metadata: { commands: ["test"], resultArtifactId: resultA.id },
      });
      expect(shipVerificationRefusal(f.db, "s", "t")).toContain("gates failed");
    });

    it("[F] a dependency change between base and candidate makes attribution inconclusive", async () => {
      writeFileSync(join(root, "label.test.ts"), test("label", 'expect(label).toBe("other");'));
      gitIn(root, "commit", "--quiet", "-am", "red base");
      await begin(true);
      const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text());
      writeFileSync(
        join(root, "package.json"),
        // Any manifest change counts: the base would run with the change's dependencies.
        JSON.stringify({ ...pkg, description: "a changed manifest" }),
      );
      const result = await verify("code verify candidate");
      expect(result.outcome).toBe("failed");
      expect((result as { preexistingOnly?: boolean }).preexistingOnly).toBeFalsy();
      const text = f.db
        .listCodingRunArtifacts(run!.id)
        .filter((a) => a.kind === "verification")
        .at(-1)!.content_text;
      expect(text).toContain("INCONCLUSIVE");
      expect(text).toContain("dependency manifests or lockfiles differ");
      expect(text).toContain("package.json");
    });

    it("[retention] a verification at the 64-pin limit retires stale refs first instead of refusing", async () => {
      const tree = gitIn(root, "rev-parse", "HEAD^{tree}").trim();
      const date = `${Math.floor(Date.now() / 1000) - 86_400} +0000`;
      for (let i = 0; i < 64; i++) {
        const commit = Bun.spawnSync(
          ["git", "commit-tree", tree, "-m", "Marina source candidate (not an operator branch)"],
          {
            cwd: root,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Marina candidate",
              GIT_AUTHOR_EMAIL: "candidate@marina.invalid",
              GIT_COMMITTER_NAME: "Marina candidate",
              GIT_COMMITTER_EMAIL: "candidate@marina.invalid",
              GIT_AUTHOR_DATE: date,
              GIT_COMMITTER_DATE: date,
            },
          },
        )
          .stdout.toString()
          .trim();
        gitIn(
          root,
          "update-ref",
          `refs/marina/candidates/00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          commit,
        );
      }
      await begin(true);
      writeFileSync(
        join(root, "src.ts"),
        `${await Bun.file(join(root, "src.ts")).text()}// tidy\n`,
      );
      expect((await verify("code verify candidate")).outcome).toBe("passed");
      const refs = gitIn(root, "for-each-ref", "refs/marina/candidates/").trim().split("\n");
      expect(refs.length).toBe(49);
    });

    it("[11] code ship refuses a change the repository's gates have not verified", async () => {
      await begin(true);
      writeFileSync(
        join(root, "src.ts"),
        `${await Bun.file(join(root, "src.ts")).text()}// tidy\n`,
      );
      expect(shipVerificationRefusal(f.db, "s", "x")).toContain("no verification");
      await verify("code verify candidate");
      const latest = f.db.listCodingArtifacts("s", 50).find((a) => a.kind === "verification")!;
      const tree = (JSON.parse(latest.metadata_json) as { tree: string }).tree;
      expect(shipVerificationRefusal(f.db, "s", tree)).toBeNull();
      expect(shipVerificationRefusal(f.db, "s", "another-tree")).toContain("moved");
      breakLabel();
      await verify("code verify candidate");
      expect(shipVerificationRefusal(f.db, "s", tree)).toContain("gates failed");
    });
  });

  describe("native runtimes", () => {
    const native = async (
      change?: () => void,
      options: { deadlineAt?: number; drain?: boolean; onFinished?: () => void } = {},
    ) => {
      const baseline = await observeWorkspaceState(root);
      change?.(); // what the native turn did to the folder
      return verifyNativeTurn({
        dir: root,
        baseline,
        gates: repositoryGates(root),
        deadlineAt: options.deadlineAt ?? Date.now() + 120_000,
        subscribe: (handler) => {
          finished = (p) => {
            options.onFinished?.();
            handler(p);
          };
          return () => {
            finished = undefined;
          };
        },
        run: async (command) => {
          const from = output.length;
          await send(command);
          const admitted = output.slice(from);
          if (options.drain !== false) await f.engine.drainCommands();
          return admitted;
        },
      });
    };
    const ended = (end: Awaited<ReturnType<typeof native>>) => {
      if (end === "timeout") throw new Error("unexpected timeout");
      return end;
    };

    it("verifies a native turn's change on the repository's gates; requirements not mapped", async () => {
      const end = ended(
        await native(() =>
          writeFileSync(
            join(root, "src.ts"),
            'export const add = (a: number, b: number) => b + a;\nexport const label = "ok";\n',
          ),
        ),
      );
      expect(end).toMatchObject({
        verification: "passed",
        requirements: { listed: false, optional: true },
      });
      const outcome = printOutcome(end);
      expect(outcome).toEqual({ status: "verified", exitCode: 0, notice: REQUIREMENTS_NOT_MAPPED });
      expect(printResultJson(outcome, end, [], 1)).toMatchObject({
        status: "verified",
        verification: "passed",
        requirements: { listed: false, optional: true },
      });
    });

    it("reports a native turn that breaks a test as unverified, naming the failing gate", async () => {
      const end = ended(await native(breakLabel));
      expect(end.verification).toBe("failed");
      expect(end.verificationReason).toContain("Repository gate failed: bun test");
      const outcome = printOutcome(end);
      expect(outcome).toMatchObject({ status: "unverified", exitCode: 3 });
      expect(outcome.notice).toContain("Requirements not mapped");
    });

    it("reports a native turn that changed nothing as nothing to verify", async () => {
      const end = ended(await native());
      expect(end).toMatchObject({
        verification: "not_applicable",
        verificationReason: "nothing to verify: no files changed during this task",
      });
      expect(printOutcome(end)).toMatchObject({ status: "no_changes", exitCode: 3 });
      expect(
        output.some((p) => (p.data?.code as { event?: string })?.event === "verification_started"),
      ).toBe(false);
    });

    it("[8] re-checks the folder against the snapshot when the result arrives", async () => {
      const end = ended(
        await native(
          () =>
            writeFileSync(
              join(root, "src.ts"),
              `${readFileSync(join(root, "src.ts"), "utf8")}// a\n`,
            ),
          // An edit lands while verification_finished is being delivered.
          { onFinished: () => writeFileSync(join(root, "src.ts"), "export const add = 1;\n") },
        ),
      );
      expect(end.verification).toBe("stale");
    });

    it("[R7] a completion read after the deadline is a timeout, never a pass", async () => {
      const end = await native(
        () =>
          writeFileSync(
            join(root, "src.ts"),
            `${readFileSync(join(root, "src.ts"), "utf8")}// a\n`,
          ),
        { deadlineAt: Date.now() + 1 },
      );
      expect(end).toBe("timeout");
    });

    it("[9] one deadline covers the gates; past it the result is a timeout (exit 2)", async () => {
      const end = await native(
        () =>
          writeFileSync(
            join(root, "src.ts"),
            `${readFileSync(join(root, "src.ts"), "utf8")}// a\n`,
          ),
        { deadlineAt: Date.now(), drain: false },
      );
      expect(end).toBe("timeout");
      expect(printOutcome("timeout").exitCode).toBe(2);
      await f.engine.drainCommands();
    });

    it("names why a folder without gates could not be verified", () => {
      const plain = mkdtempSync(join(tmpdir(), "marina-plain-"));
      try {
        const gates = repositoryGates(plain);
        expect(gates).toEqual({ ok: false, reason: "the folder is not a Git repository" });
        const end = nativeVerificationEnd({ comparison: { kind: "changed", paths: ["a"] }, gates });
        expect(end.verification).toBe("unavailable");
        expect(end.verificationReason).toContain("the folder is not a Git repository");
        expect(printOutcome(end).exitCode).toBe(3);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it("never reports verified for a stale snapshot, a non-gate run or another folder", () => {
      const changed = { kind: "changed" as const, paths: ["src.ts"] };
      const gates = { ok: true as const, runner: "test" };
      const passed = {
        outcome: "passed",
        gates: true,
        freshness: "current",
        workspace: "/r",
        steps: [{ command: "bun test", role: "tests", outcome: "passed" }],
      };
      expect(
        nativeVerificationEnd({ comparison: changed, gates, report: passed, folder: "/r" })
          .verification,
      ).toBe("passed");
      expect(
        nativeVerificationEnd({
          comparison: changed,
          gates,
          report: { ...passed, freshness: "stale" },
          folder: "/r",
        }).verification,
      ).toBe("stale");
      expect(
        nativeVerificationEnd({
          comparison: changed,
          gates,
          report: { ...passed, gates: false },
          folder: "/r",
        }).verification,
      ).toBe("unbound");
      expect(
        nativeVerificationEnd({ comparison: changed, gates, report: passed, folder: "/other" })
          .verification,
      ).toBe("unbound");
      expect(
        nativeVerificationEnd({ comparison: changed, gates, report: new Error("timed out") })
          .verification,
      ).toBe("error");
    });
  });
});

describe("the one-shot default", () => {
  it("is candidate for a Git repository with a detected runner, else delivery", () => {
    const repo = mkdtempSync(join(tmpdir(), "marina-default-"));
    const plain = mkdtempSync(join(tmpdir(), "marina-default-plain-"));
    const noRunner = mkdtempSync(join(tmpdir(), "marina-default-norunner-"));
    try {
      project(repo);
      gitIn(noRunner, "init", "--quiet", "--template=");
      writeFileSync(join(noRunner, "README.md"), "docs\n");
      writeFileSync(join(plain, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      expect(repositoryGates(repo)).toEqual({ ok: true, runner: "test" });
      expect(printVerification(undefined, {}, repo)).toBe("candidate");
      expect(printVerification(undefined, {}, plain)).toBe("delivery");
      expect(printVerification(undefined, {}, noRunner)).toBe("delivery");
      expect(repositoryGates(noRunner)).toEqual({
        ok: false,
        reason: "Marina detects no test runner in the folder",
      });
      // Explicit choices win: the flag, then MARINA_CODE_VERIFICATION.
      expect(printVerification("delivery", {}, repo)).toBe("delivery");
      expect(printVerification(undefined, { MARINA_CODE_VERIFICATION: "delivery" }, repo)).toBe(
        "delivery",
      );
      // The gates leave room for the full suite after the work.
      expect(printTimeoutMs("candidate", {})).toBe(1_200_000);
      expect(printTimeoutMs("delivery", {})).toBe(600_000);
      expect(printTimeoutMs("candidate", { MARINA_CODE_TASK_TIMEOUT_MS: "5000" })).toBe(5000);
    } finally {
      for (const dir of [repo, plain, noRunner]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires the full suite to pass under the gates; elsewhere a budget overrun is tolerated", () => {
    const steps = [
      {
        step: { command: "bun test a.test.ts", role: "tests" as const },
        outcome: { outcome: "passed" as const, reason: "passed" },
      },
      {
        step: { command: "bun run test", role: "full-tests" as const },
        outcome: {
          outcome: "not_run" as const,
          reason: "the full suite did not finish within its time budget",
        },
      },
    ];
    expect(aggregateVerification({ steps, testsPlanned: true }).outcome).toBe("passed");
    expect(aggregateVerification({ steps, testsPlanned: true, repositoryGates: true })).toEqual({
      outcome: "not_run",
      reason:
        "bun run test: the full suite did not finish within its time budget (every repository gate must run and pass)",
    });
  });
});
