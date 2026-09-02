// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `witness` — the earnable path through the safety gates, made walkable.
 *
 * The gate registry always promised "supervised demonstrations flip a gate to
 * solo use"; this command is where that promise lives. An agent with the
 * standing to attempt a gate asks for supervision; a qualified holder grants
 * a one-demonstration window (guarded posture) or reviews demonstrations that
 * already ran (earned posture); enough attested demonstrations flip the gate.
 *
 * Witness qualification is unchanged from safety-gates: you may witness only
 * a gate you yourself hold unsupervised (`canWitness`) — capability
 * propagates down a chain that bootstraps from operators, never from
 * self-report.
 */

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId } from "../../types";
import { getAutonomyPosture } from "../autonomy";
import {
  canWitness,
  getGateProgress,
  recordWitnessedDemonstration,
  SAFETY_GATES,
} from "../safety-gates";

const WINDOW_TTL_MS = 10 * 60 * 1000; // one supervised demonstration, 10 minutes
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

const HELP = `witness — earn gated capabilities through supervised demonstrations.
Usage:
  witness                       — your gate ladder + open items you can act on
  witness request <gate>        — ask a qualified holder to supervise a demonstration
  witness grant <entity> <gate> — (qualified) open a one-demonstration window (10 min)
  witness queue                 — open requests + pending demonstrations you can act on
  witness attest <id>           — (qualified) attest a recorded demonstration
  witness reject <id> [reason]  — (qualified) reject a recorded demonstration
Gates and your progress: \`standing\`. Qualification: you can witness only gates you hold solo.`;

