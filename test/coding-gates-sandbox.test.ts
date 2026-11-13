// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The repository's gates under the bubblewrap sandbox runner: the candidate snapshot, the
// base re-run and a native turn's gates all run inside the sandbox; dependencies the
// workspace installed are copied in (no network, no host install); a refused sandbox says why.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryGates, verifyNativeTurn } from "../scripts/code";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { setSandboxDefaultsForTests } from "../src/coding/sandbox-workspace";
import { beginCodingRun, codingRunMetadata } from "../src/coding/task-run";
import { executePreparation } from "../src/coding/verification-plan";
import { VerificationRunner } from "../src/coding/verification-runner";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { observeWorkspaceState } from "../src/coding/workspace-state";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import type { CodingArtifactRow } from "../src/persistence/database";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { git as gitIn } from "./git-helpers";
import { scopeProcessState } from "./process-state";

function bwrapWorks(): boolean {
  const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path));
  if (!bwrap || !existsSync("/usr/bin/prlimit")) return false;
  const probe = Bun.spawnSync(
    [bwrap, "--unshare-all", "--unshare-user", "--disable-userns", "--ro-bind", "/", "/", "true"],
    { stdout: "ignore", stderr: "ignore" },
  );
  return probe.exitCode === 0;
}

const unit = (name: string, body: string) =>
  `import { expect, test } from "bun:test";\nimport { label } from "./src";\nimport { dep } from "dep";\ntest(${JSON.stringify(name)}, () => { ${body} });\n`;

