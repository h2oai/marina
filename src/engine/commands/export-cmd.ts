import type { BoardManager } from "../../coordination/board-manager";
import type { CommandDef, Entity, RoomContext } from "../../types";

export function exportCommand(
  boards: BoardManager,
  getEntity: (id: string) => Entity | undefined,
): CommandDef {
  return {
    name: "export",
    aliases: [],
    help: "Export board posts. Usage: export <board> [json]",
    handler: (ctx: RoomContext, input) => {
      const entity = getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const boardName = tokens[0];
      if (!boardName) {
        ctx.send(input.entity, "Usage: export <board> [json]");
        return;
      }

      const format = tokens[1]?.toLowerCase() === "json" ? "json" : "markdown";

      const board = boards.getBoardByName(boardName);
      if (!board) {
        ctx.send(input.entity, `Board "${boardName}" not found.`);
        return;
      }

      const posts = boards.listPosts(board.id, { limit: 100 });
      if (posts.length === 0) {
        ctx.send(input.entity, `Board "${boardName}" has no posts.`);
        return;
      }

      if (format === "json") {
        const data = posts.map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          author: p.authorName,
          date: new Date(p.createdAt).toISOString(),
        }));
        ctx.send(input.entity, JSON.stringify(data, null, 2));
      } else {
        const lines: string[] = [`# ${board.name}`, ""];
        for (const p of posts) {
          const date = new Date(p.createdAt).toISOString().slice(0, 10);
          if (p.title) {
            lines.push(`## ${p.title}`);
          }
          lines.push(`*${p.authorName}* \u2014 ${date}`, "");
          lines.push(p.body, "");
          lines.push("---", "");
        }
        ctx.send(input.entity, lines.join("\n"));
      }
    },
  };
}
