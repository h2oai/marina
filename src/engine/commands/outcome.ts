// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `outcome` — read-only view of the outcome path (`src/outcomes/`): what has
 * resolved, whether learning keeps up with it, and what agents actually get
 * done per kind of work and model.
 *
 *   outcome | outcome stats              delivery state per consumer (lessons, history)
 *   outcome evidence [source:<s>] [since:<d>] [judged]
 *                                        live success rates per model and role (Wilson 95 % lower bound)
 *   outcome list [kind:<k>] [limit:<n>]  your own resolved outcomes
 *
 * Rank 0. `list` shows only the caller's own outcomes; `stats` and `evidence`
 * are aggregates (no task text, no other person's outcomes).
 */

import { bold, dim, header, separator } from "../../net/ansi";
import { EARNED_MIN_COMPARED, EARNED_MIN_LOWER, judgeAgreement } from "../../outcomes/agreement";
import { liveEvidence } from "../../outcomes/evidence";
import type { MarinaDB } from "../../persistence/database";
import type { OutcomeKind } from "../../persistence/db-outcomes";
import type { CommandDef, EntityId, RoomContext } from "../../types";
import { canonicalSub, parseModifiers, unknownSubcommand } from "../parse-input";
import { requiresPersistence } from "./command-messages";

const USAGE =
  "Usage: outcome [stats] | outcome evidence [source:<s>] [since:<duration>] [judged] | outcome list [kind:<k>] [limit:<n>] | outcome agreement";
const SUBS = ["stats", "evidence", "list", "agreement"] as const;
const KINDS: readonly OutcomeKind[] = ["forecast", "task", "request", "benchmark"];

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export function outcomeCommand(deps: {
  db?: MarinaDB;
  getEntity?: (id: EntityId) => { name: string } | undefined;
}): CommandDef {
  return {
    name: "outcome",
    aliases: ["outcomes"],
    category: "Information",
    minRank: 0,
    usage: [
      "outcome",
      "outcome stats",
      "outcome evidence [source:<s>] [since:<duration>] [judged]",
      "outcome list [kind:<k>] [limit:<n>]",
      "outcome agreement",
    ],
    help: `Every resolved result — forecasts, task verdicts, Code Mode checks — is recorded once and learned from.\n${USAGE}\n\nstats: whether lessons and history keep up (pending, done, skipped, failed). evidence: live success rates per kind of work, model and role, from real work (mechanical outcomes; \`judged\` shows judged ones instead). list: your own outcomes. agreement: how often each judge's opinions match the mechanical results for the same work (a judge settles results on its own only once earned). Read-only.`,
    handler: (ctx: RoomContext, input) => {
      const db = deps.db;
      if (!db) {
        ctx.send(input.entity, requiresPersistence("outcomes"));
        return;
      }
      const tokens = input.tokens;
      const sub = canonicalSub(tokens[0], SUBS) ?? (tokens[0] ? undefined : "stats");
      if (sub === "stats") {
        const counts = db.outcomeDeliveryCounts();
        const byConsumer = new Map<string, string[]>();
        for (const c of counts) {
          byConsumer.set(c.consumer, [...(byConsumer.get(c.consumer) ?? []), `${c.state} ${c.n}`]);
        }
        const recent = db.listOutcomes({ limit: 1 })[0];
        ctx.send(
          input.entity,
          [
            header("Outcomes"),
            separator(),
            ...(byConsumer.size
              ? [...byConsumer].map(
                  ([consumer, states]) => `${bold(consumer)}: ${states.join(" · ")}`,
                )
              : ["No outcomes recorded yet."]),
            ...(recent
              ? [dim(`latest: ${recent.source} at ${new Date(recent.resolved_at).toISOString()}`)]
              : []),
          ].join("\n"),
        );
        return;
      }
      if (sub === "evidence") {
        const { values, errors } = parseModifiers(tokens.slice(1), {
          source: { type: "string" },
          since: { type: "duration" },
          judged: { type: "bool" },
        });
        if (errors.length) {
          ctx.send(input.entity, `outcome: ${errors.join("; ")}`);
          return;
        }
        const since = values.since as number | undefined;
        const cells = liveEvidence(db, {
          ...(values.source ? { source: values.source as string } : {}),
          ...(since !== undefined ? { since: Date.now() - since } : {}),
          basis: values.judged ? "judged" : "mechanical",
        });
        ctx.send(
          input.entity,
          [
            header(`Live evidence${values.judged ? " (judged)" : ""}`),
            separator(),
            ...(cells.length
              ? cells.map(
                  (c) =>
                    `${bold(c.source)} ${c.model}${c.role ? ` (${c.role})` : ""}: ${c.successes}/${c.n} ${pct(c.rate)} ${dim(`lower ${pct(c.lower)}`)}`,
                )
              : [
                  "No live evidence yet: outcomes record the agent's model and role as work resolves.",
                ]),
          ].join("\n"),
        );
        return;
      }
      if (sub === "list") {
        const { values, errors } = parseModifiers(tokens.slice(1), {
          kind: { type: "string" },
          limit: { type: "int" },
        });
        const kind = values.kind as string | undefined;
        if (errors.length || (kind && !KINDS.includes(kind as OutcomeKind))) {
          ctx.send(
            input.entity,
            `outcome: ${errors.join("; ") || `kind is one of ${KINDS.join(", ")}`}`,
          );
          return;
        }
        const name = deps.getEntity?.(input.entity)?.name;
        if (!name) {
          ctx.send(input.entity, "outcome list needs a named entity.");
          return;
        }
        const limit = Math.min(Math.max((values.limit as number | undefined) ?? 20, 1), 200);
        const rows = db.listOutcomes({
          owner: name,
          ...(kind ? { kind: kind as OutcomeKind } : {}),
          limit,
        });
        ctx.send(
          input.entity,
          [
            header("Your outcomes"),
            separator(),
            ...(rows.length
              ? rows.map(
                  (o) =>
                    `${o.succeeded ? "✓" : "✗"} ${bold(o.source)} ${dim(o.subject)} ${o.detail ?? ""}${o.quality !== null ? dim(` · quality ${o.quality.toFixed(2)}`) : ""}`,
                )
              : ["None yet."]),
          ].join("\n"),
        );
        return;
      }
      if (sub === "agreement") {
        const rows = judgeAgreement(db);
        ctx.send(
          input.entity,
          [
            header("Judge agreement"),
            separator(),
            ...(rows.length
              ? rows.map(
                  (a) =>
                    `${bold(a.judge)}: agreed ${a.agreed}/${a.compared} compared (${a.judged} judged)${a.falsePass ? ` · false pass ${a.falsePass}` : ""} ${dim(`lower ${pct(a.lower)}`)} ${a.earned ? bold("earned") : dim(`not earned (needs ${EARNED_MIN_COMPARED} compared, lower ≥ ${pct(EARNED_MIN_LOWER)})`)}`,
                )
              : ["No judged outcomes yet."]),
          ].join("\n"),
        );
        return;
      }
      ctx.send(input.entity, unknownSubcommand("outcome", tokens[0], USAGE));
    },
  };
}
