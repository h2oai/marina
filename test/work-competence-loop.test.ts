// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { routeEvidenceSettingsFromEnv } from "../src/engine/benchmark-evidence";
import { competenceCommand } from "../src/engine/commands/competence";
import { competenceMap, renderCompetence } from "../src/forecast/competence";
import { outcomeRefs } from "../src/forecast/routing-refs";
import { liveEvidence } from "../src/outcomes/evidence";
import { recordTaskOpinion, recordTaskVerdict, recordVerification } from "../src/outcomes/live";
import { recordResolved, settleDelivery } from "../src/outcomes/record";
import { scopeOf, sharedEvidence, visibleTo, workRefs } from "../src/outcomes/work-refs";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomContext } from "../src/types";

describe("work outcomes carry family / method / scope", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    db.createUser({ id: "u_jeff", name: "jeff" });
    db.saveAgentConfig({ name: "Helper", model: "vendor/a", role: "coder", spawnedBy: "jeff" });
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
    expect(scopeOf(refsOf("task:2:Helper"))).toBe("owner:jeff");
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
    expect(scopeOf(workRefs(db, { kind: "task", actor: "jeff" }))).toBe("owner:jeff");
    expect(scopeOf(workRefs(db, { kind: "task", actor: "nobody" }))).toBe("unscoped");
    expect(scopeOf(workRefs(undefined, { kind: "task", actor: "Roamer" }))).toBe("unscoped");
    // A person's own work names no method: it is not a model's record.
    expect(workRefs(db, { kind: "task", actor: "jeff" }).some((r) => r.startsWith("method:"))).toBe(
      false,
    );
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
    expect(shared.map((c) => c.method)).toEqual(["model:vendor/b", "model:vendor/b"]);
    expect(shared.every((c) => c.basis === "mechanical")).toBe(true);
    const mine = competenceMap(db, { family: "work:task", viewer: "jeff" });
    expect(mine.map((c) => c.method)).toContain("model:vendor/a");
    const judged = competenceMap(db, { family: "work:task", includeJudged: true });
    expect(judged.some((c) => c.basis === "judged")).toBe(true);
    expect(renderCompetence(judged)).toContain("(judged)");
  });

  it("the competence command is read-only and scopes `mine` to the caller", () => {
    recordTaskVerdict(db, { taskId: 2, claimant: "Helper", approved: true, at: 2 });
    const sent: string[] = [];
    const ctx = { send: (_: EntityId, msg: string) => sent.push(msg) } as unknown as RoomContext;
    const cmd = competenceCommand({ db, getEntity: () => ({ name: "jeff" }) });
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
    expect(sharedEvidence(["scope:owner:jeff"])).toBe(false);
    expect(sharedEvidence(["scope:unscoped"])).toBe(false);
    expect(visibleTo(["scope:owner:jeff"], "jeff")).toBe(true);
    expect(visibleTo(["scope:owner:jeff"], "ann")).toBe(false);
  });

  it("live route evidence is on unless explicitly off; acting stays observe by default", () => {
    expect(routeEvidenceSettingsFromEnv({}).live).toBe(true);
    expect(routeEvidenceSettingsFromEnv({ MARINA_ROUTE_EVIDENCE_LIVE: "off" }).live).toBe(false);
    expect(routeEvidenceSettingsFromEnv({}).mode).toBe("observe");
  });
});
