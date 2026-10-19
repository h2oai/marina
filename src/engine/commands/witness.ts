// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `witness` — compatibility surface for the retired witness ladder.
 *
 * APPROVALS ARE THE PROOF (2026-10-14): the earnable path through a safety
 * gate is now the challenge flow (src/engine/challenges.ts). Running a gated
 * action you don't hold yet holds it as a challenge; the people who may
 * approve it are asked; an approved run executes, and an approval from
 * outside your own lineage is one demonstration. `witness` keeps every
 * subcommand working so existing scripts never break:
 *
 * - `witness` — your gate ladder (same text as `gate list`).
 * - `witness request <gate>` — explains the path; nothing to open any more.
 * - `witness grant <entity> <gate>` — supervision windows are retired; lists
 *   the entity's held runs of that gate you can approve instead.
 * - `witness queue` / `attest` / `reject` — review the pending demonstrations
 *   the `earned` posture records for optimistic runs (and any legacy rows in
 *   `witness_attestations`, which stays readable). Attesting follows the
 *   challenge rule: an operator (a person), never the requester's own
 *   lineage, never self.
 */

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { WitnessRow } from "../../persistence/db-witness";
import type { CommandDef, Entity, EntityId } from "../../types";
import { getAutonomyPosture } from "../autonomy";
import { approvalDemonstrates, isOperatorPrincipal, listAnswerable } from "../challenges";
import { sanitizeEntityName } from "../entity-name";
import {
  gateNextStep,
  getGateProgress,
  isOperatorGrantGate,
  recordApprovedDemonstration,
  SAFETY_GATES,
} from "../safety-gates";

const HELP = `witness — earn gated capabilities (now through challenges).
Usage:
  witness                       — your gate ladder (same as \`gate list\`)
  witness request <gate>        — how to earn <gate>: run it; a person approves the held run
  witness grant <entity> <gate> — (retired) lists <entity>'s held runs of <gate> you can approve
  witness queue                 — pending demonstrations (earned posture) you can review
  witness attest <id>           — (operator) count a pending demonstration
  witness reject <id> [reason]  — (operator) decline a pending demonstration
A gated action you don't hold runs once a person approves it (\`challenge\`); approvals from
outside your own lineage build the gate. Operator-grant gates are granted, never earned.`;