describe.skipIf(!bwrapWorks())("repository gates in the bubblewrap sandbox", () => {
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
      env: {
        MARINA_AUTONOMY: "guarded",
        MARINA_CHALLENGES: "off",
        MARINA_CODE_SANDBOX: "default",
      },
    });
    root = mkdtempSync(join(tmpdir(), "marina-gates-sbx-"));
    gitIn(root, "init", "--quiet", "--template=");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" }, dependencies: { dep: "1.0.0" } }),
    );
    writeFileSync(join(root, "src.ts"), 'export const label = "ok";\n');
    writeFileSync(join(root, "label.test.ts"), unit("label", 'expect(label + dep).toBe("ok!");'));
    // Installed in the workspace only: the snapshot must get it without a network.
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "dep", "package.json"),
      '{"name":"dep","main":"index.js"}',
    );
    writeFileSync(join(root, "node_modules", "dep", "index.js"), 'exports.dep = "!";\n');
    gitIn(root, "add", ".");
    gitIn(root, "commit", "--quiet", "-m", "base");
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
    setSandboxDefaultsForTests();
    await f.dispose();
    rmSync(root, { recursive: true, force: true });
    state.dispose();
  });
  const send = (command: string) =>
    f.engine.processCommand(owner.entityId, command, {
      codingTarget: { sessionId: "s", ...(run ? { runId: run.id } : {}) },
    });
  async function begin() {
    const actor = f.engine.entities.get(owner.entityId)!;
    run = beginCodingRun(f.db, {
      session: f.db.getCodingSession("s")!,
      owner: actor,
      worker: actor,
      prompt: "Change the code",
      profile: "marina",
      verificationRequirement: "candidate",
      verificationGates: "repository",
      initialWorkspace: await observeWorkspaceState(root),
    });
  }
  async function verify() {
    await send("code verify candidate");
    await f.engine.drainCommands();
    const result = f.db
      .listCodingRunArtifacts(run!.id)
      .filter((a) => a.kind === "verification")
      .at(-1);
    if (!result) throw new Error(output.map((p) => p.data?.text).join("\n"));
    return {
      text: result.content_text,
      meta: JSON.parse(result.metadata_json) as {
        outcome: string;
        outcomeReason: string;
        executionRunner?: { kind: string };
        preparation?: { reason?: string };
        preexistingOnly?: boolean;
      },
    };
  }

  it("verifies inside the sandbox, with the workspace's installed dependencies copied in", async () => {
    await begin();
    writeFileSync(join(root, "src.ts"), 'export const label = "ok"; // tidy\n');
    const { meta } = await verify();
    expect(meta.executionRunner?.kind).toBe("sandbox");
    expect(meta.preparation?.reason).toContain("Copied the workspace's installed dependencies");
    expect(meta.outcome).toBe("passed");
    await send("code summary Done");
    expect(codingRunMetadata(f.db.getCodingArtifact(run!.id)!).verification).toBe("passed");
  });

  it("re-runs a failed gate on the base inside the sandbox and labels a pre-existing failure", async () => {
    writeFileSync(join(root, "label.test.ts"), unit("label", 'expect(label + dep).toBe("x");'));
    gitIn(root, "commit", "--quiet", "-am", "red base");
    await begin();
    writeFileSync(join(root, "src.ts"), 'export const label = "ok"; // tidy\n');
    const { meta, text } = await verify();
    expect(meta.executionRunner?.kind).toBe("sandbox");
    expect(meta.preexistingOnly).toBe(true);
    expect(text).toContain("PRE-EXISTING:");
  });

  it("says why when the sandbox refuses the snapshot", async () => {
    setSandboxDefaultsForTests({ bwrapPaths: ["/nonexistent/bwrap"] });
    await begin();
    writeFileSync(join(root, "src.ts"), 'export const label = "ok"; // tidy\n');
    await send("code verify candidate");
    await f.engine.drainCommands();
    const said = [
      ...output.map((p) => String(p.data?.text ?? "")),
      ...f.db.listCodingRunArtifacts(run!.id).map((a) => a.content_text),
    ].join("\n");
    expect(said).toContain("needs bubblewrap");
    // The run's own verification states the sandbox's reason, not a generic error.
    await send("code summary Done");
    expect(codingRunMetadata(f.db.getCodingArtifact(run!.id)!).verificationReason).toContain(
      "needs bubblewrap",
    );
    expect(codingRunMetadata(f.db.getCodingArtifact(run!.id)!).verification).not.toBe("passed");
  });

  it("runs a native turn's gates in the sandbox too", async () => {
    const baseline = await observeWorkspaceState(root);
    writeFileSync(join(root, "src.ts"), 'export const label = "ok"; // native\n');
    let seen: Perception | undefined;
    const end = await verifyNativeTurn({
      dir: root,
      baseline,
      gates: repositoryGates(root),
      deadlineAt: Date.now() + 120_000,
      subscribe: (handler) => {
        finished = (p) => {
          seen = p;
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
        await f.engine.drainCommands();
        return admitted;
      },
    });
    if (end === "timeout") throw new Error("timeout");
    expect(end.verification).toBe("passed");
    const resultId = (seen?.data?.code as { metadata?: { gates?: { resultId?: string } } })
      ?.metadata?.gates?.resultId;
    const evidence = JSON.parse(f.db.getCodingArtifact(resultId!)!.metadata_json) as {
      executionRunner?: { kind: string };
    };
    expect(evidence.executionRunner?.kind).toBe("sandbox");
  });
});

describe("dependencies for a sandboxed snapshot", () => {
  it("takes the checkout's installed trees when the session worktree has none", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "marina-deps-checkout-"));
    const worktree = mkdtempSync(join(tmpdir(), "marina-deps-worktree-"));
    const snapshot = mkdtempSync(join(tmpdir(), "marina-deps-snapshot-"));
    try {
      for (const dir of [checkout, worktree]) {
        gitIn(dir, "init", "--quiet", "--template=");
        writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      }
      mkdirSync(join(checkout, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(checkout, "node_modules", "dep", "index.js"), "1");
      const result = await executePreparation(
        {
          mode: "auto",
          language: "javascript",
          probe: ["test", "-d", "node_modules"],
          missingReason: "none",
          copyDependencies: { from: [worktree, checkout], to: snapshot },
        },
        {
          runPreparationStep: async (argv) => ({
            command: argv,
            exitCode: existsSync(join(snapshot, "node_modules")) ? 0 : 1,
            output: "",
            truncated: false,
            timedOut: false,
            durationMs: 1,
          }),
        },
      );
      expect(result.status).toBe("ready");
      expect(result.reason).toContain("Copied the workspace's installed dependencies");
      expect(existsSync(join(snapshot, "node_modules", "dep", "index.js"))).toBe(true);
    } finally {
      for (const dir of [checkout, worktree, snapshot])
        rmSync(dir, { recursive: true, force: true });
    }
  });
});
