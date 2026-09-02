// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  composeRolePrompt,
  inferTaskCategory,
  isTraitActiveForCategory,
  type ResolvedRole,
  resolveRole,
} from "../../agent/roles";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB, RoleRow, TraitCapabilities, TraitRow } from "../../persistence/database";
import type { EditHistoryRow } from "../../persistence/db-agents";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getRank } from "../permissions";
import { requiresPersistence } from "./command-messages";

interface RoleInspectionMetadata {
  includedTraits: string[];
  suppressedTraits: string[];
  missingTraits: string[];
  inferredCategory: string | undefined;
  roleHistoryCount: number;
  roleHistoryMore: boolean;
}

function isTraitSuppressed(
  role: ResolvedRole,
  index: number,
  category: string | undefined,
): boolean {
  if (!category) return false;
  const caps = role.traitCapabilities[index];
  if (!caps) return false;
  // Mirror the real gating in filterTraitsByTask so the preview matches reality
  // (activation:[always], task-category domain gating, applicableTasks).
  return !isTraitActiveForCategory(caps, category);
}

export function getRoleInspectionMetadata(
  db: MarinaDB,
  role: ResolvedRole,
  category: string | undefined,
): RoleInspectionMetadata {
  const includedTraits: string[] = [];
  const suppressedTraits: string[] = [];

  for (let i = 0; i < role.traitNames.length; i++) {
    const traitName = role.traitNames[i];
    if (!traitName) continue;
    if (isTraitSuppressed(role, i, category)) {
      suppressedTraits.push(traitName);
    } else {
      includedTraits.push(traitName);
    }
  }

  const historyRows = db.getRoleHistory(role.name, 101);
  const roleHistoryMore = historyRows.length > 100;

  return {
    includedTraits,
    suppressedTraits,
    missingTraits: role.missingTraitNames,
    inferredCategory: category,
    roleHistoryCount: roleHistoryMore ? 100 : historyRows.length,
    roleHistoryMore,
  };
}

function traitList(names: string[]): string {
  return names.length > 0 ? names.join(", ") : dim("(none)");
}

export function renderRoleInspectionMetadata(meta: RoleInspectionMetadata): string[] {
  const historyCount = `${meta.roleHistoryCount}${meta.roleHistoryMore ? "+" : ""}`;
  return [
    bold("Inspection metadata:"),
    `  ${bold("Included traits:")} ${traitList(meta.includedTraits)}`,
    `  ${bold("Suppressed traits:")} ${traitList(meta.suppressedTraits)}`,
    `  ${bold("Missing traits:")} ${traitList(meta.missingTraits)}`,
    `  ${bold("Inferred task category:")} ${meta.inferredCategory ?? dim("(none)")}`,
    `  ${bold("Role history:")} ${historyCount} change(s) available`,
  ];
}

/** Items in `b` not in `a` (added) and items in `a` not in `b` (removed). */
export function listDiff(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const aSet = new Set(a);
  const bSet = new Set(b);
  return {
    added: b.filter((x) => !aSet.has(x)),
    removed: a.filter((x) => !bSet.has(x)),
  };
}

export function renderListDiffLine(label: string, a: string[], b: string[]): string | null {
  const { added, removed } = listDiff(a, b);
  if (added.length === 0 && removed.length === 0) return null;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`+${added.join(", +")}`);
  if (removed.length > 0) parts.push(`-${removed.join(", -")}`);
  return `${bold(`${label}:`)} ${parts.join("  ")}`;
}

