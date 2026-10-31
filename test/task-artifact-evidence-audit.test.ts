// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ArtifactValue } from "../src/coordination/task-artifact";
import {
  type ArtifactEvidencePlan,
  auditArtifactEvidence,
  auditProseEvidence,
} from "../src/coordination/task-artifact-evidence";
import { auditTaskArtifactFile } from "../src/coordination/task-artifact-evidence-file";
import {
  artifactFileHash,
  type TaskArtifactFileAccess,
} from "../src/coordination/task-artifact-file";
import { TaskWork, type WorkActor } from "../src/coordination/task-work";
import { type EvidenceSource, resolveEvidenceSource } from "../src/decisions/evidence";
import { createTestEngine } from "./engine-fixture";

const policy = "Only verified originals count toward liability.";
const amount = "The verified liability is 75 dollars.";
const cash = "A payment of 20 dollars has been receipted.";
const sources: Record<string, ArtifactValue> = {
  contract: {
    requirements: [
      { key: "liability", facts: [["policy", "amount"]] },
      { key: "balance", facts: [["policy", "amount", "cash"]] },
    ],
  },
  ledger: { id: "ledger", statements: [policy, amount, cash] },
};
const resolve = (ref: string): EvidenceSource => ({
  ref,
  status: "current",
  version: "v1",
  text: JSON.stringify(sources[ref]),
});
const plan = (): ArtifactEvidencePlan => ({
  requirements: { ref: "contract", path: "/requirements", key: "/key", bundles: "/facts" },
  targets: { path: "/items", key: "/key", citations: "/cites", document: "/doc", quote: "/quote" },
  sources: [{ ref: "ledger", document: "/id", text: "/statements" }],
  bindings: [
    { fact: "policy", ref: "ledger", path: "/statements/0" },
    { fact: "amount", ref: "ledger", path: "/statements/1" },
    { fact: "cash", ref: "ledger", path: "/statements/2" },
  ],
});
const cite = (quote: string) => ({ doc: "ledger", quote });
const draft = () => ({
  items: [
    { key: "liability", value: 75, cites: [cite(policy), cite(amount)] },
    { key: "balance", value: 55, cites: [cite(policy), cite(amount), cite(cash)] },
  ],
});

