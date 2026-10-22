#!/usr/bin/env -S bun --no-env-file
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * marina — the dispatcher bin.
 *
 *   marina [dir]                 folder-scoped coding session (the default flow)
 *   marina connect <name> [...]  connect to a running Marina (REPL / -c one-shot / pipe)
 *   marina attach [url] [...]    code in an existing coding session on a running Marina
 *   marina start                 run the full server in the foreground
 *   marina worlds [--json]       list the worlds built into this binary
 *   marina endpoint [--data-dir <dir>] [--show-key]
 *                                where the running instance for a data directory
 *                                listens (its endpoint.json; the key stays masked;
 *                                experimental: for embedders, Flow Nov 2026)
 *   marina acp <name>            Agent Client Protocol over stdio for editors
 *                                (targets MARINA_URL, else the instance in MARINA_DATA_DIR)
 *   marina mcp-stdio [--url <mcp-url>] [--token <t>] [--data-dir <dir>]
 *                                stdio MCP bridge to a running Marina's /mcp
 *   marina memory-mcp [...]      stdio MCP server for one Marina memory space
 *   marina status [--url|--port] is a Marina running? health + capability readiness
 *   marina init                  interactive .env setup
 *   marina supervise [...]       manage local coding agents from the dashboard
 *   marina route [...]           join, publish, and exchange participant messages
 *   marina predict <question>    start a private, saved forecast
 *   marina research <question>   start a private, saved research report
 *   marina inquiry <verb> [id]   list, watch, reopen and manage saved investigations
 *   marina version               print the package version
 *   marina --help | -h           usage
 *
 * The package root is resolved from this file's location (import.meta.dir),
 * never process.cwd(), so the bin works when installed as a dependency. The
 * folder a coding session targets is the caller's cwd (or the given dir).
 * Settings come from the shell and Marina's own files, never the project's
 * `.env` (scripts/cli-env.ts).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_THINKING_LEVELS, parseAgentThinkingLevel } from "../src/agent/agent-types";
import { MARINA_VERSION } from "../src/version";
import { applyCliEnvironment } from "./cli-env";
import { ATTACH_USAGE } from "./code-attach";

/** Verification a one-shot `-p` task must pass before it can submit. */
export const PRINT_VERIFICATION_MODES = ["checks", "candidate", "delivery"] as const;
export type PrintVerification = (typeof PRINT_VERIFICATION_MODES)[number];
export const CODE_DRIVER_NAMES = ["single", "crew"] as const;
export type CodeDriverName = (typeof CODE_DRIVER_NAMES)[number];

export type Dispatch =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init" }
  /** `url` is set only when `--url`/`--port` was given; env defaults resolve at run time. */
  | { kind: "status"; url?: string }
  /** `message`, when present, is a complete one-line error printed without the usage text. */
  | { kind: "usage-error"; arg: string; message?: string }
  /** A bare word that is neither a subcommand nor a directory (`marina myname`). */
  | { kind: "unknown-target"; arg: string }
  | {
      kind: "code";
      dir?: string;
      fresh?: boolean;
      print?: string;
      /** `-p` given without an inline task: read the task from stdin (a pipe). */
      taskFromStdin?: boolean;
      allowExec?: boolean;
      dangerouslyAllowAll?: boolean;
      agent?: string;
      model?: string;
      profile?: string;
      harness?: string;
      tui?: boolean;
      verbose?: boolean;
      allowUnverified?: boolean;
      /** One-shot verification requirement (`code do verification:<mode>`); default `delivery`. */
      verification?: PrintVerification;
      /** The coder's thinking level (`MARINA_CODE_THINKING` for the folder server). */
      thinking?: string;
      /** Code Mode driver for the session (`code driver <name>`): single (default) or crew. */
      driver?: CodeDriverName;
      json?: boolean;
    }
  | { kind: "connect"; rest: string[] }
  | { kind: "code-connected"; url: string; name: string; session: string; tui?: boolean }
  | { kind: "attach"; url?: string; name?: string; session?: string; tui?: boolean }
  | { kind: "route"; rest: string[] }
  | { kind: "inquiry"; mode: "predict" | "research" | "inquiry"; rest: string[] }
  | { kind: "supervise"; rest: string[] }
  | { kind: "start" }
  | { kind: "acp"; rest: string[] }
  | { kind: "mcp-stdio"; rest: string[] }
  | { kind: "memory-mcp"; rest: string[] }
  | { kind: "worlds"; json: boolean }
  | { kind: "endpoint"; dataDir?: string; showKey: boolean };

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

