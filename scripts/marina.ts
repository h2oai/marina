#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * marina — the dispatcher bin.
 *
 *   marina [dir]                 folder-scoped coding session (the default flow)
 *   marina connect <name> [...]  connect to a running Marina (REPL / -c one-shot / pipe)
 *   marina start                 run the full server in the foreground
 *   marina status                is a Marina running? health + capability readiness
 *   marina init                  interactive .env setup
 *   marina version               print the package version
 *   marina --help | -h           usage
 *
 * The package root is resolved from this file's location (import.meta.dir),
 * never process.cwd(), so the bin works when installed as a dependency. The
 * folder a coding session targets is the caller's cwd (or the given dir).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Dispatch =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init" }
  | { kind: "status" }
  | { kind: "usage-error"; arg: string }
  /** A bare word that is neither a subcommand nor a directory (`marina myname`). */
  | { kind: "unknown-target"; arg: string }
  | {
      kind: "code";
      dir?: string;
      fresh?: boolean;
      print?: string;
      allowExec?: boolean;
      dangerouslyAllowAll?: boolean;
    }
  | { kind: "connect"; rest: string[] }
  | { kind: "start" };

/** Default directory probe for `parseDispatch` — an existing directory on disk. */
function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A positional argument is a coding-session target only when it is unmistakably
 * a path (`.`, `..`, or starting with `/`, `./`, `../`) or an existing directory.
 * A bare word like `myname` or a mistyped subcommand is NOT silently turned
 * into a folder — that used to open Code Mode in a directory called `init`.
 */
export function looksLikeDirectory(arg: string, isDir: (p: string) => boolean): boolean {
  if (arg === "." || arg === "..") return true;
  if (arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../")) return true;
  return isDir(arg);
}

/** Pure routing: argv (after the script path) → which flow to run. */
export function parseDispatch(
  argv: string[],
  isDir: (p: string) => boolean = isExistingDirectory,
): Dispatch {
  const [first] = argv;
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };
  if (first === "--version" || first === "-v" || first === "version") return { kind: "version" };
  if (first === "init") return { kind: "init" };
  if (first === "status") return { kind: "status" };
  if (first === "connect") return { kind: "connect", rest: argv.slice(1) };
  if (first === "start") return { kind: "start" };
  // Coding flow: [dir] plus optional --fresh, -p/--print "<task>", and the
  // exec-approval flags, in any order.
  let dir: string | undefined;
  let fresh: boolean | undefined;
  let print: string | undefined;
  let allowExec: boolean | undefined;
  let dangerouslyAllowAll: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--fresh") {
      fresh = true;
      continue;
    }
    if (arg === "--allow-exec") {
      allowExec = true;
      continue;
    }
    if (arg === "--dangerously-allow-all") {
      dangerouslyAllowAll = true;
      continue;
    }
    if (arg === "-p" || arg === "--print") {
      const task = argv[i + 1];
      // A missing or flag-shaped follow-up is a usage error, not a task.
      if (task === undefined || task.startsWith("-")) return { kind: "usage-error", arg };
      print = task;
      i++;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "usage-error", arg };
    if (dir !== undefined) return { kind: "usage-error", arg };
    if (!looksLikeDirectory(arg, isDir)) return { kind: "unknown-target", arg };
    dir = arg;
  }
  return {
    kind: "code",
    dir,
    ...(fresh !== undefined ? { fresh } : {}),
    ...(print !== undefined ? { print } : {}),
    ...(allowExec !== undefined ? { allowExec } : {}),
    ...(dangerouslyAllowAll !== undefined ? { dangerouslyAllowAll } : {}),
  };
}

