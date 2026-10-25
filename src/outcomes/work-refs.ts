// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Evidence tags for WORK outcomes — task verdicts, judged task grades, Code
 * Mode checks and requests reported to `POST /v1/outcomes` — in the same
 * `family:` / `method:` convention the arena (`src/arena/settle.ts`),
 * benchmark runs (`./benchmark.ts`) and forecasts (`src/forecast/routing-refs.ts`)
 * use, so one competence map and one evidence reader cover all of them.
 *
 *   family:work:<kind>              the kind of work (task, code, request,
 *                                   research, project)
 *   family:work:<kind>:role:<role>  the same, for the role the worker played
 *   method:model:<model>            the model that did it (an agent's configured
 *                                   model, or the model that served a request);
 *                                   a person's own work carries no model method
 *   method:<dimension>:<value>      how it was done, one tag per dimension
 *                                   (`approach`): e.g. `crew:<formation>` or
 *                                   `solo` for a task, `driver:<harness>`,
 *                                   `runner:<local|container|…>` and
 *                                   `verify:<mode>` for a Code Mode check,
 *                                   `orchestration:<pattern>` for a project,
 *                                   `pattern:<name>` for a pattern run and
 *                                   `room-formation:<formation>` for a room
 *                                   round (`./orchestration.ts`) — so
 *                                   the competence map can say which ways of
 *                                   working succeed at which kinds of work
 *   scope:shared | scope:owner:<o>  whose evidence it is (`workScopeFor`): only
 *                                   `shared` work — owner-less world agents —
 *                                   is pooled into shared evidence; a person's
 *                                   work, and anything their agents did, stays
 *                                   in that person's own view. `scope:unscoped`
 *                                   (no principal found) is never pooled.
 *
 * Labels and ids only — never task text, submissions or command output.
 */

import { type ScopeReader, workScopeFor } from "../learning/work";

const SAFE = /^[A-Za-z0-9:._/+@-]{1,120}$/;

export type WorkKind = "task" | "code" | "request" | "research" | "project";

/** A row's evidence scope from its refs: `shared`, `owner:<name>`, `unscoped`, or undefined (untagged). */
export function scopeOf(refs: readonly string[]): string | undefined {
  return refs.find((r) => r.startsWith("scope:"))?.slice(6);
}

/**
 * Whether a row may be pooled into SHARED evidence: tagged `scope:shared`, or
 * untagged (producers that predate scoping, and boards — arena rounds,
 * benchmark runs, forecasts — whose evidence was always shared). A row tagged
 * with an owner, or unscoped, is not.
 */
export function sharedEvidence(refs: readonly string[]): boolean {
  const s = scopeOf(refs);
  return s === undefined || s === "shared";
}

/** Whether a row is visible in `viewer`'s own view: shared, or that viewer's own work. */
export function visibleTo(refs: readonly string[], viewer: string | undefined): boolean {
  if (sharedEvidence(refs)) return true;
  return viewer !== undefined && scopeOf(refs) === `owner:${viewer}`;
}

/** The scope ref for `actor`'s work; `scope:unscoped` when it cannot be placed. */
export function scopeRef(db: ScopeReader | undefined, actor: string | undefined): string {
  if (!db || !actor) return "scope:unscoped";
  let scope: ReturnType<typeof workScopeFor>;
  try {
    scope = workScopeFor(db, actor);
  } catch {
    return "scope:unscoped";
  }
  if (!scope) return "scope:unscoped";
  if (scope.kind === "shared") return "scope:shared";
  return SAFE.test(scope.owner) ? `scope:owner:${scope.owner}` : "scope:unscoped";
}

/** `family:` / `method:` / `scope:` refs for one piece of work. */
export function workRefs(
  db: ScopeReader | undefined,
  input: {
    kind: WorkKind;
    actor?: string;
    model?: string;
    role?: string;
    /** How the work was done, one `<dimension>:<value>` per dimension (see the module comment). */
    approach?: readonly string[];
  },
): string[] {
  const refs = [`family:work:${input.kind}`];
  if (input.role && SAFE.test(input.role))
    refs.push(`family:work:${input.kind}:role:${input.role}`);
  if (input.model && SAFE.test(input.model)) refs.push(`method:model:${input.model}`);
  for (const a of input.approach ?? [])
    if (SAFE.test(a) && !a.startsWith("model:")) refs.push(`method:${a}`);
  refs.push(scopeRef(db, input.actor));
  return refs;
}

/** True when `db` can place an actor (the principal reads `workScopeFor` needs). */
export function canScope(db: unknown): db is ScopeReader {
  const d = db as Partial<Record<keyof ScopeReader, unknown>> | undefined;
  return (
    !!d &&
    typeof d.getPrincipal === "function" &&
    typeof d.listPrincipals === "function" &&
    typeof d.getUserByName === "function"
  );
}
