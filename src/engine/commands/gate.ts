// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `gate` — grant, revoke and list safety-gate competence in-world.
 *
 * Grants pass capability down the same chain witnessing does, without
 * escalation: you may grant a gate only if you are a sovereign (rank 9) or
 * hold that gate solo yourself; the destructive core (OPEN_POSTURE_CORE) is
 * sovereign-only; nobody grants themselves; a non-sovereign never grants to
 * an agent they spawned (a grant is not a way to launder your own trust into
 * a sockpuppet). Revoking is sovereign-only. A grant writes the same
 * `GRANTED_DEMONSTRATIONS` row an operator seed does (`grant()`).
 */

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId } from "../../types";
import { OPEN_POSTURE_CORE } from "../autonomy";
import { sanitizeEntityName } from "../entity-name";
import { getErrorMessage } from "../errors";
import { Logger } from "../logger";
import { getRank } from "../permissions";
import { checkUnattendedGate, getGateProgress, grant, revoke, SAFETY_GATES } from "../safety-gates";

const logger = new Logger();

const SOVEREIGN_RANK = 9;

const HELP = `gate — safety-gate competence: who holds what, and passing it on.
Usage:
  gate list [entity]            — every gate and its status for you (or <entity>)
  gate grant <entity> <gate>    — grant a gate you hold solo (sovereigns: any gate)
  gate revoke <entity> <gate>   — (sovereign) take a gate back
Core gates (${[...OPEN_POSTURE_CORE].join(", ")}) are granted by sovereigns only; nobody grants themselves.
Earning a gate instead: \`witness request <gate>\`. Your ladder: \`standing\`.`;

export function gateCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
  resolveEntity: (name: string) => Entity | undefined;
  /** The name of the entity that spawned `name`, if an agent. */
  spawnedBy?: (name: string) => string | undefined;
}): CommandDef {
  return {
    usage: ["gate list [entity]", "gate grant <entity> <gate>", "gate revoke <entity> <gate>"],
    name: "gate",
    aliases: ["gates"],
    category: "Civic",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const reply = (text: string) => ctx.send(input.entity, text);
      const sub = input.tokens[0]?.toLowerCase() ?? "list";

      if (sub === "list" || sub === "ls") {
        const targetName = input.tokens[1];
        const target = targetName ? deps.resolveEntity(targetName) : actor;
        if (!target) return reply(`No entity named "${targetName}" found.`);
        const rows = getGateProgress(deps.db, String(target.id));
        return reply(
          [
            header(`Gates — ${target.name}`),
            separator(),
            ...rows.map(
              (g) =>
                `  ${bold(g.id.padEnd(24))} ${g.status}${g.decayed ? " (standing decayed)" : ""} ${dim(`standing ${g.minStanding} · ${g.demonstrations}/${g.demoThreshold} demos · ${g.description}`)}`,
            ),
          ].join("\n"),
        );
      }

      if (sub !== "grant" && sub !== "revoke") return reply(HELP);

      const targetName = input.tokens[1] ?? "";
      const gateId = input.tokens[2] ?? "";
      if (!targetName || !gateId) return reply(`Usage: gate ${sub} <entity> <gate>`);
      if (!SAFETY_GATES[gateId]) {
        return reply(`Unknown gate "${gateId}". Gates: ${Object.keys(SAFETY_GATES).join(", ")}`);
      }
      const target = deps.resolveEntity(targetName);
      if (!target) return reply(`No entity named "${targetName}" found.`);
      const sovereign = getRank(actor) >= SOVEREIGN_RANK;

      if (sub === "revoke") {
        if (!sovereign) return reply("Revoking a gate takes a sovereign (rank 9).");
        revoke(deps.db, String(target.id), gateId);
        audit(deps.db, "revoke", actor.name, target.name, gateId);
        return reply(`Revoked ${gateId} from ${target.name}.`);
      }

      if (String(target.id) === String(actor.id)) {
        return reply(
          `Nobody grants a gate to themselves — earn it: \`witness request ${gateId}\`.`,
        );
      }
      if (OPEN_POSTURE_CORE.has(gateId) && !sovereign) {
        return reply(`${gateId} is a core gate — only a sovereign (rank 9) grants it.`);
      }
      if (!sovereign) {
        if (!checkUnattendedGate(deps.db, String(actor.id), gateId).ok) {
          return reply(
            `You can grant only gates you hold solo — you don't hold ${gateId} unsupervised.`,
          );
        }
        const creator = deps.spawnedBy?.(target.name);
        if (creator && sanitizeEntityName(creator) === sanitizeEntityName(actor.name)) {
          return reply(
            `${target.name} is an agent you spawned — it earns ${gateId} through a witness other than you, or a sovereign grants it.`,
          );
        }
      }
      grant(deps.db, String(target.id), gateId);
      audit(deps.db, "grant", actor.name, target.name, gateId);
      ctx.send(target.id as EntityId, `${actor.name} granted you the ${gateId} gate.`);
      return reply(`Granted ${gateId} to ${target.name}.`);
    },
  };
}

/**
 * Every grant and revoke is civic history: an immutable chronicle `event`
 * (engine-emitted, never corrected away). No standing flows from it — being
 * granted a gate is not a contribution.
 */
function audit(
  db: MarinaDB,
  action: "grant" | "revoke",
  actor: string,
  target: string,
  gateId: string,
): void {
  try {
    db.appendChronicle({
      kind: "event",
      source: "gate",
      title: `${actor} ${action === "grant" ? "granted" : "revoked"} ${gateId} ${action === "grant" ? "to" : "from"} ${target}`,
      participants: [actor, target],
      refs: [`gate:${gateId}`],
    });
  } catch (error) {
    logger.warn("gate", "Gate audit entry failed", {
      action,
      gateId,
      error: getErrorMessage(error),
    });
  }
}
