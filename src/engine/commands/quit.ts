// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommandDef, Connection, EntityId } from "../../types";

export function quitCommand(deps: {
  getConnection: (entityId: EntityId) => Connection | undefined;
  /**
   * Tear down the entity now — quit is an explicit goodbye, not a
   * transient disconnect. Without this, the entity would linger in the
   * reconnect-grace window and `who` would still show the quitter as
   * present for up to a minute.
   */
  removeConnection: (connId: string, intent: "transient" | "explicit") => void;
}): CommandDef {
  return {
    name: "quit",
    aliases: ["exit", "logout", "disconnect"],
    help: "Disconnect from Marina and end your session.",
    handler(ctx, input) {
      const conn = deps.getConnection(input.entity);
      if (!conn) {
        ctx.send(input.entity, "No active connection found.");
        return;
      }
      ctx.send(input.entity, "Goodbye. Your session has ended.");
      deps.removeConnection(conn.id, "explicit");
      conn.close();
    },
  };
}
