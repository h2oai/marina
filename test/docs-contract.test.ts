// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

const readDoc = async (path: string) => Bun.file(path).text();

const currentDocs = [
  "README.md",
  "SKILL.md",
  "skills/marina-claude/SKILL.md",
  "docs/guides/agent-development.md",
  "docs/guides/coding.md",
  "docs/guides/commands.md",
  "docs/guides/building-worlds.md",
  "docs/guides/federation.md",
  "docs/guides/getting-started.md",
  "docs/guides/coordination.md",
  "docs/guides/troubleshooting.md",
  "docs/guides/markets.md",
  "docs/guides/memory.md",
  "docs/guides/civic-substrate.md",
  "docs/guides/configuration.md",
  "docs/marina-foundational-paper.md",
];

describe("documentation contract", () => {
  it("keeps README pointed at SKILL.md as the command field guide", async () => {
    const readme = await readDoc("README.md");

    expect(readme).toContain(
      "The complete command reference and operational manual live in [SKILL.md](SKILL.md).",
    );
    expect(readme).toContain("`SKILL.md` is the agent-facing field guide.");
  });

  it("keeps root SKILL.md anchored on agent and prompt-surface contracts", async () => {
    const skill = await readDoc("SKILL.md");

    expect(skill).toContain("## Agent Operating Contract");
    expect(skill).toContain("## Prompt and Knowledge Surfaces");
  });

  it("keeps the Claude skill scoped to connection modes and root Marina guidance", async () => {
    const claudeSkill = await readDoc("skills/marina-claude/SKILL.md");

    expect(claudeSkill).toContain("## Scope");
    expect(claudeSkill).toContain("This skill is a Claude connection adapter.");
    expect(claudeSkill).toContain("use the root `SKILL.md` served by the Marina instance");
    expect(claudeSkill).toContain("`GET /api/skill`");
    expect(claudeSkill).toContain("the repository copy at `SKILL.md`");
  });

  it("does not preserve stale seeded role and trait count claims", async () => {
    const docs = await Promise.all([readDoc("README.md"), readDoc("SKILL.md")]);

    for (const doc of docs) {
      expect(doc).not.toMatch(/\b(?:six|6) roles and (?:nine|9) traits\b/i);
    }
  });

  it("keeps current command examples aligned with implemented command names", async () => {
    const docs = await Promise.all(currentDocs.map(readDoc));

    for (const doc of docs) {
      expect(doc).not.toContain("reflection <");
      expect(doc).not.toMatch(/\bpool join\b/);
      expect(doc).not.toMatch(/\bpool [\w:-]+ read\b/);
      expect(doc).not.toMatch(/\bbuild command [\w-]+ \|/);
      expect(doc).not.toContain("build metrics");
      expect(doc).not.toMatch(/\bboard reply [\w-]+ \|/);
      expect(doc).not.toMatch(/\bboard vote [\w-]+ \|/);
      expect(doc).not.toMatch(/\bsource room\b/);
    }
  });

  it("keeps current access docs focused on existing gates, not stale rank ladders", async () => {
    const docs = await Promise.all(currentDocs.map(readDoc));

    for (const doc of docs) {
      expect(doc).not.toContain("auto-promoted to rank 4 (admin)");
      expect(doc).not.toContain("minRank is the only permission gate");
      expect(doc).not.toContain("Spawning requires Builder rank");
      expect(doc).not.toContain("Builder rank (2)");
      expect(doc).not.toMatch(/\brank\s*[5-9]\+\b/i);
      expect(doc).not.toMatch(/\b(?:Guardian|Steward|Sovereign)\+/);
      expect(doc).not.toContain("Sovereign only");
      expect(doc).not.toContain("Admin (Rank 4)");
      expect(doc).not.toContain("API Keys (Admin)");
      expect(doc).not.toContain("Platform Adapters (Admin)");
      expect(doc).not.toContain("Ask an admin to promote you");
      expect(doc).not.toContain("Promotes to Canvas rank");
      expect(doc).not.toContain("Rank: Guest (0)");
      expect(doc).not.toContain("Rank: Citizen (1)");
      expect(doc).not.toMatch(/Resolve market \((Builder|Coordinator) rank required\)/);
    }
  });

  it("keeps the fast-loop contract visible in current guidance", async () => {
    const [readme, skill, behaviorGuide] = await Promise.all([
      readDoc("README.md"),
      readDoc("SKILL.md"),
      readDoc("docs/guides/behavior-surfaces.md"),
    ]);

    for (const doc of [readme, skill, behaviorGuide]) {
      expect(doc).toContain("Fast Loop");
      expect(doc).toContain("canvas intent claim");
      expect(doc).toContain("crew dispatch");
      expect(doc).toContain("brief social");
    }
  });
});
