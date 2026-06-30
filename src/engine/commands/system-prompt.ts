import { getLeanSystemPrompt } from "../../agent/prompts/lean-system";
import { composeRolePrompt, inferTaskCategory, resolveRole } from "../../agent/roles";
import { dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, RoomContext } from "../../types";
import { getRoleInspectionMetadata, renderRoleInspectionMetadata } from "./role";

/**
 * Read-only preview of the assembled agent system prompt. The system prompt
 * itself stays code-driven (`getLeanSystemPrompt`) — the editable surface is
 * the role section. This command makes the otherwise-invisible assembly
 * inspectable: what an agent actually receives, optionally with a role's
 * composed section PRISM-gated by a goal-inferred task category.
 */
export function systemPromptCommand(deps: { db?: MarinaDB }): CommandDef {
  return {
    name: "system-prompt",
    aliases: ["sysprompt"],
    minRank: 0,
    help: "Preview the assembled agent system prompt (read-only).\nUsage: system-prompt [role <name>] [goal <text>]\n\nShows exactly what an agent receives as its system prompt. With `role <name>`, the role's composed section is included; add `goal <text>` to PRISM-gate it by the inferred task category (the same gating an agent gets at spawn). No role = the base general-purpose prompt.",
    handler: (ctx: RoomContext, input) => {
      const tokens = input.tokens;
      let roleName: string | undefined;
      let goalText: string | undefined;
      let i = 0;
      while (i < tokens.length) {
        const key = tokens[i]?.toLowerCase();
        if (key === "role") {
          roleName = tokens[i + 1];
          i += 2;
        } else if (key === "goal") {
          goalText = tokens
            .slice(i + 1)
            .join(" ")
            .trim();
          break; // goal consumes the rest
        } else {
          i++;
        }
      }

      let rolePrompt: string | null = null;
      const notes: string[] = [];
      const inspectionLines: string[] = [];
      if (roleName) {
        if (!deps.db) {
          ctx.send(input.entity, "Roles require database support.");
          return;
        }
        const resolved = resolveRole(deps.db, roleName);
        if (!resolved) {
          ctx.send(input.entity, `Role "${roleName}" not found.`);
          return;
        }
        const category = goalText ? inferTaskCategory(goalText) : undefined;
        rolePrompt = composeRolePrompt(resolved, category);
        notes.push(`role: ${roleName}`);
        inspectionLines.push(
          ...renderRoleInspectionMetadata(getRoleInspectionMetadata(deps.db, resolved, category)),
        );
        if (goalText) {
          notes.push(`goal: ${goalText}`, `inferred category: ${category ?? "(none)"}`);
        }
      } else {
        notes.push("no role — base general-purpose prompt");
      }

      const lines = [
        header("System Prompt (read-only preview)"),
        dim(notes.join(" · ")),
        ...inspectionLines,
        separator(),
        getLeanSystemPrompt(rolePrompt),
      ];
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
