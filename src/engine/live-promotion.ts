// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live-evidence promotion: real work can move a role's default model.
 *
 * The slot is `role-model:<role>` (`src/config/model-tiers.ts` reads it
 * between the role's env settings and its tier). Its evidence is the one
 * outcome path: mechanical outcomes tagged `family:work:<kind>:role:<role>`
 * and exactly one `method:model:<m>`, SHARED scope only (`sharedEvidence`: a
 * person's work, and their agents', never moves a world default), never a
 * measurement run. Every kind of work a role does is pooled for its slot.
 *
 * The rule is the benchmark promotion rule on live outcomes, not a new one:
 *
 *   split     a time split over the role's outcomes: the older half is
 *             discovery, the newer half holdout (as arena signal discovery).
 *   earned    on the HOLDOUT the candidate beats the incumbent (the model the
 *             role resolves to now) with the 95 % Agresti–Caffo interval on
 *             the difference above 0 (`differenceInterval`, `src/stats`) and
 *             the difference past `promotionMargin(tried)`; it does not lose
 *             on discovery; every arm in both splits has at least
 *             `LIVE_PROMOTION_MIN_PER_ARM` outcomes.
 *   fishing   `tried` counts every candidate ever recorded for the slot
 *             (`attemptsBefore`), plus the other candidates the same pass
 *             compared — so reading the report repeatedly never lowers the bar.
 *
 * Nothing here files a promotion. The hourly-ish pass (`runLivePromotionPass`,
 * tick job `live-promotion`) records a refused attempt once per evidence
 * state (append-only `benchmark_promotions`) and raises ONE ops-inbox
 * proposal for a candidate that passes, never twice for the same incumbent
 * and candidate. A PERSON holding `role.edit` files it with
 * `benchmark promote role-model:<role> <model>`, which re-evaluates and calls
 * `fileSlotPromotion` — the one write path. Agents never file one.
 */

import {
  MODEL_ROLES,
  type ModelChoice,
  type ModelRole,
  modelCallable,
  roleModel,
  roleModelSlotKey,
} from "../config/model-tiers";
import { outcomeRefs } from "../forecast/routing-refs";
import { sharedEvidence } from "../outcomes/work-refs";
import type { MarinaDB } from "../persistence/database";
import type { OutcomeRow } from "../persistence/db-outcomes";
import { differenceInterval } from "../stats";
import { attemptsBefore, recordLiveRefusal } from "./benchmark-promotion";
import { getErrorMessage } from "./errors";
import { promotionMargin } from "./fishing-margin";
import { Logger } from "./logger";

const logger = new Logger();

/** Fewest outcomes per arm in EACH split (discovery and holdout) before a slot is judged. */
export const LIVE_PROMOTION_MIN_PER_ARM = 20;
/** The newest share of a role's outcomes that forms its holdout. */
export const LIVE_HOLDOUT_FRACTION = 0.5;
/** How many outcomes one pass reads (newest first). */
const LIVE_EVIDENCE_LIMIT = 10_000;
/** The ops-inbox category of a live promotion proposal. */
export const LIVE_PROPOSAL_CATEGORY = "promotion";

/** The `challenger_run_id` a live attempt records: one id per candidate model. */
export function liveChallengerId(model: string): string {
  return `live:${model}`;
}

/** The proposal's ops-inbox key: one per (slot, incumbent, candidate). */
export function liveProposalKey(slot: string, incumbent: string, candidate: string): string {
  return `${LIVE_PROPOSAL_CATEGORY}:${slot}:${incumbent}>${candidate}`;
}

export interface ArmCount {
  n: number;
  successes: number;
  rate: number;
}

export type LiveCandidateStatus =
  | "eligible"
  | "refused"
  | "too-little-data"
  | "not-callable"
  | "env-set";

export interface LiveCandidate {
  slot: string;
  role: string;
  candidate: string;
  incumbent: string;
  discovery: { candidate: ArmCount; incumbent: ArmCount };
  holdout: { candidate: ArmCount; incumbent: ArmCount };
  /** Holdout rate difference, candidate − incumbent. */
  delta: number;
  /** 95 % Agresti–Caffo interval on `delta`. */
  ci: [number, number];
  margin: number;
  /** Distinct candidates recorded for the slot before (this one excluded) plus peers. */
  triedBefore: number;
  status: LiveCandidateStatus;
  reasons: string[];
  /** Who did the work the evidence rests on (outcome owners), for self-attestation. */
  producers: string[];
  /** The evidence state: incumbent and the four arm counts. One refusal per state. */
  fingerprint: string;
}

export interface LiveSlotReport {
  role: string;
  slot: string;
  /** What the role resolves to now, and where from. */
  incumbent: ModelChoice;
  /** Where the incumbent came from: an env setting, a promoted slot, or the tier. */
  layer: "env" | "promoted" | "tier";
  outcomes: number;
  candidates: LiveCandidate[];
}

interface LiveRow {
  id: number;
  model: string;
  succeeded: 0 | 1;
  resolvedAt: number;
  owner: string | null;
}

type LiveStore = Pick<
  MarinaDB,
  "listOutcomes" | "getBenchmarkDefault" | "listBenchmarkPromotions" | "getSetting"
> &
  Partial<Pick<MarinaDB, "getBenchmarkRun" | "latestUpstreamDefaultSeed">>;

const ROLE_REF = /^family:work:[^:]+:role:(.+)$/;

/** The role outcome rows shared live evidence can promote on, by role. */
function rowsByRole(rows: readonly OutcomeRow[]): Map<string, LiveRow[]> {
  const out = new Map<string, LiveRow[]>();
  for (const o of rows) {
    if (o.eval_mode === "measure" || o.basis !== "mechanical") continue;
    const refs = outcomeRefs(o.refs_json);
    if (!sharedEvidence(refs)) continue;
    const models = refs.filter((r) => r.startsWith("method:model:")).map((r) => r.slice(13));
    if (models.length !== 1) continue;
    const roles = new Set<string>();
    for (const r of refs) {
      const m = ROLE_REF.exec(r);
      if (m?.[1]) roles.add(m[1]);
    }
    for (const role of roles) {
      const list = out.get(role) ?? [];
      list.push({
        id: o.id,
        model: models[0]!,
        succeeded: o.succeeded,
        resolvedAt: o.resolved_at,
        owner: o.owner,
      });
      out.set(role, list);
    }
  }
  return out;
}

/**
 * What `role` resolves to now, the way its consumers resolve it: a model role
 * (`judge`, `crew`, …) through `roleModel` with every pre-existing knob read
 * as env; any other (work) role as an agent spawned for it with no model.
 */
export function currentRoleModel(
  db: LiveStore,
  role: string,
  env: Record<string, string | undefined> = process.env,
): { choice: ModelChoice; layer: LiveSlotReport["layer"] } {
  const runtimeDefault = safe(() => db.getSetting("default_model"));
  const known = Object.hasOwn(MODEL_ROLES, role) ? (role as ModelRole) : undefined;
  const knob = known ? MODEL_ROLES[known].knobs.find((k) => env[k]?.trim()) : undefined;
  const choice = known
    ? roleModel(known, {
        env,
        slots: db,
        ...(knob ? { knob: { name: knob, value: env[knob] } } : {}),
        ...(known === "resident" && runtimeDefault ? { runtimeDefault } : {}),
      })
    : roleModel("resident", {
        env,
        slots: db,
        workRole: role,
        ...(runtimeDefault ? { runtimeDefault } : {}),
      });
  const layer = choice.source.startsWith("promoted ")
    ? "promoted"
    : choice.source.startsWith("tier:")
      ? "tier"
      : "env";
  return { choice, layer };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined; // allow-empty-catch: an optional lookup that cannot answer reads as unset
  }
}

