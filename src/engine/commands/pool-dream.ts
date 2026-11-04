// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `pool <name> dream …` — cross-agent dreaming over a shared pool (phase 5).
 * The same pass as `memory dream`, over the pool's records and every member's
 * use evidence, recorded under `pool:<name>`; EVERY op it proposes waits for
 * a RATIFIER — a member with standing ≥ 15 (rank 2), a sovereign, or the
 * ungated local operator (`checkRatification`, the institutional rule) who
 * did not write any note the op touches (the party rule). `ratify` applies
 * one op under the same re-checks as an adoption; `rollback` reverses a
 * ratified dream whole. Readouts are the owner's: log, show, proposals.
 */

import {
  adoptProposal,
  type DreamProposal,
  dismissProposal,
  dreamingMode,
  explainDream,
  opIds,
  pendingProposals,
  poolScopeName,
  renderDreamExplanation,
  restoreDreamOp,
  rollbackDream,
  runDream,
} from "../../memory/dream";
import type { DreamProbe, RejectedOp, StoredDreamOp } from "../../memory/dream/types";
import { checkRatification } from "../../memory/institutional";
import { bold, dim, header, label, separator } from "../../net/ansi";
import type { MarinaDB, MemoryPoolRow } from "../../persistence/database";
import { parseDreamJson } from "../../persistence/db-memory-dreams";
import type { Entity, RoomContext } from "../../types";
import { refuseCommand } from "../command-response";
import { canonicalSub } from "../parse-input";
import { dreamChecksOf, renderDreamOps, renderDreamProposal, renderDreamRejected } from "./memory";

const VERBS = [
  "now",
  "dry-run",
  "log",
  "show",
  "proposals",
  "ratify",
  "dismiss",
  "rollback",
  "restore",
  "why",
];

