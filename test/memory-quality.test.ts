// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

describe("evidence-aware memory", () => {
  let db: MarinaDB;
  let path: string;

  beforeEach(() => {
    path = join("/tmp", `marina-memory-quality-${crypto.randomUUID()}.db`);
    db = new MarinaDB(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("keeps source provenance and confidence", () => {
    const id = db.createNote("Ada", "The launch window is Tuesday", undefined, {
      noteType: "fact",
      confidence: 0.8,
      verificationStatus: "verified",
    });
    db.addNoteSource(id, { url: "https://example.test/schedule", observedAt: 1_700_000_000_000 });
    expect(db.getNote(id)?.confidence).toBe(0.8);
    expect(db.getNoteSources(id)[0]?.url).toBe("https://example.test/schedule");
  });

  test("detects polarity contradictions without resolving them", () => {
    db.createNote("Ada", "The reactor is stable", undefined, { skipDedup: true });
    db.createNote("Ada", "The reactor is not stable", undefined, { skipDedup: true });
    expect(db.findMemoryContradictions("Ada")).toHaveLength(1);
  });

  test("consolidation retains records and hides superseded notes from recall", () => {
    const keeper = db.createNote("Ada", "Signal quality is excellent", undefined, {
      skipDedup: true,
    });
    const duplicate = db.createNote("Ada", "Signal quality is excellent today", undefined, {
      skipDedup: true,
    });
    expect(db.consolidateNotes("Ada", keeper, [duplicate])).toBe(1);
    expect(db.getNote(duplicate)?.verification_status).toBe("superseded");
    expect(db.recallNotes("Ada", "Signal quality").some((n) => n.id === duplicate)).toBe(false);
    expect(db.getNoteLinks(keeper).some((l) => l.relationship === "supersedes")).toBe(true);
  });

  test("attention policy survives config upserts", () => {
    db.saveAgentConfig({ name: "Ada", model: "openai/test", spawnedBy: "system" });
    db.updateAttentionPolicy("Ada", "focused", 70);
    db.saveAgentConfig({ name: "Ada", model: "openai/test-2", spawnedBy: "system" });
    expect(db.getAgentConfig("Ada")?.attention_mode).toBe("focused");
    expect(db.getAgentConfig("Ada")?.attention_threshold).toBe(70);
    expect(db.recordAttentionFeedback("Ada", "useful")?.attention_threshold).toBe(65);
    expect(db.recordAttentionFeedback("Ada", "noise")?.attention_threshold).toBe(70);
  });

  test("calibrates confidence from evidence and dispute state", () => {
    const verified = db.createNote("Ada", "Verified claim", undefined, {
      verificationStatus: "verified",
      confidence: 0.2,
    });
    db.addNoteSource(verified, { url: "https://example.test/a" });
    const disputed = db.createNote("Ada", "Disputed claim", undefined, {
      verificationStatus: "disputed",
      confidence: 0.9,
    });
    db.calibrateMemoryConfidence();
    expect(db.getNote(verified)?.confidence).toBe(0.75);
    expect(db.getNote(disputed)?.confidence).toBe(0.25);
  });

  test("persists operational alert acknowledgement and resolution", () => {
    const alert = db.upsertOperationalAlert({
      key: "memory:test",
      severity: "warning",
      category: "memory",
      title: "Test",
      detail: "Needs review",
      remedy: "note contradictions",
    });
    expect(db.setOperationalAlertStatus(alert.id, "acknowledged")).toBe(true);
    expect(db.listOperationalAlerts("acknowledged")).toHaveLength(1);
    expect(db.setOperationalAlertStatus(alert.id, "resolved")).toBe(true);
    expect(db.listOperationalAlerts("resolved")).toHaveLength(1);
  });

  test("preserves typed derivation provenance and verification rationale", () => {
    const source = db.createNote("Ada", "Primary observation", undefined, { confidence: 0.8 });
    const claim = db.createNote("Ada", "Derived conclusion", undefined, { confidence: 0.6 });
    db.addNoteSource(claim, {
      url: `note:${source}`,
      sourceType: "note",
      sourceNoteId: source,
      sourceEntity: "Ada",
      capturedBy: "Ada",
      excerpt: "Primary observation",
      credibility: 0.8,
    });
    db.recordNoteVerification(
      claim,
      "Reviewer",
      "verified",
      0.9,
      "Confirmed against the observation",
    );
    const provenance = db.getNoteSources(claim)[0];
    expect(provenance?.source_note_id).toBe(source);
    expect(provenance?.source_type).toBe("note");
    expect(provenance?.credibility).toBe(0.8);
    expect(db.getNoteVerifications(claim)[0]?.rationale).toBe("Confirmed against the observation");
    expect(db.getNote(claim)?.verification_status).toBe("verified");
  });

  test("opens and resolves contradictions across agents in a shared pool", () => {
    db.createMemoryPool("shared", "Shared", "Ada");
    const left = db.addPoolNote("shared", "Ada", "The launch is approved", 7, "fact");
    const right = db.addPoolNote("shared", "Grace", "The launch is not approved", 7, "fact");
    expect(db.refreshContradictionCases()).toBe(1);
    const conflict = db.listContradictionCases("open")[0]!;
    expect(conflict.scope_type).toBe("pool");
    expect(
      db.resolveContradictionCase(conflict.id, "left", "Reviewer", "Approval record inspected"),
    ).toBe(true);
    expect(db.getNote(left)?.verification_status).toBe("verified");
    expect(db.getNote(right)?.verification_status).toBe("disputed");
    expect(db.listContradictionCases("resolved")).toHaveLength(1);
  });

  test("learns attention and productivity from terminal outcomes", () => {
    db.saveAgentConfig({ name: "Ada", model: "openai/test", spawnedBy: "system" });
    expect(db.recordAutomaticAttentionOutcome("Ada", "success")?.attention_threshold).toBe(51);
    expect(db.recordAutomaticAttentionOutcome("Ada", "failure")?.attention_threshold).toBe(48);
    const startedAt = Date.now() - 60_000;
    db.startProductivitySession("agent-ada", "Ada", 42, startedAt, 10);
    expect(
      db.finishProductivitySession("agent-ada", "Ada", 42, "approved", startedAt + 60_000, 14),
    ).toBe(true);
    const summary = db.getProductivitySummary("Ada");
    expect(summary.successRate).toBe(1);
    expect(summary.medianDurationMs).toBe(60_000);
    expect(summary.averageToolCalls).toBe(4);
    const trend = db.getProductivityTrend("Ada");
    expect(trend).toHaveLength(1);
    expect(trend[0]?.outcomes).toBe(1);
    expect(trend[0]?.successes).toBe(1);
  });
});
