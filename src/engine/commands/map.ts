// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { category, header } from "../../net/ansi";
import type { CommandDef, EntityId, RoomContext, RoomId } from "../../types";

interface RoomInfo {
  id: RoomId;
  short: string;
  exits: Record<string, RoomId>;
}

export function mapCommand(deps: {
  getEntityRoom: (entity: EntityId) => RoomInfo | undefined;
  getRoomShort: (id: RoomId) => string | undefined;
}): CommandDef {
  return {
    name: "map",
    aliases: [],
    help: "Show a map of nearby spaces.",
    handler: (ctx: RoomContext, input) => {
      const room = deps.getEntityRoom(input.entity);
      if (!room) {
        ctx.send(input.entity, "You are nowhere.");
        return;
      }

      const exits = room.exits;
      const exitKeys = Object.keys(exits);

      if (exitKeys.length === 0) {
        ctx.send(input.entity, `${header(room.short)}\n  No exits.`);
        return;
      }

      // Build spatial layout
      const get = (dir: string): string | undefined => {
        const id = exits[dir];
        if (!id) return undefined;
        return deps.getRoomShort(id) ?? id;
      };

      const n = get("north");
      const s = get("south");
      const e = get("east");
      const w = get("west");
      const ne = get("northeast");
      const nw = get("northwest");
      const se = get("southeast");
      const sw = get("southwest");
      const u = get("up");
      const d = get("down");

      const center = room.short;
      const pad = (s: string | undefined, len: number): string => {
        if (!s) return " ".repeat(len);
        if (s.length > len) return `${s.slice(0, len - 1)}\u2026`;
        const left = Math.floor((len - s.length) / 2);
        return " ".repeat(left) + s + " ".repeat(len - s.length - left);
      };

      const W = 18;
      const lines: string[] = [header("Nearby Rooms"), ""];

      // Row 1: NW - N - NE
      if (nw || n || ne) {
        lines.push(`  ${pad(nw, W)} ${pad(n, W)} ${pad(ne, W)}`);
        const nwc = nw ? "  \u2572" : "   ";
        const nc = n ? "       \u2502" : "        ";
        const nec = ne ? "\u2571  " : "   ";
        lines.push(`  ${" ".repeat(W / 2)}${nwc}${nc}${nec}`);
      }

      // Row 2: W - CENTER - E
      const wStr = w ? `${pad(w, W)} \u2500\u2500 ` : `${pad(undefined, W)}    `;
      const eStr = e ? ` \u2500\u2500 ${pad(e, W)}` : "";
      const centerStr = category(`[${center}]`);
      lines.push(`  ${wStr}${centerStr}${eStr}`);

      // Up/Down indicators
      if (u || d) {
        const upDown: string[] = [];
        if (u) upDown.push(`\u2191 ${u}`);
        if (d) upDown.push(`\u2193 ${d}`);
        lines.push(`  ${" ".repeat(W + 4)}${upDown.join("  ")}`);
      }

      // Row 3: SW - S - SE
      if (sw || s || se) {
        const swc = sw ? "  \u2571" : "   ";
        const sc = s ? "       \u2502" : "        ";
        const sec = se ? "\u2572  " : "   ";
        lines.push(`  ${" ".repeat(W / 2)}${swc}${sc}${sec}`);
        lines.push(`  ${pad(sw, W)} ${pad(s, W)} ${pad(se, W)}`);
      }

      lines.push("");
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
