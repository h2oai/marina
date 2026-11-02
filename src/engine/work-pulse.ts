// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The work pulse: a standing source of real, bounded, verifiable work for the
 * world's agents, so the task → review → outcome → lesson → standing loop
 * runs without a person feeding it.
 *
 * Measured 2026-11-02: with the seeded agents back on, the task board held
 * only self-made "standby" tasks; 173 agent turns produced no task, no
 * verdict and no outcome. The loops downstream of work (the outcome judges,
 * lessons from work, standing) had nothing to learn from.
 *
 * Once a day, when at least one agent is running and the pulse project
 * (`MARINA_WORK_PULSE_PROJECT`, default "Demo Pulse") has no open pulse task,
 * the pulse audits the shared knowledge pool (`MARINA_WORK_PULSE_POOL`,
 * default `guide`) with the same auditor as `guide audit` and turns ONE
 * finding into one task: fix a stale command reference, merge a duplicate,
 * ground an unsupported claim, split an overlong note. The task names the
 * finding, asks for inspectable evidence (the corrected note), and is
 * created by the reviewer account (`MARINA_WORK_PULSE_REVIEWER`, default
 * "Critic") so the creator's verdict is an independent party's and earns
 * standing. A finding is worked once: the task carries a marker the pulse
 * checks before opening another. `MARINA_WORK_PULSE=off` disables it. No
 * model call; the agents' own cycles do the work.
 */

import { TaskManager } from "../coordination/task-manager";
import type { MarinaDB } from "../persistence/database";
import {
  auditKnowledgeNotes,
  type CommandVocabulary,
  type KnowledgeHygieneFinding,
} from "./commands/knowledge-hygiene";

export const WORK_PULSE_TITLE_PREFIX = "Work pulse:";
const DAY_MS = 86_400_000;
/** Notes untouched this long count as stale for the audit (as `guide audit`). */
export const WORK_PULSE_STALE_MS = 90 * DAY_MS;

export interface WorkPulseDeps {
  db: Pick<
    MarinaDB,
    | "getProjectByName"
    | "listTasks"
    | "getMemoryPool"
    | "getPoolNotes"
    | "getUserByName"
    | "createTask"
    | "getTask"
    | "updateTaskStatus"
  >;
  /** The live command vocabulary (`commandVocabulary(engine)`); without it stale-command findings are skipped. */
  vocabulary?: CommandVocabulary;
  /** Names of the agents running now; no agent ⇒ no task (nothing would do it). */
  runningAgents: () => readonly string[];
  /**
   * Announce an opened task where the agents read (the engine posts it to
   * `general` from the reviewer, addressed to `MARINA_WORK_PULSE_WORKER`): a
   * name-addressed message is what attention treats as owed, so the worker
   * wakes and claims it. Measured 2026-11-02: the first pulse task sat unclaimed
   * for 17 minutes while every agent looped on its own standby note; a tell
   * naming Builder was claimed in 80 s.
   */
  announce?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface WorkPulseResult {
  opened?: { id: number; title: string; kind: KnowledgeHygieneFinding["kind"] };
  skipped?: string;
}

export function workPulseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MARINA_WORK_PULSE ?? "").trim().toLowerCase() !== "off";
}

