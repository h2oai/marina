// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { A, bold, dim, entity, header, rank, separator, table } from "../../net/ansi";
import type { CommandDef, Crew, Entity, EntityId, RoomContext } from "../../types";
import {
  type Presence,
  type PresenceWatch,
  presenceTag,
  WATCH_FILTERS,
  type WatchFilter,
} from "../presence";
import { formatDuration } from "./format-duration";

/** The presence surface `who` reads and `who watch` writes. */
export interface WhoPresence {
  statusOf(name: string): Presence | undefined;
  watch(watch: PresenceWatch): void;
  unwatch(watcher: EntityId, target: string): boolean;
  watchesOf(watcher: EntityId): PresenceWatch[];
}

const WATCH_USAGE =
  "Usage: who watch <name> [idle|blocked|any] [once] · who watch <name> off · who watch";

/** Agent is considered silent if no entity_activity rows in this window. */
const SILENT_THRESHOLD_MS = 5 * 60 * 1000;

export function whoCommand(
  getOnlineEntities: () => Entity[],
  getRoomShort?: (roomId: string) => string | undefined,
  getLastActivityAt?: (entityName: string) => number | null,
  getCrews?: () => Crew[],
  isRuntimeAgent?: (entityName: string) => boolean,
  /** Display label per name (`Wren [claude]` for a supervised resident). */
  labelOf?: (entityName: string) => string,
  presence?: WhoPresence,
): CommandDef {
  // Every login shares kind "agent" by design (humans and agents are equal
  // entities). For the roster, distinguish runtime-driven agents from other
  // participants (humans, external SDK clients) so a human isn't listed as
  // an "agent" on their first `who`.
  const displayKind = (e: Entity): string =>
    e.kind === "agent" && isRuntimeAgent && !isRuntimeAgent(e.name) ? "participant" : e.kind;
  return {
    category: "Information",
    usage: [
      { syntax: "who", effect: "read" },
      { syntax: "who watch", effect: "read" },
      { syntax: "who watch <name> [idle|blocked|any] [once]", effect: "write" },
      { syntax: "who watch <name> off", effect: "delete" },
    ],
    name: "who",
    aliases: [],
    help: "List all connected entities with each agent's status (working, idle, blocked, needs you, resting, offline). Agents with no activity in 5m are tagged [silent]. `who watch <name> [idle|blocked|any] [once]` sends you one notice per status change instead of polling.",
    handler: (ctx: RoomContext, input) => {
      const words = input.args.trim().split(/\s+/).filter(Boolean);
      if (words[0]?.toLowerCase() === "watch") {
        ctx.send(input.entity, whoWatch(presence, input.entity, words.slice(1)));
        return;
      }
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
        const status = presenceTag(presence?.statusOf(e.name));
        rows.push([
          `  ${entity(labelOf ? labelOf(e.name) : e.name)}`,
          dim(status ? `${displayKind(e)} · ${status}` : displayKind(e)),
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

function whoWatch(presence: WhoPresence | undefined, watcher: EntityId, words: string[]): string {
  if (!presence) return "Presence is not available in this world.";
  if (!words.length) {
    const mine = presence.watchesOf(watcher);
    if (!mine.length) return `No watches. ${WATCH_USAGE}`;
    return mine.map((w) => `  ${w.target} ${w.filter}${w.once ? " once" : ""}`).join("\n");
  }
  const [target, ...rest] = words;
  if (!target || !/^[A-Za-z0-9_]{1,20}$/.test(target)) return WATCH_USAGE;
  if (rest.length === 1 && rest[0]!.toLowerCase() === "off")
    return presence.unwatch(watcher, target)
      ? `Stopped watching ${target}.`
      : `Not watching ${target}.`;
  let filter: WatchFilter = "any";
  let once = false;
  for (const word of rest.map((w) => w.toLowerCase())) {
    if (word === "once") once = true;
    else if ((WATCH_FILTERS as readonly string[]).includes(word)) filter = word as WatchFilter;
    else return WATCH_USAGE;
  }
  presence.watch({ watcher, target, filter, once });
  const now = presenceTag(presence.statusOf(target));
  return `Watching ${target} (${filter}${once ? ", once" : ""})${now ? `; now ${now}` : ""}.`;
}
