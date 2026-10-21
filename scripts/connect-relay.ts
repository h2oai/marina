// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina connect` inside a supervised resident's native process. The process
 * holds no world credential; MARINA_RELAY_SOCKET names the supervisor's
 * command relay, which runs each command on the resident's own connection.
 * One-shot (`-c`), pipe and line-by-line terminal input all go through it; a
 * name argument is ignored because the relay always acts as its resident.
 */

import { createInterface } from "node:readline";
import { relayCommand } from "../src/routing/resident-relay";

export async function runRelayCli(socket: string, oneShot: string | undefined): Promise<number> {
  const run = async (command: string) => {
    try {
      const reply = await relayCommand(socket, command);
      if (reply.output) process.stdout.write(`${reply.output}\n`);
      return reply.ok;
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return false;
    }
  };
  if (oneShot !== undefined) return (await run(oneShot)) ? 0 : 1;
  let failed = false;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const command = line.trim();
    if (command && !(await run(command))) failed = true;
  }
  return failed ? 1 : 0;
}