/** `marina attach [url] [--name N] [--session S] [--tui]`; resolution happens at run time. */
function parseAttach(argv: string[]): Dispatch {
  const attach: { url?: string; name?: string; session?: string; tui?: boolean } = {};
  const invalid = (arg: string, problem: string): Dispatch => ({
    kind: "usage-error",
    arg,
    message: `${problem}. Usage: ${ATTACH_USAGE}`,
  });
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tui") {
      attach.tui = true;
      continue;
    }
    if (arg === "--name" || arg === "--session" || arg === "--url") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) return invalid(arg, `${arg} needs a value`);
      const key = arg.slice(2) as "name" | "session" | "url";
      if (attach[key] !== undefined) return invalid(arg, `${arg} given twice`);
      attach[key] = value;
      continue;
    }
    if (arg.startsWith("-")) return invalid(arg, `Unknown attach option ${arg}`);
    if (attach.url !== undefined) return invalid(arg, `Unexpected argument ${arg}`);
    attach.url = arg;
  }
  return { kind: "attach", ...attach };
}

/** One line naming exactly what the flag form of connected coding is missing. */
function missingConnectedPieces(connected: { url?: string; name?: string; session?: string }) {
  const missing = [
    ...(connected.url ? [] : ["--url <url> (or MARINA_URL)"]),
    ...(connected.name ? [] : ["--name <account>"]),
    ...(connected.session ? [] : ["--session <id>"]),
  ];
  const list =
    missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
  return `Connected coding is missing ${list}. Or let Marina find them: ${ATTACH_USAGE}`;
}

/** `marina endpoint [--data-dir <dir>] [--show-key]`. */
function parseEndpoint(argv: string[]): Dispatch {
  let dataDir: string | undefined;
  let showKey = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--show-key") showKey = true;
    else if (arg === "--data-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) return { kind: "usage-error", arg };
      dataDir = value;
    } else return { kind: "usage-error", arg };
  }
  return { kind: "endpoint", ...(dataDir ? { dataDir } : {}), showKey };
}