export const USAGE = `marina — you think, therefore you are here

Usage:
  marina [dir]                 code in a folder (defaults to the current directory)
  marina -p "<task>" [dir]     one-shot: run a task, print the diff + summary, exit
  marina connect <name> [...]  connect to a running Marina (-c "cmd" for one-shot)
  marina start                 run the full server in the foreground
  marina status                health + capability readiness of the running Marina
  marina init                  interactive setup (writes .env)
  marina version               print the package version
  marina --help                show this help

Options:
  -p, --print <task>           dispatch one coding task, await completion, then exit
  --fresh                      throwaway database (deleted on exit) instead of the
                               per-folder default at ~/.marina/projects/<slug>/marina.db
  --allow-exec                 permit non-allowlisted host commands, prompting for
                               approval (y/N/a) on each one. Interactive local
                               session only (requires a TTY you own).
  --dangerously-allow-all      auto-approve every host command with no prompt.
                               DANGEROUS — an interactive local session only
                               (requires a TTY you own); prints a loud banner.

A [dir] must be a path (".", "/abs", "./rel", "../up") or an existing directory.
To join a running world by name use: marina connect <name>

Host execution is allowlist-only by default. --allow-exec / --dangerously-allow-all
loosen that only in an interactive local terminal you own; without a TTY they are
refused and the session stays allowlist-only.

Exit codes (one-shot -p):
  0  task completed (summary recorded; session diff printed)
  1  task failed (the agent died mid-task or the run was stopped)
  2  task timed out (MARINA_CODE_TASK_TIMEOUT_MS, default 600000) — code stop sent

Environment:
  MARINA_URL                   server URL for connect/status (default: ws://localhost:3300)
  MARINA_TOKEN                 bearer token for \`marina status\` readiness (else the
                               newest cached \`marina connect\` session is used)
  MARINA_CODE_FRESH=1          same as --fresh
  MARINA_CODE_TASK_TIMEOUT_MS  one-shot task timeout in ms (default 600000)
  ANTHROPIC_API_KEY, ...       an LLM provider key so agents can think`;

// ── version ──────────────────────────────────────────────────────────────────

export function readPackageVersion(root = join(import.meta.dir, "..")): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── status ───────────────────────────────────────────────────────────────────

/** `ws://host:port` (the MARINA_URL convention) → `http://host:port`. */
export function httpBaseFromUrl(url: string): string {
  return url.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
}

export interface HealthView {
  status?: string;
  uptime?: number;
  connections?: number;
  rooms?: number;
  entities?: number;
  agents?: number;
}

export interface ReadinessView {
  instanceName?: string;
  world?: string;
  trustProfile?: { profile?: string; autonomy?: string };
  checks?: { id: string; label: string; status: string; detail: string; remediation?: string }[];
}

function fmtUptime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Compact table for `marina status`. Pure — takes the two fetched payloads. */
export function formatStatus(
  url: string,
  health: HealthView,
  readiness: ReadinessView | { error: string },
): string {
  const lines: string[] = [];
  lines.push(`Marina at ${url}: ${health.status ?? "unknown"}`);
  const world = "world" in readiness && readiness.world ? readiness.world : undefined;
  const name = "instanceName" in readiness ? readiness.instanceName : undefined;
  if (name || world) lines.push(`  instance   ${name ?? "?"}${world ? ` (${world})` : ""}`);
  lines.push(`  uptime     ${fmtUptime(health.uptime)}`);
  lines.push(
    `  online     ${health.connections ?? "?"} connections · ${health.entities ?? "?"} entities · ${health.agents ?? "?"} agents · ${health.rooms ?? "?"} rooms`,
  );
  if ("error" in readiness) {
    lines.push(`  readiness  ${readiness.error}`);
    return lines.join("\n");
  }
  if (readiness.trustProfile?.profile) {
    lines.push(
      `  trust      ${readiness.trustProfile.profile}${readiness.trustProfile.autonomy ? ` · autonomy ${readiness.trustProfile.autonomy}` : ""}`,
    );
  }
  const checks = readiness.checks ?? [];
  if (checks.length > 0) {
    lines.push("", "  status     capability");
    const width = Math.max(...checks.map((c) => c.label.length));
    for (const c of checks) {
      const mark =
        c.status === "ok" ? "ok      " : c.status === "degraded" ? "degraded" : "off     ";
      lines.push(`  ${mark}   ${c.label.padEnd(width)}  ${c.detail}`);
      if (c.status !== "ok" && c.remediation)
        lines.push(`${" ".repeat(15 + width)}→ ${c.remediation}`);
    }
  }
  return lines.join("\n");
}

