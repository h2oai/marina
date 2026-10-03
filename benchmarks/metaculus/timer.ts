// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * systemd user units for the bot: a oneshot service that runs one pass
 * (forecast, then resolve) and a timer that starts it every 20 minutes.
 * Written for the operator to review and enable; never enabled here.
 * Credentials come from an EnvironmentFile the operator creates (mode 0600).
 */

export interface TimerConfig {
  /** The Marina checkout the service runs in. */
  repoDir: string;
  /** Absolute path to bun. */
  bun: string;
  /** EnvironmentFile with METACULUS_TOKEN, OPENROUTER_API_KEY, DB_PATH, … */
  envFile: string;
  tournaments: Array<string | number>;
  dailyCapUsd: number;
  everyMinutes?: number;
}

export function timerUnits(c: TimerConfig): { service: string; timer: string } {
  const args = [
    "run",
    "scripts/metaculus.ts",
    "pass",
    ...c.tournaments.flatMap((t) => ["--tournament", String(t)]),
    "--daily-cap",
    String(c.dailyCapUsd),
  ];
  const service = [
    "[Unit]",
    "Description=Marina Metaculus bot (one pass: forecast open questions, learn from resolved ones)",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${c.repoDir}`,
    `EnvironmentFile=${c.envFile}`,
    `ExecStart=${c.bun} ${args.join(" ")}`,
    // A pass that hangs must not block the next one forever.
    "TimeoutStartSec=18min",
    "Nice=10",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=Run the Marina Metaculus bot every 20 minutes",
    "",
    "[Timer]",
    "OnBootSec=5min",
    `OnUnitActiveSec=${c.everyMinutes ?? 20}min`,
    "Persistent=true",
    "Unit=marina-metaculus.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}
