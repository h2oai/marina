import { composeRolePrompt, inferTaskCategory, resolveRole } from "../../agent/roles";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { EditHistoryRow } from "../../persistence/db-agents";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getRank } from "../permissions";

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
    help: "Manage composable agent roles.\nUsage: role list | role view <name> [goal <text>] | role history <name> | role create <name> [traits <t1,t2,...>] [guidelines <g1|g2|...>] [focus <f1,f2,...>] [tone <tone>] | role edit <name> ... | role reload <name> | role delete <name>\n\nRoles are compositions of traits plus guidelines, focus areas, and tone.\n`role view <name> goal <text>` previews the PRISM-gated prompt an agent with that goal actually receives. `role history <name>` shows the audited edit trail. `role reload <name>` propagates the current definition into running agents bound to it.",
    handler: async (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, "Roles require database support.");
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
            const suppressed = resolved.traitNames.filter((_, i) => {
              const applicable = resolved.traitCapabilities[i]?.applicableTasks;
              return (
                category && applicable && applicable.length > 0 && !applicable.includes(category)
              );
            });
            const gLines = [header(`Role: ${resolved.name} — preview for goal`), separator()];
            gLines.push(`${bold("Goal:")} ${goalText}`);
            gLines.push(
              `${bold("Inferred task category:")} ${category ?? dim("(none — every trait applies)")}`,
            );
            if (suppressed.length > 0) {
              gLines.push(
                `${bold("Suppressed traits")} ${dim("(out of scope for this task)")}: ${suppressed.join(", ")}`,
              );
            }
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
            "Usage: role list | role view <name> [goal <text>] | role history <name> | role create <name> ... | role edit <name> ... | role reload <name> | role delete <name>",
          );
      }
    },
  };
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