/** Newest cached `marina connect` session token for this server URL, if any. */
function cachedSessionToken(url: string): string | undefined {
  const dir = join(homedir(), ".marina", "sessions");
  try {
    let best: { token: string; mtime: number } | undefined;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(dir, file);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: string; url?: string };
      if (!parsed.token || (parsed.url && parsed.url !== url)) continue;
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { token: parsed.token, mtime };
    }
    return best?.token;
  } catch {
    return undefined;
  }
}

async function runStatus(): Promise<number> {
  const wsUrl = process.env.MARINA_URL ?? "ws://localhost:3300";
  const base = httpBaseFromUrl(wsUrl);
  let health: HealthView;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    health = (await res.json()) as HealthView;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `Cannot reach Marina at ${base} (${reason}).\nIs Marina running at ${wsUrl}? Start it with \`bun run start\`.`,
    );
    return 1;
  }
  let readiness: ReadinessView | { error: string };
  try {
    const token = process.env.MARINA_TOKEN ?? cachedSessionToken(wsUrl);
    const res = await fetch(`${base}/api/readiness`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3_000),
    });
    if (res.status === 401 || res.status === 403) {
      readiness = {
        error:
          "needs a session — run `marina connect <name>` once (or set MARINA_TOKEN), " +
          "or type `readiness` inside the world",
      };
    } else if (!res.ok) {
      readiness = { error: `HTTP ${res.status}` };
    } else {
      readiness = (await res.json()) as ReadinessView;
    }
  } catch (err) {
    readiness = { error: err instanceof Error ? err.message : String(err) };
  }
  console.log(formatStatus(wsUrl, health, readiness));
  return 0;
}

if (import.meta.main) {
  const dispatch = parseDispatch(process.argv.slice(2));
  switch (dispatch.kind) {
    case "help":
      console.log(USAGE);
      break;
    case "version":
      console.log(readPackageVersion());
      break;
    case "usage-error":
      console.error(`Unknown option: ${dispatch.arg}\n\n${USAGE}`);
      process.exit(1);
      break;
    case "unknown-target":
      console.error(
        `"${dispatch.arg}" is not a directory or a marina subcommand.\n` +
          `To join a running Marina as "${dispatch.arg}": marina connect ${dispatch.arg}\n` +
          `To code in a folder: marina . | marina ./${dispatch.arg}\n\n${USAGE}`,
      );
      process.exit(1);
      break;
    case "init": {
      const { runInit } = await import("./init");
      await runInit();
      break;
    }
    case "status":
      process.exit(await runStatus());
      break;
    case "connect":
      // connect.ts reads process.argv.slice(2) at module load — rewrite argv so
      // the delegated flow sees exactly its own arguments.
      process.argv = [
        process.argv[0] ?? "bun",
        join(import.meta.dir, "connect.ts"),
        ...dispatch.rest,
      ];
      await import("./connect");
      break;
    case "start":
      // Full server in the foreground; src/main.ts prints its own boot banner.
      await import("../src/main");
      break;
    case "code": {
      const { runCodeSession } = await import("./code");
      await runCodeSession(dispatch.dir ?? process.cwd(), {
        fresh: dispatch.fresh,
        print: dispatch.print,
        allowExec: dispatch.allowExec,
        dangerouslyAllowAll: dispatch.dangerouslyAllowAll,
      });
      break;
    }
  }
}
