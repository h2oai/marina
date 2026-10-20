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
import { applyGateReset, auditGateGrants, planGateReset } from "../gate-audit";
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
  gate audit                    — every operator-grant (999) row by holder; agents flagged
  gate reset <entity|agents> [gate|all] [apply]
                                — dry run by default: what would be revoked. \`apply\`
                                  (operator) revokes operator-grant rows only, chronicled;
                                  demonstrated competence stays; \`gate grant\` restores
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
    usage: [
      { syntax: "gate list [entity]", effect: "read" },
      { syntax: "gate grant <entity> <gate>", effect: "write" },
      { syntax: "gate revoke <entity> <gate>", effect: "delete" },
      { syntax: "gate audit", effect: "read" },
      { syntax: "gate reset <entity|agents> [gate|all] [apply]", effect: "delete" },
    ],
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

      if (sub === "audit") {
        const audit = auditGateGrants(deps.db);
        if (audit.totalRows === 0)
          return reply("No operator-grant gate rows: every gate is earned.");
        return reply(
          [
            header("Gate audit — operator-grant rows"),
            separator(),
            `  ${audit.totalRows} row(s) at the grant sentinel; ${bold(String(audit.agentRows))} held by agent accounts.`,
            ...audit.holders.map(
              (h) =>
                `  ${bold(h.name.padEnd(20))} ${h.kind.padEnd(7)} rank ${h.rank ?? "?"} · ${h.gates.length} gate(s) ${dim(h.gates.join(", "))}`,
            ),
            "",
            dim(
              "Agents holding grants were mostly made sovereign by a local loopback login before 2026-10-20 (new logins no longer are).",
            ),
            dim(
              "Under the local profile gates are lifted anyway; the rows bite only once the profile or MARINA_AUTONOMY changes.",
            ),
            dim(
              "Dry run: gate reset agents · apply (operator): gate reset agents all apply · undo: gate grant <entity> <gate>",
            ),
          ].join("\n"),
        );
      }

      if (sub === "reset") {
        const args = input.tokens.slice(1);
        const apply = args.at(-1)?.toLowerCase() === "apply";
        const [target, gate] = apply ? args.slice(0, -1) : args;
        if (!target) return reply("Usage: gate reset <entity|agents> [gate|all] [apply]");
        const plan = planGateReset(deps.db, target, gate?.toLowerCase() === "all" ? "all" : gate);
        if (plan.error) return reply(plan.error);
        if (plan.rows.length === 0)
          return reply(
            `Nothing to reset: ${target} holds no operator-grant ${gate ?? "gate"} rows.`,
          );
        const listing = plan.rows.map((r) => `  ${r.name.padEnd(20)} ${r.gate}`);
        if (!apply)
          return reply(
            [
              header(`Gate reset — dry run (${plan.rows.length} row(s))`),
              separator(),
              ...listing,
              "",
              dim(
                `Nothing changed. To revoke: gate reset ${args.join(" ")} apply (operator). Demonstrated competence is never touched.`,
              ),
            ].join("\n"),
          );
        if (!isOperatorPrincipal(actor))
          return reply("Applying a gate reset takes an operator (a person at rank 9).");
        const done = applyGateReset(deps.db, plan, actor.name);
        return reply(
          [
            `Reset ${done.length} operator-grant row(s); each holder's reset is in the chronicle.`,
            ...done.map((r) => `  ${r.name.padEnd(20)} ${r.gate}`),
            dim("Undo any of them with: gate grant <entity> <gate>"),
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
