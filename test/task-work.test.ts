// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TaskWork, WORK_CHECK_TTL_MS, type WorkActor } from "../src/coordination/task-work";
import type { WorkAction } from "../src/coordination/task-work-types";
import { resolveEvidenceSource } from "../src/decisions/evidence";
import { CanvasReadGrants } from "../src/engine/canvas-access";
import { withEvidenceCutoff } from "../src/engine/evidence-fence";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

describe("optional shared task work", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  let work: TaskWork;
  let owner: WorkActor;
  let worker: WorkActor;
  let peer: WorkActor;
  let taskId: number;

  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true, env: { MARINA_DECISION_VERIFY: "off" } });
    fixture = createTestEngine();
    const actor = (name: string): WorkActor => ({ name, id: fixture.login(name).entityId });
    owner = actor("Owner");
    worker = actor("Worker");
    peer = actor("Peer");
    const tasks = fixture.engine.taskManager!;
    taskId = tasks.create({
      title: "Restoration",
      creatorId: owner.id,
      creatorName: owner.name,
    }).id;
    tasks.claim(taskId, worker.id, worker.name);
    work = new TaskWork(fixture.db, (who, ref) => resolveEvidenceSource(fixture.db, who, ref));
  });

  afterEach(async () => {
    try {
      await fixture.dispose();
    } finally {
      state.dispose();
    }
  });

  const revision = () => fixture.db.getTaskWorkRevision(taskId)?.revision ?? 0;
  const raw = () => (fixture.db as unknown as { db: Database }).db;
  const apply = (who: WorkActor, action: WorkAction) => work.apply(taskId, who, revision(), action);

  test("journal entries are the task's own record and the prose audit reads them", () => {
    const policy = "Only verified originals count toward liability.";
    const amount = "The verified liability is 75 dollars.";
    const contract = source(
      JSON.stringify({ requirements: [{ key: "liability", facts: [["policy", "amount"]] }] }),
    );
    const ledger = source(JSON.stringify({ id: "ledger", statements: [policy, amount] }));
    const plan = {
      requirements: { ref: contract, path: "/requirements", key: "/key", bundles: "/facts" },
      targets: {
        path: "/items",
        key: "/key",
        citations: "/cites",
        document: "/doc",
        quote: "/quote",
      },
      sources: [{ ref: ledger, document: "/id", text: "/statements" }],
      bindings: [
        { fact: "policy", ref: ledger, path: "/statements/0" },
        { fact: "amount", ref: ledger, path: "/statements/1" },
      ],
    };
    expect(() => work.auditProse(taskId, worker, { journal: true, plan })).toThrow(
      "no journal entries",
    );
    apply(worker, { kind: "journal", text: `Read the ledger: "${policy}" Liability still open.` });
    apply(worker, { kind: "journal", text: `Confirmed "${amount}" — next owner files it.` });
    const entries = work.show(taskId, owner).journal ?? [];
    expect(entries.map((e) => [e.id, e.authorName])).toEqual([
      ["j1", "Worker"],
      ["j2", "Worker"],
    ]);
    const audited = work.auditProse(taskId, owner, { journal: true, plan });
    expect(audited.target.name).toBe(`task:${taskId}:journal`);
    expect(audited.outcome).toBe("matches-declared-evidence");
    expect(audited.obligations).toEqual([{ id: "liability", missing: [[]], complete: true }]);
    const named = work.auditProse(taskId, owner, {
      target: { name: "handoff.md", content: `Liability is 75 dollars; see "${policy}".` },
      plan,
    });
    expect(named.outcome).toBe("discrepancies");
    expect(named.obligations[0]!.missing).toEqual([["amount"]]);
    expect(() => work.auditProse(taskId, owner, { plan })).toThrow("journal: true");
  });
  function source(content: string, shared = true) {
    if (shared && !fixture.db.getMemoryPoolById("work-pool"))
      fixture.db.createMemoryPool("work-pool", "work", owner.name);
    return `note:${fixture.db.createNote(owner.name, content, undefined, shared ? { poolId: "work-pool" } : undefined)}`;
  }
  function declaredAssignment() {
    const quote = "Inez must continue read-only diagnostics.";
    const ref = source(quote);
    apply(worker, { kind: "patch", patch: { Inez: "reserve" } });
    apply(owner, { kind: "cite", field: "Inez", ref, quote });
    const citation = work.show(taskId, owner).citations.at(-1)!.id;
    apply(owner, {
      kind: "expect",
      field: "Inez",
      op: "eq",
      expected: "read-only diagnostics",
      citation,
    });
    return { ref, quote, citation };
  }

  test("native commands flag a contradiction, preserve citations on correction and leave approval autonomous", async () => {
    const { citation } = declaredAssignment();
    const send = (actor: WorkActor, command: string) =>
      fixture.engine.dispatchCommand(actor.id as never, command);
    await send(worker, `task work ${taskId} check`);
    const initial = work.check(taskId, worker);
    expect(initial.report.outcome).toBe("discrepancies");
    expect(initial.report.checks[0]).toMatchObject({
      actual: "reserve",
      expected: "read-only diagnostics",
      status: "contradiction",
    });
    await send(worker, `task work ${taskId} patch ${revision()} {"Inez":"read-only diagnostics"}`);
    expect(work.show(taskId, owner).citations.map((entry) => entry.id)).toEqual([citation]);
    const corrected = work.check(taskId, worker);
    expect(corrected.reused).toBe(false);
    expect(corrected.report.outcome).toBe("consistent");
    expect(work.check(taskId, worker).reused).toBe(true);
    // A subsequent contradictory draft still does not become a new approval gate.
    apply(worker, { kind: "patch", patch: { Inez: "reserve" } });
    expect(work.check(taskId, worker).report.outcome).toBe("discrepancies");
    await send(worker, `task submit ${taskId} Deliberate alternate plan for owner review`);
    await send(owner, `task approve ${taskId} Worker`);
    expect(fixture.db.getTask(taskId)!.status).toBe("completed");
  });

  test("peer proposals change only their fields and cannot overwrite an intervening edit", () => {
    apply(worker, { kind: "patch", patch: { traffic: 20, replicas: 3 } });
    expect(() => apply(peer, { kind: "patch", patch: { traffic: 10 } })).toThrow("propose");
    apply(peer, { kind: "propose", patch: { traffic: 10 } });
    const proposal = work.show(taskId, owner).proposals[0]!;
    apply(worker, { kind: "patch", patch: { replicas: 2 } });
    apply(worker, { kind: "accept", id: proposal.id });
    expect(work.show(taskId, worker).fields).toEqual({ traffic: 10, replicas: 2 });
    apply(peer, { kind: "propose", patch: { traffic: 5 } });
    const stale = work.show(taskId, owner).proposals.at(-1)!;
    apply(worker, { kind: "patch", patch: { traffic: 0 } });
    const before = revision();
    expect(() => apply(worker, { kind: "accept", id: stale.id })).toThrow("stale");
    expect(revision()).toBe(before);
    expect(work.show(taskId, worker).fields.traffic).toBe(0);
    // Returning to the old value does not revive an obsolete proposal (ABA).
    apply(worker, { kind: "patch", patch: { traffic: 10 } });
    expect(() => apply(worker, { kind: "accept", id: stale.id })).toThrow("stale");
  });

  test("proposals accept valid names inherited by ordinary JavaScript objects", () => {
    const patch = { toString: "plain text", hasOwnProperty: true, valueOf: 2 };
    apply(peer, { kind: "propose", patch });
    apply(worker, { kind: "accept", id: work.show(taskId, worker).proposals[0]!.id });
    expect(work.show(taskId, worker).fields).toEqual(patch);
    apply(peer, { kind: "propose", patch: { toString: "updated" } });
    apply(worker, { kind: "accept", id: work.show(taskId, worker).proposals[1]!.id });
    expect(work.show(taskId, worker).fields).toEqual({ ...patch, toString: "updated" });
  });

  test("task sources follow requirement edits and current group access", () => {
    fixture.db.createGroup({ id: "source-group", name: "Sources", leaderId: owner.id });
    fixture.db.addGroupMember("source-group", owner.id);
    fixture.db.addGroupMember("source-group", peer.id);
    const sourceTask = fixture.engine.taskManager!.create({
      title: "Source requirements",
      description: "Maximum traffic is 10 percent.",
      creatorId: owner.id,
      creatorName: owner.name,
      groupId: "source-group",
    });
    apply(worker, { kind: "patch", patch: { traffic: 10 } });
    apply(owner, {
      kind: "cite",
      field: "traffic",
      ref: `task:${sourceTask.id}`,
      quote: "Maximum traffic is 10 percent.",
    });
    apply(owner, { kind: "expect", field: "traffic", op: "lte", expected: 10, citation: "c2" });
    expect(work.check(taskId, peer).report.outcome).toBe("consistent");
    expect(work.check(taskId, peer).reused).toBe(true);
    raw().run("UPDATE tasks SET description=? WHERE id=?", [
      "Maximum traffic is 5 percent.",
      sourceTask.id,
    ]);
    expect(work.check(taskId, peer)).toMatchObject({
      reused: false,
      report: { outcome: "unverified" },
    });
    expect(work.show(taskId, peer).citations[0]).toMatchObject({ status: "changed" });
    expect(work.show(taskId, peer).citations[0]!.quote).toBeUndefined();
    fixture.db.removeGroupMember("source-group", peer.id);
    expect(work.show(taskId, peer, 2).citations[0]).toMatchObject({ status: "unavailable" });
    expect(work.check(taskId, peer).reused).toBe(false);
  });

  test("chronicle corrections invalidate the original source without deleting its citation", () => {
    const quote = "Maximum traffic is 10 percent.";
    const original = fixture.db.appendChronicle({
      kind: "narrative",
      source: owner.name,
      title: "Traffic",
      body: quote,
    });
    apply(worker, { kind: "patch", patch: { traffic: 10 } });
    apply(owner, { kind: "cite", field: "traffic", ref: `chronicle:${original}`, quote });
    apply(owner, { kind: "expect", field: "traffic", op: "lte", expected: 10, citation: "c2" });
    expect(work.check(taskId, peer).report.outcome).toBe("consistent");
    fixture.db.appendChronicle({
      kind: "correction",
      source: owner.name,
      title: "Traffic correction",
      body: "Maximum traffic is 5 percent.",
      supersedes: original,
    });
    expect(work.check(taskId, peer)).toMatchObject({
      reused: false,
      report: { outcome: "unverified" },
    });
    expect(work.show(taskId, peer).citations).toHaveLength(1);
    expect(work.show(taskId, peer, 2).citations[0]).toMatchObject({ status: "superseded", quote });
  });

  test("asset edits and expiring live read grants invalidate receipts and historical source visibility", () => {
    const assetId = "6f1c2b9e-1111-4222-8333-944445555666";
    const quote = "Maximum traffic is 10 percent.";
    fixture.db.createAsset({
      id: assetId,
      entityName: owner.name,
      filename: "requirements.txt",
      mimeType: "text/plain",
      size: 0,
      storageKey: "test-work-source",
    });
    fixture.db.updateAssetText(assetId, { caption: quote });
    fixture.db.createCanvas({
      id: "work-private",
      name: "Private sources",
      scope: "entity",
      scopeId: owner.id,
      creatorName: owner.name,
    });
    fixture.db.createNode({
      id: "work-source-node",
      canvasId: "work-private",
      type: "image",
      assetId,
      creatorName: owner.name,
    });
    let grantTime = Date.now();
    const grants = new CanvasReadGrants(() => grantTime);
    grants.grant({
      nodeIds: ["work-source-node"],
      principals: [peer.id],
      ttlMs: 60_000,
      reason: "Review source",
    });
    work = new TaskWork(fixture.db, (who, ref) =>
      resolveEvidenceSource(fixture.db, who, ref, {
        canvas: { db: fixture.db, entities: fixture.engine.entities, canvasGrants: grants },
      }),
    );
    apply(worker, { kind: "patch", patch: { traffic: 10 } });
    apply(owner, { kind: "cite", field: "traffic", ref: `asset:${assetId}`, quote });
    apply(owner, { kind: "expect", field: "traffic", op: "lte", expected: 10, citation: "c2" });
    expect(work.check(taskId, peer).report.outcome).toBe("consistent");
    expect(work.check(taskId, peer).reused).toBe(true);
    fixture.db.updateAssetText(assetId, { caption: "Maximum traffic is 5 percent." });
    expect(work.check(taskId, peer)).toMatchObject({
      reused: false,
      report: { outcome: "unverified" },
    });
    expect(work.show(taskId, peer).citations[0]).toMatchObject({ status: "changed" });
    expect(work.show(taskId, peer, 2).citations[0]!.quote).toBeUndefined();
    grantTime += 60_000;
    expect(work.check(taskId, peer)).toMatchObject({
      reused: false,
      report: { outcome: "unverified" },
    });
    const historical = work.show(taskId, peer, 2).citations[0]!;
    expect(historical.status).toBe("unavailable");
    expect(historical.quote).toBeUndefined();
    expect(historical).not.toHaveProperty("sourceVersion");
    expect(historical).not.toHaveProperty("start");
    expect(historical).not.toHaveProperty("end");
    expect(work.show(taskId, owner).citations[0]!.status).toBe("changed");
  });

  test("the complete command workflow preserves exact JSON quotations and emits no peer wake-up", async () => {
    const observer = fixture.login("Observer");
    observer.connection.clear();
    const quote = 'Allowed staffing:\nInez performs "read-only" diagnostics.';
    const ref = source(quote);
    const send = (who: WorkActor, suffix: string) =>
      fixture.engine.dispatchCommand(who.id as never, `task work ${taskId} ${suffix}`);
    await send(worker, 'patch 0 {"Inez":"reserve"}');
    await send(owner, `cite 1 ${JSON.stringify({ field: "Inez", ref, quote })}`);
    await send(
      owner,
      'expect 2 {"field":"Inez","op":"oneOf","expected":["diagnostics"],"citation":"c2"}',
    );
    await send(peer, 'propose 3 {"Inez":"diagnostics"}');
    await send(worker, "accept 4 p4");
    await send(peer, "show");
    await send(worker, "check fresh");
    expect(work.show(taskId, peer).citations[0]!.quote).toBe(quote);
    expect(work.check(taskId, worker).report.outcome).toBe("consistent");
    await send(owner, "retire 5 k3 Updated instructions require a new check");
    await send(owner, "show 3");
    expect(work.show(taskId, owner).constraints[0]!.retired!.reason).toBe(
      "Updated instructions require a new check",
    );
    expect(work.show(taskId, owner, 3).constraints[0]!.retired).toBeUndefined();
    expect(observer.connection.allTextJoined()).toBe("");
    expect(fixture.db.getTask(taskId)!.status).toBe("claimed");
  });

  test("private citations survive peer edits without exposing quotations or replaying another reader's check", () => {
    const quote = "Private staffing instruction: Inez stays on diagnostics.";
    const ref = source(quote, false);
    apply(worker, { kind: "patch", patch: { Inez: "diagnostics" } });
    apply(owner, { kind: "cite", field: "Inez", ref, quote });
    const citation = work.show(taskId, owner).citations[0]!;
    apply(owner, {
      kind: "expect",
      field: "Inez",
      op: "eq",
      expected: "diagnostics",
      citation: citation.id,
    });
    expect(work.check(taskId, owner).report.outcome).toBe("consistent");
    const peerView = work.show(taskId, peer);
    expect(peerView.citations[0]).toMatchObject({ id: citation.id, status: "unavailable" });
    expect(peerView.citations[0]!.quote).toBeUndefined();
    expect(peerView.citations[0]).not.toHaveProperty("sourceVersion");
    expect(peerView.citations[0]).not.toHaveProperty("start");
    expect(peerView.citations[0]).not.toHaveProperty("end");
    const persisted = JSON.parse(fixture.db.getTaskWorkRevision(taskId)!.document);
    expect(JSON.stringify(peerView)).not.toContain(persisted.citations[0].sourceVersion);
    expect(work.check(taskId, peer)).toMatchObject({
      reused: false,
      report: { outcome: "unverified" },
    });
    apply(worker, { kind: "patch", patch: { progress: "reviewed" } });
    expect(work.show(taskId, owner).citations[0]!.quote).toBe(quote);
    expect(fixture.db.getTaskWorkRevision(taskId)!.document).not.toContain(quote);
  });

  test("revoking source access invalidates receipts and historical quotations", () => {
    fixture.db.createGroup({ id: "private", name: "Private", leaderId: owner.id });
    fixture.db.addGroupMember("private", owner.id);
    fixture.db.addGroupMember("private", peer.id);
    fixture.db.createMemoryPool("private-pool", "private", owner.name, "private");
    const quote = "Maximum traffic is 10 percent.";
    const ref = `note:${fixture.db.createNote(owner.name, quote, undefined, { poolId: "private-pool" })}`;
    apply(worker, { kind: "patch", patch: { traffic: 10 } });
    apply(owner, { kind: "cite", field: "traffic", ref, quote });
    const citation = work.show(taskId, owner).citations[0]!;
    apply(owner, {
      kind: "expect",
      field: "traffic",
      op: "lte",
      expected: 10,
      citation: citation.id,
    });
    expect(work.check(taskId, peer).report.outcome).toBe("consistent");
    expect(work.check(taskId, peer).reused).toBe(true);
    const oldRevision = revision();
    fixture.db.removeGroupMember("private", peer.id);
    expect(work.check(taskId, peer)).toMatchObject({
      reused: false,
      report: { outcome: "unverified" },
    });
    expect(work.show(taskId, peer, oldRevision).citations[0]!.quote).toBeUndefined();
    expect(work.show(taskId, owner).citations[0]!.quote).toBe(quote);
  });

  test("source supersession, disputed evidence and changed requirements invalidate otherwise correct checks", () => {
    const { ref } = declaredAssignment();
    apply(worker, { kind: "patch", patch: { Inez: "read-only diagnostics" } });
    const first = work.check(taskId, worker);
    expect(first.report.outcome).toBe("consistent");
    raw().run("UPDATE tasks SET description='New review criteria' WHERE id=?", [taskId]);
    expect(work.check(taskId, worker).reused).toBe(false);
    const noteId = Number(ref.split(":")[1]);
    fixture.db.updateNoteQuality(noteId, owner.name, 0.4, "disputed");
    expect(work.check(taskId, worker).report.citations[0]!.status).toBe("disputed");
    fixture.db.reviseNote(owner.name, noteId, "Inez is now assigned to reserve.");
    const revised = work.check(taskId, worker);
    expect(revised.reused).toBe(false);
    expect(revised.report.citations[0]!.status).toBe("superseded");
    expect(revised.report.checks[0]!.status).toBe("unverified");
  });

  test("no-op writes preserve revision and receipt; forced, expired and clock-rollback checks do not reuse", () => {
    declaredAssignment();
    apply(worker, { kind: "patch", patch: { Inez: "read-only diagnostics" } });
    const now = Date.now();
    const first = work.check(taskId, worker, false, now);
    const before = revision();
    expect(apply(worker, { kind: "patch", patch: { Inez: "read-only diagnostics" } })).toEqual({
      revision: before,
      changed: false,
    });
    expect(work.check(taskId, worker, false, now + 1)).toMatchObject({
      reused: true,
      receiptId: first.receiptId,
    });
    expect(work.check(taskId, worker, true, now + 2).reused).toBe(false);
    expect(work.check(taskId, worker, false, now + WORK_CHECK_TTL_MS + 2).reused).toBe(false);
    expect(work.check(taskId, worker, false, now).reused).toBe(false);
  });

  test("empty or partial checks disclose unverified work, and new evidence/proposals reopen review", () => {
    expect(work.check(taskId, worker).report.outcome).toBe("unverified");
    declaredAssignment();
    apply(worker, {
      kind: "patch",
      patch: { Inez: "read-only diagnostics", readiness: "unknown" },
    });
    expect(work.check(taskId, worker).report.uncheckedFields).toEqual(["readiness"]);
    apply(peer, { kind: "propose", patch: { readiness: "ready" } });
    expect(work.check(taskId, worker).report.pendingProposals).toHaveLength(1);
    const proposal = work.show(taskId, worker).proposals[0]!;
    apply(worker, { kind: "accept", id: proposal.id });
    expect(work.check(taskId, worker).report.pendingProposals).toHaveLength(0);
  });

  test("retiring evidence requires an accountable reason and preserves previous revisions", () => {
    const { citation } = declaredAssignment();
    const old = revision();
    expect(() => apply(peer, { kind: "retire", id: citation, reason: "Cannot read it" })).toThrow(
      "author or task owner",
    );
    expect(() => apply(worker, { kind: "retire", id: citation, reason: " " })).toThrow("reason");
    apply(worker, {
      kind: "retire",
      id: citation,
      reason: "Replaced by updated staffing evidence",
    });
    expect(work.show(taskId, owner).citations[0]).toMatchObject({
      status: "retired",
      retired: { reason: "Replaced by updated staffing evidence" },
    });
    expect(work.show(taskId, owner, old).citations[0]!.retired).toBeUndefined();
    expect(work.check(taskId, worker).report.outcome).toBe("unverified");
  });

  test("retired evidence does not cause fresh checks when unrelated sources change", () => {
    const { ref, citation } = declaredAssignment();
    apply(owner, { kind: "retire", id: citation, reason: "No longer a current source" });
    const receipt = work.check(taskId, worker);
    fixture.db.reviseNote(
      owner.name,
      Number(ref.split(":")[1]),
      "A later instruction unrelated to this draft.",
    );
    expect(work.check(taskId, worker)).toMatchObject({
      receiptId: receipt.receiptId,
      reused: true,
    });
  });

  test("owner reconnect preserves editing authority and reader-specific receipt identity", () => {
    declaredAssignment();
    const receipt = work.check(taskId, owner);
    const connection = fixture.engine.getConnectionForEntity(owner.id as never)!;
    fixture.engine.removeConnection(connection.id, "explicit");
    const reconnected = fixture.login(owner.name);
    expect(reconnected.entityId).not.toBe(owner.id);
    const next = { name: owner.name, id: reconnected.entityId };
    expect(work.check(taskId, next)).toMatchObject({ reused: true, receiptId: receipt.receiptId });
    apply(next, { kind: "patch", patch: { Inez: "read-only diagnostics" } });
    expect(work.check(taskId, next).report.outcome).toBe("consistent");
  });

  test("optimistic revisions and strict parsing prevent stale or malformed changes", async () => {
    apply(worker, { kind: "patch", patch: { traffic: 10 } });
    expect(() => work.apply(taskId, worker, 0, { kind: "patch", patch: { traffic: 20 } })).toThrow(
      "Work changed",
    );
    const before = fixture.db.getTaskWorkRevision(taskId)!;
    for (const payload of [
      '{"traffic":',
      '{"traffic":1e400}',
      '{"__proto__":"bad"}',
      '{"traffic":{"nested":true}}',
    ]) {
      await fixture.engine.dispatchCommand(
        worker.id as never,
        `task work ${taskId} patch ${revision()} ${payload}`,
      );
    }
    expect(fixture.db.getTaskWorkRevision(taskId)).toEqual(before);
    expect(() =>
      apply(owner, {
        kind: "cite",
        field: "traffic",
        ref: source("Maximum 10."),
        quote: "Maximum 20.",
      }),
    ).toThrow("Quotation");
  });

  test("work records do not weaken group access or the existing as-of evidence fence", async () => {
    fixture.db.createGroup({ id: "team", name: "Team", leaderId: owner.id });
    fixture.db.addGroupMember("team", owner.id);
    raw().run("UPDATE tasks SET group_id='team' WHERE id=?", [taskId]);
    expect(() => work.show(taskId, peer)).toThrow("not accessible");
    expect(() => work.check(taskId, peer)).toThrow("not accessible");
    expect(() => apply(peer, { kind: "propose", patch: { traffic: 10 } })).toThrow(
      "not accessible",
    );
    await withEvidenceCutoff("2025-01-01T00:00:00Z", () =>
      fixture.engine.dispatchCommand(
        owner.id as never,
        `task work ${taskId} patch 0 {"traffic":10}`,
      ),
    );
    expect(fixture.db.getTaskWorkRevision(taskId)).toBeUndefined();
  });

  test("an authenticated account erasure anonymizes shared authors and removes its reusable receipts", () => {
    declaredAssignment();
    work.check(taskId, owner);
    const key = fixture.db.durableEntityKey(owner.id);
    const result = fixture.db.deleteUser(key);
    expect(result.task_work!.revisions).toBeGreaterThan(0);
    expect(result.task_work!.checks).toBe(1);
    const rows = raw()
      .query("SELECT author_id,author_name,document FROM task_work_revisions")
      .all();
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(JSON.stringify(rows)).not.toContain('"author_name":"Owner"');
    expect(work.show(taskId, worker).fields.Inez).toBe("reserve");
  });
});