export function witnessCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
  getAllEntities: () => Entity[];
  resolveEntityIdByName: (name: string) => EntityId | undefined;
}): CommandDef {
  return {
    name: "witness",
    category: "Civic",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const db = deps.db;
      const sub = input.tokens[0]?.toLowerCase();

      if (sub === "request") {
        const gateId = input.tokens[1] ?? "";
        const gate = SAFETY_GATES[gateId];
        if (!gate) {
          ctx.send(
            input.entity,
            `Unknown gate "${gateId}". Gates: ${Object.keys(SAFETY_GATES).join(", ")}`,
          );
          return;
        }
        const already = db
          .listOpenWitnessRows({ kind: "request", gate: gateId, entityId: String(actor.id) })
          .at(0);
        if (already) {
          ctx.send(input.entity, `Your request #${already.id} for ${gateId} is already open.`);
          return;
        }
        const row = db.createWitnessRow({
          entityId: String(actor.id),
          gate: gateId,
          kind: "request",
          expiresAt: Date.now() + REQUEST_TTL_MS,
        });
        // Invite every qualified witness currently in the world.
        let invited = 0;
        for (const candidate of deps.getAllEntities()) {
          if (candidate.id === actor.id) continue;
          if (!canWitness(db, String(candidate.id), gateId)) continue;
          ctx.send(
            candidate.id,
            `${actor.name} is ready to demonstrate "${gate.description}" (${gateId}) and asks for your supervision. Grant a window with: witness grant ${actor.name} ${gateId}`,
          );
          invited++;
        }
        ctx.send(
          input.entity,
          `Request #${row.id} recorded for ${gateId}. ${invited > 0 ? `${invited} qualified witness(es) were invited.` : "No qualified witness is online right now — the request stays open 24h and shows in `witness queue`."}`,
        );
        return;
      }

      if (sub === "grant") {
        const targetName = input.tokens[1] ?? "";
        const gateId = input.tokens[2] ?? "";
        const gate = SAFETY_GATES[gateId];
        if (!targetName || !gate) {
          ctx.send(input.entity, "Usage: witness grant <entity> <gate>");
          return;
        }
        if (!canWitness(db, String(actor.id), gateId)) {
          ctx.send(
            input.entity,
            `You can witness only gates you hold solo — you don't hold ${gateId} unsupervised yet.`,
          );
          return;
        }
        const targetId = deps.resolveEntityIdByName(targetName);
        if (!targetId) {
          ctx.send(input.entity, `No entity named "${targetName}" found.`);
          return;
        }
        if (String(targetId) === String(actor.id)) {
          ctx.send(input.entity, "You cannot witness your own demonstration.");
          return;
        }
        const window = db.createWitnessRow({
          entityId: String(targetId),
          gate: gateId,
          kind: "window",
          witnessId: String(actor.id),
          expiresAt: Date.now() + WINDOW_TTL_MS,
        });
        // Close any open request this window answers.
        for (const req of db.listOpenWitnessRows({
          kind: "request",
          gate: gateId,
          entityId: String(targetId),
        })) {
          db.resolveWitnessRow(req.id, "attested", { witnessId: String(actor.id) });
        }
        const threshold = gate.demoThreshold;
        ctx.send(
          input.entity,
          `Window #${window.id} open: ${targetName} may run one supervised "${gateId}" demonstration in the next 10 minutes, credited to you.`,
        );
        ctx.send(
          targetId,
          `${actor.name} is watching: you have a 10-minute window to demonstrate "${gate.description}" (${gateId}). Run the gated operation now — ${threshold} attested demonstration(s) unlock solo use.`,
        );
        return;
      }

      if (sub === "queue") {
        const rows = db.listOpenWitnessRows({ limit: 100 });
        const actionable = rows.filter(
          (row) =>
            row.entity_id !== String(actor.id) &&
            (row.kind === "request" || row.kind === "pending") &&
            canWitness(db, String(actor.id), row.gate),
        );
        const mine = rows.filter((row) => row.entity_id === String(actor.id));
        const lines = [header("Witness queue"), separator()];
        if (actionable.length === 0 && mine.length === 0) {
          lines.push(
            dim("Nothing open. Agents ask for supervision with `witness request <gate>`."),
          );
        }
        if (actionable.length > 0) {
          lines.push(bold("You can act on:"));
          for (const row of actionable) {
            const who = deps.getEntity(row.entity_id)?.name ?? row.entity_id;
            lines.push(
              row.kind === "request"
                ? `  #${row.id} ${who} requests supervision for ${row.gate} — \`witness grant ${who} ${row.gate}\``
                : `  #${row.id} ${who} ran ${row.gate} (${row.evidence ?? "no evidence"}) — \`witness attest ${row.id}\` or \`witness reject ${row.id}\``,
            );
          }
        }
        if (mine.length > 0) {
          lines.push(bold("Yours, awaiting others:"));
          for (const row of mine) {
            lines.push(
              `  #${row.id} ${row.kind} · ${row.gate}${row.evidence ? ` · ${row.evidence}` : ""}`,
            );
          }
        }
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "attest" || sub === "reject") {
        const id = Number(input.tokens[1]);
        if (!Number.isInteger(id)) {
          ctx.send(
            input.entity,
            `Usage: witness ${sub} <id>${sub === "reject" ? " [reason]" : ""}`,
          );
          return;
        }
        const row = db.getWitnessRow(id);
        if (row?.status !== "open" || row.kind !== "pending") {
          ctx.send(input.entity, `No open pending demonstration #${id}.`);
          return;
        }
        if (row.entity_id === String(actor.id)) {
          ctx.send(input.entity, "You cannot attest your own demonstration.");
          return;
        }
        if (!canWitness(db, String(actor.id), row.gate)) {
          ctx.send(
            input.entity,
            `You can attest only gates you hold solo — you don't hold ${row.gate} unsupervised yet.`,
          );
          return;
        }
        if (sub === "reject") {
          const reason = input.tokens.slice(2).join(" ") || undefined;
          db.resolveWitnessRow(id, "rejected", { witnessId: String(actor.id), reason });
          ctx.send(input.entity, `Demonstration #${id} rejected.`);
          const target = deps.getEntity(row.entity_id);
          if (target) {
            ctx.send(
              target.id,
              `${actor.name} reviewed your ${row.gate} demonstration (#${id}) and didn't attest it${reason ? `: ${reason}` : "."} Keep practicing — rejected runs don't count against you.`,
            );
          }
          return;
        }
        db.resolveWitnessRow(id, "attested", { witnessId: String(actor.id) });
        const recorded = recordWitnessedDemonstration(
          db,
          row.entity_id,
          row.gate,
          String(actor.id),
        );
        const comp = db.getCompetence(row.entity_id, row.gate);
        const gate = SAFETY_GATES[row.gate];
        const unlocked = comp?.supervised_only === 0;
        ctx.send(
          input.entity,
          recorded
            ? `Attested #${id}: ${row.entity_id} now has ${comp?.demonstrations ?? "?"}/${gate?.demoThreshold} demonstrations on ${row.gate}${unlocked ? " — UNLOCKED for solo use." : "."}`
            : `Attestation recorded, but the demonstration could not be credited (qualification changed?).`,
        );
        const target = deps.getEntity(row.entity_id);
        if (target && recorded) {
          ctx.send(
            target.id,
            unlocked
              ? `${actor.name} attested your ${row.gate} demonstration — that was your ${gate?.demoThreshold}th: ${row.gate} is now yours to use solo. Welcome to the other side of the gate.`
              : `${actor.name} attested your ${row.gate} demonstration (${comp?.demonstrations}/${gate?.demoThreshold}). Keep going.`,
          );
        }
        return;
      }

      // Default view: the ladder, personalized.
      const posture = getAutonomyPosture();
      const progress = getGateProgress(db, String(actor.id));
      const lines = [header("Your gate ladder"), separator(), dim(`Autonomy posture: ${posture}`)];
      for (const gate of progress) {
        const marker = gate.status === "unlocked" ? "✓" : gate.status === "supervised" ? "◐" : "🔒";
        const next =
          gate.status === "unlocked"
            ? "yours"
            : gate.status === "supervised"
              ? posture === "open"
                ? "open posture — usable now (unless destructive-core)"
                : posture === "earned"
                  ? `run it — a witness attests afterwards (${gate.demonstrations}/${gate.demoThreshold} attested)`
                  : `witness request ${gate.id} (${gate.demonstrations}/${gate.demoThreshold} demos)`
              : `standing ${gate.standing.toFixed(0)}/${gate.minStanding} — contribute to grow`;
        lines.push(`  ${marker} ${gate.id} — ${next}`);
      }
      lines.push("", dim(HELP.split("\n").slice(2, 8).join("\n")));
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
