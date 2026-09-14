// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommandDef } from "../../types";
import type { ReadinessReport, ReadinessStatus, ReadinessTrustProfile } from "../readiness";

const ICON: Record<ReadinessStatus, string> = { ok: "✓", degraded: "⚠", off: "✗" };

/** One line: `Trust profile: LOCAL — ungated · autonomy: guarded`. */
export function renderTrustProfileLine(trust: ReadinessTrustProfile): string {
  const state = trust.ungated ? "ungated" : "gates enforced";
  const why = trust.reason ? ` (${trust.reason})` : "";
  return `Trust profile: ${trust.profile.toUpperCase()} — ${state}${why} · autonomy: ${trust.autonomy}`;
}

/**
 * `readiness` (aliases `doctor`, `health`) — operator-facing capability health.
 * Reports each Marina capability as ok / degraded / off with a concrete fix.
 * (`status` is taken by `orient` for an agent's own cognitive status.)
 * Reads config presence only (never secret values), so it's safe at rank 0.
 */
export function readinessCommand(deps: { readiness: () => ReadinessReport }): CommandDef {
  return {
    name: "readiness",
    aliases: ["doctor", "health"],
    help: "Show which Marina capabilities are active, degraded, or off — with fixes.",
    handler: (ctx, input) => {
      const report = deps.readiness();
      const counts = { ok: 0, degraded: 0, off: 0 };
      for (const c of report.checks) counts[c.status]++;

      const lines: string[] = [];
      lines.push(`Marina readiness — ${report.instanceName} · world: ${report.world}`);
      lines.push(renderTrustProfileLine(report.trustProfile));
      lines.push(`${counts.ok} ok · ${counts.degraded} degraded · ${counts.off} off`);
      lines.push("");
      for (const c of report.checks) {
        lines.push(`  ${ICON[c.status]} ${c.label} — ${c.detail}`);
        if (c.status !== "ok" && c.remediation) lines.push(`      → ${c.remediation}`);
      }
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
