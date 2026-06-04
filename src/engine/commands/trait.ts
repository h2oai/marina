import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB, TraitCapabilities } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getRank } from "../permissions";

/**
 * Parse optional capabilities from the end of a trait create command.
 * Syntax: trait create <name> <category> <prompt text> [strengths s1,s2] [preferences p1,p2] [avoids a1,a2]
 *
 * Returns { prompt, capabilities } where prompt has the capability tokens stripped.
 */
function parseCapabilities(tokens: string[]): {
  prompt: string;
  capabilities: TraitCapabilities;
} {
  const caps: TraitCapabilities = {};
  const promptTokens: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const lower = tokens[i]!.toLowerCase();
    if (
      (lower === "strengths" || lower === "preferences" || lower === "avoids") &&
      i + 1 < tokens.length
    ) {
      const values = tokens[i + 1]!.split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length > 0) {
        caps[lower] = values;
      }
      i += 2;
    } else {
      promptTokens.push(tokens[i]!);
      i++;
    }
  }

  return { prompt: promptTokens.join(" "), capabilities: caps };
}

function formatCapabilities(caps: TraitCapabilities): string[] {
  const lines: string[] = [];
  if (caps.strengths && caps.strengths.length > 0) {
    lines.push(`${bold("Strengths:")} ${caps.strengths.join(", ")}`);
  }
  if (caps.preferences && caps.preferences.length > 0) {
    lines.push(`${bold("Preferences:")} ${caps.preferences.join(", ")}`);
  }
  if (caps.avoids && caps.avoids.length > 0) {
    lines.push(`${bold("Avoids:")} ${caps.avoids.join(", ")}`);
  }
  return lines;
}

export function traitCommand(deps: {
  db?: MarinaDB;
  getEntity?: (id: EntityId) => Entity | undefined;
}): CommandDef {
  return {
    name: "trait",
    aliases: [],
    minRank: 0,
    help: "Manage composable agent traits.\nUsage: trait list | trait view <name> | trait create <name> <category> <prompt> [strengths s1,s2] [preferences p1,p2] [avoids a1,a2] | trait delete <name>\n\nTraits are atomic prompt fragments used to compose roles.\nOptional capabilities metadata enables semantic composition (synergies/tensions).",
    handler: (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, "Traits require database support.");
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "list") {
        const traits = db.getAllTraits();
        if (traits.length === 0) {
          ctx.send(input.entity, "No traits defined.");
          return;
        }

        const byCategory = new Map<string, typeof traits>();
        for (const t of traits) {
          if (!byCategory.has(t.category)) byCategory.set(t.category, []);
          byCategory.get(t.category)!.push(t);
        }

        const lines = [header("Traits"), separator()];
        for (const [category, categoryTraits] of byCategory) {
          lines.push(bold(category));
          for (const t of categoryTraits) {
            const preview = t.prompt.slice(0, 60).replace(/\n/g, " ");
            const caps: TraitCapabilities = JSON.parse(t.capabilities || "{}");
            const hasCaps =
              (caps.strengths?.length ?? 0) > 0 ||
              (caps.preferences?.length ?? 0) > 0 ||
              (caps.avoids?.length ?? 0) > 0;
            const capTag = hasCaps ? " [caps]" : "";
            lines.push(
              `  ${bold(t.name)}${dim(capTag)} ${dim(`— ${preview}${t.prompt.length > 60 ? "..." : ""}`)}`,
            );
          }
        }
        lines.push(separator(), dim(`${traits.length} trait(s) total`));
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      switch (sub) {
        case "view": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: trait view <name>");
            return;
          }
          const trait = db.getTrait(name);
          if (!trait) {
            ctx.send(input.entity, `Trait "${name}" not found.`);
            return;
          }
          const caps: TraitCapabilities = JSON.parse(trait.capabilities || "{}");
          const capLines = formatCapabilities(caps);
          const lines = [
            header(`Trait: ${trait.name}`),
            separator(),
            `${bold("Category:")} ${trait.category}`,
            `${bold("Created by:")} ${trait.created_by}`,
            separator(),
            trait.prompt,
          ];
          if (capLines.length > 0) {
            lines.push(separator());
            lines.push(bold("Capabilities:"));
            lines.push(...capLines);
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "create": {
          const entity = deps.getEntity?.(input.entity);
          if (entity && getRank(entity) < 3) {
            ctx.send(input.entity, "Requires organizer rank (3) or higher.");
            return;
          }
          const name = tokens[1];
          const category = tokens[2];
          const remaining = tokens.slice(3);
          if (!name || !category || remaining.length === 0) {
            ctx.send(
              input.entity,
              "Usage: trait create <name> <category> <prompt text> [strengths s1,s2] [preferences p1,p2] [avoids a1,a2]",
            );
            return;
          }
          const { prompt, capabilities } = parseCapabilities(remaining);
          if (!prompt) {
            ctx.send(input.entity, "Prompt text is required.");
            return;
          }
          const existing = db.getTrait(name);
          if (existing) {
            ctx.send(input.entity, `Trait "${name}" already exists. Delete it first to recreate.`);
            return;
          }
          db.saveTrait({
            name,
            category,
            prompt,
            capabilities,
            createdBy: deps.getEntity?.(input.entity)?.name ?? "unknown",
          });
          const hasCaps =
            (capabilities.strengths?.length ?? 0) > 0 ||
            (capabilities.preferences?.length ?? 0) > 0 ||
            (capabilities.avoids?.length ?? 0) > 0;
          const suffix = hasCaps ? " with capabilities" : "";
          ctx.send(input.entity, `Trait "${name}" created (${category})${suffix}.`);
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
            ctx.send(input.entity, "Usage: trait delete <name>");
            return;
          }
          const trait = db.getTrait(name);
          if (!trait) {
            ctx.send(input.entity, `Trait "${name}" not found.`);
            return;
          }
          db.deleteTrait(name);
          ctx.send(input.entity, `Trait "${name}" deleted.`);
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Usage: trait list | trait view <name> | trait create <name> <category> <prompt> [strengths s1,s2] [preferences p1,p2] [avoids a1,a2] | trait delete <name>",
          );
      }
    },
  };
}