function arm(rows: readonly LiveRow[], model: string): ArmCount {
  let n = 0;
  let successes = 0;
  for (const r of rows) {
    if (r.model !== model) continue;
    n++;
    successes += r.succeeded;
  }
  return { n, successes, rate: n ? successes / n : 0 };
}

const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;

/**
 * Judge every candidate of every role slot the shared live evidence names —
 * READ-ONLY: nothing is recorded and nothing is filed.
 */
export function evaluateLiveSlots(
  db: LiveStore,
  opts: {
    env?: Record<string, string | undefined>;
    /** Only this role (or slot `role-model:<role>`). */
    role?: string;
    minPerArm?: number;
  } = {},
): LiveSlotReport[] {
  const env = opts.env ?? process.env;
  const minPerArm = Math.max(1, opts.minPerArm ?? LIVE_PROMOTION_MIN_PER_ARM);
  const rows = db.listOutcomes({ basis: "mechanical", limit: LIVE_EVIDENCE_LIMIT });
  const reports: LiveSlotReport[] = [];
  const wanted = opts.role?.replace(/^role-model:/, "");
  for (const [role, list] of [...rowsByRole(rows)].sort(([a], [b]) => a.localeCompare(b))) {
    const slot = roleModelSlotKey(role);
    if (wanted !== undefined && roleModelSlotKey(wanted) !== slot) continue;
    const { choice, layer } = currentRoleModel(db, role, env);
    const incumbent = choice.model;
    // The time split: the older part is discovery, the newer part holdout.
    const ordered = [...list].sort((a, b) => a.resolvedAt - b.resolvedAt || a.id - b.id);
    const cut = Math.floor(ordered.length * (1 - LIVE_HOLDOUT_FRACTION));
    const discovery = ordered.slice(0, cut);
    const holdout = ordered.slice(cut);
    const models = [...new Set(list.map((r) => r.model))].filter((m) => m !== incumbent).sort();
    const base = models.map((candidate) => {
      const d = { candidate: arm(discovery, candidate), incumbent: arm(discovery, incumbent) };
      const h = { candidate: arm(holdout, candidate), incumbent: arm(holdout, incumbent) };
      const enough = [d.candidate, d.incumbent, h.candidate, h.incumbent].every(
        (a) => a.n >= minPerArm,
      );
      return { candidate, d, h, enough };
    });
    // Every other candidate this pass compared on the holdout counts as tried.
    const compared = base.filter((b) => b.enough).length;
    const candidates: LiveCandidate[] = base.map(({ candidate, d, h, enough }) => {
      const peers = Math.max(0, compared - (enough ? 1 : 0));
      const triedBefore = attemptsBefore(db, slot, liveChallengerId(candidate)) + peers;
      const margin = promotionMargin(triedBefore);
      const delta = h.candidate.rate - h.incumbent.rate;
      const ci = differenceInterval(
        h.candidate.rate,
        h.candidate.n,
        h.incumbent.rate,
        h.incumbent.n,
      );
      const reasons: string[] = [];
      let status: LiveCandidateStatus;
      if (!modelCallable(candidate, { env })) {
        status = "not-callable";
        reasons.push(`${candidate} cannot be called on this installation (no provider key)`);
      } else if (!enough) {
        status = "too-little-data";
        reasons.push(
          `needs ≥ ${minPerArm} outcomes per arm in each split (discovery ${d.candidate.n} vs ${d.incumbent.n}, holdout ${h.candidate.n} vs ${h.incumbent.n})`,
        );
      } else {
        if (ci[0] <= 0)
          reasons.push(
            `holdout ${pts(delta)} pts, but the 95% interval starts at ${pts(ci[0])}: not distinguishable from noise`,
          );
        if (delta < margin)
          reasons.push(
            `holdout ${pts(delta)} pts is below the margin ${(margin * 100).toFixed(1)} (${triedBefore} candidate(s) tried)`,
          );
        if (d.candidate.rate < d.incumbent.rate)
          reasons.push(
            `loses on discovery (${(d.candidate.rate * 100).toFixed(1)}% vs ${(d.incumbent.rate * 100).toFixed(1)}%)`,
          );
        status = reasons.length === 0 ? (layer === "env" ? "env-set" : "eligible") : "refused";
        if (status === "env-set")
          reasons.push(
            `${choice.source} sets this role's model; a promotion would not take effect`,
          );
      }
      const producers = [
        ...new Set(
          list
            .filter((r) => r.model === candidate || r.model === incumbent)
            .map((r) => r.owner)
            .filter((o): o is string => !!o),
        ),
      ].sort();
      return {
        slot,
        role,
        candidate,
        incumbent,
        discovery: d,
        holdout: h,
        delta,
        ci,
        margin,
        triedBefore,
        status,
        reasons,
        producers,
        fingerprint: [
          incumbent,
          d.candidate.successes,
          d.candidate.n,
          d.incumbent.successes,
          d.incumbent.n,
          h.candidate.successes,
          h.candidate.n,
          h.incumbent.successes,
          h.incumbent.n,
        ].join("|"),
      };
    });
    reports.push({ role, slot, incumbent: choice, layer, outcomes: list.length, candidates });
  }
  return reports;
}

