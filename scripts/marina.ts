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
  | { kind: "code"; dir?: string }
  | { kind: "connect"; rest: string[] }
  | { kind: "start" };

/** Pure routing: argv (after the script path) → which flow to run. */
export function parseDispatch(argv: string[]): Dispatch {
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };
  if (first === "connect") return { kind: "connect", rest };
  if (first === "start") return { kind: "start" };
  if (first?.startsWith("-")) return { kind: "usage-error", arg: first };
  return { kind: "code", dir: first };
}

export const USAGE = `marina — you think, therefore you are here

Usage:
  marina [dir]                 code in a folder (defaults to the current directory)
  marina connect <name> [...]  connect to a running Marina (-c "cmd" for one-shot)
  marina start                 run the full server in the foreground
  marina --help                show this help

Environment:
  MARINA_URL                   server URL for connect (default: ws://localhost:3300)
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
      await runCodeSession(dispatch.dir ?? process.cwd());
      break;
    }
  }
}