describe("source-declared per-entry evidence audit", () => {
  test("an unlisted peer original is unverified, never a reason to remove an authentic quotation", () => {
    const value = draft();
    value.items[1]!.cites.push({ doc: "peer-ledger", quote: "A valid original held by the peer." });
    const before = JSON.stringify(value);
    const report = auditArtifactEvidence(value, plan(), resolve);
    expect(report.quotations.at(-1)!.status).toBe("unverified");
    expect(report.outcome).toBe("unverified");
    expect(report.findings.at(-1)!.message).toContain("Preserve it");
    expect(JSON.stringify(value)).toBe(before);
    expect(report.obligations.every((entry) => entry.complete)).toBe(true);
  });

  test("a correct derived value still needs its own policy premise", () => {
    const value = draft();
    value.items[1]!.cites.shift();
    const result = auditArtifactEvidence(value, plan(), resolve);
    expect(result.obligations).toEqual([
      { id: "liability", path: "/items/0", missing: [[]], complete: true },
      { id: "balance", path: "/items/1", missing: [["policy"]], complete: false },
    ]);
    expect(result.findings[0]!.message).toContain("does not inherit");
    value.items[1]!.cites.push(cite(policy));
    expect(auditArtifactEvidence(value, plan(), resolve).findings).toEqual([]);
  });

  test("an extra altered quotation fails even when all sufficient facts are present", () => {
    const value = draft();
    value.items[1]!.cites.push(cite("A payment of 20 dollars has receipted."));
    const result = auditArtifactEvidence(value, plan(), resolve);
    expect(result.obligations.every((row) => row.complete)).toBe(true);
    expect(result.quotations.at(-1)).toMatchObject({ path: "/items/1/cites/3", status: "invalid" });
    expect(result.outcome).toBe("discrepancies");
    expect(value.items[1]!.cites.at(-1)!.quote).toContain("has receipted");
  });

  test("unaltered exact selections pass without rewriting, approving or inferring values", () => {
    const value = draft(),
      before = JSON.stringify(value);
    const first = auditArtifactEvidence(value, plan(), resolve);
    expect(first.findings).toEqual([]);
    expect(auditArtifactEvidence(value, plan(), resolve)).toEqual(first);
    expect(JSON.stringify(value)).toBe(before);
    value.items[1]!.value = 999;
    expect(auditArtifactEvidence(value, plan(), resolve).findings).toEqual([]);
    expect(first.scope).toContain("do not prove entailment");
  });

  test("no bindings or missing entries cannot create a vacuous pass", () => {
    const input = plan();
    input.bindings = [];
    const result = auditArtifactEvidence(draft(), input, resolve);
    expect(result.obligations[1]!.missing).toEqual([["policy", "amount", "cash"]]);
    const absent = auditArtifactEvidence({ items: [] }, plan(), resolve);
    expect(absent.obligations.every((row) => !row.complete)).toBe(true);
    const empty = auditArtifactEvidence(draft(), plan(), (ref) =>
      ref === "contract" ? { ...resolve(ref), text: '{"requirements":[]}' } : resolve(ref),
    );
    expect(empty.findings.some((f) => f.id === "requirements")).toBe(true);
  });

  test("alternatives require one complete bundle; duplicates and spliced fragments do not fill gaps", () => {
    const alternative = (ref: string) =>
      ref === "contract"
        ? {
            ...resolve(ref),
            text: JSON.stringify({
              requirements: [{ key: "balance", facts: [["policy", "amount"], ["cash"]] }],
            }),
          }
        : resolve(ref);
    expect(
      auditArtifactEvidence(
        { items: [{ key: "balance", cites: [cite(cash)] }] },
        plan(),
        alternative,
      ).findings,
    ).toEqual([]);
    const duplicates = draft();
    duplicates.items.push(duplicates.items[1]!);
    expect(auditArtifactEvidence(duplicates, plan(), resolve).obligations[1]!.complete).toBe(false);
    const fragmented = draft();
    fragmented.items[1]!.cites = [
      cite(policy),
      cite(amount),
      cite("A payment of 20 dollars"),
      cite("has been receipted."),
    ];
    expect(auditArtifactEvidence(fragmented, plan(), resolve).obligations[1]!.missing).toEqual([
      ["cash"],
    ]);
  });

  test("changed or inaccessible sources invalidate receipt fingerprints without disclosing text", () => {
    const before = auditArtifactEvidence(draft(), plan(), resolve);
    const hidden = auditArtifactEvidence(draft(), plan(), (ref) =>
      ref === "ledger" ? { ref, status: "unavailable" } : resolve(ref),
    );
    expect(hidden.outcome).toBe("unverified");
    expect(hidden.fingerprint).not.toBe(before.fingerprint);
    expect(JSON.stringify(hidden)).not.toContain(policy);
    expect(hidden.obligations.every((row) => !row.complete)).toBe(true);
    const changed = auditArtifactEvidence(draft(), plan(), (ref) => ({
      ...resolve(ref),
      version: "v2",
    }));
    expect(changed.fingerprint).not.toBe(before.fingerprint);
  });

  test("ambiguous document IDs and malformed mappings never pass", () => {
    const input = plan();
    input.sources.push({ ref: "other", document: "/id", text: "/statements" });
    const result = auditArtifactEvidence(draft(), input, (ref) =>
      ref === "other" ? { ...resolve("ledger"), ref } : resolve(ref),
    );
    expect(result.findings.some((f) => f.id === "ambiguous:ledger")).toBe(true);
    expect(result.obligations.every((row) => !row.complete)).toBe(true);
    expect(() => auditArtifactEvidence(draft(), { ...plan(), sources: [] }, resolve)).toThrow(
      "sources",
    );
    const malformed = plan();
    delete (malformed.targets as Partial<typeof malformed.targets>).citations;
    expect(() => auditArtifactEvidence(draft(), malformed, resolve)).toThrow("Pointer");
  });

  test("source metadata and shape changes become scoped findings, not an aborted audit", () => {
    const metadata = (ref: string) =>
      ref === "ledger"
        ? {
            ...resolve(ref),
            text: JSON.stringify({
              ...(sources.ledger as object),
              constructor: "unrelated metadata",
            }),
          }
        : resolve(ref);
    expect(auditArtifactEvidence(draft(), plan(), metadata).findings).toEqual([]);
    const input = plan();
    input.sources[0]!.text = "/statements/nonnumeric";
    expect(
      auditArtifactEvidence(draft(), input, resolve).findings.some(
        (f) => f.id === "mapping:ledger",
      ),
    ).toBe(true);
  });

  test("reordered sources cannot silently rebind a fact without explicit renewal", () => {
    const value = draft();
    value.items[1]!.cites.shift();
    const versions = { contract: "v1", ledger: "v1" };
    expect(auditArtifactEvidence(value, plan(), resolve, versions).obligations[1]!.complete).toBe(
      false,
    );
    const changed = (ref: string) =>
      ref === "ledger"
        ? {
            ...resolve(ref),
            version: "v2",
            text: JSON.stringify({ id: "ledger", statements: [cash, amount, policy] }),
          }
        : resolve(ref);
    const result = auditArtifactEvidence(value, plan(), changed, versions);
    expect(result.outcome).toBe("unverified");
    expect(result.obligations.every((row) => !row.complete)).toBe(true);
    expect(result.findings.some((f) => f.message.includes("changed since binding"))).toBe(true);
  });

  test("source context is explicit and type sensitive", () => {
    const input = plan();
    input.context = { source: "/phase", target: "/phase" };
    const source = (ref: string) =>
      ref === "contract"
        ? { ...resolve(ref), text: JSON.stringify({ ...(sources.contract as object), phase: 2 }) }
        : resolve(ref);
    expect(auditArtifactEvidence({ ...draft(), phase: 2 }, input, source).findings).toEqual([]);
    for (const phase of [1, "2"])
      expect(
        auditArtifactEvidence({ ...draft(), phase }, input, source).findings.some(
          (f) => f.id === "context",
        ),
      ).toBe(true);
  });

  test("public reports cannot test guesses of an inaccessible bound source version", () => {
    const hidden = (ref: string): EvidenceSource =>
      ref === "ledger" ? { ref, status: "unavailable" } : resolve(ref);
    const first = auditArtifactEvidence(draft(), plan(), hidden, {
      contract: "v1",
      ledger: "private-version-A",
    });
    const second = auditArtifactEvidence(draft(), plan(), hidden, {
      contract: "v1",
      ledger: "private-version-B",
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("private-version");
  });
});

describe("optional durable evidence plan", () => {
  let fixture: ReturnType<typeof createTestEngine>,
    work: TaskWork,
    owner: WorkActor,
    peer: WorkActor,
    taskId: number;
  let input: ArtifactEvidencePlan;
  const revision = () => fixture.db.getTaskWorkRevision(taskId)!.revision;
  beforeEach(() => {
    fixture = createTestEngine();
    owner = { id: fixture.login("Owner").entityId, name: "Owner" };
    peer = { id: fixture.login("Peer").entityId, name: "Peer" };
    fixture.db.createMemoryPool("audit-sources", "evidence", owner.name);
    const refs = Object.fromEntries(
      Object.entries(sources).map(([key, value]) => [
        key,
        `note:${fixture.db.createNote(owner.name, JSON.stringify(value), undefined, { poolId: "audit-sources" })}`,
      ]),
    );
    input = plan();
    input.requirements.ref = refs.contract!;
    input.sources[0]!.ref = refs.ledger!;
    input.bindings.forEach((b) => {
      b.ref = refs.ledger!;
    });
    work = new TaskWork(fixture.db, (actor, ref) => resolveEvidenceSource(fixture.db, actor, ref));
    taskId = fixture.engine.taskManager!.create({
      title: "Evidence audit",
      creatorId: owner.id,
      creatorName: owner.name,
    }).id;
    work.editArtifact(taskId, owner, 0, [{ op: "set", path: "", value: draft() }]);
  });
  afterEach(async () => {
    await fixture.dispose();
  });

  test("an ordinary file is audited against originals without creating native work or changing task status", async () => {
    const task = fixture.engine.taskManager!.create({
      title: "Ordinary file",
      creatorId: owner.id,
      creatorName: owner.name,
    });
    const value = draft();
    value.items[1]!.cites.shift();
    const content = JSON.stringify(value);
    let version = "1";
    const access: TaskArtifactFileAccess = {
      read: async () => ({ content, version }),
      command: async (command) => {
        const payload = JSON.parse(
          command.slice(command.indexOf("artifact-audit ") + "artifact-audit ".length),
        );
        return JSON.stringify(work.auditArtifactFile(task.id, owner, payload));
      },
      compareAndWrite: async () => {
        throw new Error("Read-only audit must not write");
      },
    };
    const request = {
      taskId: task.id,
      path: "submission.json",
      expected: { version, sha256: artifactFileHash(content) },
      plan: input,
    };
    const result = await auditTaskArtifactFile(access, request);
    expect(result.report.obligations[1].missing).toEqual([["policy"]]);
    expect(fixture.db.getTaskWorkRevision(task.id)).toBeUndefined();
    expect(fixture.db.getTask(task.id)!.status).toBe("open");
    expect(work.show(task.id, owner).artifact).toBeUndefined();
    const command = access.command;
    access.command = async (text) => {
      const answer = await command(text);
      version = "3";
      return answer;
    };
    await expect(auditTaskArtifactFile(access, request)).rejects.toThrow("changed during audit");
    expect(fixture.db.getTaskWorkRevision(task.id)).toBeUndefined();
  });

  test("actual-file audit obeys task and source access without exposing hidden originals", () => {
    const payload = {
      target: { name: "submission.json", content: JSON.stringify(draft()) },
      plan: input,
    };
    const hiddenWork = new TaskWork(fixture.db, (_actor, ref) => ({ ref, status: "unavailable" }));
    const hidden = hiddenWork.auditArtifactFile(taskId, peer, payload);
    expect(hidden.report.outcome).toBe("unverified");
    expect(JSON.stringify(hidden)).not.toContain(policy);
    fixture.db.createGroup({ id: "private-audit", name: "Private", leaderId: owner.id });
    fixture.db.addGroupMember("private-audit", owner.id);
    const secret = fixture.engine.taskManager!.create({
      title: "Private file",
      creatorId: owner.id,
      creatorName: owner.name,
      groupId: "private-audit",
    });
    expect(() => work.auditArtifactFile(secret.id, peer, payload)).toThrow("accessible");
    expect(() =>
      work.auditArtifactFile(taskId, owner, {
        ...payload,
        target: { name: "file", content: "invalid JSON" },
      }),
    ).toThrow();
  });

  test("binding is optional, idempotent, revision guarded and returns gaps after later edits", () => {
    expect(work.artifactStatus(taskId, owner).report.evidence).toBeUndefined();
    const before = revision();
    expect(work.declareArtifactEvidence(taskId, owner, before, input)).toMatchObject({
      changed: true,
      revision: before + 1,
    });
    expect(work.declareArtifactEvidence(taskId, owner, revision(), input)).toMatchObject({
      changed: false,
    });
    expect(() => work.declareArtifactEvidence(taskId, owner, before, input)).toThrow("changed");
    const result = work.editArtifact(taskId, owner, revision(), [
      { op: "remove", path: "/items/1/cites/0", reason: "Regression: omit derived field policy" },
    ]);
    expect(result.feedback.findings.some((f) => f.id === "evidence:obligation:balance")).toBe(true);
    const checked = work.checkArtifact(taskId, owner);
    expect(work.checkArtifact(taskId, owner).receiptId).toBe(checked.receiptId);
    expect(fixture.db.getTask(taskId)!.status).toBe("open");
    expect(() => work.declareArtifactEvidence(taskId, peer, revision(), input)).toThrow("creator");
    work.declareArtifactEvidence(taskId, owner, revision(), null);
    expect(work.artifactStatus(taskId, owner).report.evidence).toBeUndefined();
  });

  test("persisted versions require explicit renewal and are absent from public historical views", () => {
    const ledger = input.sources[0]!.ref;
    let changed = false;
    work = new TaskWork(fixture.db, (actor, ref) => {
      const source = resolveEvidenceSource(fixture.db, actor, ref);
      if (ref === ledger && changed)
        return {
          ...source,
          version: "reordered-private-version",
          text: JSON.stringify({ id: "ledger", statements: [cash, amount, policy] }),
        };
      return source;
    });
    work.declareArtifactEvidence(taskId, owner, revision(), input);
    const boundRevision = revision();
    const first = work.checkArtifact(taskId, owner);
    changed = true;
    const result = work.checkArtifact(taskId, owner);
    expect(result.receiptId).not.toBe(first.receiptId);
    expect(result.report.evidence!.outcome).toBe("unverified");
    expect(revision()).toBe(boundRevision);
    input.bindings[0]!.path = "/statements/2";
    input.bindings[2]!.path = "/statements/0";
    work.declareArtifactEvidence(taskId, owner, revision(), input);
    expect(work.artifactStatus(taskId, owner).report.evidence!.findings).toEqual([]);
    for (const rev of [undefined, revision()])
      expect(JSON.stringify(work.show(taskId, owner, rev))).not.toContain(
        "reordered-private-version",
      );
    expect(work.show(taskId, owner).artifact?.evidencePlan).toEqual(input);
  });

  test("unrelated peer plan updates preserve private bindings but cannot renew changed private mappings", () => {
    fixture.engine.taskManager!.claim(taskId, peer.id, peer.name);
    const ledger = input.sources[0]!.ref;
    work = new TaskWork(fixture.db, (actor, ref) =>
      actor.id === peer.id && ref === ledger
        ? { ref, status: "unavailable" }
        : resolveEvidenceSource(fixture.db, actor, ref),
    );
    work.declareArtifactEvidence(taskId, owner, revision(), input);
    input.targets.path = "/other";
    work.declareArtifactEvidence(taskId, peer, revision(), input);
    expect(
      work
        .artifactStatus(taskId, owner)
        .report.evidence!.findings.some((f) => f.id === `source:${ledger}`),
    ).toBe(false);
    expect(work.artifactStatus(taskId, peer).report.evidence!.outcome).toBe("unverified");
    input.targets.path = "/items";
    input.bindings[0]!.path = "/statements/2";
    work.declareArtifactEvidence(taskId, peer, revision(), input);
    expect(
      work
        .artifactStatus(taskId, owner)
        .report.evidence!.findings.some((f) => f.id === `source:${ledger}`),
    ).toBe(true);
    input.bindings[0]!.path = "/statements/0";
    work.declareArtifactEvidence(taskId, owner, revision(), input);
    expect(work.artifactStatus(taskId, owner).report.evidence!.findings).toEqual([]);
  });
});

describe("the same evidence audit over prose", () => {
  test("a fact counts only when the prose quotes its bound source selection verbatim", () => {
    const text = `Per the ledger, "${policy}" and "${amount}", so liability is 75 dollars; the balance is 55 after the payment.`;
    const report = auditProseEvidence(text, plan(), resolve);
    expect(report.obligations).toEqual([
      { id: "liability", missing: [[]], complete: true },
      { id: "balance", missing: [["cash"]], complete: false },
    ]);
    expect(report.outcome).toBe("discrepancies");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.id).toBe("obligation:balance");
    expect(report.findings[0]!.message).toContain("verbatim");
    expect(report.quoted.map((q) => q.fact)).toEqual(["policy", "amount"]);
    expect(report.advisory).toBe(true);
  });

  test("every bundle quoted matches the declared evidence; a paraphrase never counts", () => {
    const full = `${policy} ${amount} ${cash} Balance: 55.`;
    const complete = auditProseEvidence(full, plan(), resolve);
    expect(complete.outcome).toBe("matches-declared-evidence");
    expect(complete.findings).toEqual([]);
    expect(complete.quoted).toHaveLength(3);
    const paraphrased = `${policy} ${amount} A 20 dollar payment was receipted.`;
    const partial = auditProseEvidence(paraphrased, plan(), resolve);
    expect(partial.obligations[1]).toEqual({ id: "balance", missing: [["cash"]], complete: false });
    expect(complete.fingerprint).not.toBe(partial.fingerprint);
  });

  test("an unreadable requirement source is unverified, and empty prose is refused", () => {
    const gone = (ref: string): EvidenceSource =>
      ref === "contract" ? { ref, status: "unavailable", reason: "unavailable" } : resolve(ref);
    const report = auditProseEvidence(`${policy} ${amount} ${cash}`, plan(), gone);
    expect(report.outcome).toBe("unverified");
    expect(report.obligations).toEqual([]);
    expect(() => auditProseEvidence("   ", plan(), resolve)).toThrow("Supply the prose");
  });
});