/** Pure routing: argv (after the script path) → which flow to run. */
export function parseDispatch(
  argv: string[],
  isDir: (p: string) => boolean = isExistingDirectory,
  env: Record<string, string | undefined> = process.env,
): Dispatch {
  const [first] = argv;
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };
  if (first === "--version" || first === "-v" || first === "version") return { kind: "version" };
  if (first === "init") return { kind: "init" };
  if (first === "status") return parseStatus(argv.slice(1));
  if (first === "supervise") return { kind: "supervise", rest: argv.slice(1) };
  if (first === "route") return { kind: "route", rest: argv.slice(1) };
  if (first === "predict" || first === "research" || first === "inquiry")
    return { kind: "inquiry", mode: first, rest: argv.slice(1) };
  if (first === "connect") return { kind: "connect", rest: argv.slice(1) };
  if (first === "attach") return parseAttach(argv.slice(1));
  if (first === "start") return { kind: "start" };
  if (first === "acp") return { kind: "acp", rest: argv.slice(1) };
  if (first === "mcp-stdio") return { kind: "mcp-stdio", rest: argv.slice(1) };
  if (first === "memory-mcp") return { kind: "memory-mcp", rest: argv.slice(1) };
  if (first === "worlds") return { kind: "worlds", json: argv.includes("--json") };
  if (first === "endpoint") return parseEndpoint(argv.slice(1));
  // Coding flow: [dir] plus optional --fresh, -p/--print "<task>", and the
  // exec-approval flags, in any order.
  let dir: string | undefined;
  let fresh: boolean | undefined;
  let tui: boolean | undefined;
  let verbose: boolean | undefined;
  let allowUnverified: boolean | undefined;
  let verification: PrintVerification | undefined;
  let thinking: string | undefined;
  let driver: CodeDriverName | undefined;
  let json: boolean | undefined;
  let print: string | undefined;
  let taskFromStdin: boolean | undefined;
  let allowExec: boolean | undefined;
  let dangerouslyAllowAll: boolean | undefined;
  const selection: { agent?: string; model?: string; profile?: string; harness?: string } = {};
  const connected: { url?: string; name?: string; session?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tui") {
      tui = true;
      continue;
    }
    if (["--url", "--name", "--session"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("-")) return { kind: "usage-error", arg };
      connected[arg.slice(2) as keyof typeof connected] = value;
      continue;
    }
    if (["--agent", "--model", "--profile", "--harness"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("-")) return { kind: "usage-error", arg };
      selection[arg.slice(2) as keyof typeof selection] = value;
      continue;
    }
    if (arg === "--fresh") {
      fresh = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--allow-unverified") {
      allowUnverified = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--verification") {
      const value = argv[++i];
      if (!PRINT_VERIFICATION_MODES.includes(value as PrintVerification))
        return {
          kind: "usage-error",
          arg,
          message: `--verification takes one of: ${PRINT_VERIFICATION_MODES.join(", ")}`,
        };
      verification = value as PrintVerification;
      continue;
    }
    if (arg === "--thinking") {
      const value = argv[++i];
      if (!parseAgentThinkingLevel(value))
        return {
          kind: "usage-error",
          arg,
          message: `--thinking takes one of: ${AGENT_THINKING_LEVELS.join(", ")}`,
        };
      thinking = parseAgentThinkingLevel(value);
      continue;
    }
    if (arg === "--driver") {
      const value = argv[++i];
      if (!CODE_DRIVER_NAMES.includes(value as CodeDriverName))
        return {
          kind: "usage-error",
          arg,
          message: `--driver takes one of: ${CODE_DRIVER_NAMES.join(", ")}`,
        };
      driver = value as CodeDriverName;
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
      // A missing or flag-shaped follow-up means the task comes from stdin
      // (a pipe): `printf "…" | marina -p`.
      if (task === undefined || task.startsWith("-")) {
        taskFromStdin = true;
        continue;
      }
      print = task;
      i++;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "usage-error", arg };
    if (dir !== undefined) return { kind: "usage-error", arg };
    if (!looksLikeDirectory(arg, isDir)) return { kind: "unknown-target", arg };
    dir = arg;
  }
  // The one-shot result flags shape a -p run only.
  if ((allowUnverified || json || verification || driver) && print === undefined && !taskFromStdin)
    return {
      kind: "usage-error",
      arg: allowUnverified
        ? "--allow-unverified"
        : json
          ? "--json"
          : verification
            ? "--verification"
            : "--driver",
    };
  if (Object.keys(connected).length) {
    if (
      dir !== undefined ||
      fresh ||
      print !== undefined ||
      allowExec ||
      dangerouslyAllowAll ||
      Object.keys(selection).length
    )
      return {
        kind: "usage-error",
        arg: "Connected coding requires --url, --name and --session together; folder, one-shot and local runtime options belong to standalone coding.",
      };
    connected.url ??= env.MARINA_URL || undefined;
    if (!connected.url || !connected.name || !connected.session)
      return {
        kind: "usage-error",
        arg: "connected",
        message: missingConnectedPieces(connected),
      };
    return {
      kind: "code-connected",
      url: connected.url,
      name: connected.name,
      session: connected.session,
      ...(tui ? { tui } : {}),
    };
  }
  return {
    kind: "code",
    dir,
    ...selection,
    ...(tui ? { tui } : {}),
    ...(verbose ? { verbose } : {}),
    ...(allowUnverified ? { allowUnverified } : {}),
    ...(json ? { json } : {}),
    ...(verification ? { verification } : {}),
    ...(thinking ? { thinking } : {}),
    ...(driver ? { driver } : {}),
    ...(fresh !== undefined ? { fresh } : {}),
    ...(print !== undefined ? { print } : {}),
    ...(taskFromStdin ? { taskFromStdin } : {}),
    ...(allowExec !== undefined ? { allowExec } : {}),
    ...(dangerouslyAllowAll !== undefined ? { dangerouslyAllowAll } : {}),
  };
}

