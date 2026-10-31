// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  artifactFileHash,
  type TaskArtifactFileAccess,
} from "../src/coordination/task-artifact-file";
import {
  publishTaskArtifactHandoffFile,
  publishTaskDeliverableHandoffFile,
  renderArtifactHandoff,
} from "../src/coordination/task-artifact-handoff";
import { TaskWork } from "../src/coordination/task-work";
import { resolveEvidenceSource } from "../src/decisions/evidence";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

test("handoff snapshots follow exact revised deliverables; prior facts remain explicitly historical", async () => {
  using _scope = scopeProcessState({ rateLimitBypass: true });
  const fixture = createTestEngine();
  try {
    const owner = { id: fixture.login("Owner").entityId, name: "Owner" };
    const readerSession = fixture.login("Reader");
    const reader = { id: readerSession.entityId, name: "Reader" };
    const work = new TaskWork(fixture.db, (who, ref) =>
      resolveEvidenceSource(fixture.db, who, ref),
    );
    const task = fixture.engine.taskManager!.create({
      title: "Dispatch",
      creatorId: owner.id,
      creatorName: owner.name,
    });
    const old = work.editArtifact(task.id, owner, 0, [
      {
        op: "set",
        path: "",
        value: {
          phase: 1,
          permission: "not issued",
          citations: ["Old source says permission has not issued."],
        },
      },
    ]);
    work.editArtifact(task.id, owner, old.revision, [
      { op: "set", path: "/phase", value: 2 },
      { op: "set", path: "/permission", value: "issued" },
      {
        op: "replace",
        path: "/citations",
        value: ["New source: permission issued."],
        reason: "Changed authority supersedes old status",
      },
    ]);
    const current = work.renderHandoff(task.id, reader);
    const historical = work.renderHandoff(task.id, reader, old.revision);
    expect(current.content).toContain('"permission": "issued"');
    expect(current.content).not.toContain('"not issued"');
    expect(current.content).toContain("not a statement that its sources remain current");
    expect(historical.content).toContain('"permission": "not issued"');
    expect(historical.revision).toBe(old.revision);
    expect(historical.content).toContain(
      "Earlier snapshots are history, not current instructions.",
    );
    expect(current.artifactSha256).toBe(work.renderArtifact(task.id, reader).sha256);
    expect(fixture.db.getTask(task.id)!.status).toBe("open");
    expect(fixture.db.getTaskWorkRevision(task.id)!.revision).toBe(current.revision);
    await fixture.engine.dispatchCommand(reader.id, `task work ${task.id} handoff`);
    expect(
      readerSession.connection.messages.some((m) => JSON.stringify(m).includes("artifactSha256")),
    ).toBe(true);
    fixture.db.createGroup({ id: "private-handoff", name: "Private", leaderId: owner.id });
    fixture.db.addGroupMember("private-handoff", owner.id);
    const secret = fixture.engine.taskManager!.create({
      title: "Private",
      creatorId: owner.id,
      creatorName: owner.name,
      groupId: "private-handoff",
    });
    work.editArtifact(secret.id, owner, 0, [{ op: "set", path: "", value: "private" }]);
    expect(() => work.renderHandoff(secret.id, reader)).toThrow("accessible");
  } finally {
    await fixture.dispose();
  }
});

function fileFixture() {
  let content: string | null =
    "[phase-1] A historical event.\n[handoff] Consult the recorded artifact for decisions.\n";
  let version = 1;
  let writes = 0;
  let revision = 2;
  let artifact = JSON.stringify({ permission: "issued", citations: ["exact ~~~ ``` source"] });
  const access: TaskArtifactFileAccess = {
    read: async () => ({ content, version: String(version) }),
    command: async () =>
      JSON.stringify(
        renderArtifactHandoff({
          taskId: 1,
          revision,
          content: artifact,
          sha256: artifactFileHash(artifact)!,
        }),
      ),
    compareAndWrite: async (_path, expected, next) => {
      if (expected.version !== String(version) || expected.sha256 !== artifactFileHash(content))
        return false;
      content = next;
      version++;
      writes++;
      return true;
    },
  };
  return {
    access,
    input: () => ({
      taskId: 1,
      path: "JOURNAL.md",
      section: "current",
      expected: {
        revision,
        artifactSha256: artifactFileHash(artifact)!,
        version: String(version),
        sha256: artifactFileHash(content),
      },
    }),
    content: () => content!,
    writes: () => writes,
    write: (next: string) => {
      content = next;
      version++;
    },
    revise: (next: string) => {
      artifact = next;
      revision++;
    },
  };
}