export function renderRoleDiff(a: RoleRow, b: RoleRow): string {
  const lines = [header(`Role diff: ${a.name} → ${b.name}`), separator()];

  if (a.description !== b.description) {
    lines.push(
      `${bold("Description:")}`,
      `  - ${a.description || dim("(none)")}`,
      `  + ${b.description || dim("(none)")}`,
    );
  }
  const traitLine = renderListDiffLine("Traits", JSON.parse(a.traits), JSON.parse(b.traits));
  if (traitLine) lines.push(traitLine);
  const focusLine = renderListDiffLine("Focus", JSON.parse(a.focus), JSON.parse(b.focus));
  if (focusLine) lines.push(focusLine);
  const guideLine = renderListDiffLine(
    "Guidelines",
    JSON.parse(a.guidelines),
    JSON.parse(b.guidelines),
  );
  if (guideLine) lines.push(guideLine);
  if (a.tone !== b.tone) {
    lines.push(
      `${bold("Tone:")}`,
      `  - ${a.tone || dim("(none)")}`,
      `  + ${b.tone || dim("(none)")}`,
    );
  }

  // Only the header + separator means no structural differences.
  if (lines.length === 2) {
    lines.push(dim("No differences."));
  }
  return lines.join("\n");
}

export function roleCommand(deps: {
  db?: MarinaDB;
  getEntity?: (id: EntityId) => Entity | undefined;
  listAgents?: () => { name: string; role: string; state: string }[];
  reconfigureAgent?: (name: string, opts: { role?: string }) => Promise<void>;
}): CommandDef {
  return {
    name: "role",
    aliases: [],
    minRank: 0,
    help: "Manage composable agent roles.\nUsage: role list | role view <name> [goal <text>] | role lint <name> | role diff <a> <b> | role history <name> | role create <name> [traits <t1,t2,...>] [guidelines <g1|g2|...>] [focus <f1,f2,...>] [tone <tone>] | role edit <name> ... | role reload <name> | role delete <name>\n\nRoles are compositions of traits plus guidelines, focus areas, and tone.\n`role view <name> goal <text>` previews the PRISM-gated prompt an agent with that goal actually receives. `role lint <name>` reports pragmatic prompt-shaping warnings without changing the role. `role history <name>` shows the audited edit trail. `role reload <name>` propagates the current definition into running agents bound to it.",
    handler: async (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("roles"));
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "list") {
        const roles = db.getAllRoles();
        if (roles.length === 0) {
          ctx.send(input.entity, "No roles defined.");
          return;
        }
        const lines = [header("Roles"), separator()];
        for (const r of roles) {
          const traitList: string[] = JSON.parse(r.traits);
          const traitStr = traitList.length > 0 ? dim(` [${traitList.join(", ")}]`) : "";
          lines.push(`${bold(r.name)}${traitStr}`);
          if (r.description) lines.push(`  ${dim(r.description)}`);
        }
        lines.push(separator(), dim(`${roles.length} role(s) total`));
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      switch (sub) {
        case "view": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: role view <name>");
            return;
          }
          const resolved = resolveRole(db, name);
          if (!resolved) {
            ctx.send(input.entity, `Role "${name}" not found.`);
            return;
          }

          // Goal-conditional preview: `role view <name> goal <text>` shows the
          // PRISM-gated prompt an agent pursuing that goal actually receives,
          // so a role's task-conditional behavior can be tested before assigning.
          if (tokens[2]?.toLowerCase() === "goal") {
            const goalText = tokens.slice(3).join(" ").trim();
            if (!goalText) {
              ctx.send(input.entity, "Usage: role view <name> goal <text>");
              return;
            }
            const category = inferTaskCategory(goalText);
            const gLines = [header(`Role: ${resolved.name} — preview for goal`), separator()];
            gLines.push(`${bold("Goal:")} ${goalText}`);
            gLines.push(
              ...renderRoleInspectionMetadata(getRoleInspectionMetadata(db, resolved, category)),
            );
            gLines.push(
              `\n${separator()}\n${bold("Effective Prompt (what the agent receives):")}`,
              composeRolePrompt(resolved, category),
            );
            ctx.send(input.entity, gLines.join("\n"));
            return;
          }

          const lines = [header(`Role: ${resolved.name}`), separator()];
          if (resolved.description) lines.push(resolved.description);
          if (resolved.traitNames.length > 0) {
            lines.push(`\n${bold("Traits:")} ${resolved.traitNames.join(", ")}`);
          }
          if (resolved.missingTraitNames.length > 0) {
            lines.push(`${bold("Missing traits:")} ${resolved.missingTraitNames.join(", ")}`);
          }
          if (resolved.focus.length > 0) {
            lines.push(`${bold("Focus:")} ${resolved.focus.join(", ")}`);
          }
          if (resolved.guidelines.length > 0) {
            lines.push(`\n${bold("Guidelines:")}`);
            for (const g of resolved.guidelines) lines.push(`  - ${g}`);
          }
          if (resolved.tone) lines.push(`\n${bold("Tone:")} ${resolved.tone}`);
          if (resolved.origin) lines.push(`${bold("Origin:")} ${resolved.origin}`);

          if (resolved.traitPrompts.length > 0) {
            lines.push(`\n${separator()}\n${bold("Composed Prompt:")}`);
            for (const prompt of resolved.traitPrompts) {
              lines.push(prompt);
            }
          }

          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "history": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: role history <name>");
            return;
          }
          const hist = db.getRoleHistory(name);
          if (hist.length === 0) {
            ctx.send(input.entity, `No edit history for role "${name}".`);
            return;
          }
          ctx.send(input.entity, renderEditHistory(`Role "${name}"`, hist));
          return;
        }

        case "lint": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: role lint <name>");
            return;
          }
          const role = db.getRole(name);
          if (!role) {
            ctx.send(input.entity, `Role "${name}" not found.`);
            return;
          }
          ctx.send(input.entity, renderRoleLint(db, role));
          return;
        }

        case "diff": {
          const a = tokens[1];
          const b = tokens[2];
          if (!a || !b) {
            ctx.send(input.entity, "Usage: role diff <a> <b>");
            return;
          }
          const roleA = db.getRole(a);
          const roleB = db.getRole(b);
          if (!roleA) {
            ctx.send(input.entity, `Role "${a}" not found.`);
            return;
          }
          if (!roleB) {
            ctx.send(input.entity, `Role "${b}" not found.`);
            return;
          }
          ctx.send(input.entity, renderRoleDiff(roleA, roleB));
          return;
        }

        case "reload": {
          // Propagate an edited role into agents already running it — reuses the
          // agent reconfigure path, which re-derives the system prompt from the
          // (now-edited) DB role. Gated like edit, since it changes live behavior.
          const entity = deps.getEntity?.(input.entity);
          if (entity && getRank(entity) < 3) {
            ctx.send(input.entity, "Requires organizer rank (3) or higher.");
            return;
          }
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: role reload <name>");
            return;
          }
          if (!db.getRole(name)) {
            ctx.send(input.entity, `Role "${name}" not found.`);
            return;
          }
          if (!deps.listAgents || !deps.reconfigureAgent) {
            ctx.send(input.entity, "Agent runtime unavailable — cannot reload running agents.");
            return;
          }
          const live = new Set(["starting", "connected", "autonomous", "idle"]);
          const targets = deps.listAgents().filter((a) => a.role === name && live.has(a.state));
          if (targets.length === 0) {
            ctx.send(input.entity, `No running agents are bound to role "${name}".`);
            return;
          }
          const reloaded: string[] = [];
          const failed: string[] = [];
          for (const a of targets) {
            try {
              await deps.reconfigureAgent(a.name, { role: name });
              reloaded.push(a.name);
            } catch {
              failed.push(a.name);
            }
          }
          let msg = `Reloaded role "${name}" into ${reloaded.length} running agent(s)${
            reloaded.length > 0 ? `: ${reloaded.join(", ")}` : ""
          }.`;
          if (failed.length > 0) msg += ` Failed: ${failed.join(", ")}.`;
          ctx.send(input.entity, msg);
          return;
        }

        case "create":
        case "edit": {
          const entity = deps.getEntity?.(input.entity);
          if (entity && getRank(entity) < 3) {
            ctx.send(input.entity, "Requires organizer rank (3) or higher.");
            return;
          }
          const name = tokens[1];
          if (!name) {
            ctx.send(
              input.entity,
              `Usage: role ${sub} <name> [traits <t1,t2,...>] [guidelines <g1|g2|...>] [focus <f1,f2,...>] [tone <text>]`,
            );
            return;
          }

          if (sub === "create" && db.getRole(name)) {
            ctx.send(input.entity, `Role "${name}" already exists. Use "role edit" to modify.`);
            return;
          }
          if (sub === "edit" && !db.getRole(name)) {
            ctx.send(input.entity, `Role "${name}" not found. Use "role create" to define it.`);
            return;
          }

          const opts = parseRoleArgs(tokens.slice(2));
          db.saveRole({
            name,
            description: opts.description,
            traits: opts.traits,
            guidelines: opts.guidelines,
            focus: opts.focus,
            tone: opts.tone,
            origin: opts.origin,
            createdBy: deps.getEntity?.(input.entity)?.name ?? "unknown",
          });
          ctx.send(input.entity, `Role "${name}" ${sub === "create" ? "created" : "updated"}.`);
          return;
        }

        case "delete": {
          const entity = deps.getEntity?.(input.entity);
          if (entity && getRank(entity) < 3) {
            ctx.send(input.entity, "Requires organizer rank (3) or higher.");
            return;
          }
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: role delete <name>");
            return;
          }
          if (!db.getRole(name)) {
            ctx.send(input.entity, `Role "${name}" not found.`);
            return;
          }
          db.deleteRole(name);
          ctx.send(input.entity, `Role "${name}" deleted.`);
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Usage: role list | role view <name> [goal <text>] | role lint <name> | role diff <a> <b> | role history <name> | role create <name> ... | role edit <name> ... | role reload <name> | role delete <name>",
          );
      }
    },
  };
}

