// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  formatSkillContent,
  loadSkillFile,
  resolveConfinedSkillPath,
} from "../../agent/skill-import";
import { memoryAccess } from "../../memory/access";
import { memoryNoteResults, memoryResult } from "../../memory/command-result";
import { header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { isLocalUngated } from "../trust-profile";
import { requiresPersistence } from "./command-messages";
import { auditKnowledgeNotes, renderKnowledgeHygieneReport } from "./knowledge-hygiene";

export function skillCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  logEvent?: (event: EngineEvent) => void;
  getCommandNames?: () => string[];
}): CommandDef {
  return {
    name: "skill",
    aliases: [],
    help: "Skill library — bank what works so it outlives you. Usage: skill store <name> | <desc> | <actions> | skill search <query> | skill verify <id> | skill list | skill audit | skill share <id> <pool> | skill compose <id1> <id2> ... | skill import <path> (rank 3+; path under the server cwd). Example: skill store pool-recall-fanout | find a fact when one keyword misses | recall <topic> ; pool bench-facts recall <synonym> ; note the hit. See also: evolve.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("skills"));
        return;
      }
      const db = deps.db;
      const access = memoryAccess(db, entity);
      const sub = input.tokens[0]?.toLowerCase();

      if (!sub) {
        // Check if agent has any skills — if not, guide them
        const skills = db.getNotesByType(entity.name, "skill");
        if (skills.length === 0) {
          ctx.send(
            input.entity,
            "Skill library (empty). Store reusable action sequences here — a skill is a\n" +
              "named procedure you can replay and that outlives you for your successors.\n" +
              "Usage: skill store <name> | <description> | <action_sequence>\n" +
              "Example: skill store pool-recall-fanout | find a fact when one keyword misses | " +
              "recall <topic> ; pool bench-facts recall <synonym> ; note the hit\n\n" +
              "Looking for help? Try: evolve, help, guide",
          );
        } else {
          ctx.send(
            input.entity,
            "Usage: skill store <name> | <desc> | <actions> | skill search <query> | skill verify <id> | skill list | skill audit | skill share <id> <pool> | skill compose <id1> <id2> ... | skill import <path> (rank 3+)",
          );
        }
        return;
      }

      switch (sub) {
        case "store": {
          const rest = input.args.slice("store".length).trim();
          const parts = rest.split("|").map((p) => p.trim());
          if (parts.length < 3) {
            ctx.send(input.entity, "Usage: skill store <name> | <description> | <action_sequence>");
            return;
          }
          const [name, description, ...actionParts] = parts;
          const actions = actionParts.join(" | ");
          const content = `[Skill: ${name}] ${description} || Actions: ${actions}`;
          const id = db.createNote(entity.name, content, undefined, {
            importance: 6,
            noteType: "skill",
          });
          deps.logEvent?.({
            type: "note_created",
            entity: input.entity,
            noteId: id,
            authorName: entity.name,
            content,
            importance: 6,
            noteType: "skill",
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Skill #${id} "${name}" stored.`);
          return;
        }

        case "search": {
          const query = input.tokens.slice(1).join(" ");
          if (!query) {
            ctx.send(
              input.entity,
              "Usage: skill search <query>",
              undefined,
              memoryResult("skill-search", { success: false, error: "Query required" }),
            );
            return;
          }
          const results = db.recallNotesWithType(entity.name, query, "skill", {
            weightImportance: 0.4,
            weightRecency: 0.2,
            weightRelevance: 0.4,
          });
          if (results.length === 0) {
            ctx.send(
              input.entity,
              "No matching skills found.",
              undefined,
              memoryResult("skill-search", { success: true, notes: [] }),
            );
            return;
          }
          // Touch each to track recall
          for (const note of results) {
            db.touchNote(note.id);
          }
          const lines = [
            header(`Skills: "${query}"`),
            separator(),
            ...results.map((n) => {
              return `  #${n.id} [imp=${n.importance} score=${n.score.toFixed(2)}]: ${n.content.slice(0, 80)}`;
            }),
          ];
          ctx.send(
            input.entity,
            lines.join("\n"),
            undefined,
            memoryResult("skill-search", { success: true, notes: memoryNoteResults(results) }),
          );
          return;
        }

        case "verify": {
          const id = Number.parseInt(input.tokens[1] ?? "", 10);
          if (Number.isNaN(id)) {
            ctx.send(input.entity, "Usage: skill verify <id>");
            return;
          }
          const note = db.getNote(id);
          if (!access.write(note) || note.note_type !== "skill") {
            ctx.send(input.entity, `Skill #${id} not found.`);
            return;
          }
          // Add a supports self-link to indicate verification
          try {
            db.createNoteLink(id, id, "supports");
            deps.logEvent?.({
              type: "note_link_created",
              entity: input.entity,
              sourceId: id,
              targetId: id,
              relationship: "supports",
              timestamp: Date.now(),
            });
          } catch {
            // Already verified by this mechanism
          }
          // Boost importance (capped at 10)
          const newImportance = Math.min(note.importance + 1, 10);
          // We need to update importance directly — use a corrected version
          if (newImportance > note.importance) {
            // Create a new note that supersedes with higher importance
            // Actually, just update the note's importance via touch + recall pattern
            // For simplicity, store a verification note linking to the skill
            const verifyContent = `[Verified skill #${id}] ${note.content.slice(0, 60)}`;
            const verifyId = db.createNote(entity.name, verifyContent, undefined, {
              importance: 3,
              noteType: "observation",
            });
            deps.logEvent?.({
              type: "note_created",
              entity: input.entity,
              noteId: verifyId,
              authorName: entity.name,
              content: verifyContent,
              importance: 3,
              noteType: "observation",
              timestamp: Date.now(),
            });
            try {
              db.createNoteLink(verifyId, id, "supports");
              deps.logEvent?.({
                type: "note_link_created",
                entity: input.entity,
                sourceId: verifyId,
                targetId: id,
                relationship: "supports",
                timestamp: Date.now(),
              });
            } catch {
              // Ignore
            }
          }
          ctx.send(input.entity, `Skill #${id} verified. Verification recorded.`);
          return;
        }

        case "list": {
          const skills = db.getNotesByType(entity.name, "skill");
          if (skills.length === 0) {
            ctx.send(input.entity, "No skills stored.");
            return;
          }
          const lines = [
            header("Skill Library"),
            separator(),
            ...skills.map((n) => {
              // Count supports links as verification count
              const links = db.getNoteLinks(n.id);
              const verifications = links.filter(
                (l) => l.relationship === "supports" && l.target_id === n.id,
              ).length;
              const verified = verifications > 0 ? ` [verified x${verifications}]` : "";
              return `  #${n.id} (imp=${n.importance})${verified}: ${n.content.slice(0, 70)}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "audit": {
          const notes = db.getNotesByType(entity.name, "skill", 500);
          const report = auditKnowledgeNotes(notes, { knownCommands: deps.getCommandNames?.() });
          ctx.send(input.entity, renderKnowledgeHygieneReport("Skill library", report));
          return;
        }

        case "share": {
          const id = Number.parseInt(input.tokens[1] ?? "", 10);
          const poolName = input.tokens[2];
          if (Number.isNaN(id) || !poolName) {
            ctx.send(input.entity, "Usage: skill share <id> <pool>");
            return;
          }
          const note = db.getNote(id);
          if (!access.write(note) || note.note_type !== "skill") {
            ctx.send(input.entity, `Skill #${id} not found.`);
            return;
          }
          const pool = db.getMemoryPool(poolName);
          if (!pool || !access.pool(pool)) {
            ctx.send(input.entity, `Pool "${poolName}" not found.`);
            return;
          }
          const sharedId = db.addPoolNote(
            pool.id,
            entity.name,
            note.content,
            note.importance,
            "skill",
          );
          try {
            db.createNoteLink(sharedId, id, "related_to");
            deps.logEvent?.({
              type: "note_link_created",
              entity: input.entity,
              sourceId: sharedId,
              targetId: id,
              relationship: "related_to",
              timestamp: Date.now(),
            });
          } catch {
            // Ignore
          }
          ctx.send(input.entity, `Skill #${id} shared to pool "${poolName}" as note #${sharedId}.`);
          return;
        }

        case "compose": {
          const ids = input.tokens
            .slice(1)
            .map((t) => Number.parseInt(t, 10))
            .filter((n) => !Number.isNaN(n));
          if (ids.length < 2) {
            ctx.send(input.entity, "Usage: skill compose <id1> <id2> [id3] ...");
            return;
          }
          const skills = ids
            .map((id) => db.getNote(id))
            .filter((n): n is NonNullable<typeof n> => access.read(n) && n.note_type === "skill");
          if (skills.length < 2 || skills.length !== ids.length) {
            ctx.send(input.entity, "Need at least 2 valid skill notes to compose.");
            return;
          }

          // Extract action sequences and compose
          const actionParts: string[] = [];
          const nameparts: string[] = [];
          for (const s of skills) {
            // Parse out action sequence from "[Skill: name] desc || Actions: ..."
            const actMatch = s.content.match(/Actions:\s*(.+)/);
            if (actMatch?.[1]) {
              actionParts.push(actMatch[1].trim());
            }
            const nameMatch = s.content.match(/\[Skill:\s*([^\]]+)\]/);
            if (nameMatch?.[1]) {
              nameparts.push(nameMatch[1].trim());
            }
          }

          const composedName = nameparts.join(" + ") || "composed_skill";
          const composedActions = actionParts.join(" ; ");
          const content = `[Skill: ${composedName}] Composed from skills ${ids.map((i) => `#${i}`).join(", ")} || Actions: ${composedActions}`;
          const maxImp = Math.min(Math.max(...skills.map((s) => s.importance)) + 1, 10);
          const newId = db.createNote(entity.name, content, undefined, {
            importance: maxImp,
            noteType: "skill",
          });
          deps.logEvent?.({
            type: "note_created",
            entity: input.entity,
            noteId: newId,
            authorName: entity.name,
            content,
            importance: maxImp,
            noteType: "skill",
            timestamp: Date.now(),
          });

          // Link to component skills
          for (const s of skills) {
            try {
              db.createNoteLink(s.id, newId, "part_of");
              deps.logEvent?.({
                type: "note_link_created",
                entity: input.entity,
                sourceId: s.id,
                targetId: newId,
                relationship: "part_of",
                timestamp: Date.now(),
              });
            } catch {
              // Ignore
            }
          }

          ctx.send(
            input.entity,
            `Composed skill #${newId} "${composedName}" from ${skills.length} skills (importance=${maxImp}).`,
          );
          return;
        }

        case "import": {
          // Host file read driven by in-world input: rank-gated and confined
          // to the server's working directory (see resolveConfinedSkillPath).
          const rank = (entity.properties.rank as number | undefined) ?? 0;
          if (rank < 3 && !isLocalUngated()) {
            ctx.send(input.entity, "skill import requires rank 3+ (host file access)");
            return;
          }
          const path = input.tokens.slice(1).join(" ").trim();
          if (!path) {
            ctx.send(
              input.entity,
              "Usage: skill import <path-to-markdown-file>\n\n" +
                "Imports a skill from a markdown file with YAML frontmatter:\n" +
                "  ---\n" +
                "  name: my-skill\n" +
                "  description: what it does\n" +
                "  tags: foo, bar\n" +
                "  importance: 7\n" +
                "  ---\n" +
                "  <procedure body>",
            );
            return;
          }
          let parsed: ReturnType<typeof loadSkillFile>;
          try {
            // LOCAL profile: any readable path (the operator's own files).
            parsed = loadSkillFile(isLocalUngated() ? path : resolveConfinedSkillPath(path));
          } catch (err) {
            ctx.send(input.entity, err instanceof Error ? err.message : String(err));
            return;
          }
          const content = formatSkillContent(parsed);
          const newId = db.createNote(entity.name, content, undefined, {
            importance: parsed.importance,
            noteType: "skill",
          });
          deps.logEvent?.({
            type: "note_created",
            entity: input.entity,
            noteId: newId,
            authorName: entity.name,
            content,
            importance: parsed.importance,
            noteType: "skill",
            timestamp: Date.now(),
          });
          ctx.send(
            input.entity,
            `Imported skill #${newId} "${parsed.name}" (importance=${parsed.importance}, tags=${parsed.tags.join(",") || "—"}).`,
          );
          return;
        }

        default: {
          ctx.send(
            input.entity,
            "Usage: skill store <name> | <desc> | <actions> | skill search <query> | skill verify <id> | skill list | skill audit | skill share <id> <pool> | skill compose <id1> <id2> ... | skill import <path> (rank 3+)",
          );
        }
      }
    },
  };
}