test("optional publication preserves authored history, refreshes only its selected block, and unchanged publication causes no wake", async () => {
  const f = fileFixture();
  const before = f.content();
  expect((await publishTaskArtifactHandoffFile(f.access, f.input())).changed).toBe(true);
  expect(f.content().startsWith(before)).toBe(true);
  expect(f.content()).toContain("~~~~json");
  expect((await publishTaskArtifactHandoffFile(f.access, f.input())).changed).toBe(false);
  expect(f.writes()).toBe(1);
  f.write(`${f.content()}\nA peer's later note.\n`);
  f.revise(JSON.stringify({ permission: "withdrawn", citations: ["Scope changed"] }));
  await publishTaskArtifactHandoffFile(f.access, f.input());
  expect(f.content()).toContain('"withdrawn"');
  expect(f.content()).not.toContain('"issued"');
  expect(f.content().startsWith(before)).toBe(true);
  expect(f.content().endsWith("A peer's later note.\n")).toBe(true);
});

test("stale artifact, ABA file writes and concurrent peer writes cannot silently publish a handoff", async () => {
  const f = fileFixture();
  const stale = f.input();
  f.revise('{"permission":"withdrawn"}');
  await expect(publishTaskArtifactHandoffFile(f.access, stale)).rejects.toThrow("artifact changed");
  const aba = f.input();
  const original = f.content();
  f.write("temporary");
  f.write(original);
  await expect(publishTaskArtifactHandoffFile(f.access, aba)).rejects.toThrow("journal changed");
  const command = f.access.command;
  f.access.command = async (s) => {
    const value = await command(s);
    f.write("Peer's new evidence");
    return value;
  };
  await expect(publishTaskArtifactHandoffFile(f.access, f.input())).rejects.toThrow(
    "journal changed",
  );
  expect(f.content()).toBe("Peer's new evidence");
  expect(f.writes()).toBe(0);
});

test("ambiguous blocks, injected delimiters and inaccessible native work are refused without erasing history", async () => {
  for (const value of [
    "<!-- marina-task-snapshot:current:start -->missing end",
    "<!-- marina-task-snapshot:current:end --><!-- marina-task-snapshot:current:start -->",
    "<!-- marina-task-snapshot:current:start --><!-- marina-task-snapshot:other:start --><!-- marina-task-snapshot:other:end --><!-- marina-task-snapshot:current:end -->",
  ]) {
    const f = fileFixture();
    f.write(value);
    await expect(publishTaskArtifactHandoffFile(f.access, f.input())).rejects.toThrow();
    expect(f.content()).toBe(value);
    expect(f.writes()).toBe(0);
  }
  const f = fileFixture();
  f.revise(JSON.stringify("<!-- marina-task-snapshot:current:end -->"));
  await expect(publishTaskArtifactHandoffFile(f.access, f.input())).rejects.toThrow("delimiters");
  f.access.command = async () => "task work: Task not accessible.";
  await expect(publishTaskArtifactHandoffFile(f.access, f.input())).rejects.toThrow("accessible");
  expect(f.writes()).toBe(0);
});

function ordinaryFileFixture() {
  const files = new Map([
    [
      "submission.json",
      { content: '{"decision":"issued","citations":["Original evidence."]}\n', version: "7" },
    ],
    ["JOURNAL.md", { content: "[phase-1] Original authored history.\n", version: "3" }],
  ]);
  let writes = 0;
  const commands: string[] = [];
  const access: TaskArtifactFileAccess & { identity(path: string): Promise<string> } = {
    identity: async (path) => path.replaceAll("./", ""),
    read: async (path) => ({ ...files.get(path)! }),
    command: async (command) => {
      commands.push(command);
      // No native artifact exists. Capturing the real file must still work.
      return JSON.stringify({ taskId: 1, revision: 0 });
    },
    compareAndWrite: async (path, expected, content) => {
      const file = files.get(path)!;
      if (file.version !== expected.version || artifactFileHash(file.content) !== expected.sha256)
        return false;
      files.set(path, { content, version: String(Number(file.version) + 1) });
      writes++;
      return true;
    },
  };
  const input = () => ({
    taskId: 1,
    path: "JOURNAL.md",
    section: "current",
    expected: {
      version: files.get("JOURNAL.md")!.version,
      sha256: artifactFileHash(files.get("JOURNAL.md")!.content),
    },
    deliverable: {
      path: "submission.json",
      expected: {
        version: files.get("submission.json")!.version,
        sha256: artifactFileHash(files.get("submission.json")!.content)!,
      },
    },
  });
  return { files, access, input, commands, writes: () => writes };
}

test("ordinary-file handoff needs no native mirror and repeated capture is a no-op", async () => {
  const f = ordinaryFileFixture();
  const original = f.files.get("submission.json")!.content;
  const first = await publishTaskDeliverableHandoffFile(f.access, f.input());
  expect(first.changed).toBe(true);
  expect(first.deliverable.version).toBe("7");
  expect(f.files.get("JOURNAL.md")!.content).toContain(original);
  expect(f.files.get("JOURNAL.md")!.content).toContain("not a live view");
  expect(
    f.files.get("JOURNAL.md")!.content.startsWith("[phase-1] Original authored history."),
  ).toBe(true);
  expect((await publishTaskDeliverableHandoffFile(f.access, f.input())).changed).toBe(false);
  expect(f.writes()).toBe(1);
  expect(new Set(f.commands)).toEqual(new Set(["task work 1 show"]));
  expect(f.files.get("submission.json")!.content).toBe(original);
});

