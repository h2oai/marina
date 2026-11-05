// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  BUILTIN_SKILLS,
  builtinSkill,
  rankBuiltinSkills,
  searchBuiltinSkills,
} from "../../agent/builtin-skills";
import {
  formatSkillContent,
  loadSkillFile,
  resolveConfinedSkillPath,
} from "../../agent/skill-import";
import { memoryAccess } from "../../memory/access";
import { memoryNoteResults, memoryResult } from "../../memory/command-result";
import { isSkillDraft, skillContent, skillSlug, skillSteps } from "../../memory/skill-draft";
import { promoteSkill } from "../../memory/skill-promotion";
import { header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { refuseCommand } from "../command-response";
import { tryLog } from "../errors";
import { currentEvidenceCutoffMs } from "../evidence-fence";
import { beginTrial, endTrial, type TrialDeps } from "../evolution-trial";
import { principalOf } from "../gate-context";
import { Logger } from "../logger";
import { type ModifierSpec, parseModifiers } from "../parse-input";
import { rankFloorRefusal } from "../rank-floor";
import { checkGateForExecution, recordGateExecution } from "../safety-gates";
import { renderSkillTrial, runSkillTrial, storedSkillTrial } from "../skill-trial";
import { isLocalUngated } from "../trust-profile";
import { requiresPersistence } from "./command-messages";
import { DEFAULT_TRIAL_BENCHMARK, type TrialOptions } from "./evolve";
import {
  auditKnowledgeNotes,
  type CommandVocabulary,
  renderKnowledgeHygieneReport,
} from "./knowledge-hygiene";

/** Bytes `skill top` returns by default, and at most. */
export const SKILL_TOP_DEFAULT_BYTES = 800;
export const SKILL_TOP_MAX_BYTES = 2_000;

/** `text` cut to `max` UTF-8 bytes at a line or word boundary, marked when cut. */
export function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let cut = text;
  while (Buffer.byteLength(cut) > max - 4) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return `${(at > cut.length / 2 ? cut.slice(0, at) : cut).trimEnd()} …`;
}

const SKILL_TRIAL_MODS: ModifierSpec = {
  role: { type: "string" },
  benchmark: { type: "string" },
  limit: { type: "int" },
  seed: { type: "int" },
  model: { type: "string" },
  timeout: { type: "duration" },
};

/** What a draft needs before it is served; said wherever a draft is made or met. */
export const draftNotice = (id: number) =>
  `A draft is not served until validated: skill trial ${id} (child or parallel world) or a person's skill verify ${id}.`;

