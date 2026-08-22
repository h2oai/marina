#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * marina — the dispatcher bin.
 *
 *   marina [dir]                 folder-scoped coding session (the default flow)
 *   marina connect <name> [...]  connect to a running Marina (REPL / -c one-shot / pipe)
 *   marina start                 run the full server in the foreground
 *   marina --help | -h           usage
 *
 * The package root is resolved from this file's location (import.meta.dir),
 * never process.cwd(), so the bin works when installed as a dependency. The
 * folder a coding session targets is the caller's cwd (or the given dir).
 */

import { join } from "node:path";

export type Dispatch =
  | { kind: "help" }
  | { kind: "usage-error"; arg: string }
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

/** Pure routing: argv (after the script path) → which flow to run. */
export function parseDispatch(argv: string[]): Dispatch {
  const [first] = argv;
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };
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

Host execution is allowlist-only by default. --allow-exec / --dangerously-allow-all
loosen that only in an interactive local terminal you own; without a TTY they are
refused and the session stays allowlist-only.

Exit codes (one-shot -p):
  0  task completed (summary recorded; session diff printed)
  1  task failed (the agent died mid-task or the run was stopped)
  2  task timed out (MARINA_CODE_TASK_TIMEOUT_MS, default 600000) — code stop sent

Environment:
  MARINA_URL                   server URL for connect (default: ws://localhost:3300)
  MARINA_CODE_FRESH=1          same as --fresh
  MARINA_CODE_TASK_TIMEOUT_MS  one-shot task timeout in ms (default 600000)
  ANTHROPIC_API_KEY, ...       an LLM provider key so agents can think`;

if (import.meta.main) {
  const dispatch = parseDispatch(process.argv.slice(2));
  switch (dispatch.kind) {
    case "help":
      console.log(USAGE);
      break;
    case "usage-error":
      console.error(`Unknown option: ${dispatch.arg}\n\n${USAGE}`);
      process.exit(1);
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
