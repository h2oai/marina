// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `admin decisions …` — runtime decision settings from the console and the
 * `marina` CLI (`marina -c "admin decisions set gate on"`). The `admin`
 * command's router gate (rank 5 + `admin.destructive`) applies; on top of it
 * an agent-driven entity is refused (see `src/decisions/settings.ts`).
 */

import {
  changeDecisionSetting,
  DECISION_SETTINGS,
  DecisionSettingError,
  decisionSettingsHistory,
  describeDecisionSettings,
  isAgentDriven,
} from "../../decisions/settings";
import type { MarinaDB } from "../../persistence/database";
import type { Connection, Entity } from "../../types";

export const ADMIN_DECISIONS_USAGE = [
  "admin decisions                      — every decision setting, its value and where it comes from",
  "admin decisions set <setting> <value> — change one at runtime (not if the environment sets it)",
  "admin decisions unset <setting>       — back to the built-in default",
  "admin decisions history               — who changed what, when",
].join("\n");

export function adminDecisions(
  deps: { db: MarinaDB; getConnections: () => Map<string, Connection> },
  entity: Entity,
  tokens: string[],
): string {
  const sub = (tokens[0] ?? "show").toLowerCase();
  if (sub === "show" || sub === "list" || sub === "ls") return render(deps.db);
  if (sub === "history") {
    const h = decisionSettingsHistory(deps.db);
    if (h.length === 0) return "No runtime decision setting has been changed.";
    return h
      .slice(0, 20)
      .map(
        (c) => `${c.at}  ${c.by}  ${c.setting}: ${c.from ?? "(default)"} → ${c.to ?? "(default)"}`,
      )
      .join("\n");
  }
  if (sub !== "set" && sub !== "unset") return `Usage:\n${ADMIN_DECISIONS_USAGE}`;
  const internal = [...deps.getConnections().values()].some(
    (c) => c.entity === entity.id && c.internal,
  );
  if (
    isAgentDriven({
      internalConnection: internal,
      hasAgentConfig: !!deps.db.getAgentConfig(entity.name),
    })
  ) {
    return "Refused: an agent never changes the decision settings that supervise it. A person (the operator) must.";
  }
  const name = tokens[1];
  if (!name) return `Usage:\n${ADMIN_DECISIONS_USAGE}`;
  const value = sub === "set" ? tokens.slice(2).join(" ").trim() : null;
  if (sub === "set" && !value) return `Usage: admin decisions set ${name} <value>`;
  try {
    const v = changeDecisionSetting(deps.db, name, value, entity.name);
    return `${v.name} (${v.env}) = ${v.value ?? "(default)"} — takes effect on the next decision.`;
  } catch (err) {
    if (err instanceof DecisionSettingError) return err.message;
    throw err;
  }
}

function render(db: MarinaDB): string {
  const rows = describeDecisionSettings(db);
  const width = Math.max(...DECISION_SETTINGS.map((s) => s.name.length));
  return [
    "Decision settings (env wins: a value set in the environment is locked):",
    ...rows.map((r) => {
      const where = r.locked ? "env, locked" : r.source;
      return `  ${r.name.padEnd(width)}  ${(r.value ?? "(default)").padEnd(24)}  [${where}]  ${r.describe}`;
    }),
    "Base URLs, paths and API keys are never set at runtime (environment / Admin → Keys).",
    `Change: admin decisions set <setting> <value> · unset <setting> · history`,
  ].join("\n");
}
