// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bearer a process uses to call this Marina's own `/v1` (lesson writer
 * and judge, classifier engines). Inside the serving process that is the
 * in-process internal token, which only that process recognises. A separate
 * process — an operator CLI such as `bun run forecastbench resolve` — has a
 * different internal token the server would reject, so it uses a key the
 * server accepts: the operator's first `MODEL_API_KEYS` secret, else the local
 * profile's key (`MARINA_LOCAL_API_KEY`, or the `<DB_PATH>.local-api-key` file
 * the server created — read, never created here). With neither, it falls back
 * to the internal token and the call is refused as before.
 */

import { existsSync, readFileSync } from "node:fs";
import { localApiKeyPath } from "./local-api-key";

let serving = false;

/** Called once by the server entry point: self-calls use the in-process token. */
export function markServingProcess(): void {
  serving = true;
}

/** For tests: forget `markServingProcess`. */
export function resetServingProcessForTests(): void {
  serving = false;
}

const LOCAL_KEY = /^mk_local_[A-Za-z0-9_-]{32,}$/;

function readLocalKey(dbPath: string): string | undefined {
  const path = localApiKeyPath(dbPath);
  if (!existsSync(path)) return undefined;
  const key = readFileSync(path, "utf8").trim();
  return LOCAL_KEY.test(key) ? key : undefined;
}

export async function selfModelToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!serving) {
    const operator = env.MODEL_API_KEYS?.split(",")
      .map((k) => k.trim())
      .find(Boolean);
    if (operator) {
      const i = operator.indexOf(":");
      return i < 0 ? operator : operator.slice(0, i);
    }
    const local = env.MARINA_LOCAL_API_KEY?.trim() || readLocalKey(env.DB_PATH || "marina.db");
    if (local) return local;
  }
  const { getInternalModelToken } = await import("../agent/agent-runtime");
  return getInternalModelToken();
}
