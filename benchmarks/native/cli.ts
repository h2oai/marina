// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Native task CLI.
 *
 * Inspect (no server):
 *   bun run bench:native --task csp --seed 7 --print [--json] [--members A,B,C] [--crash]
 *   bun run bench:native --task all --seeds 1-3 --print
 *
 * Run against a live server (the lane method):
 *   bun run bench:native --task csp --seed 7 --port 40400 --db <world.db> \
 *     [--crew answerer] [--formation f] [--workspace dir] [--crash] \
 *     [--deadline 300] [--poll 15] [--settle 30] [--hab habitat.tsv] [--win windows.tsv] [--json]
 *
 * Lane hooks (split the run around the lane's own dispatch/poll):
 *   --setup-only  apply the setup, print NATIVE_* shell assignments (TID, TEXT, RE, OK) for eval
 *   --score-only  score the first deliverable note already in --db, print JSON
 */

import { environmentSpec, GENERATORS, resolveTask } from "./index";
import {
  applySetup,
  exactOkRe,
  generateFor,
  OperatorSession,
  resolveRoster,
  runNative,
  scoreFromDb,
  shq,
} from "./runner";
import { DEFAULT_MEMBERS, type NativeTaskId } from "./shared";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

function seedsArg(): number[] {
  const spec = flag("seeds") ?? flag("seed") ?? "1";
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-").map((s) => Number.parseInt(s, 10));
    if (!Number.isInteger(a)) throw new Error(`bad seed spec "${spec}"`);
    for (let s = a!; s <= (Number.isInteger(b) ? b! : a!); s++) out.push(s);
  }
  return out;
}

function usage(): never {
  process.stderr.write(
    "usage: bench:native --task <csp|aggregation|bugs|auction|delphi|pipeline|all> --seed N [--print [--json]] | [--port P --db PATH ...]\n",
  );
  process.exit(2);
}

const taskArg = flag("task");
if (!taskArg) usage();
const tasks: NativeTaskId[] =
  taskArg === "all" ? (Object.keys(GENERATORS) as NativeTaskId[]) : [resolveTask(taskArg)];
const seeds = seedsArg();
const crash = has("crash");
const port = flag("port") ? Number(flag("port")) : undefined;
const db = flag("db");
const crew = flag("crew") ?? "answerer";
const membersFlag = flag("members")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (has("print") || port === undefined) {
  const members = membersFlag ?? (db ? resolveRoster(db, crew) : DEFAULT_MEMBERS);
  for (const task of tasks)
    for (const seed of seeds) {
      const inst = generateFor({ task, seed, members, crash });
      if (has("json")) {
        process.stdout.write(
          `${JSON.stringify({ ...inst, environment: environmentSpec(inst) })}\n`,
        );
        continue;
      }
      const g = GENERATORS[task];
      const self = await g.score(inst.answer, inst.oracle, {
        files: Object.fromEntries(
          (inst.scoreFiles ?? []).map((p) => [
            p,
            (inst.oracle as { correctSource?: string }).correctSource ?? "",
          ]),
        ),
      });
      const lines = [
        `=== ${inst.tag} — ${g.title} (seed ${seed}, shape: ${inst.shape}) ===`,
        `TEXT: ${inst.text}`,
        ...Object.entries(inst.privateMaterial).flatMap(([m, msgs]) =>
          msgs.map((t) => `PRIVATE → ${m}: ${t}`),
        ),
        ...inst.setup
          .filter((s) => s.kind !== "private")
          .map((s) =>
            s.kind === "file"
              ? `FILE ${s.path} (${s.content.length} B)`
              : s.kind === "pool"
                ? `POOL ${s.pool}`
                : `POOL NOTE ${s.pool}: ${s.text}`,
          ),
        ...(inst.fault
          ? [`FAULT: agent stop ${inst.fault.member} at +${inst.fault.afterSeconds}s`]
          : []),
        `DELIVERABLE /${inst.deliverableRe}/ in pool ${inst.pool}`,
        `ANSWER: ${inst.answer}`,
        `ORACLE SELF-CHECK: correct=${self.correct} score=${self.score.toFixed(3)}`,
        "",
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    }
  process.exit(0);
}

if (!db) usage();
if (tasks.length !== 1 || seeds.length !== 1) {
  process.stderr.write("a live run takes exactly one --task and one --seed\n");
  process.exit(2);
}
const task = tasks[0]!;
const seed = seeds[0]!;
const workspace = flag("workspace");

if (has("setup-only")) {
  const members = resolveRoster(db, crew, membersFlag);
  const inst = generateFor({ task, seed, members, crash });
  const session = await OperatorSession.open(`ws://localhost:${port}`);
  try {
    for (const line of await applySetup(session, inst, workspace))
      process.stderr.write(`  setup ${line}\n`);
  } finally {
    session.close();
  }
  process.stdout.write(
    [
      `NATIVE_TID=${shq(inst.tag)}`,
      `NATIVE_TEXT=${shq(inst.text)}`,
      `NATIVE_RE=${shq(inst.deliverableRe)}`,
      `NATIVE_OK=${shq(exactOkRe(inst))}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (has("score-only")) {
  const members = resolveRoster(db, crew, membersFlag);
  const inst = generateFor({ task, seed, members, crash });
  const { notes, result } = await scoreFromDb(inst, db, workspace);
  process.stdout.write(
    `${JSON.stringify({ tag: inst.tag, notes: notes.length, deliverable: notes[0]?.content, result })}\n`,
  );
  process.exit(0);
}

const res = await runNative({
  task,
  seed,
  port,
  db,
  crew,
  formation: flag("formation"),
  members: membersFlag,
  workspace,
  crash,
  deadlineSec: flag("deadline") ? Number(flag("deadline")) : undefined,
  pollSec: flag("poll") ? Number(flag("poll")) : undefined,
  settleSec: flag("settle") ? Number(flag("settle")) : undefined,
  hab: flag("hab"),
  win: flag("win"),
});
if (has("json")) process.stdout.write(`${JSON.stringify(res)}\n`);
else
  process.stdout.write(
    `${res.tag}\tfound=${res.found ? 1 : 0}\tnotes=${res.notes}\tcorrect=${res.result.correct ? 1 : 0}\tscore=${res.result.score.toFixed(4)}\t${JSON.stringify(res.result.details)}\n`,
  );
process.exit(0);
