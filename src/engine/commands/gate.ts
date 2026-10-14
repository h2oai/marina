// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `gate` — grant, revoke and list safety-gate competence in-world.
 *
 * Grants pass capability on without escalation: you may grant a gate only if you are a sovereign (rank 9) or
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
import { isOperatorPrincipal, principalKind } from "../challenges";
import { sanitizeEntityName } from "../entity-name";
import { getErrorMessage } from "../errors";
import { Logger } from "../logger";
import {
  checkUnattendedGate,
  gateNextStep,
  getGateProgress,
  grant,
  revoke,
  SAFETY_GATES,
} from "../safety-gates";

const logger = new Logger();

const HELP = `gate — safety-gate competence: who holds what, and passing it on.
Usage:
  gate list [entity]            — every gate and its status for you (or <entity>)
  gate grant <entity> <gate>    — grant a gate you hold solo (sovereigns: any gate)
  gate revoke <entity> <gate>   — (sovereign) take a gate back
Operator-grant gates (${[...OPEN_POSTURE_CORE].join(", ")}) are granted by sovereigns only; nobody grants themselves.
Earning a gate instead: run the gated action — the held run executes once a person approves it, and
approvals from outside your own lineage build the gate (\`challenge\`).`;

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
                `  ${bold(g.id.padEnd(24))} ${g.status} ${gateNextStep(g)} ${dim(`· ${g.description}`)}`,
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
      // An operator is a PERSON at sovereign rank (the rule holds use): a
      // rank-9 agent is not one, and a grant is an approval for good.
      const sovereign = isOperatorPrincipal(actor);
      const person = principalKind(actor) === "person";

      if (sub === "revoke") {
        if (!sovereign) return reply("Revoking a gate takes an operator (a person at rank 9).");
        revoke(deps.db, String(target.id), gateId);
        audit(deps.db, "revoke", actor.name, target.name, gateId);
        return reply(`Revoked ${gateId} from ${target.name}.`);
      }

      if (String(target.id) === String(actor.id)) {
        return reply(
          `Nobody grants a gate to themselves — run the gated action; a person's approval of the held run builds it.`,
        );
      }
      if (!person) {
        return reply(
          `Agents don't grant gates — a person does. ${target.name} earns ${gateId} through people's approvals of its held runs.`,
        );
      }
      if (OPEN_POSTURE_CORE.has(gateId) && !sovereign) {
        return reply(
          `${gateId} is an operator-grant gate — only an operator (a person at rank 9) grants it.`,
        );
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
            `${target.name} is an agent you spawned — it earns ${gateId} through approvals from outside your lineage, or a sovereign grants it.`,
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