export const USAGE = `marina — you think, therefore you are here

Usage:
  marina [dir]                 code in a folder (defaults to the current directory)
  marina -p "<task>" [dir]     one-shot: run a task, print the diff + summary, exit
  marina attach [url]          code in an existing coding session on a running Marina;
                               picks the cached account and active session, logs in
                               when needed (TTY); closing leaves the world running
  marina --url <url> --name <account> --session <id>
                               the same, with every piece given explicitly
  marina connect <name> [...]  connect to a running Marina (-c "cmd" for one-shot)
  marina supervise [...]       manage local coding agents from the dashboard
  marina predict <question>    prediction workspace (or --plain / --json)
  marina research <question>   deep research with captured evidence
  marina inquiry [...]        saved answers, collaboration and standalone TUI
  marina route [...]           join, publish, and exchange participant messages
  marina start                 run the full server in the foreground
  marina worlds [--json]       list the worlds built into this binary
  marina endpoint [--data-dir <dir>] [--show-key]
                               where the running instance for a data directory
                               listens (its endpoint.json; the key stays masked;
                               experimental: for embedders, Flow Nov 2026)
  marina acp <name>            Agent Client Protocol over stdio for editors
                               (targets MARINA_URL, else the instance in MARINA_DATA_DIR)
  marina mcp-stdio [--url <mcp-url>] [--token <t>] [--data-dir <dir>]
                               stdio MCP bridge to a running Marina's /mcp
  marina memory-mcp [...]      stdio MCP server for one Marina memory space
  marina status [--url <ws-url> | --port <n>]
                               health + capability readiness of the running Marina
  marina init                  interactive setup (writes .env)
  marina version               print the package version
  marina --help                show this help

Options:
  --tui                      interactive workspace with inline command guidance;
                              omit for scrollback; one-shot and pipes stay plain
  --url --name --session      connected interactive coding, using the server's workspace;
                              --url defaults to MARINA_URL; no new world is started
                              (marina attach takes the same --name/--session/--tui)
  --agent <runtime>           marina (default), claude, codex, or pi
  --model <id>                model for the selected runtime; \`route\` picks a tier
                              model for the task from MARINA_ROUTES / tier models
  --thinking <level>          the coder's reasoning depth (off, minimal, low, medium,
                              high, xhigh); default MARINA_CODE_THINKING (high), used
                              only where the model declares reasoning support
  --driver <name>             Code Mode driver: single (default, one bound coder) or
                              crew (a lead owns the task and its contract; a crew
                              reviews and tests alongside it)
  --profile <dialect>         Marina command dialect: marina, claude, codex, pi
  --harness <name-or-path>    saved harness or explicit portable JSON file
                              /harness save <name> remembers a folder's default
  -p, --print <task>           dispatch one coding task, await completion, then exit
  --allow-unverified           with -p: exit 0 for completed work that was not verified
                               (still reported on stderr)
  --verification <mode>        with -p: what the task must verify before it can submit:
                               checks (the project's own checks), candidate (a Git
                               snapshot), or delivery (default, MARINA_CODE_VERIFICATION:
                               the declared output files checked alone in a clean
                               directory, each stated requirement mapped to a check
                               that observes it)
  --json                       with -p: print one JSON result object as the last stdout
                               line; everything else goes to stderr
  --verbose                    print startup details (database, server endpoints,
                               federation address) before the prompt
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
  0  task completed and its checks passed (verified; session diff printed)
  3  task completed but was not verified (the reason is printed; --allow-unverified
     makes this 0). A native agent's turn (--agent claude|codex|pi) is never
     verified by Marina, so it ends 3 unless --allow-unverified.
  1  task failed (the agent died mid-task, the run was stopped, or it ended
     blocked); edits already made stay and are listed. A block over an
     interpretation is answered automatically and recorded as an assumption
  2  task timed out (MARINA_CODE_TASK_TIMEOUT_MS, default 600000) — code stop sent

Environment:
  MARINA_URL                   server URL for connect/status/attach and connected coding
                               (connect/status default: ws://localhost:$WS_PORT, else 3300)
  MARINA_TOKEN                 credential for connected coding or status readiness;
                               connected coding otherwise uses that account's server-bound cache
  MARINA_CODE_FRESH=1          same as --fresh
  MARINA_CODE_TASK_TIMEOUT_MS  one-shot task timeout in ms (default 600000)
  ANTHROPIC_API_KEY, ...       an LLM provider key so agents can think`;

// ── version ──────────────────────────────────────────────────────────────────

