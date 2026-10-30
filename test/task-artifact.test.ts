// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type ArtifactEdit,
  artifactAt,
  artifactRuleMatches,
  editTaskArtifact,
  type TaskArtifact,
} from "../src/coordination/task-artifact";
import { artifactFileHash, editTaskArtifactFile } from "../src/coordination/task-artifact-file";
import { TaskWork, type WorkActor } from "../src/coordination/task-work";
import { resolveEvidenceSource } from "../src/decisions/evidence";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

describe("structured task deliverables", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let scope: DisposableStack;
  let work: TaskWork;
  let owner: WorkActor;
  let peer: WorkActor;
  let reader: WorkActor;
  let taskId: number;
  const revision = () => fixture.db.getTaskWorkRevision(taskId)?.revision ?? 0;
  const edit = (ops: ArtifactEdit[], actor = owner, base = revision()) =>
    work.editArtifact(taskId, actor, base, ops);
  const render = (actor = owner) => JSON.parse(work.renderArtifact(taskId, actor).content);
  const initial = () =>
    edit([
      {
        op: "set",
        path: "",
        value: {
          phase: 1,
          decisions: [
            {
              id: "batch",
              value: 50,
              reason: "Initial allocation",
              citations: [{ doc_id: "policy", quote: "Maximum batch size is 37 items." }],
            },
          ],
          dependencies: [{ before: "review", after: "publish" }],
        },
      },
    ]);

  beforeEach(() => {
    scope = scopeProcessState({ rateLimitBypass: true, env: { MARINA_DECISION_VERIFY: "off" } });
    fixture = createTestEngine();
    const actor = (name: string) => ({ name, id: fixture.login(name).entityId });
    owner = actor("Owner");
    peer = actor("Peer");
    reader = actor("Reader");
    taskId = fixture.engine.taskManager!.create({
      title: "Report",
      creatorId: owner.id,
      creatorName: owner.name,
    }).id;
    fixture.engine.taskManager!.claim(taskId, peer.id, peer.name);
    work = new TaskWork(fixture.db, (who, ref) => resolveEvidenceSource(fixture.db, who, ref));
  });

  afterEach(async () => {
    try {
      await fixture.dispose();
    } finally {
      scope.dispose();
    }
  });

  test("native scoped edits render the actual deliverable and retain a peer's citations", async () => {
    initial();
    const base = revision();
    edit([{ op: "set", path: "/phase", value: 2 }]);
    const result = edit([{ op: "set", path: "/decisions/0/value", value: 37 }], peer, base);
    expect(result.rebased).toBe(true);
    expect(render()).toMatchObject({
      phase: 2,
      decisions: [
        { value: 37, citations: [{ doc_id: "policy", quote: "Maximum batch size is 37 items." }] },
      ],
    });
    await fixture.engine.dispatchCommand(
      peer.id as never,
      `task work ${taskId} artifact-edit ${revision()} [{"op":"set","path":"/decisions/0/reason","value":"Reduced to the documented maximum"}]`,
    );
    expect(render().decisions[0].reason).toBe("Reduced to the documented maximum");
    const output = work.renderArtifact(taskId, peer);
    expect(JSON.parse(output.content)).toEqual(render());
    expect(output.sha256).toHaveLength(64);
  });

  test("stale and ABA edits are refused without discarding valid independent changes", () => {
    initial();
    const base = revision();
    edit([{ op: "set", path: "/decisions/0/value", value: 37 }]);
    edit([{ op: "set", path: "/decisions/0/value", value: 50 }]);
    expect(() => edit([{ op: "set", path: "/decisions/0/value", value: 31 }], peer, base)).toThrow(
      "changed",
    );
    edit([{ op: "set", path: "/phase", value: 2 }], peer, base);
    expect(render().decisions[0].value).toBe(50);
    const before = revision();
    expect(() =>
      edit(
        [{ op: "replace", path: "/decisions", value: [], reason: "Remove old decisions" }],
        peer,
        base,
      ),
    ).toThrow("changed");
    expect(revision()).toBe(before);
  });

  test("whole-object replacement requires a reason; a failed batch is atomic", () => {
    initial();
    const before = revision();
    expect(() =>
      edit([{ op: "set", path: "/decisions/0", value: { id: "batch", value: 37 } }]),
    ).toThrow("preserve");
    expect(() =>
      edit([
        { op: "set", path: "/phase", value: 2 },
        { op: "remove", path: "/missing", reason: "obsolete" },
      ]),
    ).toThrow("existing");
    expect(revision()).toBe(before);
    expect(render().phase).toBe(1);
    expect(render().decisions[0].citations).toHaveLength(1);
    edit([
      {
        op: "replace",
        path: "/dependencies",
        value: [],
        reason: "This phase has no blocking edges",
      },
    ]);
    expect(render().dependencies).toEqual([]);
    expect(
      JSON.parse(fixture.db.getTaskWorkRevision(taskId)!.document).artifact.lastEdit.operations[0]
        .reason,
    ).toContain("no blocking");
  });

  test("append using project entries returns an actionable error and preserves the entire batch", () => {
    initial();
    const before = revision();
    const malformed = JSON.parse(
      '{"op":"append","path":"/decisions/0/citations","entries":[{"doc_id":"source","quote":"Exact supporting source."}]}',
    );
    expect(() => edit([{ op: "set", path: "/phase", value: 2 }, malformed])).toThrow(
      "append requires value",
    );
    expect(revision()).toBe(before);
    expect(render().phase).toBe(1);
    expect(render().decisions[0].citations).toHaveLength(1);
  });

  test("idempotent appends and unchanged edits create no extra revision", () => {
    initial();
    const before = revision();
    edit([
      {
        op: "append",
        path: "/decisions/0/citations",
        value: { doc_id: "policy", quote: "Maximum batch size is 37 items." },
      },
    ]);
    edit([{ op: "set", path: "/decisions/0/value", value: 50 }]);
    expect(revision()).toBe(before);
    expect(render().decisions[0].citations).toHaveLength(1);
  });

  test("array structure changes invalidate old numeric-index edits", () => {
    initial();
    edit([{ op: "append", path: "/decisions", value: { id: "other", value: 2 } }]);
    const base = revision();
    edit([{ op: "remove", path: "/decisions/0", reason: "No longer part of this report" }]);
    expect(() => edit([{ op: "set", path: "/decisions/1/value", value: 3 }], peer, base)).toThrow(
      "changed",
    );
    expect(render().decisions).toEqual([{ id: "other", value: 2 }]);
  });

  test("declared checks expose contradictions and reuse receipts without becoming approval gates", async () => {
    initial();
    const quote = "Maximum batch size is 37 items.";
    const note = fixture.db.createNote(owner.name, quote);
    work.declareArtifactRule(taskId, owner, revision(), {
      id: "batch-bound",
      path: "/decisions/0/value",
      op: "lte",
      expected: 37,
      source: { ref: `note:${note}`, quote },
    });
    expect(work.checkArtifact(taskId, owner).report.outcome).toBe("discrepancies");
    expect(work.checkArtifact(taskId, owner).reused).toBe(true);
    edit([{ op: "set", path: "/decisions/0/value", value: 37 }]);
    expect(work.checkArtifact(taskId, owner)).toMatchObject({
      reused: false,
      report: { outcome: "matches-declared-checks" },
    });
    expect(work.checkArtifact(taskId, owner).reused).toBe(true);
    expect(work.checkArtifact(taskId, peer).report.outcome).toBe("unverified");
    const view = work.show(taskId, peer).artifact!;
    expect(view.rules[0]!.source).toEqual({ ref: `note:${note}`, status: "unavailable" });
    const exported = work.renderArtifact(taskId, peer);
    expect(JSON.stringify(exported.rules)).not.toContain("sourceVersion");
    expect(JSON.stringify(exported.rules)).not.toContain('"start"');
    edit([{ op: "set", path: "/decisions/0/value", value: 99 }]);
    await fixture.engine.dispatchCommand(
      peer.id as never,
      `task submit ${taskId} Alternate plan for review`,
    );
    await fixture.engine.dispatchCommand(owner.id as never, `task approve ${taskId} Peer`);
    expect(fixture.db.getTask(taskId)!.status).toBe("completed");
  });

  test("shape changes and source revisions invalidate advisory results without aborting", () => {
    initial();
    const note = fixture.db.createNote(owner.name, "The label must be present.");
    work.declareArtifactRule(taskId, owner, revision(), {
      id: "label",
      path: "/dependencies/label",
      op: "required",
    });
    work.declareArtifactRule(taskId, owner, revision(), {
      id: "source",
      path: "/phase",
      op: "eq",
      expected: 1,
      source: { ref: `note:${note}`, quote: "The label must be present." },
    });
    expect(work.checkArtifact(taskId, owner).report.checks[0]!.status).toBe("discrepancy");
    const checked = work.checkArtifact(taskId, owner);
    expect(checked.reused).toBe(true);
    fixture.db.reviseNote(owner.name, note, "Changed source.");
    const changed = work.checkArtifact(taskId, owner);
    expect(changed.reused).toBe(false);
    expect(changed.report.checks[1]!.status).toBe("unverified");
  });

  test("requirements are explicit, removable with audit, and changes invalidate receipts", () => {
    initial();
    work.declareArtifactRule(taskId, owner, revision(), {
      id: "phase",
      path: "/phase",
      op: "eq",
      expected: 2,
    });
    work.declareArtifactRule(taskId, owner, revision(), {
      id: "edges",
      path: "/dependencies",
      op: "setEquals",
      expected: [],
    });
    const failed = work.checkArtifact(taskId, owner);
    expect(failed.report.checks.map((check) => check.status)).toEqual([
      "discrepancy",
      "discrepancy",
    ]);
    expect(() => work.removeArtifactRule(taskId, reader, revision(), "phase", "changed")).toThrow(
      "author",
    );
    work.removeArtifactRule(
      taskId,
      owner,
      revision(),
      "phase",
      "Requirement moved to the next phase",
    );
    expect(work.checkArtifact(taskId, owner).reused).toBe(false);
    expect(work.checkArtifact(taskId, owner).report.checks).toHaveLength(1);
    expect(work.renderArtifact(taskId, owner, 1).rules).toHaveLength(0);
  });

  test("reader permissions do not become edit permissions and existing group ACLs apply", () => {
    initial();
    expect(() => edit([{ op: "set", path: "/phase", value: 2 }], reader)).toThrow("claimant");
    fixture.db.createGroup({ id: "private-report", name: "Private report", leaderId: owner.id });
    fixture.db.addGroupMember("private-report", owner.id);
    const privateId = fixture.engine.taskManager!.create({
      title: "Private",
      creatorId: owner.id,
      creatorName: owner.name,
      groupId: "private-report",
    }).id;
    work.editArtifact(privateId, owner, 0, [
      { op: "set", path: "", value: { secret: "authored" } },
    ]);
    expect(() => work.renderArtifact(privateId, reader)).toThrow("accessible");
    expect(() => work.checkArtifact(privateId, reader)).toThrow("accessible");
  });

  test("explicit source selections publish exact text atomically, preserving previous citations", () => {
    initial();
    const source = fixture.db.createNote(
      owner.name,
      JSON.stringify({ doc_id: "capacity", statements: ["Measured capacity is 37 items."] }),
    );
    const before = revision();
    const selection: ArtifactEdit = {
      op: "source",
      path: "/decisions/0/citations",
      ref: `note:${source}`,
      pick: { doc_id: "/doc_id", quote: "/statements/0" },
    };
    expect(() => edit([selection], peer)).toThrow("unavailable");
    expect(revision()).toBe(before);
    expect(() =>
      edit([
        { op: "set", path: "/phase", value: 2 },
        { ...selection, pick: { quote: "/missing" } },
      ]),
    ).toThrow("not found");
    expect(render().phase).toBe(1);
    edit([selection]);
    expect(render(peer).decisions[0].citations).toEqual([
      { doc_id: "policy", quote: "Maximum batch size is 37 items." },
      { doc_id: "capacity", quote: "Measured capacity is 37 items." },
    ]);
    const after = revision();
    edit([selection]);
    expect(revision()).toBe(after);
    expect(
      JSON.parse(fixture.db.getTaskWorkRevision(taskId)!.document).artifact.lastEdit.operations[0]
        .ref,
    ).toBe(`note:${source}`);
  });

  test("the optional file adapter adopts an existing deliverable and writes scoped edits directly", async () => {
    let file: string | null = JSON.stringify({
      items: [{ value: 50, citations: ["peer evidence"] }],
    });
    const command = async (text: string) => {
      if (text.endsWith(" show")) return JSON.stringify(work.show(taskId, owner));
      const parsed = /artifact-edit (\d+) ([\s\S]+)/.exec(text)!;
      return JSON.stringify(
        work.editArtifact(taskId, owner, Number(parsed[1]), JSON.parse(parsed[2]!)),
      );
    };
    let generation = 0;
    const observed = () => ({
      revision: revision(),
      version: String(generation),
      sha256: artifactFileHash(file),
    });
    const access = {
      read: async () => ({ content: file, version: String(generation) }),
      command,
      compareAndWrite: async (
        _path: string,
        expected: { version: string; sha256: string | null },
        content: string,
      ) => {
        if (artifactFileHash(file) !== expected.sha256 || String(generation) !== expected.version)
          return false;
        file = content;
        generation++;
        return true;
      },
    };
    const original = observed();
    const updated = await editTaskArtifactFile(access, {
      taskId,
      path: "report.json",
      expected: original,
      edits: [{ op: "set", path: "/items/0/value", value: 37 }],
    });
    expect(JSON.parse(file!)).toEqual({ items: [{ value: 37, citations: ["peer evidence"] }] });
    expect(updated.content).toBe(file!);
    expect(updated.feedback).toMatchObject({
      advisory: true,
      checkedRevision: updated.revision,
      outcome: "unverified",
      findings: expect.arrayContaining([expect.objectContaining({ id: "coverage-undeclared" })]),
    });
    const before = revision();
    await expect(
      editTaskArtifactFile(access, {
        taskId,
        path: "report.json",
        expected: original,
        edits: [{ op: "set", path: "/items/0/value", value: 31 }],
      }),
    ).rejects.toThrow("changed since");
    expect(revision()).toBe(before);
    file = JSON.stringify({ items: [{ value: 35, citations: ["new ordinary file edit"] }] });
    generation++;
    await editTaskArtifactFile(access, {
      taskId,
      path: "report.json",
      expected: observed(),
      edits: [{ op: "set", path: "/items/0/value", value: 31 }],
    });
    expect(render()).toEqual(JSON.parse(file!));
    expect(render().items[0].citations).toEqual(["new ordinary file edit"]);
    const oldFile = observed();
    const priorContent = file;
    file = "{}";
    generation++;
    file = priorContent;
    generation++;
    await expect(
      editTaskArtifactFile(access, {
        taskId,
        path: "report.json",
        expected: oldFile,
        edits: [{ op: "set", path: "/items/0/value", value: 29 }],
      }),
    ).rejects.toThrow("changed since");
    const oldNative = observed();
    edit([{ op: "set", path: "/items/0/value", value: 32 }]);
    edit([{ op: "set", path: "/items/0/value", value: 31 }]);
    await expect(
      editTaskArtifactFile(access, {
        taskId,
        path: "report.json",
        expected: oldNative,
        edits: [{ op: "set", path: "/items/0/value", value: 29 }],
      }),
    ).rejects.toThrow("Native work changed");
    const latest = file;
    await expect(
      editTaskArtifactFile(
        { ...access, compareAndWrite: async () => false },
        {
          taskId,
          path: "report.json",
          expected: observed(),
          edits: [{ op: "set", path: "/items/0/value", value: 30 }],
        },
      ),
    ).rejects.toThrow("publication was not confirmed");
    expect(file).toBe(latest);
    expect(render().items[0].value).toBe(30);
    await expect(
      editTaskArtifactFile(
        {
          ...access,
          compareAndWrite: async () => {
            throw new Error("disk full");
          },
        },
        {
          taskId,
          path: "report.json",
          expected: observed(),
          edits: [{ op: "set", path: "/items/0/value", value: 28 }],
        },
      ),
    ).rejects.toThrow("Native revision");
    expect(file).toBe(latest);
    expect(render().items[0].value).toBe(28);
  });
});

