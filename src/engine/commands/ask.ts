// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TaskManager } from "../../coordination/task-manager";
import { category, dim, header, id, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { gatherRetrievalContext } from "./retrieval-core";

export function askCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  answerQuestion?: (query: string, context: string) => Promise<string | undefined>;
}): CommandDef {
  return {
    name: "ask",
    aliases: [],
    help: "Ask Marina through the shared command substrate. Usage: ask <question>",
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const query = input.args.trim();
      if (!query) {
        ctx.send(input.entity, "Usage: ask <question>");
        return;
      }

      if (!deps.db) {
        ctx.send(input.entity, "Ask requires database support.");
        return;
      }

      const lines: string[] = [header(`Ask: ${query}`), separator()];
      const contextLines: string[] = [];
      let sections = 0;

      const retrieved = gatherRetrievalContext(
        deps.db,
        { id: input.entity, name: entity.name },
        query,
      );

      if (retrieved.personal.length > 0) {
        sections++;
        lines.push(category("Personal Memory"));
        for (const note of retrieved.personal) {
          lines.push(`  ${id(note.id)} ${note.content}`);
          contextLines.push(`[personal:${note.id}] ${note.content}`);
        }
      }

      if (retrieved.guide.length > 0) {
        sections++;
        lines.push(category("Guide"));
        for (const note of retrieved.guide) {
          lines.push(`  ${id(note.id)} ${note.content}`);
          contextLines.push(`[guide:${note.id}] ${note.content}`);
        }
      }

      if (retrieved.pools.length > 0) {
        sections++;
        lines.push(category("Shared Pools"));
        for (const hit of retrieved.pools) {
          lines.push(`  ${id(hit.note.id)} [${hit.pool}] ${hit.note.content}`);
          contextLines.push(`[pool:${hit.pool}:${hit.note.id}] ${hit.note.content}`);
        }
      }

      // Chronicle — the canonical record. Including it here means the model
      // reads what actually happened (engine-emitted events) and how the
      // Chronicler interpreted it (narrative + digest), not just what's in
      // notes/pools. "Impart intelligence everywhere": canonical history
      // reaches LLM synthesis.
      if (retrieved.chronicle.length > 0) {
        sections++;
        lines.push(category("Chronicle"));
        for (const e of retrieved.chronicle) {
          const title = e.title.length > 90 ? `${e.title.slice(0, 87)}…` : e.title;
          lines.push(`  ${id(e.id)} [${e.kind}] ${title}`);
          const body = e.body ? ` — ${e.body.slice(0, 120)}` : "";
          contextLines.push(`[chronicle:${e.kind}:${e.id}] ${e.title}${body}`);
        }
      }

      if (retrieved.world.length > 0) {
        sections++;
        lines.push(category("World Search"));
        for (const hit of retrieved.world) {
          lines.push(`  [${hit.type}:${hit.context}] ${hit.title}`);
          contextLines.push(`[world:${hit.type}:${hit.context}] ${hit.title}`);
        }
      }

      if (deps.taskManager) {
        const tasks = deps.taskManager.searchTasks(query, { limit: 5 });
        if (tasks.length > 0) {
          sections++;
          lines.push(category("Related Tasks"));
          for (const task of tasks) {
            lines.push(`  ${id(task.id)} [${task.status}] ${task.title}`);
            contextLines.push(`[task:${task.id}:${task.status}] ${task.title}`);
          }
        }
      }

      let answered = false;
      if (deps.answerQuestion) {
        try {
          const answer = await deps.answerQuestion(query, contextLines.slice(0, 16).join("\n"));
          if (answer?.trim()) {
            if (sections > 0) lines.push("");
            lines.push(category("Answer"), answer.trim());
            answered = true;
          }
        } catch {
          // Preserve the local-context behavior if the model path is unavailable.
        }
      }

      if (sections > 0) {
        lines.push(
          dim(
            "This is a command-native context answer. The word can evolve through macros, dynamic commands, skills, rooms, and agents.",
          ),
        );
      } else if (!answered) {
        lines.push("No matching world context found yet.");
        lines.push(dim("Try: web search <query>, note what you learn, or ask again later."));
      }

      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