export function readPackageVersion(root?: string): string {
  if (root === undefined) return MARINA_VERSION;
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
  trustProfile?: { profile?: string; autonomy?: string; ungated?: boolean };
  checks?: {
    id: string;
    label: string;
    status: string;
    detail: string;
    remediation?: string;
    /** An optional extra: the core experience works without it. */
    optional?: boolean;
  }[];
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
  if (name || world)
    lines.push(`  instance   ${name ?? "?"}${world && world !== name ? ` (${world})` : ""}`);
  lines.push(`  uptime     ${fmtUptime(health.uptime)}`);
  lines.push(
    `  online     ${health.connections ?? "?"} connections · ${health.entities ?? "?"} entities · ${health.agents ?? "?"} agents · ${health.rooms ?? "?"} rooms`,
  );
  if ("error" in readiness) {
    lines.push(`  readiness  ${readiness.error}`);
    return lines.join("\n");
  }
  if (readiness.trustProfile?.profile) {
    const trust = readiness.trustProfile;
    lines.push(
      trust.ungated
        ? trust.autonomy === "sovereign"
          ? `  trust      ${trust.profile} · sovereign (every gate off; unset MARINA_AUTONOMY to enforce them)`
          : `  trust      ${trust.profile} · ungated (gates off; MARINA_AUTONOMY=guarded enforces them)`
        : `  trust      ${trust.profile}${trust.autonomy ? ` · autonomy ${trust.autonomy}` : ""}`,
    );
  }
  const checks = readiness.checks ?? [];
  if (checks.length > 0) {
    lines.push("", "  status     capability");
    const width = Math.max(...checks.map((c) => c.label.length));
    for (const c of checks) {
      const mark =
        c.status === "ok"
          ? "ok      "
          : c.optional
            ? "optional"
            : c.status === "degraded"
              ? "degraded"
              : "off     ";
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

/** `marina status [--url <ws-url>] [--port <n>]` — the same flags as `marina connect`. */
function parseStatus(rest: string[]): Dispatch {
  let url: string | undefined;
  let port: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = rest[i + 1];
    if ((arg === "--url" || arg === "--port") && value && !value.startsWith("-")) {
      if (arg === "--url") url = value;
      else port = value;
      i++;
      continue;
    }
    return {
      kind: "usage-error",
      arg,
      message: `marina status: unexpected "${arg}". Usage: marina status [--url <ws-url> | --port <n>]`,
    };
  }
  if (port !== undefined && !/^\d{1,5}$/.test(port))
    return { kind: "usage-error", arg: port, message: `marina status: --port expects a number.` };
  const resolved = url ?? (port ? `ws://localhost:${port}` : undefined);
  return resolved ? { kind: "status", url: resolved } : { kind: "status" };
}

/**
 * The server `marina status` probes: `--url`/`--port` (already folded into
 * `flagUrl`), then MARINA_URL, then WS_PORT, then the default — the same order
 * as `marina connect`. A pasted `/ws` endpoint is accepted.
 */
export function statusServerUrl(
  flagUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const raw =
    flagUrl ??
    (env.MARINA_URL || undefined) ??
    (env.WS_PORT ? `ws://localhost:${env.WS_PORT}` : "ws://localhost:3300");
  return raw.replace(/\/ws\/?$/, "");
}

async function runStatus(flagUrl?: string): Promise<number> {
  const wsUrl = statusServerUrl(flagUrl);
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

/** Read a one-shot task from piped stdin (`printf "…" | marina -p`). */
async function readStdinTask(): Promise<string> {
  if (process.stdin.isTTY) {
    console.error('marina -p needs a task — give one inline (`marina -p "task"`) or pipe one in.');
    process.exit(1);
  }
  const task = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!task) {
    console.error("marina -p: no task on stdin.");
    process.exit(1);
  }
  return task;
}

if (import.meta.main) {
  // Preserve the original compiled server entry as an alias for foreground
  // start. Do not exit after import: active listeners keep the server alive.
  const dispatch = parseDispatch(
    process.argv[2] === "__marina_server" ? ["start"] : process.argv.slice(2),
  );
  // A server's working directory is its instance; every other command reads
  // only the user and checkout settings (a folder session adds its own later).
  applyCliEnvironment(dispatch.kind === "start" ? { instanceDir: process.cwd() } : {});
  switch (dispatch.kind) {
    case "help":
      console.log(USAGE);
      break;
    case "version":
      console.log(readPackageVersion());
      break;
    case "usage-error":
      console.error(
        dispatch.message ?? `Invalid option or combination: ${dispatch.arg}\n\n${USAGE}`,
      );
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
      await runInit(process.argv.slice(3));
      break;
    }
    case "status":
      process.exit(await runStatus(dispatch.url));
      break;
    case "supervise": {
      const { runSupervisor } = await import("./supervise");
      process.exit(await runSupervisor(dispatch.rest));
      break;
    }
    case "route": {
      const { runRoute } = await import("./route");
      process.exit(await runRoute(dispatch.rest));
      break;
    }
    case "inquiry": {
      const { runInquiry } = await import("./inquiry");
      process.exit(await runInquiry(dispatch.mode, dispatch.rest));
      break;
    }
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
    case "code-connected": {
      const { runConnectedCodeSession } = await import("./code-connected");
      try {
        process.exitCode = await runConnectedCodeSession({
          ...dispatch,
          token: process.env.MARINA_TOKEN,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
      break;
    }
    case "attach": {
      const { loginWithConnect, resolveAttach, terminalAttachIO } = await import("./code-attach");
      const { runConnectedCodeSession } = await import("./code-connected");
      try {
        const options = await resolveAttach(dispatch, {
          env: process.env,
          io: terminalAttachIO(),
          login: loginWithConnect,
        });
        process.exitCode = await runConnectedCodeSession(options);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
      break;
    }
    case "acp": {
      // acp.ts reads process.argv.slice(2) at module load, like connect.ts.
      if (!process.env.MARINA_URL) {
        const { discoverEndpoint } = await import("./mcp-stdio");
        const endpoint = discoverEndpoint(undefined);
        if (endpoint) process.env.MARINA_URL = endpoint.url.replace(/^http/, "ws");
      }
      process.argv = [process.argv[0] ?? "bun", join(import.meta.dir, "acp.ts"), ...dispatch.rest];
      await import("./acp");
      break;
    }
    case "mcp-stdio": {
      const { runMcpStdio } = await import("./mcp-stdio");
      // Exit as soon as the bridge ends (stdin EOF): nothing else should keep it alive.
      process.exit(await runMcpStdio(dispatch.rest));
      break;
    }
    case "memory-mcp":
      process.argv = [
        process.argv[0] ?? "bun",
        join(import.meta.dir, "memory-mcp.ts"),
        ...dispatch.rest,
      ];
      await import("./memory-mcp");
      break;
    case "worlds": {
      const { BUILTIN_WORLD_SLUGS, BUILTIN_WORLD_STATUS, BUILTIN_WORLD_SUMMARIES } = await import(
        "../worlds"
      );
      const worlds = [...BUILTIN_WORLD_SLUGS].sort().map((name) => ({
        name,
        description: BUILTIN_WORLD_SUMMARIES[name] ?? "",
        status: BUILTIN_WORLD_STATUS[name] ?? "demo",
      }));
      if (dispatch.json) console.log(JSON.stringify(worlds, null, 2));
      else
        for (const w of worlds)
          console.log(
            `${w.name.padEnd(20)} ${w.status === "demo" ? "[demo] " : ""}${w.description}`,
          );
      break;
    }
    case "endpoint": {
      const { discoverEndpoint } = await import("./mcp-stdio");
      const endpoint = discoverEndpoint(dispatch.dataDir);
      if (!endpoint) {
        console.error("No running Marina for this data directory.");
        process.exitCode = 1;
        break;
      }
      const shown =
        dispatch.showKey || !endpoint.apiKey
          ? endpoint
          : { ...endpoint, apiKey: `${endpoint.apiKey.slice(0, 9)}…` };
      console.log(JSON.stringify(shown, null, 2));
      break;
    }
    case "start":
      // Full server in the foreground; src/main.ts prints its own boot banner.
      await import("../src/main");
      break;
    case "code": {
      const { runCodeSession } = await import("./code");
      const print = dispatch.taskFromStdin ? await readStdinTask() : dispatch.print;
      await runCodeSession(dispatch.dir ?? process.cwd(), {
        fresh: dispatch.fresh,
        print,
        allowExec: dispatch.allowExec,
        dangerouslyAllowAll: dispatch.dangerouslyAllowAll,
        agent: dispatch.agent,
        model: dispatch.model,
        profile: dispatch.profile,
        harness: dispatch.harness,
        tui: dispatch.tui,
        verbose: dispatch.verbose,
        allowUnverified: dispatch.allowUnverified,
        verification: dispatch.verification,
        thinking: dispatch.thinking,
        driver: dispatch.driver,
        json: dispatch.json,
      }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
      break;
    }
  }
}
