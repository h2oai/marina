import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLeanSystemPrompt } from "../src/agent/prompts/lean-system";
import { composeRolePrompt } from "../src/agent/roles";

/** Every markdown heading (`#`/`##`) that appears more than once in `text`. */
function duplicateHeadings(text: string): string[] {
  const counts = new Map<string, number>();
  for (const h of text.match(/^#{1,2} .+$/gm) ?? []) {
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([h]) => h);
}

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

  // Prompt-surface guardrails (Phase 1 inspectability) — these are bloat/
  // duplication tripwires, deliberately NOT linked to any eval or benchmark.
  describe("prompt-surface guardrails", () => {
    it("has no duplicated section headings in the base prompt", () => {
      expect(duplicateHeadings(getLeanSystemPrompt(null))).toEqual([]);
    });

    it("keeps headings unique when a composed role section is spliced in", () => {
      // A role section carries its own ## headings (Capabilities Profile, Focus
      // Areas, Behavioral Guidelines, Tone) — none may collide with the base.
      const roleSection = composeRolePrompt({
        name: "scout",
        description: "Explore and report.",
        traitNames: ["curious"],
        missingTraitNames: [],
        traitPrompts: ["Ask why."],
        traitCapabilities: [{ strengths: ["exploration"], behaviors: ["retrieve-first"] }],
        guidelines: ["Keep notes"],
        focus: ["explore"],
        tone: "calm",
        origin: "test",
      });
      expect(duplicateHeadings(getLeanSystemPrompt(roleSection))).toEqual([]);
    });

    it("keeps the base prompt within a compact length budget", () => {
      // Current base prompt (with tool prose) is ~4k chars. The budget is a
      // tripwire against prompt bloat — if a change legitimately needs more
      // room, raise this deliberately rather than letting it drift.
      const BUDGET = 6000;
      expect(getLeanSystemPrompt(null).length).toBeLessThan(BUDGET);
    });
  });
});