export function witnessCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
  getAllEntities: () => Entity[];
  resolveEntityIdByName: (name: string) => EntityId | undefined;
}): CommandDef {
  /** The live entity a witness row belongs to (rows are keyed by account). */
  const rowEntity = (row: WitnessRow): Entity | undefined =>
    deps.getEntity(row.entity_id) ??
    deps.getAllEntities().find((e) => deps.db.durableEntityKey(String(e.id)) === row.entity_id);

  return {
    usage: [
      { syntax: "witness", effect: "read" },
      { syntax: "witness attest <id>", effect: "write" },
      { syntax: "witness grant <entity> <gate>", effect: "read" },
      { syntax: "witness queue", effect: "read" },
      { syntax: "witness reject <id> [reason]", effect: "write" },
      { syntax: "witness request <gate>", effect: "write" },
    ],
    name: "witness",
    category: "Civic",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const db = deps.db;
      const reply = (text: string) => ctx.send(input.entity, text);
      const sub = input.tokens[0]?.toLowerCase();
      const unknownGate = (gateId: string) =>
        `Unknown gate "${gateId}". Gates: ${Object.keys(SAFETY_GATES).join(", ")}`;

      if (sub === "request") {
        const gateId = input.tokens[1] ?? "";
        const gate = SAFETY_GATES[gateId];
        if (!gate) return reply(unknownGate(gateId));
        if (isOperatorGrantGate(gateId)) {
          return reply(
            `${gateId} is operator-grant: an operator grants it (\`gate grant\`), or approves a single held run. ` +
              "Run the action; the refusal holds it for an operator.",
          );
        }
        return reply(
          `Nothing to request any more: run the ${gateId} action itself. If you don't hold it, the run is held ` +
            `as a challenge and the people who can approve it are asked; it runs once approved. ` +
            `${gate.demoThreshold} approved runs from outside your own lineage make ${gateId} yours to use solo ` +
            `(standing floor ${gate.minStanding}). Your holds: \`challenge\`.`,
        );
      }

      if (sub === "grant") {
        const targetName = input.tokens[1] ?? "";
        const gateId = input.tokens[2] ?? "";
        if (!targetName || !SAFETY_GATES[gateId]) {
          return reply("Usage: witness grant <entity> <gate>");
        }
        const held = listAnswerable(actor).filter(
          (c) =>
            c.gateId === gateId &&
            sanitizeEntityName(c.requesterName).toLowerCase() ===
              sanitizeEntityName(targetName).toLowerCase(),
        );
        const lines = [
          "Supervision windows are retired: approve the held run itself (it runs at once).",
        ];
        if (held.length) {
          for (const c of held) {
            lines.push(`  challenge approve ${c.token}  — ${c.summary.slice(0, 120)}`);
          }
        } else {
          lines.push(
            `No held ${gateId} run from ${targetName} that you can approve. When ${targetName} runs it, the hold is offered to its approvers (\`challenge\`).`,
          );
        }
        return reply(lines.join("\n"));
      }

      if (sub === "queue") {
        const rows = db.listOpenWitnessRows({ limit: 100 });
        const operator = isOperatorPrincipal(actor);
        const pending = rows.filter((row) => row.kind === "pending");
        const actionable = operator
          ? pending.filter((row) => {
              const who = rowEntity(row);
              return !!who && who.id !== actor.id && approvalDemonstrates(actor, who, row.gate);
            })
          : [];
        const mine = rows.filter((row) => row.entity_id === db.durableEntityKey(String(actor.id)));
        const lines = [header("Witness queue"), separator()];
        if (actionable.length === 0 && mine.length === 0) {
          lines.push(dim("Nothing to review. Held runs waiting for a person: `challenge`."));
        }
        if (actionable.length > 0) {
          lines.push(bold("You can review:"));
          for (const row of actionable) {
            const who = rowEntity(row)?.name ?? row.entity_id;
            lines.push(
              `  #${row.id} ${who} ran ${row.gate} (${row.evidence ?? "no evidence"}) — \`witness attest ${row.id}\` or \`witness reject ${row.id}\``,
            );
          }
        }
        if (mine.length > 0) {
          lines.push(bold("Yours, awaiting review:"));
          for (const row of mine) {
            lines.push(
              `  #${row.id} ${row.kind} · ${row.gate}${row.evidence ? ` · ${row.evidence}` : ""}`,
            );
          }
        }
        return reply(lines.join("\n"));
      }

      if (sub === "attest" || sub === "reject") {
        const id = Number(input.tokens[1]);
        if (!Number.isInteger(id)) {
          return reply(`Usage: witness ${sub} <id>${sub === "reject" ? " [reason]" : ""}`);
        }
        const row = db.getWitnessRow(id);
        if (row?.status !== "open" || row.kind !== "pending") {
          return reply(`No open pending demonstration #${id}.`);
        }
        const target = rowEntity(row);
        if (row.entity_id === db.durableEntityKey(String(actor.id)) || target?.id === actor.id) {
          return reply("You cannot review your own demonstration.");
        }
        if (!isOperatorPrincipal(actor)) {
          return reply(
            "Reviewing a demonstration takes an operator (a person). Held runs you can answer: `challenge`.",
          );
        }
        if (!target) {
          return reply(
            `#${id} belongs to an account that is not in the world right now; review it later.`,
          );
        }
        if (sub === "reject") {
          const reason = input.tokens.slice(2).join(" ") || undefined;
          db.resolveWitnessRow(id, "rejected", { witnessId: String(actor.id), reason });
          ctx.send(
            target.id,
            `${actor.name} reviewed your ${row.gate} run (#${id}) and didn't count it${reason ? `: ${reason}` : "."}`,
          );
          return reply(`Demonstration #${id} rejected.`);
        }
        if (!approvalDemonstrates(actor, target, row.gate)) {
          return reply(
            `${target.name} is in your own lineage (or ${row.gate} is operator-grant): your review cannot build its gate.`,
          );
        }
        db.resolveWitnessRow(id, "attested", { witnessId: String(actor.id) });
        const recorded = recordApprovedDemonstration(
          db,
          String(target.id),
          row.gate,
          String(actor.id),
        );
        const comp = db.getCompetence(String(target.id), row.gate);
        const gate = SAFETY_GATES[row.gate];
        const unlocked = comp?.supervised_only === 0;
        if (recorded) {
          ctx.send(
            target.id,
            unlocked
              ? `${actor.name} counted your ${row.gate} run: ${row.gate} is now yours to use solo.`
              : `${actor.name} counted your ${row.gate} run (${comp?.demonstrations}/${gate?.demoThreshold}).`,
          );
        }
        return reply(
          recorded
            ? `Attested #${id}: ${target.name} has ${comp?.demonstrations ?? "?"}/${gate?.demoThreshold} on ${row.gate}${unlocked ? " — solo use unlocked." : "."}`
            : "Attestation recorded, but it could not count toward the gate.",
        );
      }

      // Default view: the ladder, personalized.
      const posture = getAutonomyPosture();
      const progress = getGateProgress(db, String(actor.id));
      const lines = [header("Your gate ladder"), separator(), dim(`Autonomy posture: ${posture}`)];
      for (const gate of progress) {
        const marker = gate.status === "unlocked" ? "✓" : gate.status === "supervised" ? "◐" : "🔒";
        lines.push(`  ${marker} ${gate.id} — ${gateNextStep(gate)}`);
      }
      lines.push("", dim(HELP.split("\n").slice(-2).join("\n")));
      reply(lines.join("\n"));
    },
  };
}
