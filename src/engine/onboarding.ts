// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Connection, EntityId } from "../types";
import type { Engine } from "./engine";

export type ParticipationProtocol = "websocket" | "mcp" | "telnet" | "passthru";

import { ORIENTATION_COMMANDS } from "../sdk/onboarding";

/** Shared orientation; quest creation remains solely in authentication. */
export function participantOrientation(
  engine: Engine,
  id: EntityId,
  protocol: ParticipationProtocol,
  resumed: boolean,
) {
  const entity = engine.entities.get(id);
  if (!entity) return undefined;
  return {
    schema: "marina.onboarding.v1" as const,
    entity: { id, name: entity.name },
    room: entity.room,
    world: engine.world?.name ?? engine.instanceName,
    objective: engine.db?.getCoreMemory(entity.name, "goal")?.value ?? null,
    protocol,
    resumed,
    capabilityRevision: engine.commands.revision,
    capabilityCommand: "help catalog",
    contextCommand: "context <query>",
    actions: ORIENTATION_COMMANDS.flatMap((name) => {
      const def = engine.commands.getDef(name);
      return def ? [{ command: name, description: def.help.split(/Usage:|\n/)[0]!.trim() }] : [];
    }),
  };
}

const arrivals = new WeakMap<Connection, Map<string, Promise<void>>>();
/** Await and deduplicate an arrival on this connection; reconnects have a new connection. */
export function onboardParticipant(
  engine: Engine,
  id: EntityId,
  protocol: ParticipationProtocol,
  resumed = false,
): Promise<void> {
  const connection = engine.getConnectionForEntity(id);
  if (!connection) return Promise.resolve();
  let seen = arrivals.get(connection);
  if (!seen) {
    seen = new Map();
    arrivals.set(connection, seen);
  }
  const key = `${id}:${protocol}:${resumed}`;
  const previous = seen.get(key);
  if (previous) return previous;
  const pending = deliverOrientation(engine, id, protocol, resumed, connection);
  seen.set(key, pending);
  return pending;
}
async function deliverOrientation(
  engine: Engine,
  id: EntityId,
  protocol: ParticipationProtocol,
  resumed: boolean,
  connection: Connection,
): Promise<void> {
  const orientation = participantOrientation(engine, id, protocol, resumed);
  if (!orientation) return;
  await engine.processCommand(id, "look", { bypassModal: true });
  if (engine.getConnectionForEntity(id) !== connection) return;
  await engine.processCommand(id, "brief", { bypassModal: true });
  if (engine.getConnectionForEntity(id) !== connection) return;
  engine.sendToEntity(
    id,
    "Discover commands with help; preview your memory with context <query>.",
    "onboarding",
    { onboarding: orientation },
  );
}