export interface LintWarning {
  level: "warn" | "note";
  message: string;
}

const VAGUE_GUIDELINE_RE =
  /^(be\s+)?(good|nice|smart|helpful|careful|thoughtful|clear|concise|better|excellent)\.?$/i;
const ALWAYS_EVERY_TURN_RE =
  /\b(always|every\s+turn|each\s+turn|before\s+every|after\s+every|must\s+always|never\s+skip)\b/i;
const WATCHER_RE = /\b(watcher|watching|watch)\b/i;
const UNSAFE_LANGUAGE_RE =
  /\b(bypass|ignore|disable|override|skip)\b.{0,40}\b(gate|safety|permission|approval|policy|guard)\b|\bhide\b.{0,30}\b(uncertainty|unknowns?|doubt|confidence)\b|\bnever\s+(admit|mention|disclose)\b.{0,30}\b(uncertain|uncertainty|unknowns?|doubt)\b/i;

export function parseTraitCapabilities(raw: string | undefined): TraitCapabilities {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as TraitCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function hasTraitCapabilities(caps: TraitCapabilities): boolean {
  return (
    (caps.strengths?.length ?? 0) > 0 ||
    (caps.preferences?.length ?? 0) > 0 ||
    (caps.avoids?.length ?? 0) > 0 ||
    (caps.domains?.length ?? 0) > 0 ||
    (caps.behaviors?.length ?? 0) > 0 ||
    (caps.antiBehaviors?.length ?? 0) > 0 ||
    (caps.activation?.length ?? 0) > 0 ||
    (caps.successSignals?.length ?? 0) > 0 ||
    (caps.riskSignals?.length ?? 0) > 0 ||
    (caps.applicableTasks?.length ?? 0) > 0
  );
}

export function lintTraitDefinition(trait: TraitRow): LintWarning[] {
  const warnings: LintWarning[] = [];
  const prompt = trait.prompt.trim();
  const lowerName = trait.name.toLowerCase();
  const caps = parseTraitCapabilities(trait.capabilities);
  const promptWordCount = countWords(prompt);

  if (promptWordCount > 180) {
    warnings.push({
      level: "warn",
      message: `Prompt is long (${promptWordCount} words); traits work best as compact behavioral tendencies.`,
    });
  }
  if (ALWAYS_EVERY_TURN_RE.test(prompt) && !WATCHER_RE.test(`${lowerName} ${trait.category}`)) {
    warnings.push({
      level: "warn",
      message:
        "Prompt scripts always/every-turn behavior outside a watcher/watching trait; prefer autonomy and emergent judgment.",
    });
  }
  if (UNSAFE_LANGUAGE_RE.test(prompt)) {
    warnings.push({
      level: "warn",
      message:
        "Prompt contains bypass, safety-gate, or hidden-uncertainty language; preserve gates and honest uncertainty.",
    });
  }

  const conflicts = findCapabilityConflicts(caps);
  for (const item of conflicts) {
    warnings.push({
      level: "note",
      message: `Metadata lists "${item}" as both a strength/behavior and an avoid/anti-behavior.`,
    });
  }

  if (!hasTraitCapabilities(caps)) {
    warnings.push({
      level: "note",
      message:
        "No typed capability metadata found; consider domains/behaviors/activation/successSignals when composition would benefit.",
    });
  }

  return warnings;
}

export function renderTraitLint(trait: TraitRow): string {
  return renderLintReport(`Trait lint: ${trait.name}`, lintTraitDefinition(trait));
}

function renderRoleLint(db: MarinaDB, role: RoleRow): string {
  const warnings: LintWarning[] = [];
  const traits = parseStringList(role.traits);
  const guidelines = parseStringList(role.guidelines);
  const isWatcherRole = WATCHER_RE.test(`${role.name} ${traits.join(" ")} ${role.description}`);
  const foundTraits: { name: string; caps: TraitCapabilities }[] = [];

  for (const name of traits) {
    const trait = db.getTrait(name);
    if (!trait) {
      warnings.push({ level: "warn", message: `Missing trait "${name}" referenced by role.` });
      continue;
    }
    const traitWarnings = lintTraitDefinition(trait).map((warning) => ({
      level: warning.level,
      message: `Trait "${name}": ${warning.message}`,
    }));
    warnings.push(...traitWarnings);
    foundTraits.push({ name, caps: parseTraitCapabilities(trait.capabilities) });
  }

  for (const guideline of guidelines) {
    const wordCount = countWords(guideline);
    if (VAGUE_GUIDELINE_RE.test(guideline.trim()) || wordCount < 3) {
      warnings.push({
        level: "warn",
        message: `Vague guideline "${clip(guideline, 80)}"; make it observable or situational.`,
      });
    }
    if (wordCount > 60) {
      warnings.push({
        level: "warn",
        message: `Guideline is long (${wordCount} words): "${clip(guideline, 80)}".`,
      });
    }
    if (ALWAYS_EVERY_TURN_RE.test(guideline) && !isWatcherRole) {
      warnings.push({
        level: "warn",
        message:
          "Guideline scripts always/every-turn behavior outside a watcher/watching role; prefer autonomy and emergent judgment.",
      });
    }
    if (UNSAFE_LANGUAGE_RE.test(guideline)) {
      warnings.push({
        level: "warn",
        message:
          "Guideline contains bypass, safety-gate, or hidden-uncertainty language; preserve gates and honest uncertainty.",
      });
    }
  }

  for (const conflict of findCrossTraitConflicts(foundTraits)) {
    warnings.push({ level: "note", message: conflict });
  }

  return renderLintReport(`Role lint: ${role.name}`, warnings);
}

function renderLintReport(title: string, warnings: LintWarning[]): string {
  const lines = [header(title), separator()];
  if (warnings.length === 0) {
    lines.push("No lint warnings found.");
  } else {
    for (const warning of warnings) {
      const label = warning.level === "warn" ? "Warning" : "Note";
      lines.push(`${bold(label)}: ${warning.message}`);
    }
  }
  lines.push(separator(), dim("Read-only lint: pragmatic warnings, not eval or enforcement."));
  return lines.join("\n");
}

function parseStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase();
}

