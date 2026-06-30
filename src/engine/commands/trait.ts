import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB, TraitCapabilities } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getRank } from "../permissions";
import {
  hasTraitCapabilities,
  parseTraitCapabilities,
  renderEditHistory,
  renderTraitLint,
} from "./role";

/**
 * Parse optional capabilities from the end of a trait create command.
 * Syntax: trait create <name> <category> <prompt text> [strengths s1,s2] [preferences p1,p2] [avoids a1,a2]
 *   [domains d1,d2] [behaviors b1,b2] [antiBehaviors a1,a2] [activation a1,a2]
 *   [successSignals s1,s2] [riskSignals r1,r2]
 *
 * Returns { prompt, capabilities } where prompt has the capability tokens stripped.
 */
function parseCapabilities(tokens: string[]): {
  prompt: string;
  capabilities: TraitCapabilities;
} {
  const caps: TraitCapabilities = {};
  const promptTokens: string[] = [];
  const fields = new Map<string, keyof TraitCapabilities>([
    ["strengths", "strengths"],
    ["preferences", "preferences"],
    ["avoids", "avoids"],
    ["domains", "domains"],
    ["behaviors", "behaviors"],
    ["antibehaviors", "antiBehaviors"],
    ["antiBehaviors", "antiBehaviors"],
    ["activation", "activation"],
    ["successsignals", "successSignals"],
    ["successSignals", "successSignals"],
    ["risksignals", "riskSignals"],
    ["riskSignals", "riskSignals"],
    ["applicabletasks", "applicableTasks"],
    ["applicableTasks", "applicableTasks"],
  ]);
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i]!;
    const field = fields.get(token) ?? fields.get(token.toLowerCase());
    if (field && i + 1 < tokens.length) {
      const values = tokens[i + 1]!.split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length > 0) {
        caps[field] = values;
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
  if (caps.domains && caps.domains.length > 0) {
    lines.push(`${bold("Domains:")} ${caps.domains.join(", ")}`);
  }
  if (caps.behaviors && caps.behaviors.length > 0) {
    lines.push(`${bold("Behaviors:")} ${caps.behaviors.join(", ")}`);
  }
  if (caps.antiBehaviors && caps.antiBehaviors.length > 0) {
    lines.push(`${bold("Anti-behaviors:")} ${caps.antiBehaviors.join(", ")}`);
  }
  if (caps.activation && caps.activation.length > 0) {
    lines.push(`${bold("Activation:")} ${caps.activation.join(", ")}`);
  }
  if (caps.successSignals && caps.successSignals.length > 0) {
    lines.push(`${bold("Success signals:")} ${caps.successSignals.join(", ")}`);
  }
  if (caps.riskSignals && caps.riskSignals.length > 0) {
    lines.push(`${bold("Risk signals:")} ${caps.riskSignals.join(", ")}`);
  }
  if (caps.applicableTasks && caps.applicableTasks.length > 0) {
    lines.push(`${bold("Applicable tasks:")} ${caps.applicableTasks.join(", ")}`);
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
    help: "Manage composable agent traits.\nUsage: trait list | trait view <name> | trait lint <name> | trait history <name> | trait create <name> <category> <prompt> [strengths s1,s2] [preferences p1,p2] [avoids a1,a2] [domains d1,d2] [behaviors b1,b2] [antiBehaviors a1,a2] [activation a1,a2] [successSignals s1,s2] [riskSignals r1,r2] [applicableTasks t1,t2] | trait delete <name>\n\nTraits are atomic prompt fragments used to compose roles.\nOptional capabilities metadata enables semantic composition (synergies/tensions), task gating, and typed behavioral hints.\n`trait lint <name>` reports pragmatic prompt-shaping warnings without changing the trait. `trait history <name>` shows the audited edit trail.",
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
            const caps = parseTraitCapabilities(t.capabilities);
            const capTag = hasTraitCapabilities(caps) ? " [caps]" : "";
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
          const caps = parseTraitCapabilities(trait.capabilities);
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

        case "history": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: trait history <name>");
            return;
          }
          const hist = db.getTraitHistory(name);
          if (hist.length === 0) {
            ctx.send(input.entity, `No edit history for trait "${name}".`);
            return;
          }
          ctx.send(input.entity, renderEditHistory(`Trait "${name}"`, hist));
          return;
        }

        case "lint": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: trait lint <name>");
            return;
          }
          const trait = db.getTrait(name);
          if (!trait) {
            ctx.send(input.entity, `Trait "${name}" not found.`);
            return;
          }
          ctx.send(input.entity, renderTraitLint(trait));
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
              "Usage: trait create <name> <category> <prompt text> [strengths s1,s2] [preferences p1,p2] [avoids a1,a2] [domains d1,d2] [behaviors b1,b2] [antiBehaviors a1,a2] [activation a1,a2] [successSignals s1,s2] [riskSignals r1,r2] [applicableTasks t1,t2]",
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
          const suffix = hasTraitCapabilities(capabilities) ? " with capabilities" : "";
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
            "Usage: trait list | trait view <name> | trait lint <name> | trait history <name> | trait create <name> <category> <prompt> [strengths s1,s2] [preferences p1,p2] [avoids a1,a2] [domains d1,d2] [behaviors b1,b2] [antiBehaviors a1,a2] [activation a1,a2] [successSignals s1,s2] [riskSignals r1,r2] [applicableTasks t1,t2] | trait delete <name>",
          );
      }
    },
  };
}
