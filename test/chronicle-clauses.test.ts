import { describe, expect, it } from "bun:test";
import { extractChronicleClauses } from "../src/engine/commands/chronicle";

const KEYS = ["refs", "participants", "period"];

describe("extractChronicleClauses", () => {
  it("keeps the compact form", () => {
    const r = extractChronicleClauses("T | Body. refs feed:1,task:2 participants alice,bob", KEYS);
    expect(r.text).toBe("T | Body.");
    expect(r.modifiers).toEqual({ refs: "feed:1,task:2", participants: "alice,bob" });
  });

  it("reads a comma-space list (the Chronicler's own shape)", () => {
    const r = extractChronicleClauses("T | Status: blocked. refs task:3, note:10538", KEYS);
    expect(r.text).toBe("T | Status: blocked.");
    expect(r.modifiers.refs).toBe("task:3, note:10538");
  });

  it("reads `refs:` with a space and clauses set off by pipes, in any order", () => {
    const r = extractChronicleClauses(
      "Day | Summary. | refs: note:1, chronicle:344, feed:345 | period day:2026-11-03 | participants Builder, Critic",
      KEYS,
    );
    expect(r.text).toBe("Day | Summary.");
    expect(r.modifiers).toEqual({
      refs: "note:1, chronicle:344, feed:345",
      period: "day:2026-11-03",
      participants: "Builder, Critic",
    });
  });

  it("reads --key=value and key=value", () => {
    expect(extractChronicleClauses("T | B --refs=feed:1", KEYS).modifiers.refs).toBe("feed:1");
    expect(extractChronicleClauses("T | B refs=feed:1,feed:2", KEYS).modifiers.refs).toBe(
      "feed:1,feed:2",
    );
  });

  it("leaves a key word inside the body alone", () => {
    const r = extractChronicleClauses("T | The refs a, b were checked later.", KEYS);
    expect(r.text).toBe("T | The refs a, b were checked later.");
    expect(r.modifiers).toEqual({});
  });

  it("never reads a body word glued to a key as a clause", () => {
    expect(extractChronicleClauses("T | cross-refs note:1", KEYS).modifiers).toEqual({});
    expect(extractChronicleClauses("T | xrefs note:1", KEYS).modifiers).toEqual({});
  });
});
