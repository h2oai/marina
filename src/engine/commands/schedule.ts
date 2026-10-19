// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../../persistence/database";
import type { ScheduleRow } from "../../persistence/db-schedules";
import { deadlineKinds, resolveDeadline } from "../../schedules/deadlines";
import { ALERT_AFTER_FAILURES, schedulesMode } from "../../schedules/runner";
import {
  firstRun,
  intervalMs,
  parseTrigger,
  renderTrigger,
  type Trigger,
} from "../../schedules/trigger";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { canonicalSub, parseModifiers, splitOnTerminator, unknownSubcommand } from "../parse-input";
import { getRank } from "../permissions";
import { requiresPersistence } from "./command-messages";
import { formatAge, parseDuration } from "./format-duration";

const HELP = `Schedules — run one of your own commands later or on a repeat.
A scheduled run is your command exactly as if you typed it: your rank, gates,
challenges and spend caps apply. It keeps running while you are offline (a
stopped agent's schedules wait), and repeated failures raise an alert.

Usage:
  schedule add <name> <when> [catch-up:once|none] [max-runs:N] -- <command>
      <when>: every:<dur> | daily:HH:MM (UTC) | at:<time> | before:<time|ref> lead:<dur>
      ref: a deadline reference such as arena:<round> (follows the round's lock)
  schedule [list]                  your schedules
  schedule show <name>             details and recent runs
  schedule history <name> [limit:N]
  schedule pause <name> | resume <name>
  schedule run <name>              run it at the next pass (within ~10 s)
  schedule delete <name>           (also rm, remove)

Times are ISO with a zone: 2026-10-14T13:00Z. A missed run (server down) runs
once late by default (catch-up:once); catch-up:none skips to the next slot.

Examples:
  schedule add digest daily:08:00 -- brief full
  schedule add check-arena every:1h -- arena rounds
  schedule add check-w42 before:arena:civiqs-2026-w42-approval lead:2h -- arena show civiqs-2026-w42-approval`;

const SUBS = ["add", "list", "show", "history", "pause", "resume", "run", "delete"];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const COMMAND_MAX_CHARS = 2000;

/** `MARINA_SCHEDULES_PER_ENTITY` (default 20, `0` = unlimited). */
export function schedulesPerEntity(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MARINA_SCHEDULES_PER_ENTITY);
  return Number.isInteger(n) && n >= 0 && env.MARINA_SCHEDULES_PER_ENTITY?.trim() ? n : 20;
}

/** `MARINA_SCHEDULE_MIN_INTERVAL` (default 1m): the shortest repeat allowed. */
export function scheduleMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseDuration(env.MARINA_SCHEDULE_MIN_INTERVAL?.trim()) ?? 60_000;
}

