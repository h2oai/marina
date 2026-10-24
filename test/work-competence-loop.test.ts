// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { routeEvidenceSettingsFromEnv } from "../src/engine/benchmark-evidence";
import { competenceCommand } from "../src/engine/commands/competence";
import {
  competenceFrom,
  competenceMap,
  methodDimension,
  rankMethods,
  renderCompetence,
  renderMethodRanking,
} from "../src/forecast/competence";
import { outcomeRefs } from "../src/forecast/routing-refs";
import { liveEvidence } from "../src/outcomes/evidence";
import {
  recordTaskOpinion,
  recordTaskVerdict,
  recordVerification,
  taskApproach,
} from "../src/outcomes/live";
import { recordResolved, settleDelivery } from "../src/outcomes/record";
import { scopeOf, sharedEvidence, visibleTo, workRefs } from "../src/outcomes/work-refs";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomContext } from "../src/types";

describe("work outcomes carry family / method / scope", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    db.createUser({ id: "u_alice", name: "alice" });
    db.saveAgentConfig({ name: "Helper", model: "vendor/a", role: "coder", spawnedBy: "alice" });
    db.saveAgentConfig({ name: "Roamer", model: "vendor/b", role: "coder", spawnedBy: "system" });
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  const refsOf = (subjectPrefix: string) =>
    outcomeRefs(
      db.listOutcomes({ limit: 100 }).find((o) => o.subject.startsWith(subjectPrefix))?.refs_json,
    );

  it("tags a world agent's verdict as shared and a person's agent as that person's", () => {
    recordTaskVerdict(db, { taskId: 1, claimant: "Roamer", approved: true, at: 1 });
    recordTaskVerdict(db, { taskId: 2, claimant: "Helper", approved: false, at: 2 });
    const roamer = refsOf("task:1:Roamer");
    expect(roamer).toContain("family:work:task");
    expect(roamer).toContain("family:work:task:role:coder");
    expect(roamer).toContain("method:model:vendor/b");
    expect(scopeOf(roamer)).toBe("shared");
    expect(scopeOf(refsOf("task:2:Helper"))).toBe("owner:alice");
  });

  it("tags Code Mode checks as code work and judged opinions as judged", () => {
    recordVerification(db, {
      artifactId: "a1",
      actor: "Roamer",
      passed: true,
      commands: [["bun", "test"]],
      detail: "passed 1 check",
      at: 3,
    });
    recordTaskOpinion(db, { taskId: 4, claimant: "Roamer", judge: "j", opinion: "pass", at: 4 });
    expect(refsOf("artifact:a1")).toContain("family:work:code");
    const judged = db.listOutcomes({ basis: "judged", limit: 10 });
    expect(judged).toHaveLength(1);
    expect(outcomeRefs(judged[0]!.refs_json)).toContain("family:work:task");
  });

  it("a person directly, or someone unknown, is never shared", () => {
    expect(scopeOf(workRefs(db, { kind: "task", actor: "alice" }))).toBe("owner:alice");
    expect(scopeOf(workRefs(db, { kind: "task", actor: "nobody" }))).toBe("unscoped");
    expect(scopeOf(workRefs(undefined, { kind: "task", actor: "Roamer" }))).toBe("unscoped");
    // A person's own work names no method: it is not a model's record.
    expect(
      workRefs(db, { kind: "task", actor: "alice" }).some((r) => r.startsWith("method:")),
    ).toBe(false);
  });

  it("only shared work feeds live routing evidence", () => {
    for (let i = 0; i < 5; i++) {
      recordTaskVerdict(db, { taskId: 10 + i, claimant: "Roamer", approved: true, at: 10 + i });
      recordTaskVerdict(db, { taskId: 20 + i, claimant: "Helper", approved: true, at: 20 + i });
    }
    const models = liveEvidence(db).map((c) => c.model);
    expect(models).toContain("vendor/b");
    expect(models).not.toContain("vendor/a");
  });

  it("the shared map hides a person's work; their own view and judged view add it, labelled", () => {
    recordTaskVerdict(db, { taskId: 1, claimant: "Roamer", approved: true, at: 1 });
    recordTaskVerdict(db, { taskId: 2, claimant: "Helper", approved: true, at: 2 });
    recordResolved(db, {
      subject: "judged:task:3:Roamer:3",
      kind: "task",
      source: "task:verdict",
      domain: "tools",
      owner: "Roamer",
      succeeded: true,
      quality: 0.8,
      metric: "judge-quality",
      basis: "judged",
      judge: "j",
      refs: workRefs(db, { kind: "task", actor: "Roamer", model: "vendor/b" }),
      resolvedAt: 3,
    });
    const shared = competenceMap(db, { family: "work:task" });
    // Each family counts the model and how the task was worked (solo here).
    expect(shared.map((c) => c.method)).toEqual([
      "model:vendor/b",
      "solo",
      "model:vendor/b",
      "solo",
    ]);
    expect(shared.every((c) => c.basis === "mechanical")).toBe(true);
    const mine = competenceMap(db, { family: "work:task", viewer: "alice" });
    expect(mine.map((c) => c.method)).toContain("model:vendor/a");
    const judged = competenceMap(db, { family: "work:task", includeJudged: true });
    expect(judged.some((c) => c.basis === "judged")).toBe(true);
    expect(renderCompetence(judged)).toContain("(judged)");
  });

  it("the competence command is read-only and scopes `mine` to the caller", () => {
    recordTaskVerdict(db, { taskId: 2, claimant: "Helper", approved: true, at: 2 });
    const sent: string[] = [];
    const ctx = { send: (_: EntityId, msg: string) => sent.push(msg) } as unknown as RoomContext;
    const cmd = competenceCommand({ db, getEntity: () => ({ name: "alice" }) });
    const run = (args: string) =>
      cmd.handler(ctx, {
        entity: "e_1" as EntityId,
        args,
        tokens: args.split(/\s+/).filter(Boolean),
      } as never);
    run("work:task");
    expect(sent.at(-1)).not.toContain("vendor/a");
    run("mine work:task");
    expect(sent.at(-1)).toContain("model:vendor/a");
    run("a b c");
    expect(sent.at(-1)).toContain("Usage: competence");
  });
});