/** The marker a pulse task carries so its finding is never worked twice. */
export function workPulseMarker(f: Pick<KnowledgeHygieneFinding, "kind" | "noteIds">): string {
  return `[work-pulse ${f.kind} ${[...f.noteIds]
    .sort((a, b) => a - b)
    .map((n) => `#${n}`)
    .join(",")}]`;
}

const WHAT_TO_DO: Record<KnowledgeHygieneFinding["kind"], { title: string; ask: string }> = {
  "stale-command": {
    title: "fix a stale command reference in the shared knowledge",
    ask: "Correct the note so every command it names is one that exists (check with `help <command>`), or retire the note if its advice no longer applies.",
  },
  duplicate: {
    title: "merge duplicate notes in the shared knowledge",
    ask: "Keep the better note, fold anything only the other one says into it, and retire the duplicate.",
  },
  "unsupported-claim": {
    title: "ground an unsupported claim in the shared knowledge",
    ask: "Add the evidence the claim rests on (a citation, a measurement, a world record) or soften it to what the evidence supports.",
  },
  overlong: {
    title: "split an overlong note in the shared knowledge",
    ask: "Split it into notes that each make one point, or trim it to the part that is still true and useful.",
  },
  stale: {
    title: "review a note that nobody has touched in months",
    ask: "Confirm it still holds (and say how you checked), update it, or retire it.",
  },
};

/** Findings in the order the pulse works them: the ones a reader trips over first. */
const PRIORITY: KnowledgeHygieneFinding["kind"][] = [
  "stale-command",
  "duplicate",
  "unsupported-claim",
  "overlong",
  "stale",
];

/**
 * Open one pulse task when the conditions hold. Pure over its deps; the
 * result says what happened or why nothing did.
 */
export function openWorkPulseTask(deps: WorkPulseDeps): WorkPulseResult {
  const env = deps.env ?? process.env;
  if (!workPulseEnabled(env)) return { skipped: "off (MARINA_WORK_PULSE)" };
  const projectName = env.MARINA_WORK_PULSE_PROJECT?.trim() || "Demo Pulse";
  const project = deps.db.getProjectByName(projectName);
  if (!project?.group_id) return { skipped: `no project "${projectName}"` };
  const running = deps.runningAgents();
  if (!running.length) return { skipped: "no agent running" };
  const reviewerName = env.MARINA_WORK_PULSE_REVIEWER?.trim() || "Critic";
  const reviewer = deps.db.getUserByName(reviewerName);
  if (!reviewer) return { skipped: `no reviewer account "${reviewerName}"` };
  const tasks = deps.db.listTasks({ groupId: project.group_id, limit: 500 });
  const open = tasks.find(
    (t) =>
      t.title.startsWith(WORK_PULSE_TITLE_PREFIX) &&
      t.status !== "completed" &&
      t.status !== "cancelled",
  );
  if (open) return { skipped: `pulse task #${open.id} is still open` };
  const poolName = env.MARINA_WORK_PULSE_POOL?.trim() || "guide";
  const pool = deps.db.getMemoryPool(poolName);
  if (!pool) return { skipped: `no pool "${poolName}"` };
  const notes = deps.db.getPoolNotes(pool.id, 500);
  const report = auditKnowledgeNotes(notes, {
    ...(deps.vocabulary ?? {}),
    maxAgeMs: WORK_PULSE_STALE_MS,
  });
  const byKind: Record<KnowledgeHygieneFinding["kind"], KnowledgeHygieneFinding[]> = {
    "stale-command": report.staleCommands,
    duplicate: report.duplicateGroups,
    "unsupported-claim": report.unsupportedClaims,
    overlong: report.overlong,
    stale: report.stale,
  };
  const worked = new Set(
    tasks.flatMap((t) => (t.description ?? "").match(/\[work-pulse [^\]]+\]/g) ?? []),
  );
  const finding = PRIORITY.flatMap((k) => byKind[k]).find((f) => !worked.has(workPulseMarker(f)));
  if (!finding) return { skipped: `no new finding in pool "${poolName}"` };
  const what = WHAT_TO_DO[finding.kind];
  const noteList = finding.noteIds.map((n) => `#${n}`).join(", ");
  const description = [
    `Pool "${poolName}", note${finding.noteIds.length === 1 ? "" : "s"} ${noteList}: ${finding.detail}`,
    what.ask,
    `Read the note with \`pool ${poolName} show ${finding.noteIds[0]}\`; submit with the corrected note id(s) as evidence (\`task submit <id> <what you changed and why>\`). ${reviewerName} reviews.`,
    workPulseMarker(finding),
  ].join("\n\n");
  const task = new TaskManager(deps.db as MarinaDB).create({
    title: `${WORK_PULSE_TITLE_PREFIX} ${what.title} (${noteList})`,
    description,
    creatorId: reviewer.id,
    creatorName: reviewerName,
    groupId: project.group_id,
    validationMode: "single",
    standing: 1,
  });
  const worker = env.MARINA_WORK_PULSE_WORKER?.trim() || "Builder";
  deps.announce?.(
    `@${worker} Work pulse task #${task.id} is open: ${what.title} (${noteList}). Claim it with \`task claim ${task.id}\`, submit the corrected note as evidence; ${reviewerName} reviews.`,
  );
  return { opened: { id: task.id, title: task.title, kind: finding.kind } };
}
