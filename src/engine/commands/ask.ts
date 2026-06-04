import type { TaskManager } from "../../coordination/task-manager";
import { category, dim, header, id, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";

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

      const db = deps.db;
      const lines: string[] = [header(`Ask: ${query}`), separator()];
      const contextLines: string[] = [];
      let sections = 0;

      const memories = db.recallNotes(entity.name, query).slice(0, 5);
      if (memories.length > 0) {
        sections++;
        lines.push(category("Personal Memory"));
        for (const note of memories) {
          db.touchNote(note.id);
          lines.push(`  ${id(note.id)} ${note.content}`);
          contextLines.push(`[personal:${note.id}] ${note.content}`);
        }
      }

      const guide = db.getMemoryPool("guide");
      if (guide) {
        const guideNotes = db.recallPoolNotes(guide.id, query).slice(0, 5);
        if (guideNotes.length > 0) {
          sections++;
          lines.push(category("Guide"));
          for (const note of guideNotes) {
            db.touchNote(note.id);
            lines.push(`  ${id(note.id)} ${note.content}`);
            contextLines.push(`[guide:${note.id}] ${note.content}`);
          }
        }
      }

      const poolHits: { pool: string; content: string; noteId: number }[] = [];
      for (const pool of db.listMemoryPools()) {
        if (pool.name === "guide") continue;
        const hits = db.recallPoolNotes(pool.id, query).slice(0, 2);
        for (const hit of hits) {
          db.touchNote(hit.id);
          poolHits.push({ pool: pool.name, content: hit.content, noteId: hit.id });
          if (poolHits.length >= 6) break;
        }
        if (poolHits.length >= 6) break;
      }
      if (poolHits.length > 0) {
        sections++;
        lines.push(category("Shared Pools"));
        for (const hit of poolHits) {
          lines.push(`  ${id(hit.noteId)} [${hit.pool}] ${hit.content}`);
          contextLines.push(`[pool:${hit.pool}:${hit.noteId}] ${hit.content}`);
        }
      }

      // Chronicle — the canonical record. Including it here means the model
      // reads what actually happened (engine-emitted events) and how the
      // Chronicler interpreted it (narrative + digest), not just what's in
      // notes/pools. "Impart intelligence everywhere": canonical history
      // reaches LLM synthesis.
      const chronicleHits = db.queryChronicle({ like: query, limit: 5 });
      if (chronicleHits.length > 0) {
        sections++;
        lines.push(category("Chronicle"));
        for (const e of chronicleHits) {
          const title = e.title.length > 90 ? `${e.title.slice(0, 87)}…` : e.title;
          lines.push(`  ${id(e.id)} [${e.kind}] ${title}`);
          const body = e.body ? ` — ${e.body.slice(0, 120)}` : "";
          contextLines.push(`[chronicle:${e.kind}:${e.id}] ${e.title}${body}`);
        }
      }

      const searchHits = db.globalSearch(query).slice(0, 5);
      if (searchHits.length > 0) {
        sections++;
        lines.push(category("World Search"));
        for (const hit of searchHits) {
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
