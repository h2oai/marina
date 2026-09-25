#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator CLI for Marina's Social Simulation Arena entry (docs/guides/arena.md).
 *
 *   bun run arena keygen <path>                 new Ed25519 key (0600); prints the public half
 *   bun run arena registration --name N --org O --github LOGIN [--contact EMAIL] [--out FILE]
 *                                               entrants/<id>.json for the registration PR
 *   bun run arena status                        config, key, filed record
 *   bun run arena rounds                        open rounds, soonest lock first
 *   bun run arena show <round_id>               what Marina would file, and why
 *   bun run arena submit <round_id|due> [--dry-run]
 *                                               sign + file (due = every round inside the window)
 *   bun run arena backtest                      baseline skill vs the arena's persistence
 *
 * Reads MARINA_ARENA_* from the environment (.env). Submissions are recorded in
 * the world database (DB_PATH) so the server's autopilot and this CLI share one
 * ledger and never double-file.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { backtestSeries } from "../src/arena/forecast";
import { generateArenaKey } from "../src/arena/protocol";
import { arenaData, arenaDeps, arenaStatus } from "../src/arena/service";
import { buildForecastBody, dueRounds, submitRound } from "../src/arena/submit";
import { MarinaDB } from "../src/persistence/database";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    org: { type: "string" },
    github: { type: "string" },
    contact: { type: "string" },
    homepage: { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean" },
  },
});
const [cmd = "status", arg] = positionals;

function openDb(): MarinaDB {
  return new MarinaDB(process.env.DB_PATH || "marina.db");
}

async function main(): Promise<number> {
  switch (cmd) {
    case "keygen": {
      if (!arg) throw new Error("usage: bun run arena keygen <path>");
      const key = generateArenaKey();
      // O_EXCL: never overwrite an existing key; 0600: only this user can read it.
      const fd = openSync(arg, "wx", 0o600);
      writeSync(fd, key.privatePem);
      closeSync(fd);
      console.log(`Wrote ${arg} (mode 600). Keep it private; it never leaves this machine.`);
      console.log(`Public key (goes in the registration): ${key.publicBase64}`);
      console.log(`Next: set MARINA_ARENA_KEY_FILE=${arg} and MARINA_ARENA_ENTRANT=<id>, then`);
      console.log("      bun run arena registration --name … --org … --github <login>");
      return 0;
    }
    case "registration": {
      const s = arenaStatus();
      if (!s.configured || !s.entrant) throw new Error("set MARINA_ARENA_ENTRANT first");
      if (!s.publicKey) throw new Error(`signing key not ready: ${s.keyError}`);
      if (!values.name || !values.github) throw new Error("--name and --github are required");
      const registration = {
        entrant_id: s.entrant,
        name: values.name,
        ...(values.org ? { organization: values.org } : {}),
        type: "participant",
        ...(values.contact ? { contact: values.contact } : {}),
        github: values.github,
        ...(values.homepage ? { homepage: values.homepage } : {}),
        keys: [{ id: s.keyId, alg: "ed25519", public: s.publicKey, revoked: false }],
      };
      const text = `${JSON.stringify(registration, null, 2)}\n`;
      if (values.out) await Bun.write(values.out, text);
      process.stdout.write(text);
      console.error(
        `Add this as entrants/${s.entrant}.json in a fork of Social-Atoms/social-sim-arena and open the PR from ${values.github}.`,
      );
      return 0;
    }
    case "status": {
      const s = arenaStatus();
      console.log(JSON.stringify(s, null, 2));
      if (s.configured) {
        const db = openDb();
        const rows = db.listArenaSubmissions({ entrant: s.entrant, limit: 500 });
        console.log(
          `filed: ${rows.filter((r) => r.status === "accepted").length} accepted, ${rows.filter((r) => r.status !== "accepted").length} other`,
        );
        db.close();
      }
      return 0;
    }
    case "rounds": {
      const now = Date.now();
      for (const r of await arenaData().openRounds()) {
        const h = Math.round((Date.parse(r.lock_at) - now) / 3_600_000);
        console.log(
          `${r.lock_at}  ${String(h).padStart(4)} h  ${r.target_type.padEnd(17)} ${r.round_id}`,
        );
      }
      return 0;
    }
    case "show": {
      if (!arg) throw new Error("usage: bun run arena show <round_id>");
      const data = arenaData();
      const round = await data.round(arg);
      if (!round) throw new Error(`no round ${arg}`);
      const body = await buildForecastBody(data, arenaStatus().entrant ?? "marina-preview", round);
      console.log(
        JSON.stringify({ question: round.question, lock_at: round.lock_at, body }, null, 2),
      );
      return 0;
    }
    case "submit": {
      if (!arg) throw new Error("usage: bun run arena submit <round_id|due> [--dry-run]");
      const db = openDb();
      try {
        const deps = arenaDeps(db);
        if ("error" in deps) throw new Error(deps.error);
        const ids = arg === "due" ? (await dueRounds(deps)).map((r) => r.round_id) : [arg];
        if (ids.length === 0) console.log("Nothing due.");
        let failed = 0;
        for (const id of ids) {
          const outcome = await submitRound(deps, id, { dryRun: values["dry-run"] });
          if (outcome.kind === "dry-run") {
            console.log(`${id}: would file ${JSON.stringify(outcome.body)}`);
          } else if (outcome.kind === "accepted") {
            console.log(`${id}: accepted${outcome.already ? " (already filed)" : ""}`);
          } else {
            failed++;
            console.log(`${id}: ${outcome.kind} — ${outcome.reason}`);
          }
        }
        return failed ? 1 : 0;
      } finally {
        db.close();
      }
    }
    case "backtest": {
      const data = arenaData();
      const rows: string[] = [];
      let total = 0;
      let count = 0;
      for (const round of (await data.openRounds()).filter(
        (r) => r.target_type !== "ranking_list",
      )) {
        const lock = await data.lock(round.round_id).catch(() => undefined);
        if (!lock) continue;
        const series =
          round.target_type === "profile_energy"
            ? Object.values(lock.answer_history_by_cell ?? {})
            : [lock.answer_history ?? lock.history ?? []];
        for (const points of series) {
          const r = backtestSeries(points);
          if (!r) continue;
          total += r.skill;
          count++;
          rows.push(
            `${r.skill >= 0 ? "+" : ""}${r.skill.toFixed(3)}  ${r.rule.padEnd(11)} ${round.round_id}`,
          );
        }
      }
      console.log(rows.join("\n"));
      console.log(`mean skill over ${count} series: ${count ? (total / count).toFixed(3) : "n/a"}`);
      return 0;
    }
    default:
      throw new Error(
        `unknown command ${cmd} (keygen, registration, status, rounds, show, submit, backtest)`,
      );
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