export function scheduleCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    category: "Coordination",
    name: "schedule",
    aliases: ["schedules"],
    help: HELP,
    usage: [
      {
        syntax:
          "schedule add <name> every:<duration> [catch-up:once|none] [max-runs:N] -- <command>",
        effect: "write",
      },
      {
        syntax: "schedule add <name> daily:<HH:MM> [catch-up:once|none] [max-runs:N] -- <command>",
        effect: "write",
      },
      {
        syntax: "schedule add <name> at:<time> [catch-up:once|none] -- <command>",
        effect: "write",
      },
      { syntax: "schedule add <name> before:<time> lead:<duration> -- <command>", effect: "write" },
      { syntax: "schedule [list]", effect: "read" },
      { syntax: "schedule show <name>", effect: "read" },
      { syntax: "schedule history <name> [limit:N]", effect: "read" },
      { syntax: "schedule pause <name>", effect: "write" },
      { syntax: "schedule resume <name>", effect: "write" },
      { syntax: "schedule run <name>", effect: "execute" },
      { syntax: "schedule delete <name>", effect: "delete" },
    ],
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const say = (text: string) => ctx.send(input.entity, text);
      if (!deps.db) {
        say(requiresPersistence("schedules"));
        return;
      }
      const db = deps.db;
      // A schedule belongs to an account (the durable key), never to a transient entity.
      const user = db.getUserByName(entity.name);
      if (!user) {
        say("schedule: schedules belong to an account; this entity has none.");
        return;
      }
      const [head, command] = splitOnTerminator(input.args);
      const tokens = head.split(/\s+/).filter(Boolean);
      const sub = canonicalSub(tokens[0], SUBS) ?? "list";
      if (!SUBS.includes(sub)) {
        say(
          unknownSubcommand(
            "schedule",
            sub,
            "schedule add|list|show|history|pause|resume|run|delete",
          ),
        );
        return;
      }
      const name = tokens[1];
      const own = (): ScheduleRow | undefined => {
        if (!name) {
          say(`schedule ${sub}: name the schedule.`);
          return undefined;
        }
        const row = db.getScheduleByName(user.id, name);
        if (!row) say(`schedule: you have no schedule named "${name}".`);
        return row;
      };

      switch (sub) {
        case "add": {
          if (!name || !NAME_RE.test(name)) {
            say("schedule add: give a name (letters, digits, - or _; up to 40).");
            return;
          }
          if (!command) {
            say(
              "schedule add: put the command after -- (e.g. schedule add digest daily:08:00 -- brief full).",
            );
            return;
          }
          if (command.length > COMMAND_MAX_CHARS) {
            say(`schedule add: the command is longer than ${COMMAND_MAX_CHARS} characters.`);
            return;
          }
          const { values, rest, errors } = parseModifiers(tokens.slice(2), {
            every: { type: "string" },
            daily: { type: "string" },
            at: { type: "string" },
            before: { type: "string" },
            lead: { type: "string" },
            "catch-up": { type: "string", aliases: ["catchup"] },
            "max-runs": { type: "int", aliases: ["max"] },
          });
          if (errors.length || rest.length) {
            say(`schedule add: ${[...errors, ...rest.map((r) => `unexpected "${r}"`)].join("; ")}`);
            return;
          }
          const trigger = parseTrigger({
            every: values.every as string | undefined,
            daily: values.daily as string | undefined,
            at: values.at as string | undefined,
            before: values.before as string | undefined,
            lead: values.lead as string | undefined,
          });
          if ("error" in trigger) {
            say(`schedule add: ${trigger.error}`);
            return;
          }
          if (trigger.kind === "before" && trigger.ref) {
            const at = await resolveDeadline(trigger.ref);
            if (at === undefined) {
              const kinds = deadlineKinds();
              say(
                `schedule add: could not find the deadline of ${trigger.ref}${kinds.length ? ` (known references: ${kinds.map((k) => `${k}:<id>`).join(", ")})` : " (no deadline references are available here)"}.`,
              );
              return;
            }
            trigger.deadline = at;
          }
          const catchUp = (values["catch-up"] as string | undefined)?.toLowerCase() ?? "once";
          if (catchUp !== "once" && catchUp !== "none") {
            say("schedule add: catch-up is once or none.");
            return;
          }
          const maxRuns = values["max-runs"] as number | undefined;
          if (maxRuns !== undefined && maxRuns < 1) {
            say("schedule add: max-runs is at least 1.");
            return;
          }
          // A capped session (a passwordless remote login holds less than the
          // account's stored rank) cannot arrange runs at the account's full rank.
          const rank = getRank(entity);
          if (rank < user.rank) {
            say(
              `schedule add: this session holds rank ${rank}, below your account's rank ${user.rank}. Sign in with your account to schedule work.`,
            );
            return;
          }
          const interval = intervalMs(trigger);
          const minInterval = scheduleMinIntervalMs();
          if (interval !== undefined && interval < minInterval) {
            say(
              `schedule add: the shortest repeat is ${formatMs(minInterval)} (MARINA_SCHEDULE_MIN_INTERVAL).`,
            );
            return;
          }
          const cap = schedulesPerEntity();
          if (cap > 0 && db.countSchedules(user.id) >= cap) {
            say(
              `schedule add: you have ${cap} schedules, the limit (MARINA_SCHEDULES_PER_ENTITY). Delete one first.`,
            );
            return;
          }
          if (db.getScheduleByName(user.id, name)) {
            say(`schedule add: you already have a schedule named "${name}".`);
            return;
          }
          const now = Date.now();
          const next = firstRun(trigger, now);
          if (next === null) {
            say("schedule add: that time has already passed.");
            return;
          }
          db.createSchedule({
            ownerKey: user.id,
            ownerName: user.name,
            name,
            command,
            triggerJson: JSON.stringify(trigger),
            catchUp,
            ...(maxRuns !== undefined ? { maxRuns } : {}),
            nextRunAt: next,
            createdRank: rank,
          });
          say(
            `schedule ${name}: ${renderTrigger(trigger)}; next run ${when(next, now)}. Runs "${command}" as ${user.name}.${schedulesMode() === "off" ? " Schedules are off on this server (MARINA_SCHEDULES=off): it will not run until they are on." : ""}`,
          );
          return;
        }
        case "list": {
          const rows = db.listSchedules(user.id);
          if (!rows.length) {
            say("No schedules. Add one: schedule add <name> every:1h -- <command>");
            return;
          }
          const now = Date.now();
          say(
            [
              `Your schedules (${rows.length}):`,
              ...rows.map((r) => `  ${r.name} — ${summary(r, now)}`),
            ].join("\n"),
          );
          return;
        }
        case "show":
        case "history": {
          const row = own();
          if (!row) return;
          const { values } = parseModifiers(tokens.slice(2), { limit: { type: "int" } });
          const limit = Math.min(Math.max((values.limit as number | undefined) ?? 10, 1), 100);
          const runs = db.listScheduleRuns(row.id, limit);
          const now = Date.now();
          const lines =
            sub === "show"
              ? [
                  `schedule ${row.name} — ${summary(row, now)}`,
                  `  command: ${row.command}`,
                  `  catch-up: ${row.catch_up}${row.max_runs !== null ? `; max runs ${row.max_runs}` : ""}; runs so far ${row.runs}`,
                ]
              : [`schedule ${row.name} — last ${runs.length} run(s):`];
          for (const r of runs)
            lines.push(
              `  ${new Date(r.started_at).toISOString()}  ${r.status}${r.error_class ? ` (${r.error_class})` : ""}  ${formatMs(r.duration_ms)}${r.error ? `  ${r.error}` : ""}`,
            );
          if (!runs.length) lines.push("  no runs yet");
          say(lines.join("\n"));
          return;
        }
        case "pause": {
          const row = own();
          if (!row) return;
          db.setScheduleEnabled(row.id, false, row.next_run_at);
          say(`schedule ${row.name}: paused.`);
          return;
        }
        case "resume": {
          const row = own();
          if (!row) return;
          const now = Date.now();
          const next = firstRun(JSON.parse(row.trigger_json) as Trigger, now);
          if (next === null) {
            say(`schedule ${row.name}: its time has passed; delete it or add a new one.`);
            return;
          }
          db.setScheduleEnabled(row.id, true, next);
          say(`schedule ${row.name}: resumed; next run ${when(next, now)}.`);
          return;
        }
        case "run": {
          const row = own();
          if (!row) return;
          // Run now keeps the failure count (only resume starts fresh).
          db.updateScheduleState(row.id, { nextRunAt: Date.now(), enabled: true });
          say(`schedule ${row.name}: runs at the next pass (within ~10 s).`);
          return;
        }
        case "delete": {
          const row = own();
          if (!row) return;
          db.deleteSchedule(row.id);
          say(`schedule ${row.name}: deleted (its run history is kept until retention prunes it).`);
          return;
        }
      }
    },
  };
}

function summary(r: ScheduleRow, now: number): string {
  let trigger = "?";
  try {
    trigger = renderTrigger(JSON.parse(r.trigger_json) as Trigger);
  } catch {
    // allow-empty-catch: an unreadable stored trigger is shown as "?"
  }
  const state = r.enabled
    ? r.next_run_at === null
      ? "done"
      : "on"
    : r.next_run_at === null
      ? "done"
      : "paused";
  const next = r.enabled && r.next_run_at !== null ? `; next ${when(r.next_run_at, now)}` : "";
  const last = r.last_status
    ? `; last ${r.last_status}${r.last_run_at ? ` ${formatAge(now - r.last_run_at)} ago` : ""}`
    : "";
  const failing =
    r.consecutive_failures >= ALERT_AFTER_FAILURES
      ? `; ${r.consecutive_failures} failures in a row`
      : "";
  return `${state}; ${trigger}${next}${last}${failing}`;
}

function when(at: number, now: number): string {
  const iso = new Date(at).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z");
  return at <= now ? `${iso} (due now)` : `${iso} (in ${formatMs(at - now)})`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
