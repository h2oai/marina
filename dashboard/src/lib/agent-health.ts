/**
 * Liveness classification for an agent, so the roster can show alive-but-idle
 * vs stuck vs dead at a glance. PURE OBSERVABILITY — derived from status the
 * agent already reports (last activity, silent-turn count, error/run state). It
 * does NOT change agent behavior: an idle agent is consolidating memory (its
 * autonomous cognitive life), which is healthy, not broken.
 */
export type AgentHealth = "active" | "idle" | "stuck" | "dead";

/** Mirrors the adapter's SILENT_TURN_BACKOFF_THRESHOLD — past this the model is
 *  returning prose with no tool calls (the circuit-breaker has tripped). */
const SILENT_STUCK_THRESHOLD = 6;
/** Acted within this window → "active"; otherwise "idle" (quietly consolidating). */
const ACTIVE_WINDOW_MS = 30_000;

interface HealthInput {
  state: string;
  lastActivity?: number;
  silentTurns?: number;
}

export function agentHealth(
  status: HealthInput,
  opts?: { thinking?: boolean; now?: number },
): AgentHealth {
  if (status.state === "stopped") return "dead";
  // Stuck: surfaced error state, or the model is returning no tool calls.
  if (status.state === "error" || (status.silentTurns ?? 0) >= SILENT_STUCK_THRESHOLD) {
    return "stuck";
  }
  if (opts?.thinking) return "active"; // mid-turn right now
  const now = opts?.now ?? Date.now();
  if (status.lastActivity && now - status.lastActivity <= ACTIVE_WINDOW_MS) return "active";
  return "idle"; // alive, between actions (e.g. consolidating)
}

export const HEALTH_META: Record<AgentHealth, { color: string; label: string }> = {
  active: { color: "#22c55e", label: "active" },
  idle: { color: "var(--color-warning)", label: "idle" }, // amber = quiet, not broken
  stuck: { color: "#ef4444", label: "stuck" },
  dead: { color: "var(--color-text-dim)", label: "stopped" },
};

/** Compact relative duration: "8s", "3m", "2h", "4d". */
export function formatSince(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One-line tooltip: "active · acted 4s ago · ~12s/turn · 0 silent". */
export function agentHealthTooltip(
  status: { lastActivity?: number; avgTurnMs?: number; silentTurns?: number },
  health: AgentHealth,
  now: number = Date.now(),
): string {
  const parts: string[] = [HEALTH_META[health].label];
  if (status.lastActivity) parts.push(`acted ${formatSince(now - status.lastActivity)} ago`);
  if (status.avgTurnMs && status.avgTurnMs > 0)
    parts.push(`~${formatSince(status.avgTurnMs)}/turn`);
  if (status.silentTurns && status.silentTurns > 0) parts.push(`${status.silentTurns} silent`);
  return parts.join(" · ");
}