/** One line for a proposal or a readout: the holdout difference and its evidence. */
export function describeLiveCandidate(c: LiveCandidate): string {
  return `holdout ${pts(c.delta)} pts, 95% [${pts(c.ci[0])}, ${pts(c.ci[1])}], n=${c.holdout.candidate.n}/${c.holdout.incumbent.n} (discovery ${c.discovery.candidate.n}/${c.discovery.incumbent.n}), bar ${(c.margin * 100).toFixed(1)} pts`;
}

export interface LivePassSummary {
  slots: number;
  /** Candidates judged on enough data. */
  judged: number;
  /** New refused attempts recorded this pass. */
  refused: number;
  /** New proposals raised this pass. */
  proposed: number;
}

type PassStore = LiveStore &
  Pick<MarinaDB, "recordBenchmarkPromotion" | "upsertOperationalAlert" | "listOperationalAlerts">;

/**
 * The periodic pass: judge every live slot, record each NEW refused attempt
 * (once per evidence state), and raise one ops-inbox proposal per passing
 * candidate (once per incumbent and candidate, whatever happened to it).
 * Files nothing. Never throws.
 */
export function runLivePromotionPass(
  db: PassStore,
  opts: { env?: Record<string, string | undefined>; now?: number; minPerArm?: number } = {},
): LivePassSummary {
  const summary: LivePassSummary = { slots: 0, judged: 0, refused: 0, proposed: 0 };
  let reports: LiveSlotReport[];
  try {
    reports = evaluateLiveSlots(db, opts);
  } catch (err) {
    logger.warn("defaults", "live promotion pass could not read evidence", {
      error: getErrorMessage(err),
    });
    return summary;
  }
  const now = opts.now ?? Date.now();
  let known: Set<string> | undefined;
  for (const report of reports) {
    summary.slots++;
    for (const c of report.candidates) {
      try {
        if (c.status === "refused") {
          summary.judged++;
          if (recordLiveRefusal(db, c, now)) summary.refused++;
        } else if (c.status === "eligible") {
          summary.judged++;
          known ??= new Set(
            db
              .listOperationalAlerts(undefined, 100_000)
              .filter((a) => a.category === LIVE_PROPOSAL_CATEGORY)
              .map((a) => a.alert_key),
          );
          const key = liveProposalKey(c.slot, c.incumbent, c.candidate);
          if (known.has(key)) continue;
          db.upsertOperationalAlert({
            key,
            severity: "info",
            category: LIVE_PROPOSAL_CATEGORY,
            kind: "approval",
            title: `promote ${c.slot} → ${c.candidate} (holdout ${pts(c.delta)} pts, n=${c.holdout.candidate.n}/${c.holdout.incumbent.n})`,
            detail: `live work for role ${c.role}: ${c.candidate} beats the incumbent ${c.incumbent} — ${describeLiveCandidate(c)}`,
            remedy: `benchmark promote ${c.slot} ${c.candidate} (a person holding role.edit; re-checks the rule and files it) · benchmark eligible live`,
            actionLabel: "Promote",
            actionRef: `benchmark promote ${c.slot} ${c.candidate}`,
            metadata: {
              slot: c.slot,
              candidate: c.candidate,
              incumbent: c.incumbent,
              delta: c.delta,
              low: c.ci[0],
            },
          });
          known.add(key);
          summary.proposed++;
        } else if (c.status === "env-set") {
          summary.judged++;
        }
      } catch (err) {
        logger.warn("defaults", "live promotion candidate not processed", {
          slot: c.slot,
          error: getErrorMessage(err),
        });
      }
    }
  }
  if (summary.proposed > 0 || summary.refused > 0)
    logger.info(
      "defaults",
      `live promotion: ${summary.proposed} proposal(s) raised, ${summary.refused} refusal(s) recorded over ${summary.slots} slot(s)`,
    );
  return summary;
}

/** Resolve the open proposals of a slot (after it was filed). */
export function closeLiveProposals(
  db: Pick<MarinaDB, "listOperationalAlerts" | "setOperationalAlertStatus">,
  slot: string,
): void {
  for (const a of db.listOperationalAlerts(undefined, 100_000)) {
    if (a.category !== LIVE_PROPOSAL_CATEGORY || a.status === "resolved") continue;
    if (a.alert_key.startsWith(`${LIVE_PROPOSAL_CATEGORY}:${slot}:`))
      db.setOperationalAlertStatus(a.id, "resolved");
  }
}
