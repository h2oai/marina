// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ArenaData } from "../../arena/data";
import { backtestSeries, forecastRound } from "../../arena/forecast";
import { arenaData, arenaStatus } from "../../arena/service";
import { buildForecastBody } from "../../arena/submit";
import type { ArenaRound } from "../../arena/types";
import { bold, dim, header, separator } from "../../net/ansi";
import type { ArenaStore } from "../../persistence/interfaces/arena-store";
import type { NotesStore } from "../../persistence/interfaces/notes-store";
import type { CommandDef, RoomContext } from "../../types";
import { canonicalSub, unknownSubcommand } from "../parse-input";
import {
  type ArenaLabDeps,
  arenaDiscover,
  arenaEvaluate,
  arenaShadow,
  arenaSignals,
} from "./arena-lab";

const USAGE = [
  "Usage: arena [status] | arena rounds [n] | arena show <round_id> | arena submissions | arena backtest [n]",
  "       arena evaluate [baseline|nowcast|discovered] [tracker:T] [limit:N]   — score on resolved rounds",
  "       arena shadow [list] | arena shadow score | arena shadow run <round_id|due> [forecaster:F]",
  "       arena discover [tracker:T] [n:N] | arena signals [tracker:T]         — find new signals",
].join("\n");
const SUBS = [
  "status",
  "rounds",
  "show",
  "submissions",
  "backtest",
  "evaluate",
  "shadow",
  "discover",
  "signals",
];

/**
 * `arena` — Marina's seat in the Social Simulation Arena (src/arena), open to
 * everyone in the world: the open questions, what Marina would file and why,
 * the signed record of what it did file, and the measurement loop — evaluate,
 * shadow, discover (`arena-lab.ts`; free forecasters only). Filing under the
 * organization's name and holding its key are operator acts (`bun run arena`,
 * `MARINA_ARENA_AUTOPILOT`), never in-world ones.
 */
