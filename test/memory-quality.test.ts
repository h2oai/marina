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
});