export async function runPoolDreamCommand(
  ctx: RoomContext,
  db: MarinaDB,
  entity: Entity,
  entityId: Entity["id"],
  pool: MemoryPoolRow,
  tokens: readonly string[],
): Promise<void> {
  const name = poolScopeName(pool.name);
  const usage = `Usage: pool ${pool.name} dream [now|dry-run|log|show <id>|proposals|ratify <id> [n]|dismiss <id> [n]|rollback <id>|restore <id> <n>|why]`;
  const verb = canonicalSub(tokens[0], VERBS) ?? "log";
  const dreamOf = () => {
    const id = Number.parseInt(tokens[1] ?? "", 10);
    const row = Number.isInteger(id) ? db.getDream(id) : undefined;
    return row && row.entity_name === name ? row : undefined;
  };
  /** The institutional ratification rule, on the caller's durable account. */
  const ratifier = () => {
    const principalId = db.durableKeyForName(entity.name);
    if (!principalId)
      return {
        ok: false as const,
        reason: "An active durable world account is required to ratify.",
      };
    return checkRatification(db, principalId, { rank: entity.properties.rank });
  };
  /** The party rule: nobody ratifies an op over their own words. */
  const independent = (p: DreamProposal) => {
    const ids = p.kind === "op" ? opIds(p.op) : p.kind === "supersede" ? [p.id, ...p.refs] : [];
    return !ids.some((id) => db.getNote(id)?.entity_name === entity.name);
  };

  if (verb === "why") {
    const explanation = await explainDream(db, name);
    ctx.send(
      entityId,
      [
        header(`Pool "${pool.name}" dream — why not yet`),
        separator(),
        ...renderDreamExplanation(explanation),
      ].join("\n"),
    );
    return;
  }
  if (verb === "now" || verb === "dry-run") {
    if (dreamingMode() === "off") {
      refuseCommand(ctx, entityId, "Dreaming is off (MARINA_DREAMING=off); nothing to run.");
      return;
    }
    const summary = await runDream(db, name, verb === "now" ? "command" : "dry-run");
    if (summary.state === "skipped") {
      ctx.send(entityId, `No dream for pool "${pool.name}": ${summary.skipped}.`);
      return;
    }
    const checks = summary.checks!;
    ctx.send(
      entityId,
      [
        header(
          `Pool "${pool.name}" dream${summary.id ? ` #${summary.id}` : ""} — ${summary.state}${summary.state === "dry-run" ? " (recorded nowhere)" : ""}`,
        ),
        separator(),
        label(
          bold("Region"),
          `${summary.region?.records ?? 0} shared records · ${summary.region?.newRecords ?? 0} new`,
        ),
        label(
          bold("Ops"),
          `${checks.accepted} accepted · ${checks.rejected} rejected · ${checks.leaving} of ${checks.regionSize} would leave the active set`,
        ),
        label(
          bold("Probes"),
          `${checks.probesBefore.pass} retrievable before · ${checks.probesBefore.fail} not${checks.probesAfter ? ` · after: ${checks.probesAfter.pass} retrievable · ${checks.probesAfter.fail} not` : ""}`,
        ),
        ...renderDreamOps(summary.ops ?? []),
        ...renderDreamRejected(summary.rejected ?? []),
        "",
        dim(
          summary.state === "applied"
            ? `${summary.proposals ?? 0} op(s) await a ratifier: pool ${pool.name} dream proposals. Nothing is applied until ratified.`
            : summary.state === "observed"
              ? "Observed: nothing filed (MARINA_DREAMING=on files every op for ratification)."
              : "Dry run: nothing recorded.",
        ),
      ].join("\n"),
    );
    return;
  }
  if (verb === "proposals") {
    const pending = pendingProposals(db, name);
    if (!pending.length) {
      ctx.send(entityId, `No pending proposals for pool "${pool.name}". ${usage}`);
      return;
    }
    const lines = [
      header(`Pool "${pool.name}" — dream proposals awaiting ratification`),
      separator(),
    ];
    for (const p of pending)
      lines.push(
        ...renderDreamProposal(p),
        dim(
          `    pool ${pool.name} dream ratify ${p.dreamId} ${p.n} · pool ${pool.name} dream dismiss ${p.dreamId} ${p.n}`,
        ),
      );
    lines.push(
      "",
      dim(
        "A ratifier holds standing ≥ 15 (rank 2), is a sovereign, or is the ungated local operator, and wrote none of the notes the op touches.",
      ),
    );
    ctx.send(entityId, lines.join("\n"));
    return;
  }
  if (verb === "ratify" || verb === "dismiss") {
    const row = dreamOf();
    if (!row) {
      refuseCommand(
        ctx,
        entityId,
        `No dream #${tokens[1] ?? "?"} of pool "${pool.name}". ${usage}`,
      );
      return;
    }
    const pending = pendingProposals(db, name).filter((p) => p.dreamId === row.id);
    let n = Number.parseInt(tokens[2] ?? "", 10);
    if (!Number.isInteger(n)) {
      if (pending.length !== 1) {
        refuseCommand(
          ctx,
          entityId,
          pending.length
            ? `Dream #${row.id} has ${pending.length} pending proposals: say which (pool ${pool.name} dream ${verb} ${row.id} <n>).`
            : `Dream #${row.id} has no pending proposals.`,
        );
        return;
      }
      n = pending[0]!.n;
    }
    const proposal = pending.find((p) => p.n === n);
    if (!proposal) {
      refuseCommand(ctx, entityId, `Dream #${row.id} has no pending proposal ${n}.`);
      return;
    }
    const who = ratifier();
    if (!who.ok) {
      refuseCommand(ctx, entityId, who.reason);
      return;
    }
    if (!independent(proposal)) {
      refuseCommand(
        ctx,
        entityId,
        `You wrote a note that proposal ${n} of dream #${row.id} touches; an independent member ratifies or dismisses it.`,
      );
      return;
    }
    if (verb === "dismiss") {
      dismissProposal(db, name, row.id, n);
      ctx.send(entityId, `Dismissed proposal ${n} of pool "${pool.name}" dream #${row.id}.`);
      return;
    }
    const out = adoptProposal(db, name, row.id, n);
    if (!out.ok) {
      refuseCommand(ctx, entityId, `Proposal ${n} of dream #${row.id}: ${out.reason}.`);
      return;
    }
    ctx.send(
      entityId,
      `Ratified: ${out.kind === "op" ? out.op : out.kind} applied to pool "${pool.name}" (${who.basis}). pool ${pool.name} dream rollback ${row.id} reverses the whole dream.`,
    );
    return;
  }
  if (verb === "restore") {
    const row = dreamOf();
    if (!row) {
      refuseCommand(
        ctx,
        entityId,
        `No dream #${tokens[1] ?? "?"} of pool "${pool.name}". ${usage}`,
      );
      return;
    }
    const n = Number.parseInt(tokens[2] ?? "", 10);
    if (!Number.isInteger(n) || n < 0) {
      refuseCommand(ctx, entityId, `Usage: pool ${pool.name} dream restore <id> <n>`);
      return;
    }
    const who = ratifier();
    if (!who.ok) {
      refuseCommand(ctx, entityId, who.reason);
      return;
    }
    const out = restoreDreamOp(db, row, n);
    if (!out.ok) {
      refuseCommand(ctx, entityId, `Dream #${row.id} op ${n}: ${out.reason}.`);
      return;
    }
    ctx.send(
      entityId,
      `Restored op ${n} (${out.op}) of pool "${pool.name}" dream #${row.id}; ${out.remaining} ratified op(s) still stand${out.rolledBack ? " — none, so the dream is as rolled back" : ""}.`,
    );
    return;
  }
  if (verb === "rollback") {
    const row = dreamOf();
    if (!row) {
      refuseCommand(
        ctx,
        entityId,
        `No dream #${tokens[1] ?? "?"} of pool "${pool.name}". ${usage}`,
      );
      return;
    }
    const who = ratifier();
    if (!who.ok) {
      refuseCommand(ctx, entityId, who.reason);
      return;
    }
    const out = rollbackDream(db, row);
    if (!out.ok) {
      refuseCommand(ctx, entityId, `Dream #${row.id}: ${out.reason}.`);
      return;
    }
    ctx.send(
      entityId,
      `Pool "${pool.name}" dream #${row.id} rolled back: ${out.reverted} op(s) reversed, ${out.dismissed} proposal(s) dismissed.`,
    );
    return;
  }
  if (verb === "show") {
    const row = dreamOf();
    if (!row) {
      ctx.send(entityId, `No dream #${tokens[1] ?? "?"} of pool "${pool.name}". ${usage}`);
      return;
    }
    const checks = dreamChecksOf(row.checks_json);
    const probes = parseDreamJson<DreamProbe[]>(row.probes_json, []);
    const ops = parseDreamJson<StoredDreamOp[]>(row.ops_json, []);
    const pending = ops.filter((o) => o.proposal === "pending").length;
    ctx.send(
      entityId,
      [
        header(
          `Pool "${pool.name}" dream #${row.id} — ${new Date(row.created_at).toISOString().slice(0, 16)} (${row.trigger}, ${row.mode}, ${row.state})`,
        ),
        separator(),
        label(
          bold("Region"),
          `${row.region_count} shared records · ${row.region_new} new · ${row.region_bytes} bytes · hash ${row.region_hash}`,
        ),
        label(bold("Ops"), `${checks.accepted} accepted · ${checks.rejected} rejected`),
        label(
          bold("Probes"),
          `${checks.probesBefore.pass} retrievable before · ${checks.probesBefore.fail} not (${probes.length} probed)`,
        ),
        label(bold("Model"), `${row.model ?? "—"} · $${row.spend_usd.toFixed(4)}`),
        ...renderDreamOps(ops),
        ...renderDreamRejected(parseDreamJson<RejectedOp[]>(row.rejected_json, [])),
        ...(pending
          ? ["", dim(`${pending} proposal(s) await a ratifier: pool ${pool.name} dream proposals`)]
          : []),
      ].join("\n"),
    );
    return;
  }
  const rows = db.listDreams(name, 10);
  if (rows.length === 0) {
    ctx.send(
      entityId,
      `No dreams for pool "${pool.name}" yet. The hourly pass dreams a pool with ≥ 12 new shared records since its last dream, quiet for 30 min, 8 h apart; \`pool ${pool.name} dream now\` runs one at once.\n${usage}`,
    );
    return;
  }
  const lines = [header(`Pool "${pool.name}" — dreams`), separator()];
  for (const row of rows) {
    const checks = dreamChecksOf(row.checks_json);
    lines.push(
      `  #${String(row.id).padEnd(5)} ${new Date(row.created_at).toISOString().slice(0, 16)}  ${row.state.padEnd(11)} ${checks.accepted} ops · ${checks.rejected} rejected · ${row.trigger}`,
    );
  }
  const pending = pendingProposals(db, name).length;
  if (pending)
    lines.push("", `${pending} proposal(s) await a ratifier: pool ${pool.name} dream proposals`);
  lines.push("", dim(`pool ${pool.name} dream show <id> for one dream. ${usage}`));
  ctx.send(entityId, lines.join("\n"));
}