export function skillCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  logEvent?: (event: EngineEvent) => void;
  getCommandVocabulary?: () => CommandVocabulary;
  /** The parts a `skill trial` runs on (shared with `evolve trial`); undefined when the world lacks them. */
  trialDeps?: (opts: TrialOptions) => TrialDeps | undefined;
  benchmarkReady?: (name: string) => boolean;
  trackBackground?: (work: Promise<unknown>) => void;
}): CommandDef {
  return {
    category: "Memory",
    usage: [
      { syntax: "skill audit", effect: "read" },
      { syntax: "skill builtin [name]", effect: "read" },
      { syntax: "skill compose <id1> <id2> ..", effect: "write" },
      { syntax: "skill compose <id1> <id2> [id3] ..", effect: "write" },
      { syntax: "skill import <path-to-markdown-file>", effect: "write" },
      { syntax: "skill import <path>", effect: "write" },
      { syntax: "skill list", effect: "read" },
      { syntax: "skill search <query>", effect: "read" },
      { syntax: "skill top <query> [bytes:<n>]", effect: "read" },
      { syntax: "skill share <id> <pool>", effect: "write" },
      { syntax: "skill store <name> | <desc> | <actions>", effect: "write" },
      { syntax: "skill store <name> | <description> | <action_sequence>", effect: "write" },
      { syntax: "skill verify <id>", effect: "write" },
      {
        syntax:
          "skill trial <id> [role:<role>] [benchmark:<name>] [limit:<n>] [seed:<n>] [model:<m>] [timeout:<duration>]",
        effect: "execute",
        description:
          "Validate a skill: the role with it against the role without it on a benchmark (child or parallel world only); a win promotes a draft.",
      },
      { syntax: "skill trial <id> result", effect: "read" },
    ],
    name: "skill",
    aliases: [],
    help: "Skill library — bank what works so it outlives you. Usage: skill store <name> | <desc> | <actions> | skill search <query> | skill verify <id> | skill list | skill audit | skill share <id> <pool> | skill compose <id1> <id2> ... | skill import <path> (rank 3+; path under the server cwd) | skill builtin [name] (skills shipped with the server, e.g. quantitative-estimates) | skill top <query> [bytes:<n>] (the one best skill — your own first, else a built-in — clipped to a budget) | skill trial <id> [role:<role>] [benchmark:<name>] (validate a skill in a child world: the role with it vs without; a win promotes a draft). A composed skill, or one a dream drafted from your repeated procedures, is a DRAFT: listed, never served, until a trial wins or a person verifies it. Example: skill store pool-recall-fanout | find a fact when one keyword misses | recall <topic> ; pool bench-facts recall <synonym> ; note the hit. See also: evolve, memory dream.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        refuseCommand(ctx, input.entity, requiresPersistence("skills"));
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
              "Built-in skills (no import needed): skill builtin\n" +
              "Looking for help? Try: evolve, help, guide",
          );
        } else {
          ctx.send(
            input.entity,
            "Usage: skill store <name> | <desc> | <actions> | skill search <query> | skill verify <id> | skill list | skill audit | skill share <id> <pool> | skill compose <id1> <id2> ... | skill import <path> (rank 3+) | skill builtin [name]",
          );
        }
        return;
      }

      switch (sub) {
        case "store": {
          const rest = input.args.slice("store".length).trim();
          const parts = rest.split("|").map((p) => p.trim());
          if (parts.length < 3) {
            refuseCommand(
              ctx,
              input.entity,
              "Usage: skill store <name> | <description> | <action_sequence>",
            );
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
            refuseCommand(
              ctx,
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
          const builtins = searchBuiltinSkills(query);
          const builtinLines = builtins.map(
            (b) =>
              `  built-in "${b.name}": ${b.description.slice(0, 80)} — skill builtin ${b.name}`,
          );
          if (results.length === 0 && builtinLines.length > 0) {
            ctx.send(
              input.entity,
              [header(`Skills: "${query}"`), separator(), ...builtinLines].join("\n"),
              undefined,
              memoryResult("skill-search", { success: true, notes: [] }),
            );
            return;
          }
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
            ...builtinLines,
          ];
          ctx.send(
            input.entity,
            lines.join("\n"),
            undefined,
            memoryResult("skill-search", { success: true, notes: memoryNoteResults(results) }),
          );
          return;
        }

        case "top": {
          // The ONE best skill for a query — the agent's own first (its own
          // procedure beats a generic one), else the best-fitting built-in —
          // clipped to a byte budget. What a resident's continuation prompt
          // injects (`[Skill]`); read-only, touches nothing.
          const parsed = parseModifiers(input.tokens.slice(1), { bytes: { type: "int" } });
          const query = parsed.rest.join(" ").trim();
          if (!query) {
            refuseCommand(ctx, input.entity, "Usage: skill top <query> [bytes:<n>]");
            return;
          }
          const budget = Math.min(
            Math.max(Number(parsed.values.bytes ?? SKILL_TOP_DEFAULT_BYTES), 200),
            SKILL_TOP_MAX_BYTES,
          );
          // The as-of fence (src/engine/evidence-fence.ts): only a skill written by the cutoff.
          const fence = currentEvidenceCutoffMs();
          const own = db
            .recallNotesWithType(entity.name, query, "skill", {
              weightImportance: 0.4,
              weightRecency: 0.2,
              weightRelevance: 0.4,
            })
            .find(
              (n) => !isSkillDraft(n.content) && (fence === undefined || n.created_at <= fence),
            );
          if (own) {
            ctx.send(input.entity, clipBytes(`${own.content} (own skill #${own.id})`, budget));
            return;
          }
          const best = rankBuiltinSkills(query)[0]?.skill;
          if (!best) {
            ctx.send(input.entity, "No skill fits.");
            return;
          }
          ctx.send(
            input.entity,
            clipBytes(`[Skill: ${best.name}] (built-in) ${best.description}\n${best.body}`, budget),
          );
          return;
        }

        case "builtin": {
          const name = input.tokens[1];
          if (!name) {
            ctx.send(
              input.entity,
              [
                header("Built-in skills"),
                separator(),
                ...BUILTIN_SKILLS.map((b) => `  ${b.name}: ${b.description}`),
                "",
                "Read one with: skill builtin <name>",
              ].join("\n"),
            );
            return;
          }
          const skill = builtinSkill(name);
          if (!skill) {
            ctx.send(
              input.entity,
              `No built-in skill "${name}". Built-in: ${BUILTIN_SKILLS.map((b) => b.name).join(", ")}`,
            );
            return;
          }
          ctx.send(input.entity, `[Skill: ${skill.name}] ${skill.description}\n\n${skill.body}`);
          return;
        }

        case "verify": {
          const id = Number.parseInt(input.tokens[1] ?? "", 10);
          if (Number.isNaN(id)) {
            refuseCommand(ctx, input.entity, "Usage: skill verify <id>");
            return;
          }
          const note = db.getNote(id);
          if (!access.write(note) || note.note_type !== "skill") {
            refuseCommand(ctx, input.entity, `Skill #${id} not found.`);
            return;
          }
          if (isSkillDraft(note.content)) {
            // A draft is a derived skill nobody has checked: a PERSON's verify
            // or a won trial makes it servable, never an agent's own say-so.
            if (principalOf(entity.id) !== "person" && !isLocalUngated()) {
              refuseCommand(
                ctx,
                input.entity,
                `Skill #${id} is a draft: an agent cannot verify it. ${draftNotice(id)}`,
              );
              return;
            }
            const promoted = promoteSkill(db, entity.name, id, entity.name, "skill verify");
            if (!promoted) {
              refuseCommand(ctx, input.entity, `Skill #${id} could not be promoted.`);
              return;
            }
            ctx.send(
              input.entity,
              `Skill draft #${id} verified as skill #${promoted.id}: it is served now (skill list).`,
            );
            return;
          }
          promoteSkill(db, entity.name, id, entity.name, "skill verify");
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
              const draft = isSkillDraft(n.content)
                ? " [draft — not served: skill trial / verify]"
                : "";
              return `  #${n.id} (imp=${n.importance})${verified}${draft}: ${n.content.slice(0, 70)}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "audit": {
          const notes = db.getNotesByType(entity.name, "skill", 500);
          const report = auditKnowledgeNotes(notes, { ...deps.getCommandVocabulary?.() });
          ctx.send(input.entity, renderKnowledgeHygieneReport("Skill library", report));
          return;
        }

        case "share": {
          const id = Number.parseInt(input.tokens[1] ?? "", 10);
          const poolName = input.tokens[2];
          if (Number.isNaN(id) || !poolName) {
            refuseCommand(ctx, input.entity, "Usage: skill share <id> <pool>");
            return;
          }
          const note = db.getNote(id);
          if (!access.write(note) || note.note_type !== "skill") {
            refuseCommand(ctx, input.entity, `Skill #${id} not found.`);
            return;
          }
          const pool = db.getMemoryPool(poolName);
          if (!pool || !access.pool(pool)) {
            refuseCommand(ctx, input.entity, `Pool "${poolName}" not found.`);
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
            refuseCommand(ctx, input.entity, "Usage: skill compose <id1> <id2> [id3] ...");
            return;
          }
          const skills = ids
            .map((id) => db.getNote(id))
            .filter((n): n is NonNullable<typeof n> => access.read(n) && n.note_type === "skill");
          if (skills.length < 2 || skills.length !== ids.length) {
            ctx.send(input.entity, "Need at least 2 valid skill notes to compose.");
            return;
          }

          // Extract action sequences and compose. The result is a DRAFT: a
          // composition nobody has run is a claim, served once validated.
          const steps: string[] = [];
          const nameparts: string[] = [];
          for (const s of skills) {
            steps.push(...skillSteps(s.content));
            const nameMatch = s.content.match(/\[Skill(?: draft)?:\s*([^\]]+)\]/);
            if (nameMatch?.[1]) {
              nameparts.push(nameMatch[1].trim());
            }
          }

          const composedName = skillSlug(nameparts.join(" ")) || "composed-skill";
          const content = skillContent(
            composedName,
            `Composed from skills ${ids.map((i) => `#${i}`).join(", ")}`,
            steps,
            { draft: true },
          );
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
            `Composed skill draft #${newId} "${composedName}" from ${skills.length} skills (importance=${maxImp}). ${draftNotice(newId)}`,
          );
          return;
        }

        case "trial": {
          const id = Number.parseInt(input.tokens[1] ?? "", 10);
          if (Number.isNaN(id)) {
            refuseCommand(
              ctx,
              input.entity,
              "Usage: skill trial <id> [role:<role>] [benchmark:<name>] [limit:<n>] [seed:<n>] [model:<m>] [timeout:<duration>] | skill trial <id> result",
            );
            return;
          }
          const note = db.getNote(id);
          if (!access.write(note) || note.note_type !== "skill") {
            refuseCommand(ctx, input.entity, `Skill #${id} not found.`);
            return;
          }
          if (input.tokens[2]?.toLowerCase() === "result") {
            const stored = storedSkillTrial(db, entity.name, id);
            ctx.send(
              input.entity,
              stored
                ? renderSkillTrial(stored)
                : `No finished trial recorded for skill #${id} yet.`,
            );
            return;
          }
          if (
            process.env.MARINA_COLLECTIVE_CHILD !== "1" &&
            process.env.MARINA_EVOLVE_TRIALS !== "here"
          ) {
            ctx.send(
              input.entity,
              "Trials run in a child or parallel world, never this one. From here: `world run <child> skill trial …` (seed the role first with `world seed-role`). A dedicated parallel world can opt in with MARINA_EVOLVE_TRIALS=here.",
            );
            return;
          }
          const trialFloor = rankFloorRefusal(
            entity,
            4,
            "skill trial needs rank 4 (builder): it spawns agents and runs benchmarks, which cost real tokens.",
          );
          if (trialFloor) {
            ctx.send(input.entity, trialFloor);
            return;
          }
          const mods = parseModifiers(input.tokens.slice(2), SKILL_TRIAL_MODS);
          const role =
            (mods.values.role as string | undefined) ?? db.getAgentConfig(entity.name)?.role;
          if (!role) {
            refuseCommand(
              ctx,
              input.entity,
              "Say which role both arms run on: skill trial <id> role:<role>.",
            );
            return;
          }
          if (!db.getRole(role)) {
            ctx.send(
              input.entity,
              `Role "${role}" does not exist in this world — seed it first (\`world seed-role\` from the parent).`,
            );
            return;
          }
          const benchmark =
            (mods.values.benchmark as string | undefined) ??
            (deps.benchmarkReady?.(DEFAULT_TRIAL_BENCHMARK) ? DEFAULT_TRIAL_BENCHMARK : "smoke");
          const limit =
            (mods.values.limit as number | undefined) ?? (benchmark === "smoke" ? undefined : 100);
          const opts: TrialOptions = {
            benchmark,
            ...(benchmark === "smoke" ? {} : { partition: "holdout" as const }),
            ...(limit ? { limit } : {}),
            ...(mods.values.seed !== undefined ? { seed: mods.values.seed as number } : {}),
            agentModel: (mods.values.model as string | undefined) ?? "marina/default",
            callerId: entity.id,
          };
          const trialDeps = deps.trialDeps?.(opts);
          if (!trialDeps) {
            ctx.send(
              input.entity,
              "Trials need the agent runtime and the benchmark runner, which this world does not have.",
            );
            return;
          }
          const gate = checkGateForExecution(db, entity.id, "agent.spawn");
          if (!gate.ok) {
            ctx.send(input.entity, gate.reason ?? "agent.spawn refused");
            return;
          }
          if (!beginTrial()) {
            ctx.send(input.entity, "A trial is already running in this world — one at a time.");
            return;
          }
          recordGateExecution(db, entity.id, "agent.spawn", gate, `skill trial ${id}`);
          const timeoutMs = (mods.values.timeout as number | undefined) ?? 30 * 60_000;
          ctx.send(
            input.entity,
            `Skill trial started for #${id}: role ${role} with the skill vs without, on ${benchmark}${limit && benchmark !== "smoke" ? ` (${limit} items, holdout split)` : ""}, deadline ${Math.round(timeoutMs / 60_000)} min. ${isSkillDraft(note.content) ? "A win promotes the draft; results follow here." : "Results follow here."}${benchmark === "smoke" ? " Note: smoke has 15 items — too few to separate a small gain from noise." : ""}`,
          );
          const say = (text: string) => ctx.send(input.entity, text);
          const work = runSkillTrial(db, trialDeps, {
            skillId: id,
            entityName: entity.name,
            incumbentRole: role,
            createdBy: entity.name,
            benchmark,
            timeoutMs,
          })
            .then((result) => say(renderSkillTrial(result)))
            .catch((err) =>
              // allow-send-error: the trial runs on after the command completed (a later world event)
              say(`Skill trial #${id} failed: ${err instanceof Error ? err.message : String(err)}`),
            )
            .finally(() => endTrial());
          tryLog(new Logger(), "skill", "skill trial not tracked", () =>
            deps.trackBackground?.(work),
          );
          return;
        }

        case "import": {
          // Host file read driven by in-world input: rank-gated and confined
          // to the server's working directory (see resolveConfinedSkillPath).
          const importFloor = rankFloorRefusal(
            entity,
            3,
            "skill import requires rank 3+ (host file access)",
          );
          if (importFloor) {
            ctx.send(input.entity, importFloor);
            return;
          }
          const path = input.tokens.slice(1).join(" ").trim();
          if (!path) {
            refuseCommand(
              ctx,
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
            refuseCommand(ctx, input.entity, err instanceof Error ? err.message : String(err));
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
