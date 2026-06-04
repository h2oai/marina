import { resolveRole } from "../../agent/roles";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getRank } from "../permissions";

export function roleCommand(deps: {
  db?: MarinaDB;
  getEntity?: (id: EntityId) => Entity | undefined;
}): CommandDef {
  return {
    name: "role",
    aliases: [],
    minRank: 0,
    help: "Manage composable agent roles.\nUsage: role list | role view <name> | role create <name> [traits <t1,t2,...>] [guidelines <g1|g2|...>] [focus <f1,f2,...>] [tone <tone>] | role edit <name> ... | role delete <name>\n\nRoles are compositions of traits plus guidelines, focus areas, and tone.",
    handler: (ctx: RoomContext, input) => {
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
            "Usage: role list | role view <name> | role create <name> ... | role edit <name> ... | role delete <name>",
          );
      }
    },
  };
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