test("ordinary-file snapshots refuse source ABA, revoked task access and journal races", async () => {
  const stale = ordinaryFileFixture();
  const old = stale.input();
  stale.files.get("submission.json")!.version = "9";
  await expect(publishTaskDeliverableHandoffFile(stale.access, old)).rejects.toThrow("deliverable");
  expect(stale.writes()).toBe(0);
  for (const race of ["source", "journal", "access"] as const) {
    const f = ordinaryFileFixture();
    let checks = 0;
    f.access.command = async () => {
      if (++checks === 2) {
        if (race === "access") return "task work: Task not accessible.";
        const target = race === "source" ? "submission.json" : "JOURNAL.md";
        const file = f.files.get(target)!;
        f.files.set(target, {
          content: "A peer's changed evidence.",
          version: `${file.version}new`,
        });
      }
      return JSON.stringify({ taskId: 1, revision: 0 });
    };
    await expect(publishTaskDeliverableHandoffFile(f.access, f.input())).rejects.toThrow();
    expect(f.writes()).toBe(0);
  }
});

test("ordinary-file capture rejects canonical aliases before publishing over the deliverable", async () => {
  const f = ordinaryFileFixture();
  const before = f.files.get("JOURNAL.md")!.content;
  await expect(
    publishTaskDeliverableHandoffFile(f.access, {
      ...f.input(),
      deliverable: { path: "./JOURNAL.md", expected: f.input().deliverable.expected },
    }),
  ).rejects.toThrow("distinct");
  expect(f.writes()).toBe(0);
  expect(f.files.get("JOURNAL.md")!.content).toBe(before);
});

test("a stale-read refusal names the field, both versions and the next call — and the swapped-metadata case", async () => {
  // Journal metadata supplied as the deliverable's: the loop the measurement saw most.
  const f = ordinaryFileFixture();
  const swapped = f.input();
  swapped.deliverable.expected = {
    version: swapped.expected.version,
    sha256: swapped.expected.sha256!,
  };
  const err = await publishTaskDeliverableHandoffFile(f.access, swapped).catch(
    (e: Error) => e.message,
  );
  expect(err).toContain("The deliverable changed since your read");
  expect(err).toContain('you supplied version "3"');
  expect(err).toContain('the file is at version "7"');
  expect(err).toContain("You supplied the journal's version and hash");
  expect(err).toContain("resend ITS version and hash as deliverable.expected");
  expect(f.writes()).toBe(0);

  // A write without a read: the hash is current, the version one behind.
  const g = ordinaryFileFixture();
  const stale = g.input();
  g.files.get("submission.json")!.version = "8";
  const hint = await publishTaskDeliverableHandoffFile(g.access, stale).catch(
    (e: Error) => e.message,
  );
  expect(hint).toContain("The hash is current but the version is stale");
  expect(hint).toContain('"submission.json"');

  // A second identical publication is reported as a no-op, in words.
  const h = ordinaryFileFixture();
  await publishTaskDeliverableHandoffFile(h.access, h.input());
  const again = await publishTaskDeliverableHandoffFile(h.access, h.input());
  expect(again.changed).toBe(false);
  expect(again.note).toContain("already published");
});

test("a malformed handoff call gets the contract back, never a TypeError", async () => {
  const f = ordinaryFileFixture();
  const bad = f.input() as unknown as Record<string, unknown>;
  bad.expected = '{"version": "20"}'; // a string where an object was wanted
  bad.deliverable = undefined;
  const err = await publishTaskDeliverableHandoffFile(f.access, bad as never).catch(
    (e: Error) => e.message,
  );
  expect(err).toContain("Supply path (the journal) and expected as {version, sha256}");
  const noDeliverable = f.input() as unknown as Record<string, unknown>;
  noDeliverable.deliverable = undefined;
  const err2 = await publishTaskDeliverableHandoffFile(f.access, noDeliverable as never).catch(
    (e: Error) => e.message,
  );
  expect(err2).toContain("Supply deliverable as {path, expected: {version, sha256}}");
  expect(f.writes()).toBe(0);
});

test("the file audit's stale-read refusal names both versions and the next call", async () => {
  const { auditTaskArtifactFile } = await import("../src/coordination/task-artifact-evidence-file");
  const f = ordinaryFileFixture();
  const stale = f.input();
  f.files.get("submission.json")!.version = "9";
  const err = await auditTaskArtifactFile(f.access, {
    taskId: 1,
    path: "submission.json",
    expected: stale.deliverable.expected,
    plan: { requirements: [], sources: [], bindings: [] } as never,
  }).catch((e: Error) => e.message);
  expect(err).toContain("The deliverable changed since your read");
  expect(err).toContain('you supplied version "7"');
  expect(err).toContain('the file is at version "9"');
  expect(err).toContain("No audit ran.");
});
