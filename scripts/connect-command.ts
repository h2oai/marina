// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One command from the terminal bridge (`scripts/connect.ts`). A refused
 * command (`ok:false` — a typo, a usage error, a gate refusal) rejects with
 * `CommandError` in the SDK; for a human at a prompt that is ordinary output,
 * not a crash. Resolves `true` on success, `false` on a refusal, and rethrows
 * anything that is not a `CommandError`.
 */

import { CommandError, type Perception } from "../src/sdk/client";

export interface CommandSender {
  command(input: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface RunOptions {
  /** Stop waiting (the server may still finish the command). */
  signal?: AbortSignal;
  /** This request's own perceptions, success or refusal (the SDK's per-request buffer). */
  onResult?: (perceptions: Perception[]) => void;
}

export async function runCliCommand(
  agent: CommandSender,
  input: string,
  writeError: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  options: RunOptions = {},
): Promise<boolean> {
  try {
    const result = await agent.command(
      input,
      options.signal ? { signal: options.signal } : undefined,
    );
    options.onResult?.(Array.isArray(result) ? (result as Perception[]) : []);
    return true;
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    options.onResult?.(err.perceptions);
    // A deliberate stop is the caller's to describe.
    if (options.signal?.aborted) return false;
    // The refusal text already reached the terminal through the perception
    // printer; only a failure with no output (timeout, disconnect) needs words.
    if (!hasText(err.perceptions)) writeError(err.message);
    return false;
  }
}

function hasText(perceptions: Perception[]): boolean {
  return perceptions.some((p) => typeof (p.data.text ?? p.data.message) === "string");
}