function findCapabilityConflicts(caps: TraitCapabilities): string[] {
  const positive = new Set([
    ...(caps.strengths ?? []).map(normalizeCapability),
    ...(caps.behaviors ?? []).map(normalizeCapability),
  ]);
  const negative = new Set([
    ...(caps.avoids ?? []).map(normalizeCapability),
    ...(caps.antiBehaviors ?? []).map(normalizeCapability),
  ]);
  return [...positive].filter((v) => v && negative.has(v));
}

function findCrossTraitConflicts(traits: { name: string; caps: TraitCapabilities }[]): string[] {
  const strengths = new Map<string, string[]>();
  const avoids = new Map<string, string[]>();

  for (const trait of traits) {
    for (const value of [...(trait.caps.strengths ?? []), ...(trait.caps.behaviors ?? [])]) {
      const key = normalizeCapability(value);
      if (!key) continue;
      strengths.set(key, [...(strengths.get(key) ?? []), trait.name]);
    }
    for (const value of [...(trait.caps.avoids ?? []), ...(trait.caps.antiBehaviors ?? [])]) {
      const key = normalizeCapability(value);
      if (!key) continue;
      avoids.set(key, [...(avoids.get(key) ?? []), trait.name]);
    }
  }

  const conflicts: string[] = [];
  for (const [value, strengthTraits] of strengths) {
    const avoidTraits = avoids.get(value);
    if (!avoidTraits) continue;
    conflicts.push(
      `Capability conflict: "${value}" is encouraged by ${strengthTraits.join(", ")} and avoided by ${avoidTraits.join(", ")}.`,
    );
  }
  return conflicts;
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}...` : flat;
}

/**
 * Render a trait/role edit-history listing (most recent first). Shared by the
 * `role history` and `trait history` commands — each entry shows when, who, and
 * a clipped before→after of the serialized definition.
 */
export function renderEditHistory(label: string, rows: EditHistoryRow[]): string {
  const clip = (s: string, n = 200): string => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > n ? `${flat.slice(0, n)}…` : flat;
  };
  const lines = [header(`Edit history: ${label}`), separator()];
  for (const h of rows) {
    const when = new Date(h.changed_at).toISOString().replace("T", " ").slice(0, 19);
    const kind = h.old_value ? "edited" : "created";
    lines.push(`${bold(`#${h.id}`)} ${dim(`${when}Z`)} · ${kind} by ${h.changed_by}`);
    if (h.old_value) lines.push(`  ${dim("- was:")} ${clip(h.old_value)}`);
    lines.push(`  ${dim("+ now:")} ${clip(h.new_value)}`);
  }
  lines.push(separator(), dim(`${rows.length} change(s) shown (most recent first)`));
  return lines.join("\n");
}

/**
 * Parse role arguments from tokens after the role name.
 * Supports: traits <t1,t2,...> guidelines <g1|g2|...> focus <f1,f2,...> tone <text> origin <text> description <text>
 */
function parseRoleArgs(tokens: string[]): {
  description?: string;
  traits?: string[];
  guidelines?: string[];
  focus?: string[];
  tone?: string;
  origin?: string;
} {
  const result: {
    description?: string;
    traits?: string[];
    guidelines?: string[];
    focus?: string[];
    tone?: string;
    origin?: string;
  } = {};

  let i = 0;
  while (i < tokens.length) {
    const key = tokens[i]?.toLowerCase();
    i++;

    switch (key) {
      case "traits": {
        const val = tokens[i];
        if (val)
          result.traits = val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        i++;
        break;
      }
      case "guidelines": {
        const val = tokens[i];
        if (val)
          result.guidelines = val
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean);
        i++;
        break;
      }
      case "focus": {
        const val = tokens[i];
        if (val)
          result.focus = val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        i++;
        break;
      }
      case "tone": {
        const remaining = tokens.slice(i);
        const endIdx = remaining.findIndex((t) =>
          ["traits", "guidelines", "focus", "origin", "description"].includes(t.toLowerCase()),
        );
        result.tone = (endIdx === -1 ? remaining : remaining.slice(0, endIdx)).join(" ");
        i += endIdx === -1 ? remaining.length : endIdx;
        break;
      }
      case "origin": {
        const val = tokens[i];
        if (val) result.origin = val;
        i++;
        break;
      }
      case "description": {
        const remaining = tokens.slice(i);
        const endIdx = remaining.findIndex((t) =>
          ["traits", "guidelines", "focus", "tone", "origin"].includes(t.toLowerCase()),
        );
        result.description = (endIdx === -1 ? remaining : remaining.slice(0, endIdx)).join(" ");
        i += endIdx === -1 ? remaining.length : endIdx;
        break;
      }
    }
  }

  return result;
}
