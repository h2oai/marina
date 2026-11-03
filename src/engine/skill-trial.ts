// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `skill trial <id>` — the validation run a derived skill needs before it is
 * served (agent-swarm's `scriptify` with a positive and a negative control):
 * two trial agents on the same role and benchmark, the CANDIDATE carrying the
 * skill as one extra guideline and the INCUMBENT without it, through the
 * `evolve trial` scaffold (`evolution-trial.ts`). A win — the candidate's
 * interval on the difference above zero — promotes a draft (`skill-promotion.ts`,
 * verifier `skill:trial`); anything else leaves it a draft and says why. The
 * candidate's role exists only for the run. Child or parallel world only,
 * like every trial.
 */

import { isSkillDraft } from "../memory/skill-draft";
import { promoteSkill } from "../memory/skill-promotion";
import type { MarinaDB } from "../persistence/database";
import { parseRoleLoop, type RoleRow } from "../persistence/db-agents";
import { TRIAL_OWNER } from "./commands/evolve";
import { armBreakdown, runTrial, type TrialDeps, type TrialResult } from "./evolution-trial";

export const SKILL_TRIAL_VERIFIER = "skill:trial";
export const SKILL_TRIAL_NOTE_TYPE = "skill_trial";

export type SkillTrialVerdict = "wins" | "no change" | "loses" | "incomplete";

export interface SkillTrialSpec {
  skillId: number;
  entityName: string;
  /** The role both arms run on; the candidate gets the skill added. */
  incumbentRole: string;
  createdBy: string;
  benchmark: string;
  timeoutMs: number;
}

export interface SkillTrialResult {
  skillId: number;
  role: string;
  benchmark: string;
  trial: TrialResult;
  verdict: SkillTrialVerdict;
  /** The servable skill's id when a draft was promoted. */
  promoted?: number;
  at: number;
}

function list(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return raw ? raw.split("\n").filter(Boolean) : [];
  }
}

export const skillTrialRoleName = (skillId: number) => `skill-trial-${skillId}`;

/** The candidate arm's role: the incumbent, plus the skill as one guideline. */
export function createSkillTrialRole(
  db: MarinaDB,
  skillId: number,
  content: string,
  incumbent: RoleRow,
  createdBy: string,
): string {
  const name = skillTrialRoleName(skillId);
  db.saveRole({
    name,
    description: `${incumbent.description} (trial of skill #${skillId})`,
    traits: list(incumbent.traits),
    guidelines: [...list(incumbent.guidelines), `A skill of yours, for when it fits: ${content}`],
    focus: list(incumbent.focus),
    tone: incumbent.tone,
    origin: "skill-trial",
    loop: parseRoleLoop(incumbent.loop),
    createdBy,
  });
  return name;
}

export function skillTrialVerdict(trial: TrialResult): SkillTrialVerdict {
  if (!trial.deltaCi) return "incomplete";
  if (trial.deltaCi[0] > 0) return "wins";
  if (trial.deltaCi[1] < 0) return "loses";
  return "no change";
}

export async function runSkillTrial(
  db: MarinaDB,
  deps: TrialDeps,
  spec: SkillTrialSpec,
): Promise<SkillTrialResult> {
  const note = db.getNote(spec.skillId);
  if (!note || note.entity_name !== spec.entityName || note.note_type !== "skill")
    throw new Error(`skill #${spec.skillId} is not ${spec.entityName}'s`);
  const incumbent = db.getRole(spec.incumbentRole);
  if (!incumbent) throw new Error(`role "${spec.incumbentRole}" does not exist in this world`);
  const role = createSkillTrialRole(db, spec.skillId, note.content, incumbent, spec.createdBy);
  let trial: TrialResult;
  try {
    trial = await runTrial(deps, {
      runId: spec.skillId,
      tag: `skill${spec.skillId}`,
      timeoutMs: spec.timeoutMs,
      arms: [
        { label: "candidate", role },
        { label: "incumbent", role: spec.incumbentRole },
      ],
    });
  } finally {
    db.deleteRole(role);
  }
  const verdict = skillTrialVerdict(trial);
  const at = Date.now();
  let promoted: number | undefined;
  if (verdict === "wins" && isSkillDraft(note.content)) {
    const delta = trial.delta ?? 0;
    promoted = promoteSkill(
      db,
      spec.entityName,
      spec.skillId,
      SKILL_TRIAL_VERIFIER,
      `skill trial on ${spec.benchmark}: candidate ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} points, interval [${trial.deltaCi!.map((x) => x.toFixed(3)).join(", ")}]`,
    )?.id;
  }
  const result: SkillTrialResult = {
    skillId: spec.skillId,
    role: spec.incumbentRole,
    benchmark: spec.benchmark,
    trial,
    verdict,
    ...(promoted !== undefined ? { promoted } : {}),
    at,
  };
  // Kept, not only sent: a trial started over `world run` outlives the bridge's connection.
  db.createNote(
    TRIAL_OWNER,
    `[skill-trial #${spec.skillId}] ${JSON.stringify({ ...result, entity: spec.entityName })}`,
    undefined,
    { noteType: SKILL_TRIAL_NOTE_TYPE, tier: "process", skipDedup: true },
  );
  return result;
}

/** The latest stored result of a skill's trial, if any. */
export function storedSkillTrial(
  db: MarinaDB,
  entityName: string,
  skillId: number,
): (SkillTrialResult & { entity: string }) | undefined {
  const tag = `[skill-trial #${skillId}] `;
  for (const note of db.getNotesByType(TRIAL_OWNER, SKILL_TRIAL_NOTE_TYPE, 500)) {
    if (!note.content.startsWith(tag)) continue;
    try {
      const parsed = JSON.parse(note.content.slice(tag.length)) as SkillTrialResult & {
        entity: string;
      };
      if (parsed.entity === entityName) return parsed;
    } catch {
      // allow-empty-catch: a malformed stored result is skipped; the next one may parse
    }
  }
  return undefined;
}

export function renderSkillTrial(r: SkillTrialResult): string {
  const arm = (label: "candidate" | "incumbent") => {
    const a = r.trial.arms.find((x) => x.label === label);
    if (!a) return `  ${label}: not run`;
    const b = armBreakdown(a);
    const score = a.score !== undefined ? `${(a.score * 100).toFixed(1)}%` : (a.error ?? a.status);
    return `  ${label.padEnd(9)} ${score}${b ? ` (${b.answered}/${b.total} answered)` : ""}${a.runId ? ` · run ${a.runId}` : ""}`;
  };
  const lines = [
    `Skill trial #${r.skillId} on ${r.benchmark} (role ${r.role}): ${r.verdict}`,
    arm("candidate"),
    arm("incumbent"),
  ];
  if (r.trial.deltaCi)
    lines.push(
      `  difference ${((r.trial.delta ?? 0) * 100).toFixed(1)} points, 95% interval [${r.trial.deltaCi.map((x) => x.toFixed(3)).join(", ")}]`,
    );
  lines.push(
    r.promoted !== undefined
      ? `  promoted: skill #${r.promoted} is now served (verifier ${SKILL_TRIAL_VERIFIER}).`
      : r.verdict === "wins"
        ? "  the skill was already servable; verification recorded."
        : "  still a draft: not served until a trial wins or a person verifies it.",
  );
  return lines.join("\n");
}
