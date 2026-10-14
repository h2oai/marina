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
  command(input: string): Promise<unknown>;
}

export async function runCliCommand(
  agent: CommandSender,
  input: string,
  writeError: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<boolean> {
  try {
    await agent.command(input);
    return true;
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    // The refusal text already reached the terminal through the perception
    // printer; only a failure with no output (timeout, disconnect) needs words.
    if (!hasText(err.perceptions)) writeError(err.message);
    return false;
  }
}

function hasText(perceptions: Perception[]): boolean {
  return perceptions.some((p) => typeof (p.data.text ?? p.data.message) === "string");
}
