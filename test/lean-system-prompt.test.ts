import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLeanSystemPrompt } from "../src/agent/prompts/lean-system";

describe("getLeanSystemPrompt", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.MARINA_SYSTEM_TOOLS_PROSE;
    delete process.env.MARINA_SYSTEM_TOOLS_PROSE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MARINA_SYSTEM_TOOLS_PROSE;
    else process.env.MARINA_SYSTEM_TOOLS_PROSE = prev;
  });

  it("includes the role and the core sections exactly once", () => {
    const p = getLeanSystemPrompt("ROLE_MARKER");
    expect(p).toContain("ROLE_MARKER");
    expect(p.match(/# HOW TO BE/g) ?? []).toHaveLength(1);
    expect(p.match(/# EVERY TURN/g) ?? []).toHaveLength(1);
  });

  it("includes the tool-roster prose by default", () => {
    const p = getLeanSystemPrompt(null);
    expect(p).toContain("# TOOLS");
    expect(p).toContain("Recall is intent-aware");
  });

  it("frames world action as productive communication, memory, and coordination", () => {
    const p = getLeanSystemPrompt(null);
    expect(p).toContain("Productive action includes observing, retrieving, writing memory");
    expect(p).toContain("messaging a peer");
    expect(p).toContain("Prefer direct communication when a human or peer can unblock the work");
    expect(p).toContain("brief social");
  });

  it("omits the tool-roster prose when MARINA_SYSTEM_TOOLS_PROSE=off (for A/B)", () => {
    process.env.MARINA_SYSTEM_TOOLS_PROSE = "off";
    const p = getLeanSystemPrompt("ROLE_MARKER");
    expect(p).not.toContain("# TOOLS");
    // Everything else still present and not duplicated.
    expect(p).toContain("ROLE_MARKER");
    expect(p.match(/# HOW TO BE/g) ?? []).toHaveLength(1);
    expect(p.match(/# EVERY TURN/g) ?? []).toHaveLength(1);
    // Toggling off should meaningfully shrink the prompt.
    expect(getLeanSystemPrompt("ROLE_MARKER").length).toBeLessThan(
      (() => {
        delete process.env.MARINA_SYSTEM_TOOLS_PROSE;
        return getLeanSystemPrompt("ROLE_MARKER").length;
      })(),
    );
  });
});
