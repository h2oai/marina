// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { detectProjectRunner } from "../src/coding/project-detection";
import { planPreparation } from "../src/coding/verification-plan";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { resetVisionRateLimits } from "../src/engine/media/vision";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { codingDesk } from "../src/sdk/coding-desk";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);

it("bounds binary reads, accepts authorized absolute paths, and refuses symlink escapes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-image-read-"));
  const root = join(dir, "root");
  mkdirSync(root);
  try {
    const ws = new LocalWorkspace(root);
    writeFileSync(join(root, "diagram.png"), png);
    expect((await ws.readBytes(join(root, "diagram.png"), 20)).data).toEqual(png);
    await expect(ws.readBytes("diagram.png", 4)).rejects.toThrow("byte limit");
    writeFileSync(join(dir, "private.png"), png);
    symlinkSync(join(dir, "private.png"), join(root, "escape.png"));
    await expect(ws.readBytes("escape.png", 20)).rejects.toThrow("escapes");
    await expect(ws.readBytes(join(dir, "private.png"), 20)).rejects.toThrow("explicitly granted");
    await expect(ws.readBytes(".", 20)).rejects.toThrow("regular file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("saves workspace vision before reply, recovers it without model calls, and scopes canvas commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-vision-session-"));
  const root = join(dir, "root"),
    inputs = join(dir, "inputs");
  mkdirSync(root);
  mkdirSync(inputs);
  writeFileSync(join(inputs, "drawing with spaces.png"), png);
  using _state = scopeProcessState({ env: { MARINA_OPEN_API: "true" } });
  const f = createTestEngine();
  resetVisionRateLimits();
  let calls = 0;
  try {
    const owner = f.login("Owner");
    const stranger = f.login("Stranger");
    const ownerEntity = f.engine.entities.get(owner.entityId)!;
    f.db.createCodingSession({
      id: "visual-session",
      title: "Images",
      workspaceRoot: root,
      createdBy: ownerEntity.name,
    });
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        workspaceRegistry: new WorkspaceRegistry({ roots: [root], inputRoots: [inputs] }),
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        describeVisual: async (src, question) => {
          calls++;
          expect(src.data).toEqual(png);
          expect(question).toBe("Read the label");
          return { ok: true, text: "Label: 17 mm", model: "test/vision", kind: "image", notes: [] };
        },
      }),
    );
    const command = `code see ${JSON.stringify({ path: join(inputs, "drawing with spaces.png"), question: "Read the label" })}`;
    const target = { codingTarget: { sessionId: "visual-session" } };
    await f.engine.dispatchCommand(owner.entityId, command, target);
    const evidence = f.db
      .listCodingArtifacts("visual-session")
      .find((a) => a.kind === "visual_evidence")!;
    expect(evidence.content_text).toBe("Label: 17 mm");
    expect(JSON.parse(evidence.metadata_json)).toMatchObject({
      question: "Read the label",
      evidenceTrust: "untrusted",
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (let i = 0; i < 115; i++)
      f.db.createCodingArtifact({
        sessionId: "visual-session",
        kind: "command_output",
        title: "Later command",
        status: "complete",
        contentText: "ok",
        createdBy: ownerEntity.name,
      });
    expect(f.db.listCodingArtifacts("visual-session", 50).some((a) => a.id === evidence.id)).toBe(
      false,
    );
    expect(
      f.db.listCodingArtifacts("visual-session", 5, "visual_evidence").map((a) => a.id),
    ).toEqual([evidence.id]);
    const url = new URL(
      "http://localhost/api/coding/session/visual-session/artifacts?kind=visual_evidence&limit=1",
    );
    const response = await handleDashboardApi(new Request(url), url, "GET", f.engine, f.db);
    expect((await response!.json()).map((a: { id: string }) => a.id)).toEqual([evidence.id]);
    const detailUrl = new URL("http://localhost/api/coding/session/visual-session");
    const detail = await handleDashboardApi(
      new Request(detailUrl),
      detailUrl,
      "GET",
      f.engine,
      f.db,
    );
    expect((await detail!.json()).visualEvidence.map((a: { id: string }) => a.id)).toEqual([
      evidence.id,
    ]);
    await f.engine.dispatchCommand(owner.entityId, `code show ${evidence.id}`, target);
    await f.engine.dispatchCommand(owner.entityId, "code artifacts kind visual_evidence", target);
    expect(calls).toBe(1);
    await f.engine.dispatchCommand(stranger.entityId, command, target);
    expect(calls).toBe(1);
    // Read-only panel definition carries only the session reference and reviewed operation.
    const panel = codingDesk({ sessionId: "visual-session" });
    expect(JSON.stringify(panel)).not.toContain("Label: 17 mm");
    expect(JSON.stringify(panel)).toContain("Review image inspection");
    expect(JSON.stringify(panel)).toContain('"sessionId":"visual-session"');
  } finally {
    await f.dispose();
    resetVisionRateLimits();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("does not invent a Django prerequisite for custom Python runners", () => {
  const profile = detectProjectRunner({ markers: new Set(["setup.py", "tests/runtests.py"]) });
  const plan = planPreparation(profile, "check", {
    installsPermitted: false,
    hostCandidate: false,
  });
  expect(plan.probe).toEqual(["python", "--version"]);
  expect(plan.missingReason).not.toContain("django");
  const django = detectProjectRunner({ markers: new Set(["manage.py"]) });
  expect(
    planPreparation(django, "check", { installsPermitted: false, hostCandidate: false }).probe,
  ).toEqual(["python", "-c", "import django"]);
});