test("artifact JSON Pointer paths reject prototype pollution, invalid indices and non-JSON data", () => {
  const value = { "a/b": { "~key": 1 }, rows: [1], toString: "literal" };
  expect(artifactAt(value, "/a~1b/~0key")).toEqual({ present: true, value: 1 });
  expect(artifactAt(value, "/toString")).toEqual({ present: true, value: "literal" });
  expect(() => artifactAt(value, "/__proto__/polluted")).toThrow("Unsupported");
  expect(() => artifactAt(value, "/rows/01")).toThrow("numeric");
  const state = { value, pathRevisions: {}, rules: [] };
  expect(() =>
    editTaskArtifact(state, [{ op: "set", path: "/bad", value: Number.NaN }], 0, 1),
  ).toThrow("finite JSON");
  expect(() =>
    editTaskArtifact(
      state,
      [{ op: "set", path: "/bad", value: JSON.parse('{"__proto__":{"polluted":true}}') }],
      0,
      1,
    ),
  ).toThrow("Unsupported");
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("incremental nesting respects the full artifact depth bound atomically", () => {
  let state: TaskArtifact = { value: {}, pathRevisions: {}, rules: [] };
  for (let i = 1; i <= 64; i++)
    state = editTaskArtifact(
      state,
      [{ op: "set", path: "/a".repeat(i), value: {} }],
      i - 1,
      i,
    ).artifact;
  expect(() =>
    editTaskArtifact(state, [{ op: "set", path: "/a".repeat(65), value: {} }], 64, 65),
  ).toThrow("deeply");
  expect(artifactAt(state.value, "/a".repeat(64))).toEqual({ present: true, value: {} });
  expect(
    artifactRuleMatches({ rows: [] }, { id: "label", path: "/rows/label", op: "required" }),
  ).toBe(false);
});
