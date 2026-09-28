// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime decision settings from the console, the `marina` CLI and agents'
 * own tools — one runner behind two commands:
 *
 *   `admin decisions …`     people with the admin command's gate (rank 5 +
 *                           admin.destructive), unchanged;
 *   `decision settings …`   anyone may read; changing a setting needs
 *                           admin.destructive or `decisions.configure` for a
 *                           person, and `decisions.configure` for an AGENT —
 *                           earned (standing + witnessed demonstrations, never
 *                           self-witnessed), granted, or passed by the
 *                           operator's posture (`MARINA_AUTONOMY=open`).
 *
 * Supervision is a default an agent can outgrow by earning trust, not a fence
 * it can never cross (see src/decisions/settings.ts). Environment-locked
 * settings and env-only base URLs / keys stay out of reach for everyone.
 */

import {
  authorizeSettingsWrite,
  changeDecisionSetting,
  DECISION_SETTINGS,
  DecisionSettingError,
  decisionSettingsHistory,
  describeDecisionSettings,
  isAgentDriven,
} from "../../decisions/settings";
import type { MarinaDB } from "../../persistence/database";
import type { Entity } from "../../types";
import { checkGateForExecution, recordGateExecution } from "../safety-gates";

export const DECISION_SETTINGS_USAGE = [
  "decision settings                       — every decision setting, its value and where it comes from",
  "decision settings set <setting> <value>  — change one (admin.destructive, or the earned decisions.configure gate)",
  "decision settings unset <setting>        — back to the built-in default",
  "decision settings history                — who changed what, when",
].join("\n");

export interface DecisionSettingsDeps {
  db: MarinaDB;
  /** Is this entity's connection internal (a room / crew / runtime agent, a workload credential)? */
  isInternal: (entityId: string) => boolean;
}

/** An agent-driven entity: internal connection or a spawned agent's config. */
export function agentDrivenEntity(deps: DecisionSettingsDeps, entity: Entity): boolean {
  return isAgentDriven({
    internalConnection: deps.isInternal(entity.id),
    hasAgentConfig: !!deps.db.getAgentConfig(entity.name),
  });
}

/**
 * Show, change or list decision settings. `personAuthorized`: the caller came
 * through a surface that already required admin.destructive of a person (the
 * `admin` command's router gate), so a person needs no second check there;
 * an agent is always checked here.
 */
export function runDecisionSettings(
  deps: DecisionSettingsDeps,
  entity: Entity,
  tokens: string[],
  opts: { personAuthorized: boolean; usage: string },
): string {
  const sub = (tokens[0] ?? "show").toLowerCase();
  if (sub === "show" || sub === "list" || sub === "ls") return render(deps.db, opts.usage);
  if (sub === "history") {
    const h = decisionSettingsHistory(deps.db);
    if (h.length === 0) return "No runtime decision setting has been changed.";
    return h
      .slice(0, 20)
      .map(
        (c) =>
          `${c.at}  ${c.by}${c.agent ? " (agent)" : ""}  ${c.setting}: ${c.from ?? "(default)"} → ${c.to ?? "(default)"}`,
      )
      .join("\n");
  }
  if (sub !== "set" && sub !== "unset") return `Usage:\n${opts.usage}`;
  const name = tokens[1];
  if (!name) return `Usage:\n${opts.usage}`;
  const value = sub === "set" ? tokens.slice(2).join(" ").trim() : null;
  if (sub === "set" && !value) return `Usage: … set ${name} <value>`;

  const agent = agentDrivenEntity(deps, entity);
  if (agent || !opts.personAuthorized) {
    const auth = authorizeSettingsWrite(
      {
        check: (id, gate) => checkGateForExecution(deps.db, id, gate),
        record: (id, gate, result, evidence) =>
          recordGateExecution(deps.db, id, gate, result, evidence),
      },
      entity.id,
      agent,
    );
    if (!auth.ok) return auth.reason;
  }
  try {
    const v = changeDecisionSetting(deps.db, name, value, entity.name, { agent });
    return `${v.name} (${v.env}) = ${v.value ?? "(default)"} — takes effect on the next decision.`;
  } catch (err) {
    if (err instanceof DecisionSettingError) return err.message;
    throw err;
  }
}

/** `admin decisions …` (the `admin` command's gate already applies to people). */
export function adminDecisions(
  deps: DecisionSettingsDeps,
  entity: Entity,
  tokens: string[],
): string {
  return runDecisionSettings(deps, entity, tokens, {
    personAuthorized: true,
    usage: DECISION_SETTINGS_USAGE.replaceAll("decision settings", "admin decisions"),
  });
}

function render(db: MarinaDB, usage: string): string {
  const rows = describeDecisionSettings(db);
  const width = Math.max(...DECISION_SETTINGS.map((s) => s.name.length));
  const verb = usage.startsWith("admin") ? "admin decisions" : "decision settings";
  return [
    "Decision settings (env wins: a value set in the environment is locked):",
    ...rows.map((r) => {
      const where = r.locked ? "env, locked" : r.source;
      return `  ${r.name.padEnd(width)}  ${(r.value ?? "(default)").padEnd(24)}  [${where}]  ${r.describe}`;
    }),
    "Base URLs, paths and API keys are never set at runtime (environment / Admin → Keys).",
    `Change: ${verb} set <setting> <value> · unset <setting> · history`,
  ].join("\n");
}
