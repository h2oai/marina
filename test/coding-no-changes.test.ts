// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOutcome, printResultJson, terminalCodeLifecycle } from "../scripts/code";
import { renderRunResult, verificationReadinessLabel } from "../scripts/code-presentation";
import {
  assessCodingVerification,
  beginCodingRun,
  codingRunMetadata,
  endCodingRun,
} from "../src/coding/task-run";
import {
  compareWorkspaceState,
  noChangeReason,
  observeWorkspaceState,
} from "../src/coding/workspace-state";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import type { CodingArtifactRow } from "../src/persistence/database";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { git as gitIn } from "./git-helpers";
import { scopeProcessState } from "./process-state";

const NOTHING = "nothing to verify: no files changed during this task";

describe("coding tasks without file changes", () => {
  let f: ReturnType<typeof createTestEngine>;
  let root: string;
  let owner: ReturnType<typeof f.login>;
  let run: CodingArtifactRow;
  let output: Perception[];
  let state: DisposableStack;
  const git = (...args: string[]) => gitIn(root, ...args);
  const current = () => f.db.getCodingArtifact(run.id)!;
  const meta = () => codingRunMetadata(current());
  const send = (command: string) =>
    f.engine.dispatchCommand(owner.entityId, command, {
      codingTarget: { sessionId: "s" },
    });
  /** Dispatch the way the driver does: observe the workspace, then begin the attempt. */
  async function begin(mode: "checks" | "candidate" | "delivery" = "checks") {
    const actor = f.engine.entities.get(owner.entityId)!;
    run = beginCodingRun(f.db, {
      session: f.db.getCodingSession("s")!,
      owner: actor,
      worker: actor,
      prompt: "Confirm what source.txt contains",
      profile: "marina",
      verificationRequirement: mode,
      initialWorkspace: await observeWorkspaceState(root),
    });
    return run;
  }
  beforeEach(() => {
    state = scopeProcessState({ trustProfile: "shared", rateLimitBypass: true });
    root = mkdtempSync(join(tmpdir(), "marina-no-changes-"));
    git("init", "--quiet", "--template=");
    writeFileSync(join(root, "source.txt"), "base\n");
    writeFileSync(join(root, "other.txt"), "other\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\nbuild/\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    f = createTestEngine();
    owner = f.login("Owner");
    const actor = f.engine.entities.get(owner.entityId)!;
    grant(f.db, actor.id, "code.exec");
    f.db.createCodingSession({
      id: "s",
      title: "Question",
      workspaceRoot: root,
      createdBy: actor.name,
    });
    f.db.updateCodingSession("s", { agent: actor.name, writer: actor.name });
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        findEntityExact: (name) =>
          name === "Owner" ? f.engine.entities.get(owner.entityId) : undefined,
        getConnectionProtocol: () => "websocket",
        notify: (_id, text, metadata) =>
          output.push({ kind: "message", data: { text, ...metadata }, timestamp: Date.now() }),
      }),
    );
    output = [];
    owner.connection.send = (p) => output.push(p);
  });
  afterEach(async () => {
    await f.dispose();
    rmSync(root, { recursive: true, force: true });
    state.dispose();
  });

  it.each(["checks", "candidate", "delivery"] as const)(
    "submits a no-edit answer under %s as not_applicable everywhere: exit 3, never verified",
    async (mode) => {
      await begin(mode);
      await send("code summary source.txt contains base");
      expect(current().status).toBe("submitted");
      expect(meta()).toMatchObject({ verification: "not_applicable", verificationReason: NOTHING });
      const completion = output.map(terminalCodeLifecycle).find((p) => p?.phase === "completed");
      expect(completion).toMatchObject({ verification: "not_applicable" });
      const outcome = printOutcome(completion);
      expect(outcome).toMatchObject({ status: "no_changes", exitCode: 3 });
      expect(outcome.notice).toBe(`Completed but not verified: ${NOTHING}`);
      expect(printResultJson(outcome, completion, [], 1)).toMatchObject({
        status: "no_changes",
        exitCode: 3,
        verification: "not_applicable",
        verificationReason: NOTHING,
        files: [],
        requirements: null,
      });
      // --allow-unverified accepts it like any other completed, unverified run.
      expect(printOutcome(completion, true)).toMatchObject({ status: "no_changes", exitCode: 0 });
      await send("code status");
      expect(output.at(-1)?.data.text).toContain(NOTHING);
      await send(`code review ${run.id}`);
      expect(output.at(-1)?.data.text).toContain("Recorded verification: not_applicable");
      expect(output.at(-1)?.data.text).toContain(NOTHING);
      expect(verificationReadinessLabel("not-applicable")).toBe("verification not applicable");
      const result = renderRunResult({
        outcome: "submitted",
        verification: meta().verification,
        verificationReason: meta().verificationReason,
      });
      expect(result).toContain("verification not applicable");
      expect(result).toContain(NOTHING);
      expect(result).not.toContain("checks passed");
      await send(`code review approve ${run.id}`);
      expect(f.db.getTask(meta().taskId)?.status).toBe("completed");
      expect(meta().verification).toBe("not_applicable");
      expect(f.db.getTaskClaim(meta().taskId, owner.entityId)?.submission_text).toContain(
        "Recorded verification: not_applicable",
      );
    },
  );

  it.each([
    "tracked",
    "untracked",
    "deleted",
    "mode",
    "staged-only",
    "symlink",
    "commit",
    "untracked-in-new-dir",
  ])("keeps verification required for a %s change the task made", async (kind) => {
    await begin("delivery");
    if (kind === "tracked") writeFileSync(join(root, "source.txt"), "task edit\n");
    if (kind === "untracked") writeFileSync(join(root, "new.txt"), "task output\n");
    if (kind === "deleted") unlinkSync(join(root, "source.txt"));
    if (kind === "mode") chmodSync(join(root, "source.txt"), 0o755);
    if (kind === "symlink") {
      unlinkSync(join(root, "source.txt"));
      symlinkSync("other.txt", join(root, "source.txt"));
    }
    if (kind === "staged-only") {
      // The working tree ends as it began; only the index holds the change.
      const blob = git("hash-object", "-w", "other.txt").trim();
      git("update-index", "--cacheinfo", `100644,${blob},source.txt`);
    }
    if (kind === "commit") {
      writeFileSync(join(root, "source.txt"), "committed\n");
      git("commit", "--quiet", "-am", "task");
    }
    if (kind === "untracked-in-new-dir") {
      mkdirSync(join(root, "pkg"));
      writeFileSync(join(root, "pkg", "a.txt"), "x\n");
    }
    await send("code summary Investigation complete");
    expect(current().status).toBe("active");
    expect(meta().verification).toBe("missing");
    expect(output.map(terminalCodeLifecycle).filter(Boolean)).toHaveLength(0);
  });

  it.each(["assume-unchanged", "skip-worktree"])(
    "sees a task's edit to a %s file, which git status hides",
    async (flag) => {
      git("update-index", `--${flag}`, "source.txt");
      await begin("checks");
      writeFileSync(join(root, "source.txt"), "hidden edit\n");
      expect(git("status", "--porcelain")).toBe("");
      await send("code summary Nothing to change");
      expect(current().status).toBe("active");
      expect(meta().verification).toBe("missing");
    },
  );

  it("names files Git is told not to check when nothing changed", async () => {
    git("update-index", "--assume-unchanged", "source.txt");
    await begin("checks");
    await send("code summary Nothing to change");
    expect(meta().verification).toBe("not_applicable");
    expect(meta().verificationReason).toContain(
      "assume-unchanged or skip-worktree; 1 path: source.txt",
    );
  });

  it("names Git-ignored paths the task changed, which no check covers", async () => {
    await begin("candidate");
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build", "out.js"), "built\n");
    writeFileSync(join(root, "ignored.txt"), "scratch\n");
    await send("code summary Answer");
    expect(meta().verification).toBe("not_applicable");
    expect(meta().verificationReason).toBe(
      `${NOTHING}; Git-ignored paths changed during the task and no check covers them (build/, ignored.txt)`,
    );
  });

  it.each(["tracked", "staged", "untracked"])(
    "names %s changes already present before the task; they are not its changes",
    async (kind) => {
      const path = kind === "untracked" ? "old.txt" : "source.txt";
      writeFileSync(join(root, path), "existing\n");
      if (kind === "staged") git("add", "source.txt");
      await begin();
      expect(meta().initialWorkspace?.preexisting?.count).toBe(1);
      await send("code summary No edits needed");
      expect(current().status).toBe("submitted");
      expect(meta().verification).toBe("not_applicable");
      expect(meta().verificationReason).toBe(
        `${NOTHING}; changes already present before the task are not this task's and were not verified (1 path: ${path})`,
      );
    },
  );

  it("treats a further edit to an already-changed file as the task's change", async () => {
    writeFileSync(join(root, "source.txt"), "existing\n");
    await begin();
    writeFileSync(join(root, "source.txt"), "existing and more\n");
    await send("code summary Done");
    expect(current().status).toBe("active");
    expect(meta().verification).toBe("missing");
  });

  it("keeps the baseline when steering and observes a new one for a new attempt", async () => {
    await begin();
    const baseline = meta().initialWorkspace;
    writeFileSync(join(root, "new.txt"), "output\n");
    // Steering the active attempt keeps its first observation.
    const actor = f.engine.entities.get(owner.entityId)!;
    beginCodingRun(f.db, {
      session: f.db.getCodingSession("s")!,
      owner: actor,
      worker: actor,
      prompt: "and also",
      profile: "marina",
      initialWorkspace: await observeWorkspaceState(root),
    });
    expect(meta().initialWorkspace).toEqual(baseline!);
    await send("code summary Done");
    expect(current().status).toBe("active");
    endCodingRun(f.db, run.id, "cancelled", "new attempt");
    await begin();
    expect(meta().initialWorkspace?.source).not.toBe(baseline?.source);
    await send("code summary Output was already present");
    expect(meta().verification).toBe("not_applicable");
  });

  it("counts an edit later reverted to the same bytes as a change (conservative)", async () => {
    await begin();
    writeFileSync(join(root, "source.txt"), "temporary edit\n");
    writeFileSync(join(root, "source.txt"), "base\n");
    await send("code summary No lasting edit");
    expect(current().status).toBe("active");
    expect(meta().verification).toBe("missing");
  });

  it("rechecks no-change evidence during review", async () => {
    await begin();
    await send("code summary Confirmed");
    writeFileSync(join(root, "source.txt"), "later edit\n");
    await send(`code review approve ${run.id}`);
    expect(f.db.getTaskClaim(meta().taskId, owner.entityId)?.status).toBe("submitted");
    expect(meta().verification).toBe("missing");
  });

  it("uses existing files as the baseline in a plain directory", async () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    await begin();
    await send("code summary Existing files already answer the question");
    expect(meta().verification).toBe("not_applicable");
    expect(meta().verificationReason).toBe(NOTHING);
  });

  it("never infers no changes from a missing baseline, an observation error or a sandbox", async () => {
    await begin();
    const original = meta();
    for (const initialWorkspace of [
      undefined,
      { version: 2 as const, reason: "unavailable" },
      // An earlier baseline shape is not trusted either.
      { version: 1, fingerprint: "x" } as never,
    ]) {
      f.db.updateCodingArtifact(run.id, { metadata: { ...original, initialWorkspace } });
      expect((await assessCodingVerification(f.db, current())).verification).toBe("missing");
    }
    f.db.updateCodingArtifact(run.id, { metadata: original });
    expect((await assessCodingVerification(f.db, current(), false)).verification).toBe("missing");
    f.db.updateCodingSession("s", { executionTarget: "flywheel" });
    expect((await assessCodingVerification(f.db, current())).verification).toBe("missing");
    f.db.updateCodingSession("s", {
      executionTarget: "local",
      worktreePath: join(root, "missing"),
    });
    expect((await assessCodingVerification(f.db, current())).verification).toBe("missing");
  });

  it("an attempt begun without an observation keeps its verification", async () => {
    const actor = f.engine.entities.get(owner.entityId)!;
    run = beginCodingRun(f.db, {
      session: f.db.getCodingSession("s")!,
      owner: actor,
      worker: actor,
      prompt: "q",
      profile: "marina",
      verificationRequirement: "checks",
    });
    expect(meta().initialWorkspace?.reason).toBe("the workspace was not observed before dispatch");
    await send("code summary Answer");
    expect(meta().verification).toBe("missing");
  });
});

