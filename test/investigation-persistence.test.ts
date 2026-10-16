// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInvestigationRequest } from "../src/investigations/validation";
import { deliverOutcomes } from "../src/outcomes/deliver";
import { resolveForecast } from "../src/outcomes/forecast";
import { MarinaDB } from "../src/persistence/database";
import { exportState, importState } from "../src/persistence/export-import";
import { FORWARD_MIGRATIONS, SCHEMA_BASELINE } from "../src/persistence/schema";
import type { InvestigationRequest } from "../src/sdk/investigation-types";
import { binaryInvestigation } from "./fixtures/investigations";

const owner = { key: "owner-id", name: "owner" };
const agent = { key: "agent-id", name: "external-agent" };
const request: InvestigationRequest = { kind: "prediction", question: "Will the release ship?" };

it("upgrades an existing media schema without replacing its migration or losing data", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-investigation-upgrade-"));
  const path = join(directory, "world.db");
  try {
    const previous = new Database(path);
    let mediaTrigger: unknown;
    try {
      previous.exec(SCHEMA_BASELINE);
      for (const migration of FORWARD_MIGRATIONS.filter((entry) => entry.version <= 169)) {
        previous.transaction(() => {
          previous.exec(migration.sql);
          migration.apply?.(previous);
          previous.run("INSERT INTO schema_version(version) VALUES (?)", [migration.version]);
        })();
      }
      previous.run(
        "INSERT INTO core_memory(entity_name, key, value, version, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)",
        ["media:memory", "upgrade-fixture", "preserved"],
      );
      mediaTrigger = previous
        .query("SELECT sql FROM sqlite_schema WHERE name='assets_memory_deleted'")
        .get();
      expect(mediaTrigger).not.toBeNull();
    } finally {
      previous.close();
    }
    const upgraded = new MarinaDB(path);
    try {
      const raw = upgraded.memoryRepository().raw;
      expect(raw.query("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({
        version: 170,
      });
      expect(
        raw.query("SELECT sql FROM sqlite_schema WHERE name='assets_memory_deleted'").get(),
      ).toEqual(mediaTrigger);
      expect(raw.query("SELECT value FROM core_memory WHERE key='upgrade-fixture'").get()).toEqual({
        value: "preserved",
      });
      upgraded.createUser({ id: owner.key, name: owner.name });
      const { attempt } = upgraded.createInvestigation(owner, request, "after-upgrade");
      expect(upgraded.getInvestigation(owner.key, attempt.caseId).attempt.id).toBe(attempt.id);
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable investigations", () => {
  let directory: string;
  let path: string;
  let db: MarinaDB;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-investigation-"));
    path = join(directory, "world.db");
    db = new MarinaDB(path);
    db.createUser({ id: owner.key, name: owner.name });
    db.createUser({ id: agent.key, name: agent.name });
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const completion = () => ({
    state: "completed" as const,
    result: binaryInvestigation,
    forecast: {
      question: request.question,
      kind: "probability" as const,
      probability: 0.65,
      answerJson: JSON.stringify({ private: "secret release details" }),
    },
  });

  it("restores private answers, evidence, grants and admission keys from an operator backup", () => {
    const { attempt } = db.createInvestigation(owner, request, "exported-request");
    const generation = db.claimInvestigation(attempt.id)!;
    const contentId = db.storeInvestigationContent(attempt.id, generation, "evidence", {
      text: "private release evidence",
    });
    db.finishInvestigation(attempt.id, generation, completion());
    db.grantInvestigation(owner.key, attempt.caseId, agent.key, "work");
    const original = db.getInvestigation(owner.key, attempt.caseId);
    const restoredPath = join(directory, "restored.db");
    const empty = new MarinaDB(restoredPath);
    empty.close();
    expect(importState(restoredPath, exportState(path)).errors).toEqual([]);
    const restored = new MarinaDB(restoredPath);
    try {
      expect(restored.getInvestigation(owner.key, attempt.caseId)).toEqual(original);
      expect(restored.getInvestigation(agent.key, attempt.caseId).case.access).toBe("work");
      expect(restored.getInvestigationContent(agent.key, contentId)).toEqual(
        db.getInvestigationContent(agent.key, contentId),
      );
      expect(() => restored.getInvestigation("unrelated-account", attempt.caseId)).toThrow(
        "not found",
      );
      expect(restored.createInvestigation(owner, request, "exported-request").created).toBe(false);
      expect(restored.readInvestigationEvents(owner.key, attempt.id)).toEqual(
        db.readInvestigationEvents(owner.key, attempt.id),
      );
      expect(restored.memoryRepository().raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it("deduplicates admission while preserving deliberate new iterations", () => {
    const first = db.createInvestigation(owner, request, "request-1");
    expect(db.createInvestigation(owner, request, "request-1")).toEqual({
      ...first,
      created: false,
    });
    expect(() =>
      db.createInvestigation(owner, { ...request, question: "Changed question" }, "request-1"),
    ).toThrow("different request");
    const second = db.createInvestigation(
      owner,
      { ...request, caseId: first.attempt.caseId, parentAttemptId: first.attempt.id },
      "iteration-2",
    );
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(db.getInvestigation(owner.key, first.attempt.caseId).attempts).toHaveLength(2);
  });

  it("allows delegated external initiation and revokes inherited child access", () => {
    const first = db.createInvestigation(owner, request, "root").attempt;
    expect(() => db.getInvestigation(agent.key, first.caseId)).toThrow("not found");
    db.grantInvestigation(owner.key, first.caseId, agent.key, "work");
    const child = db.createInvestigation(
      agent,
      { ...request, parentAttemptId: first.id },
      "child",
    ).attempt;
    expect(child.actor).toEqual(agent);
    expect(db.getInvestigation(agent.key, child.caseId).case.owner).toEqual(owner);
    db.grantInvestigation(owner.key, first.caseId, agent.key, null);
    expect(() => db.getInvestigation(agent.key, child.caseId)).toThrow("not found");
    expect(db.getInvestigation(owner.key, child.caseId).attempt.id).toBe(child.id);
  });

  it("commits the canonical answer and publication together, with stale-branch fencing", () => {
    const first = db.createInvestigation(owner, request, "first").attempt;
    const firstGeneration = db.claimInvestigation(first.id)!;
    const second = db.createInvestigation(
      owner,
      { ...request, caseId: first.caseId },
      "second",
    ).attempt;
    const secondGeneration = db.claimInvestigation(second.id)!;
    expect(db.finishInvestigation(second.id, secondGeneration, completion())).toBe(true);
    expect(db.finishInvestigation(first.id, firstGeneration, completion())).toBe(true);
    expect(db.getInvestigation(owner.key, first.caseId).case.currentAttemptId).toBe(second.id);
    const saved = db.getInvestigation(owner.key, first.caseId, first.id).attempt.result!.answerId!;
    expect(db.getForecastAnswer(saved)?.probability).toBe(0.65);
    expect(db.listForecastAnswers(`investigation:${first.caseId}`)).toEqual([]);
    expect(db.openUnlinkedForecasts(100)).toEqual([]);
    expect(db.finishInvestigation(first.id, firstGeneration, completion())).toBe(false);
    expect(db.selectInvestigationAttempt(owner.key, first.id).case.currentAttemptId).toBe(first.id);
  });

  it("rolls filing back when terminal publication fails", () => {
    const first = db.createInvestigation(owner, request, "fail").attempt;
    const generation = db.claimInvestigation(first.id)!;
    const raw = new Database(path);
    raw.exec(
      "CREATE TRIGGER fail_investigation_terminal BEFORE INSERT ON investigation_events WHEN json_extract(new.event_json,'$.kind')='terminal' BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    expect(() => db.finishInvestigation(first.id, generation, completion())).toThrow(
      "injected failure",
    );
    expect(raw.query("SELECT count(*) AS n FROM forecast_answers").get()).toEqual({ n: 0 });
    expect(db.getInvestigation(owner.key, first.caseId).attempt.state).toBe("running");
    raw.close();
  });

  it("cancels owned descendants without stopping unrelated episodes or allowing late publication", () => {
    const root = db.createInvestigation(owner, request, "root").attempt;
    const generation = db.claimInvestigation(root.id)!;
    const child = db.createInvestigation(
      owner,
      { ...request, parentAttemptId: root.id },
      "child",
    ).attempt;
    const unrelated = db.createInvestigation(owner, request, "unrelated").attempt;
    expect(db.cancelInvestigation(owner.key, root.id).sort()).toEqual([root.id, child.id].sort());
    expect(db.finishInvestigation(root.id, generation, completion())).toBe(false);
    expect(db.getInvestigationAttempt(owner.key, unrelated.id).state).toBe("queued");
  });

  it("reopens with durable events and interrupts orphan work without replay", () => {
    const first = db.createInvestigation(owner, request, "recover").attempt;
    const generation = db.claimInvestigation(first.id)!;
    const contentId = db.storeInvestigationContent(first.id, generation, "input", {
      text: "retained evidence",
    });
    db.appendInvestigationEvent(first.id, generation, {
      kind: "stage_started",
      actor: "specialist",
      inputId: contentId,
    });
    const cursor = db.getInvestigation(owner.key, first.caseId).cursor;
    db.close();
    db = new MarinaDB(path);
    expect(db.recoverInvestigations()).toBe(1);
    expect(db.recoverInvestigations()).toBe(0);
    expect(db.readInvestigationEvents(owner.key, first.id, cursor).events[0]?.message).toBe(
      "interrupted",
    );
    expect(db.getInvestigationContent(owner.key, contentId).value).toEqual({
      text: "retained evidence",
    });
    expect(() => db.getInvestigationContent(agent.key, contentId)).toThrow("not found");
    expect(db.readInvestigationEvents(owner.key, first.id, cursor + 100).reset).toBe(true);
  });

  it("keeps private resolutions out of shared learning and erases all controlled copies", async () => {
    const first = db.createInvestigation(owner, request, "erase").attempt;
    const generation = db.claimInvestigation(first.id)!;
    db.finishInvestigation(first.id, generation, completion());
    const answerId = db.getInvestigation(owner.key, first.caseId).attempt.result!.answerId!;
    const resolution = resolveForecast(db, answerId, { outcome: "yes" }, Date.now())!;
    await deliverOutcomes(db, { env: {} });
    expect(
      db
        .outcomeDeliveries(resolution.outcomeId!)
        .every((d) => d.state === "skipped" && d.reason === "private investigation"),
    ).toBe(true);
    db.eraseInvestigation(owner.key, first.caseId);
    expect(db.getForecastAnswer(answerId)?.answer_json).toBe("{}");
    expect(db.isPrivateForecast(answerId)).toBe(true);
    expect(() => db.createInvestigation(owner, request, "erase")).toThrow("erased");
    expect(db.listInvestigations(owner.key)).toEqual([]);
  });

  it("account erasure removes owned cases without affecting another agent's cases", () => {
    db.createInvestigation(owner, request, "owner");
    const other = db.createInvestigation(agent, request, "agent").attempt;
    db.deleteUser(owner.key);
    expect(db.listInvestigations(owner.key)).toEqual([]);
    expect(db.getInvestigation(agent.key, other.caseId).attempt.id).toBe(other.id);
  });

  it("validates answer semantics and bounds rather than silently normalizing mistakes", () => {
    expect(
      parseInvestigationRequest({ ...request, answer: { type: "number", unit: "days" } }).answer,
    ).toEqual({ type: "number", unit: "days" });
    expect(() => parseInvestigationRequest({ ...request, answer: { type: "multi" } })).toThrow(
      "answer.type",
    );
    expect(() => parseInvestigationRequest({ ...request, limits: { calls: 1_000_000 } })).toThrow(
      "calls",
    );
    expect(() => parseInvestigationRequest({ ...request, asOf: "Friday" })).toThrow("ISO");
    expect(() =>
      parseInvestigationRequest({
        ...request,
        answer: {
          type: "choice",
          options: [
            { id: "a", label: "A" },
            { id: "a", label: "Again" },
          ],
        },
      }),
    ).toThrow("unique");
  });
});
