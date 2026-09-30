// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CREW_BRIEFS } from "../src/coordination/crew-formations";
import { auditKnowledgeNotes } from "../src/engine/commands/knowledge-hygiene";
import type { NoteRow } from "../src/persistence/database";
import type { CrewFormation } from "../src/types";
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
/** Supported spellings that are deliberately absent from `usage` (the bare
 *  `memory set/get/...` forms of `memory kv`, documented in memory.ts). */
const LEGACY_BARE_FORMS = new Set(["memory set"]);

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

    // Stricter than the auditor: every backticked ref must start with a
    // registered command, and a literal second token must be a subcommand some
    // declared usage form starts with (or the command must take a positional
    // argument there).
    function commandProblems(texts: string[]): string[] {
      const defs = new Map(
        fixture.engine.commands
          .allBuiltins()
          .flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])].map((n) => [n, cmd] as const)),
      );
      const problems: string[] = [];
      for (const text of texts) {
        for (const match of text.matchAll(/`([^`]+)`/g)) {
          const tokens = (match[1] ?? "").trim().split(/\s+/);
          const def = defs.get(tokens[0] ?? "");
          if (!def) {
            problems.push(`unknown command in \`${match[1]}\``);
            continue;
          }
          const sub = tokens[1];
          if (!sub || !/^[a-z][a-z-]*$/.test(sub)) continue;
          if (LEGACY_BARE_FORMS.has(`${def.name} ${sub}`)) continue;
          const forms = (def.usage ?? []).map(
            (u) => (typeof u === "string" ? u : u.syntax).split(/\s+/)[1] ?? "",
          );
          const ok = forms.some((f) => f === sub || f.startsWith("<") || f.includes(sub));
          if (!ok) problems.push(`\`${match[1]}\`: "${sub}" is not a ${def.name} form`);
        }
      }
      return problems;
    }

    it.each(BUILTIN)("every backticked command in %s names a real verb", (pattern) => {
      expect(commandProblems((TEMPLATES[pattern] ?? []).map((n) => n.content))).toEqual([]);
    });

    it.each(BUILTIN)("every backticked command in the %s crew brief names a real verb", (p) => {
      expect(commandProblems([CREW_BRIEFS[p as CrewFormation]])).toEqual([]);
    });
  });

  it.each(ADDED)("%s opens with a concrete starting move", (pattern) => {
    // Template: the overview note ends with a copyable first command.
    expect(TEMPLATES[pattern]?.[0]?.content).toMatch(/Start with: `[^`]+`/);
    // Crew brief: the runtime brief leads with the opening move.
    const brief = CREW_BRIEFS[pattern as CrewFormation];
    expect(brief).toStartWith("Start — ");
    expect(brief).toMatch(/`[^`]+`/);
  });
});
