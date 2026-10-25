// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a recorded `command` event keeps of the input. The event is persisted
 * to `event_log`, projected into the cognitive ledger and read by `observe`,
 * so credentials never reach it:
 *
 * - a form a command declares sensitive (`CommandDef.sensitiveSubcommands`:
 *   `key add`, `connect auth`, `adapter enable`) keeps `<verb> <sub> [redacted]`;
 * - every other input has key-shaped strings masked (`maskSecretShapes`).
 *
 * `purgeSensitiveCommandEvents` removes stored `command` rows recorded with a
 * sensitive form in clear; it is idempotent (redacted rows never match) and
 * runs once per engine start.
 */

import { maskSecretShapes } from "../decisions/gate";
import type { MarinaDB } from "../persistence/database";
import type { CommandDef, CommandInput, EntityId, RoomId } from "../types";
import type { CommandRouter } from "./command-router";

export const REDACTED_INPUT_MARK = "[redacted]";

function isSensitiveForm(def: CommandDef | undefined, input: CommandInput): boolean {
  const subs = def?.sensitiveSubcommands;
  if (!subs || subs.length === 0) return false;
  if (subs.includes("*")) return true;
  const sub = input.tokens[0]?.toLowerCase();
  return !!sub && subs.includes(sub);
}

/** Whether `input` is a plumbing form that records no `command` event (`CommandDef.unloggedSubcommands`). */
export function isUnloggedForm(def: CommandDef | undefined, input: CommandInput): boolean {
  const subs = def?.unloggedSubcommands;
  const sub = input.tokens[0]?.toLowerCase();
  return !!subs && !!sub && subs.includes(sub);
}

/** The input text a `command` event may carry. */
export function commandInputForLog(
  raw: string,
  input: CommandInput,
  def: CommandDef | undefined,
): string {
  if (isSensitiveForm(def, input)) {
    const sub = def?.sensitiveSubcommands?.includes("*") ? undefined : input.tokens[0];
    return [input.verb, sub?.toLowerCase(), REDACTED_INPUT_MARK].filter(Boolean).join(" ");
  }
  return maskSecretShapes(raw);
}

/**
 * `commandInputForLog` for raw text outside the command phase (challenge
 * summaries, approver notices): parsed and resolved against the builtins.
 */
export function redactCommandText(
  router: Pick<CommandRouter, "parse" | "getDef">,
  raw: string,
): string {
  const input = router.parse(raw, "" as EntityId, "" as RoomId);
  return commandInputForLog(raw, input, input.verb ? router.getDef(input.verb) : undefined);
}

/** SQL `LIKE` patterns (lower-case) matching a sensitive form typed in clear. */
export function sensitiveCommandPatterns(defs: readonly CommandDef[]): string[] {
  const patterns: string[] = [];
  for (const def of defs) {
    const subs = def.sensitiveSubcommands;
    if (!subs?.length) continue;
    for (const verb of [def.name, ...(def.aliases ?? [])]) {
      const v = verb.toLowerCase();
      if (subs.includes("*")) patterns.push(`${v} %`);
      else for (const sub of subs) patterns.push(`${v} ${sub.toLowerCase()} %`);
    }
  }
  return patterns;
}

/**
 * Delete stored `command` events whose input is a sensitive form in clear.
 * The event log is row-bounded telemetry, so removing these rows loses no
 * record anything else depends on. Returns the number removed.
 */
export function purgeSensitiveCommandEvents(db: MarinaDB, defs: readonly CommandDef[]): number {
  const patterns = sensitiveCommandPatterns(defs).filter((p) => /^[a-z0-9 %_.-]+$/.test(p));
  if (patterns.length === 0 || !db.tableExists("event_log")) return 0;
  const input = "lower(ltrim(json_extract(data, '$.input')))";
  const where =
    `type = 'command' AND (${patterns.map(() => `${input} LIKE ?`).join(" OR ")})` +
    ` AND json_extract(data, '$.input') NOT LIKE '% ${REDACTED_INPUT_MARK}'`;
  let total = 0;
  for (let batch = 0; batch < 1000; batch++) {
    const removed = db.deleteBatch("event_log", where, patterns, 5000);
    total += removed;
    if (removed < 5000) break;
  }
  return total;
}