describe("the workspace observation is bounded", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marina-ws-bound-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const fill = (dir: string, n: number) => {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}`), "x");
  };
  const repo = () => {
    gitIn(root, "init", "--quiet", "--template=");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "a.txt"), "a\n");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "--quiet", "-m", "base");
  };

  it("a plain folder over the limit is not observed, so verification stays required", async () => {
    fill(join(root, "a"), 10);
    const observed = await observeWorkspaceState(root, { entries: 5 });
    expect(observed.source).toBeUndefined();
    expect(observed.reason).toBe("the workspace has more than 5 entries, so it was not observed");
    expect(compareWorkspaceState(observed, observed).kind).toBe("unknown");
  });

  it("past the limit in ignored trees, the source is still compared and the skip is named", async () => {
    repo();
    fill(join(root, "node_modules", "dep"), 50);
    const before = await observeWorkspaceState(root, { ignored: 20 });
    expect(before.source).toBeDefined();
    expect(before.ignoredUnobserved).toContain("more than 20 of them");
    const same = compareWorkspaceState(before, await observeWorkspaceState(root, { ignored: 20 }));
    if (same.kind !== "unchanged") throw new Error(`expected unchanged, got ${same.kind}`);
    expect(noChangeReason(same)).toBe(
      `${NOTHING}; Git-ignored files (such as installed dependencies or build output) were not observed: there are more than 20 of them`,
    );
    writeFileSync(join(root, "a.txt"), "changed\n");
    expect(
      compareWorkspaceState(before, await observeWorkspaceState(root, { ignored: 20 })),
    ).toEqual({
      kind: "changed",
      paths: ["a.txt"],
    });
  });

  it("observes ignored dependencies within the default limit and names an edit to them", async () => {
    repo();
    fill(join(root, "node_modules", "dep"), 50);
    const before = await observeWorkspaceState(root);
    expect(before.ignoredParts).toHaveProperty("node_modules/");
    writeFileSync(join(root, "node_modules", "dep", "f3"), "patched");
    expect(compareWorkspaceState(before, await observeWorkspaceState(root))).toMatchObject({
      kind: "unchanged",
      ignoredChanged: ["node_modules/"],
    });
  });
});