describe("scope helpers and defaults", () => {
  it("untagged rows (boards, older producers) stay shared; owner and unscoped do not", () => {
    expect(sharedEvidence(["family:civiqs", "method:nowcast"])).toBe(true);
    expect(sharedEvidence(["scope:shared"])).toBe(true);
    expect(sharedEvidence(["scope:owner:alice"])).toBe(false);
    expect(sharedEvidence(["scope:unscoped"])).toBe(false);
    expect(visibleTo(["scope:owner:alice"], "alice")).toBe(true);
    expect(visibleTo(["scope:owner:alice"], "ann")).toBe(false);
  });

  it("live route evidence is on unless explicitly off; acting stays observe by default", () => {
    expect(routeEvidenceSettingsFromEnv({}).live).toBe(true);
    expect(routeEvidenceSettingsFromEnv({ MARINA_ROUTE_EVIDENCE_LIVE: "off" }).live).toBe(false);
    expect(routeEvidenceSettingsFromEnv({}).mode).toBe("observe");
  });
});

describe("how work was done is part of its record", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    db.saveAgentConfig({ name: "Solo", model: "vendor/a", role: "coder", spawnedBy: "system" });
    db.saveAgentConfig({ name: "Member", model: "vendor/a", role: "coder", spawnedBy: "system" });
    db.saveCrew({
      id: "c1",
      name: "debaters",
      goal: "g",
      formation: "debate",
      ownerId: "o",
      state: "active",
      createdAt: 1,
      lastActivityAt: 1,
    });
    db.addCrewMember("c1", "Member", "member", 1);
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  it("tags a task as crew work with its formation, or solo", () => {
    expect(taskApproach(db, "Member")).toEqual(["crew:debate"]);
    expect(taskApproach(db, "Solo")).toEqual(["solo"]);
    recordTaskVerdict(db, { taskId: 1, claimant: "Member", approved: true, at: 1 });
    const refs = outcomeRefs(db.listOutcomes({ limit: 5 })[0]!.refs_json);
    expect(refs).toContain("method:model:vendor/a");
    expect(refs).toContain("method:crew:debate");
    // The model stays first, so readers that take one method keep reading the model.
    expect(refs.find((r) => r.startsWith("method:"))).toBe("method:model:vendor/a");
  });

  it("tags a Code Mode check with driver, runner and verification mode", () => {
    recordVerification(db, {
      artifactId: "a1",
      actor: "Solo",
      passed: true,
      commands: [["bun", "test"]],
      detail: "passed",
      approach: ["driver:codex", "runner:container", "verify:candidate", "model:spoof", "bad tag!"],
      at: 2,
    });
    const refs = outcomeRefs(db.listOutcomes({ limit: 5 })[0]!.refs_json);
    expect(refs.filter((r) => r.startsWith("method:"))).toEqual([
      "method:model:vendor/a",
      "method:driver:codex",
      "method:runner:container",
      "method:verify:candidate",
    ]);
  });

  it("ranks ways of working within their own dimension, and claims a lead only when intervals separate", () => {
    for (let i = 0; i < 8; i++) {
      recordTaskVerdict(db, { taskId: 100 + i, claimant: "Member", approved: true, at: 10 + i });
      recordTaskVerdict(db, { taskId: 200 + i, claimant: "Solo", approved: i < 2, at: 30 + i });
    }
    const cells = competenceMap(db, { family: "work:task" });
    const rankings = rankMethods(cells, "work:task");
    const crew = rankings.find((r) => r.dimension === "crew")!;
    expect(crew.ranked.map((c) => c.method)).toEqual(["crew:debate", "solo"]);
    expect(crew.verdict).toBe("lead");
    const model = rankings.find((r) => r.dimension === "model")!;
    expect(model.verdict).toBe("alone");
    const text = renderMethodRanking(rankings, "work:task");
    expect(text).toContain("crew:debate leads clearly");
    expect(methodDimension("solo")).toBe("crew");
    expect(methodDimension("model:x")).toBe("model");
    expect(methodDimension("nowcast")).toBe("method");
    expect(renderMethodRanking([], "work:code")).toContain("no method has a record here");
  });

  it("never ranks a method on fewer than five outcomes, and reads a loss as lower-is-better", () => {
    const row = (method: string, loss: number, i: number) =>
      ({
        subject: `s${method}${i}`,
        kind: "forecast",
        source: "x",
        domain: "forecast",
        owner: null,
        succeeded: 1,
        quality: null,
        loss,
        metric: "crps",
        truth_json: null,
        detail: null,
        basis: "mechanical",
        judge: null,
        eval_mode: "live",
        participants_json: null,
        refs_json: JSON.stringify(["family:f", `method:${method}`]),
        resolved_at: i,
        created_at: i,
      }) as never;
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row("good", 0.1 + i * 0.001, i)),
      ...Array.from({ length: 6 }, (_, i) => row("bad", 0.9 + i * 0.001, i)),
      ...Array.from({ length: 3 }, (_, i) => row("new", 0.01, i)),
    ];
    const [r] = rankMethods(competenceFrom(rows, { family: "f" }), "f");
    expect(r!.ranked.map((c) => c.method)).toEqual(["good", "bad"]);
    expect(r!.thin.map((c) => c.method)).toEqual(["new"]);
    expect(r!.verdict).toBe("lead");
  });
});
