// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { A, bold, dim, entity, header, rank, separator, table } from "../../net/ansi";
import type { CommandDef, Crew, Entity, RoomContext } from "../../types";
import { formatDuration } from "./format-duration";

/** Agent is considered silent if no entity_activity rows in this window. */
const SILENT_THRESHOLD_MS = 5 * 60 * 1000;

export function whoCommand(
  getOnlineEntities: () => Entity[],
  getRoomShort?: (roomId: string) => string | undefined,
  getLastActivityAt?: (entityName: string) => number | null,
  getCrews?: () => Crew[],
  isRuntimeAgent?: (entityName: string) => boolean,
): CommandDef {
  // Every login shares kind "agent" by design (humans and agents are equal
  // entities). For the roster, distinguish runtime-driven agents from other
  // participants (humans, external SDK clients) so a human isn't listed as
  // an "agent" on their first `who`.
  const displayKind = (e: Entity): string =>
    e.kind === "agent" && isRuntimeAgent && !isRuntimeAgent(e.name) ? "participant" : e.kind;
  return {
    name: "who",
    aliases: [],
    help: "List all connected entities. Agents with no activity in 5m are tagged [silent].",
    handler: (ctx: RoomContext, input) => {
      const online = getOnlineEntities();
      if (online.length === 0) {
        ctx.send(input.entity, "No one is online.");
        return;
      }

      // Group by display kind
      const kindCounts = new Map<string, number>();
      for (const e of online) {
        const k = displayKind(e);
        kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
      }
      const kindColors: Record<string, string> = {
        agent: A.yellow,
        participant: A.cyan,
        npc: A.green,
        object: A.dim,
      };
      const summary = [...kindCounts.entries()]
        .map(([k, n]) => `${kindColors[k] ?? A.brightWhite}${n} ${k}${n > 1 ? "s" : ""}${A.reset}`)
        .join(dim(", "));

      const lines = [header(`Online (${online.length})`), `  ${summary}`, separator(50)];

      // Table rows: name | kind | rank | location | uptime | silent?
      const now = Date.now();
      const rows: string[][] = [];
      for (const e of online) {
        const rankVal = (e.properties.rank as number) ?? 0;
        const roomShort = getRoomShort ? (getRoomShort(e.room) ?? e.room) : e.room;
        const idle = formatDuration(now - e.createdAt);
        let silentTag = "";
        if (displayKind(e) === "agent" && getLastActivityAt) {
          const lastAt = getLastActivityAt(e.name);
          const silence = lastAt == null ? now - e.createdAt : now - lastAt;
          if (silence >= SILENT_THRESHOLD_MS) {
            silentTag = `${A.red}[silent ${formatDuration(silence)}]${A.reset}`;
          }
        }
        rows.push([
          `  ${entity(e.name)}`,
          dim(displayKind(e)),
          rank(rankVal),
          dim(roomShort),
          dim(idle),
          silentTag,
        ]);
      }
      lines.push(table(rows));

      // Crews section — only shown when there are active crews.
      if (getCrews) {
        const crews = getCrews().filter((c) => c.state !== "dissolved");
        if (crews.length > 0) {
          lines.push("", header(`Crews (${crews.length})`), separator(50));
          for (const crew of crews) {
            const memberNames = crew.members.map((m) => m.agentName).join(", ") || dim("(empty)");
            lines.push(
              `  ${bold(crew.name)} ${dim(`[${crew.formation}/${crew.lifetime}/${crew.state}]`)}`,
              `    ${dim("members:")} ${memberNames}`,
            );
          }
        }
      }

      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
