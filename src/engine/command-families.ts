// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Command families: one head command that names every member as a verb.
 * `memory recall <q>` runs the `recall` builtin — same handler, rank, gate,
 * evidence-fence row, effects and output. The member's bare name keeps
 * working as an ANNOUNCED alias: the command phase appends one terse
 * `(alias: …)` line, once per session per alias. Discovery lists members
 * under their head, never as separate top-level commands.
 *
 * Only commands whose semantics are the head's belong here. `pool` (shared
 * institutional memory), `skill` (packages), `orient` (the session-start
 * dashboard) and `bookmark` (room locations) stay distinct. A head whose
 * first argument is free text (`ask <question>`, `forecast <question>`,
 * `pool <name> …`) takes no members: a member verb would capture that text.
 * A member name becomes a reserved first word for its head (a project named
 * `plan` is reached as `project info plan`).
 */
export const COMMAND_FAMILIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  memory: Object.freeze(["note", "recall", "reflect", "recap", "debrief", "context"]),
  // Every way to start a project: `project research <goal>`, `project usecase …`.
  project: Object.freeze([
    "research",
    "debate",
    "solve",
    "explore",
    "plan",
    "monitor",
    "usecase",
    "pattern",
  ]),
  // Readouts of Marina's record of results and of its judges.
  outcome: Object.freeze(["competence", "lessons", "judge", "arbiter", "productivity"]),
  // What this server runs, what is off and why.
  readiness: Object.freeze(["posture", "methods", "uptime"]),
  // Worlds and their lineage records.
  world: Object.freeze([
    "genome",
    "marina-descend",
    "mesh",
    "association",
    "reproduce",
    "intellect",
    "mutation",
    "economy",
    "lab",
  ]),
  position: Object.freeze(["bankroll"]),
  watch: Object.freeze(["probe"]),
  shell: Object.freeze(["run"]),
  role: Object.freeze(["trait", "system-prompt"]),
  crew: Object.freeze(["recruit"]),
});

const MEMBER_HEAD = new Map<string, string>(
  Object.entries(COMMAND_FAMILIES).flatMap(([head, members]) =>
    members.map((member) => [member, head] as const),
  ),
);

/** The family head a builtin belongs to (`recall` ⇒ `memory`), else undefined. */
export function familyOf(name: string): string | undefined {
  return MEMBER_HEAD.get(name);
}

/** The member a `<head> <verb>` pair names, else undefined. Case-insensitive. */
export function familyMember(head: string, verb: string | undefined): string | undefined {
  const sub = verb?.toLowerCase();
  return sub && MEMBER_HEAD.get(sub) === head.toLowerCase() ? sub : undefined;
}

/**
 * `memory recall x` ⇒ `recall x`; any other text unchanged. Text-level
 * classifiers (tool risk, result trust) read a family form as its member.
 */
export function unfoldFamily(raw: string): string {
  const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(raw.trim());
  if (!match) return raw;
  const member = familyMember(match[1]!, match[2]);
  if (!member) return raw;
  return match[3] ? `${member} ${match[3]}` : member;
}

/** The terse trailing line a bare alias carries. */
export function aliasNotice(name: string): string | undefined {
  const head = familyOf(name);
  return head ? `(alias: use \`${head} ${name} …\`)` : undefined;
}
