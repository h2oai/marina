// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// "Verified" means the repository's own gates passed: a coder's declared check cannot stand
// in for the project's type-check, lint and full test suite, and Marina verifies a native
// runtime's result the same way.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  describe("native runtimes", () => {
    const native = async (change?: () => void) => {
      const baseline = await observeWorkspaceState(root);
      change?.(); // what the native turn did to the folder
      return verifyNativeTurn({
        dir: root,
        baseline,
        gates: repositoryGates(root),
        arm: () => new Promise((resolve) => (finished = resolve)),
        run: async (command) => {
          await send(command);
          await f.engine.drainCommands();
        },
      });
    };

    it("verifies a native turn's change on the repository's gates; requirements not mapped", async () => {
      const end = await native(() =>
        writeFileSync(
          join(root, "src.ts"),
          'export const add = (a: number, b: number) => b + a;\nexport const label = "ok";\n',
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
      const end = await native(breakLabel);
      expect(end.verification).toBe("failed");
      expect(end.verificationReason).toContain("Repository gate failed: bun test");
      const outcome = printOutcome(end);
      expect(outcome).toMatchObject({ status: "unverified", exitCode: 3 });
      expect(outcome.notice).toContain("Requirements not mapped");
    });

    it("reports a native turn that changed nothing as nothing to verify", async () => {
      const end = await native();
      expect(end).toMatchObject({
        verification: "not_applicable",
        verificationReason: "nothing to verify: no files changed during this task",
      });
      expect(printOutcome(end)).toMatchObject({ status: "no_changes", exitCode: 3 });
      expect(
        output.some((p) => (p.data?.code as { event?: string })?.event === "verification_started"),
      ).toBe(false);
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
        steps: [],
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
