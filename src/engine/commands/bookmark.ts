import { header, separator } from "../../net/ansi";
import type { CommandDef, Entity, RoomContext, RoomId } from "../../types";

interface Bookmark {
  room: RoomId;
  note?: string;
}

export function bookmarkCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  getRoomShort: (id: RoomId) => string | undefined;
}): CommandDef {
  return {
    name: "bookmark",
    aliases: ["bm"],
    help: "Save space bookmarks. Usage: bookmark | bookmark list | bookmark note <#> <text> | bookmark delete <#>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const bookmarks: Bookmark[] = (entity.properties.bookmarks as Bookmark[]) ?? [];
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        // Save current room as bookmark
        const already = bookmarks.some((b) => b.room === input.room);
        if (already) {
          ctx.send(input.entity, "This space is already bookmarked.");
          return;
        }
        bookmarks.push({ room: input.room });
        entity.properties.bookmarks = bookmarks;
        const roomName = deps.getRoomShort(input.room) ?? input.room;
        ctx.send(input.entity, `Bookmarked: ${roomName}`);
        return;
      }

      switch (sub) {
        case "list": {
          if (bookmarks.length === 0) {
            ctx.send(input.entity, "No bookmarks saved.");
            return;
          }
          const lines = [
            header("Bookmarks"),
            separator(),
            ...bookmarks.map((b, i) => {
              const name = deps.getRoomShort(b.room) ?? b.room;
              const note = b.note ? ` - ${b.note}` : "";
              return `  ${i + 1}. ${name} (${b.room})${note}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "note": {
          const idx = Number.parseInt(tokens[1] ?? "", 10) - 1;
          const text = tokens.slice(2).join(" ");
          if (Number.isNaN(idx) || idx < 0 || idx >= bookmarks.length || !text) {
            ctx.send(input.entity, "Usage: bookmark note <#> <text>");
            return;
          }
          bookmarks[idx]!.note = text;
          entity.properties.bookmarks = bookmarks;
          ctx.send(input.entity, `Bookmark ${idx + 1} annotated.`);
          return;
        }

        case "delete": {
          const idx = Number.parseInt(tokens[1] ?? "", 10) - 1;
          if (Number.isNaN(idx) || idx < 0 || idx >= bookmarks.length) {
            ctx.send(input.entity, "Usage: bookmark delete <#>");
            return;
          }
          bookmarks.splice(idx, 1);
          entity.properties.bookmarks = bookmarks;
          ctx.send(input.entity, `Bookmark ${idx + 1} removed.`);
          return;
        }

        default: {
          ctx.send(
            input.entity,
            "Usage: bookmark | bookmark list | bookmark note <#> <text> | bookmark delete <#>",
          );
        }
      }
    },
  };
}