export function arenaCommand(deps: {
  store?: ArenaStore;
  notes?: NotesStore;
  data?: () => ArenaData;
  propose?: ArenaLabDeps["propose"];
}): CommandDef {
  return {
    name: "arena",
    aliases: [],
    help: `Marina in the Social Simulation Arena: open questions, Marina's forecasts, its filed record.\n${USAGE}`,
    minRank: 0,
    handler: (ctx: RoomContext, input) => {
      const sub = canonicalSub(input.tokens[0]?.toLowerCase() ?? "status", SUBS);
      const reply = (text: string) => ctx.send(input.entity, text);
      const fail = (err: unknown) =>
        reply(`Arena data unavailable: ${err instanceof Error ? err.message : String(err)}`);
      const entrant = arenaStatus().entrant ?? "marina-preview";
      const filed = (roundId: string) =>
        deps.store && arenaStatus().entrant
          ? deps.store.latestArenaSubmission(arenaStatus().entrant!, roundId)?.status
          : undefined;

      const lab: ArenaLabDeps = {
        store: deps.store,
        notes: deps.notes,
        data: deps.data ?? (() => arenaData()),
        ...(deps.propose ? { propose: deps.propose } : {}),
      };
      const rest = input.tokens.slice(1);
      if (sub === "evaluate") return arenaEvaluate(lab, input.entity, rest, reply).catch(fail);
      if (sub === "shadow") return arenaShadow(lab, rest, reply).catch(fail);
      if (sub === "discover") return arenaDiscover(lab, input.entity, rest, reply).catch(fail);
      if (sub === "signals") return arenaSignals(lab, rest, reply);

      if (sub === "status") {
        const s = arenaStatus();
        const lines = [header("Social Simulation Arena"), separator()];
        if (!s.configured) {
          lines.push(
            s.configError
              ? `Misconfigured: ${s.configError}`
              : "Not entered. The operator sets MARINA_ARENA_ENTRANT and MARINA_ARENA_KEY_FILE (see docs/guides/arena.md).",
            dim("You can still browse: arena rounds · arena show <round_id>"),
          );
          reply(lines.join("\n"));
          return;
        }
        lines.push(
          `Entrant   ${bold(s.entrant!)}  ${dim(`key ${s.keyId}`)}`,
          `Signing   ${s.publicKey ? `ready ${dim(s.publicKey)}` : `NOT READY — ${s.keyError}`}`,
          `Autopilot ${s.autopilot ? "on — files each round in its last 24 h" : "off"}`,
        );
        const recent = deps.store?.listArenaSubmissions({ entrant: s.entrant, limit: 200 }) ?? [];
        const count = (st: string) => recent.filter((r) => r.status === st).length;
        lines.push(
          `Filed     ${count("accepted")} accepted · ${count("rejected")} rejected · ${count("error")} errored`,
        );
        reply(lines.join("\n"));
        return;
      }

      if (sub === "rounds") {
        const n = Math.min(Math.max(Number(input.tokens[1]) || 15, 1), 80);
        return lab
          .data()
          .openRounds()
          .then((rounds) => {
            if (rounds.length === 0) return reply("No open rounds.");
            const now = Date.now();
            reply(
              [
                header(`Open arena rounds (${rounds.length})`),
                separator(),
                ...rounds.slice(0, n).map((r) => {
                  const hours = Math.round((Date.parse(r.lock_at) - now) / 3_600_000);
                  const mine = filed(r.round_id);
                  return `  ${bold(r.round_id)} ${dim(`${r.target_type} · locks in ${hours} h`)}${mine ? ` · ${mine}` : ""}`;
                }),
              ].join("\n"),
            );
          })
          .catch(fail);
      }

      if (sub === "show") {
        const id = input.tokens[1];
        if (!id) return reply("Usage: arena show <round_id>");
        const data = lab.data();
        return data
          .round(id)
          .then(async (round) => {
            if (!round) return reply(`No round ${id}.`);
            const lock = await data.lock(id);
            const body = await buildForecastBody(data, entrant, round);
            const rules = forecastRound(round, lock).rules;
            reply(
              [
                header(round.round_id),
                separator(),
                round.question,
                dim(`${round.unit ?? ""} · locks ${round.lock_at} · releases ${round.release_at}`),
                "",
                `Marina would file: ${formatAnswer(round, body)}`,
                dim(body.notes ?? ""),
                ...(Object.keys(rules).length
                  ? [
                      dim(
                        `spread rules: ${Object.entries(rules)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(", ")}`,
                      ),
                    ]
                  : []),
                ...(filed(id) ? [`Filed: ${filed(id)}`] : []),
              ].join("\n"),
            );
          })
          .catch(fail);
      }

      if (sub === "submissions") {
        const rows = deps.store?.listArenaSubmissions({ limit: 30 }) ?? [];
        if (rows.length === 0) return reply("Nothing filed yet.");
        reply(
          [
            header("Arena submissions"),
            separator(),
            ...rows.map(
              (r) =>
                `  ${bold(r.round_id)} ${r.status}${r.http_status ? ` (${r.http_status})` : ""} ${dim(new Date(r.created_at).toISOString())}`,
            ),
          ].join("\n"),
        );
        return;
      }

      if (sub === "backtest") {
        const n = Math.min(Math.max(Number(input.tokens[1]) || 20, 1), 60);
        const data = lab.data();
        return data
          .openRounds()
          .then(async (rounds) => {
            const byFamily = new Map<string, { skill: number; n: number }[]>();
            for (const round of rounds
              .filter((r) => r.target_type !== "ranking_list")
              .slice(0, n)) {
              const lock = await data.lock(round.round_id).catch(() => undefined);
              if (!lock) continue;
              const series =
                round.target_type === "profile_energy"
                  ? Object.values(lock.answer_history_by_cell ?? {})
                  : [lock.answer_history ?? lock.history ?? []];
              for (const points of series) {
                const r = backtestSeries(points);
                if (!r) continue;
                const list = byFamily.get(round.tracker) ?? [];
                list.push({ skill: r.skill, n: r.points });
                byFamily.set(round.tracker, list);
              }
            }
            if (byFamily.size === 0) return reply("Not enough history to backtest.");
            reply(
              [
                header("Baseline backtest vs the arena's persistence (held-out half)"),
                separator(),
                ...[...byFamily.entries()].map(([family, list]) => {
                  const mean = list.reduce((s, x) => s + x.skill, 0) / list.length;
                  return `  ${bold(family.padEnd(18))} skill ${mean >= 0 ? "+" : ""}${mean.toFixed(3)} ${dim(`${list.length} series`)}`;
                }),
                dim("0 = the arena's persistence; above 0 beats it. Past skill is not a promise."),
              ].join("\n"),
            );
          })
          .catch(fail);
      }

      reply(unknownSubcommand("arena", input.tokens[0] ?? "", USAGE));
    },
  };
}

function formatAnswer(
  round: ArenaRound,
  body: Awaited<ReturnType<typeof buildForecastBody>>,
): string {
  if (body.topline) return `${body.topline.mean} ± ${body.topline.sd} ${round.unit ?? ""}`.trim();
  if (body.profile) {
    const cells = Object.entries(body.profile);
    return `${cells.length}-cell profile — ${cells
      .slice(0, 3)
      .map(([k, d]) => `${k} ${d.mean}±${d.sd}`)
      .join(", ")}${cells.length > 3 ? ", …" : ""}`;
  }
  return (body.ranking ?? []).map((t, i) => `${i + 1}. ${t}`).join("  ");
}
