// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { auditKnowledgeNotes } from "../src/engine/commands/knowledge-hygiene";
import type { NoteRow } from "../src/persistence/database";
import {
  AUCTION_TEMPLATE,
  BLACKBOARD_TEMPLATE,
  CHORUS_TEMPLATE,
  DEBATE_TEMPLATE,
  DELIBERATION_TEMPLATE,
  DELPHI_TEMPLATE,
  FOUNDRY_TEMPLATE,
  LEDGER_TEMPLATE,
  MAPREDUCE_TEMPLATE,
  ORCHESTRATION_PATTERNS,
  PATTERN_FIT,
  PATTERN_VALIDATION,
  PIPELINE_TEMPLATE,
  RESEARCH_TEMPLATE,
  SHARDING_TEMPLATE,
  SWARM_TEMPLATE,
  SYMBIOSIS_TEMPLATE,
  type TemplateNote,
  TOURNAMENT_TEMPLATE,
  VERIFICATION_TEMPLATE,
} from "../src/world/templates/orchestration";
import { createTestEngine } from "./engine-fixture";

const TEMPLATES: Record<string, TemplateNote[]> = {
  deliberation: DELIBERATION_TEMPLATE,
  chorus: CHORUS_TEMPLATE,
  foundry: FOUNDRY_TEMPLATE,
  swarm: SWARM_TEMPLATE,
  pipeline: PIPELINE_TEMPLATE,
  debate: DEBATE_TEMPLATE,
  mapreduce: MAPREDUCE_TEMPLATE,
  blackboard: BLACKBOARD_TEMPLATE,
  symbiosis: SYMBIOSIS_TEMPLATE,
  research: RESEARCH_TEMPLATE,
  delphi: DELPHI_TEMPLATE,
  tournament: TOURNAMENT_TEMPLATE,
  verification: VERIFICATION_TEMPLATE,
  auction: AUCTION_TEMPLATE,
  ledger: LEDGER_TEMPLATE,
  sharding: SHARDING_TEMPLATE,
};

const ADDED = ["delphi", "tournament", "verification", "auction", "ledger", "sharding"];
const BUILTIN = ORCHESTRATION_PATTERNS.filter((p) => p !== "custom");

describe("orchestration pattern templates", () => {
  it("every built-in pattern has a template, a fit entry and a validation entry", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...BUILTIN].sort());
    for (const pattern of BUILTIN) {
      expect(PATTERN_FIT[pattern], pattern).toBeDefined();
      expect(PATTERN_VALIDATION[pattern], pattern).toBeDefined();
    }
  });

  it.each(BUILTIN)("%s has 5 skill notes, opening at importance 9, closing at 7", (pattern) => {
    const notes = TEMPLATES[pattern] ?? [];
    expect(notes).toHaveLength(5);
    for (const note of notes) expect(note.type).toBe("skill");
    expect(notes[0]?.importance).toBe(9);
    expect(notes[4]?.importance).toBe(7);
  });

  it.each(ADDED)("%s follows the 9 / 8 / 8 / 8 / 7 importance layout", (pattern) => {
    expect((TEMPLATES[pattern] ?? []).map((n) => n.importance)).toEqual([9, 8, 8, 8, 7]);
  });

  it.each(ADDED)("%s is advisory: no imperative 'must'", (pattern) => {
    for (const note of TEMPLATES[pattern] ?? []) expect(note.content).not.toMatch(/\bmust\b/i);
  });

  describe("command references", () => {
    let fixture: ReturnType<typeof createTestEngine>;
    let commandNames: string[];

    beforeAll(() => {
      fixture = createTestEngine();
      commandNames = fixture.engine.commands
        .allBuiltins()
        .flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]);
    });
    afterAll(() => fixture.dispose());

    it.each(BUILTIN)("%s notes pass the knowledge-hygiene audit", (pattern) => {
      const notes = (TEMPLATES[pattern] ?? []).map(
        (note, index) => ({ id: index + 1, content: note.content }) as NoteRow,
      );
      const report = auditKnowledgeNotes(notes, { knownCommands: commandNames });
      expect(report.staleCommands.map((f) => f.detail)).toEqual([]);
      expect(report.duplicateGroups).toEqual([]);
      expect(report.overlong.map((f) => f.detail)).toEqual([]);
      expect(report.unsupportedClaims.map((f) => f.detail)).toEqual([]);
    });

    it.each(ADDED)("every backticked command in %s names a real verb", (pattern) => {
      // Stricter than the auditor for the new notes: every backticked ref must
      // start with a registered command, and a literal second token must be a
      // subcommand some declared usage form starts with (or the command must
      // take a positional argument there).
      const defs = new Map(
        fixture.engine.commands
          .allBuiltins()
          .flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])].map((n) => [n, cmd] as const)),
      );
      const problems: string[] = [];
      for (const note of TEMPLATES[pattern] ?? []) {
        for (const match of note.content.matchAll(/`([^`]+)`/g)) {
          const tokens = (match[1] ?? "").trim().split(/\s+/);
          const def = defs.get(tokens[0] ?? "");
          if (!def) {
            problems.push(`unknown command in \`${match[1]}\``);
            continue;
          }
          const sub = tokens[1];
          if (!sub || !/^[a-z][a-z-]*$/.test(sub)) continue;
          const forms = (def.usage ?? []).map(
            (u) => (typeof u === "string" ? u : u.syntax).split(/\s+/)[1] ?? "",
          );
          const ok = forms.some((f) => f === sub || f.startsWith("<") || f.includes(sub));
          if (!ok) problems.push(`\`${match[1]}\`: "${sub}" is not a ${def.name} form`);
        }
      }
      expect(problems).toEqual([]);
    });
  });
});
