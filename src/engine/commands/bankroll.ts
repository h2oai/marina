// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";

/**
 * Bankroll command — risk gates at the data layer.
 *
 * Stores per-entity trading state in core memory. The position command
 * reads these values BEFORE placing any order; there is no flag to bypass.
 * Per the filter-at-source convention: classify at the data layer, don't
 * add a downstream pipeline.
 *
 * Single-word voice-friendly keys (TTS-safe):
 *   bankroll  — total USD allocated to trading
 *   kelly     — Kelly fraction (0.5 = half-Kelly default)
 *   cap       — max single position size in USD
 *   floor     — max daily loss in USD (positive number; converted to limit)
 *
 * Subcommands:
 *   bankroll show
 *   bankroll set <usd>
 *   bankroll kelly <fraction>          (e.g., bankroll kelly 0.5)
 *   bankroll cap <usd>                 (max single position)
 *   bankroll floor <usd>               (max daily loss, positive number)
 *   bankroll reset                     (clear all bankroll keys)
 */

export const BANKROLL_KEYS = {
  bankroll: "bankroll",
  kelly: "kelly",
  cap: "cap",
  floor: "floor",
} as const;

const HELP = `Bankroll & risk gates for trading. State stored in core memory; the 'position' command reads these before placing any order.

Usage:
  bankroll show                    — display current bankroll, kelly fraction, position cap, daily floor
  bankroll set <usd>               — set total trading bankroll (e.g., 'bankroll set 10000')
  bankroll kelly <fraction>        — set Kelly fraction 0-1 (default 0.5 = half-Kelly)
  bankroll cap <usd>               — max single position size (defense against typos + concentration)
  bankroll floor <usd>             — max daily loss in USD before trading halts
  bankroll reset                   — clear all bankroll keys

Ranks: 'bankroll show' works at rank 2+; set/kelly/cap/floor/reset need rank 5+.

Examples:
  bankroll set 10000
  bankroll kelly 0.5
  bankroll cap 500
  bankroll floor 500`;

export interface BankrollState {
  bankroll: number;
  kelly: number;
  cap: number;
  floor: number;
}

export const DEFAULT_BANKROLL_STATE: BankrollState = {
  bankroll: 0,
  kelly: 0.5,
  cap: 0,
  floor: 0,
};

/**
 * Read the bankroll state for an entity. Missing keys default to safe values
 * (0 bankroll = trading effectively disabled). Caller decides what to do
 * with zero values; position.ts treats bankroll=0 as "no trading allowed."
 */
export function readBankrollState(db: MarinaDB, entityName: string): BankrollState {
  const get = (key: string) => db.getCoreMemory(entityName, key)?.value;
  const num = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    bankroll: num(get(BANKROLL_KEYS.bankroll), 0),
    kelly: num(get(BANKROLL_KEYS.kelly), DEFAULT_BANKROLL_STATE.kelly),
    cap: num(get(BANKROLL_KEYS.cap), 0),
    floor: num(get(BANKROLL_KEYS.floor), 0),
  };
}

/**
 * Write-path rank gate. `bankroll show` is rank-2 (anyone past tutorial can
 * see their own state), but mutating subcommands need rank-5 — same gate as
 * code execution. The data-layer invariants (cap, floor, no-self-hedge in
 * position.ts) do the real protection; rank gates are friction reduction.
 */
const WRITE_MIN_RANK = 5;

function requireWriteRank(ctx: RoomContext, entity: Entity, eid: Entity["id"]): boolean {
  const rank = (entity.properties.rank as number) ?? 0;
  if (rank < WRITE_MIN_RANK) {
    ctx.send(eid, `This subcommand requires rank ${WRITE_MIN_RANK}+ (you are ${rank}).`);
    return false;
  }
  return true;
}

export function bankrollCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db: MarinaDB;
}): CommandDef {
  const { db } = deps;

  return {
    name: "bankroll",
    aliases: [],
    minRank: 2, // anyone past tutorial can read; mutations gated inline
    help: HELP,
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "show" || sub === "help") {
        if (sub === "help") {
          ctx.send(input.entity, HELP);
          return;
        }
        showBankroll(ctx, input.entity, entity, db);
        return;
      }

      switch (sub) {
        case "set":
          if (!requireWriteRank(ctx, entity, input.entity)) return;
          return setKey(ctx, input.entity, entity, db, BANKROLL_KEYS.bankroll, tokens[1], {
            min: 0,
            max: 100_000_000,
            label: "bankroll",
          });
        case "kelly":
          if (!requireWriteRank(ctx, entity, input.entity)) return;
          return setKey(ctx, input.entity, entity, db, BANKROLL_KEYS.kelly, tokens[1], {
            min: 0,
            max: 1,
            label: "Kelly fraction",
          });
        case "cap":
          if (!requireWriteRank(ctx, entity, input.entity)) return;
          return setKey(ctx, input.entity, entity, db, BANKROLL_KEYS.cap, tokens[1], {
            min: 0,
            max: 100_000_000,
            label: "position cap",
          });
        case "floor":
          if (!requireWriteRank(ctx, entity, input.entity)) return;
          return setKey(ctx, input.entity, entity, db, BANKROLL_KEYS.floor, tokens[1], {
            min: 0,
            max: 100_000_000,
            label: "daily loss floor",
          });
        case "reset":
          if (!requireWriteRank(ctx, entity, input.entity)) return;
          return resetBankroll(ctx, input.entity, entity, db);
        default:
          ctx.send(input.entity, `Unknown subcommand: ${sub}\n\n${HELP}`);
      }
    },
  };
}

function showBankroll(ctx: RoomContext, eid: Entity["id"], entity: Entity, db: MarinaDB): void {
  const state = readBankrollState(db, entity.name);
  const tradingEnabled = process.env.MARINA_TRADING_ENABLED === "true";
  const lines = [
    header("Bankroll"),
    separator(),
    `  ${dim("Total bankroll:")}  ${bold(fmtUsd(state.bankroll))}`,
    `  ${dim("Kelly fraction:")}  ${bold(state.kelly.toFixed(2))} ${dim(`(${(state.kelly * 100).toFixed(0)}% of full Kelly)`)}`,
    `  ${dim("Position cap:")}    ${bold(fmtUsd(state.cap))} ${dim("max single position")}`,
    `  ${dim("Daily floor:")}     ${bold(fmtUsd(state.floor))} ${dim("max daily loss before halt")}`,
    "",
    `  ${dim("Mode:")} ${tradingEnabled ? bold("LIVE TRADING ENABLED") : dim("paper trading (default)")}`,
  ];
  if (state.bankroll === 0) {
    lines.push("", dim("  Trading disabled — set bankroll > 0 to enable position commands."));
  } else if (state.cap === 0) {
    lines.push("", dim("  Position cap is 0 — set 'bankroll cap <usd>' before opening positions."));
  } else if (state.floor === 0) {
    lines.push(
      "",
      dim("  Daily floor is 0 — set 'bankroll floor <usd>' before opening positions."),
    );
  }
  ctx.send(eid, lines.join("\n"));
}

function setKey(
  ctx: RoomContext,
  eid: Entity["id"],
  entity: Entity,
  db: MarinaDB,
  key: string,
  raw: string | undefined,
  bounds: { min: number; max: number; label: string },
): void {
  if (!raw) {
    ctx.send(eid, `Usage: bankroll ${key} <value>`);
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    ctx.send(eid, `Invalid number: ${raw}`);
    return;
  }
  if (n < bounds.min || n > bounds.max) {
    ctx.send(eid, `${bounds.label} must be ${bounds.min}-${bounds.max}`);
    return;
  }
  db.setCoreMemory(entity.name, key, String(n));
  ctx.send(
    eid,
    `${bounds.label} set to ${bold(key === BANKROLL_KEYS.kelly ? n.toFixed(2) : fmtUsd(n))}.`,
  );
}

function resetBankroll(ctx: RoomContext, eid: Entity["id"], entity: Entity, db: MarinaDB): void {
  for (const key of Object.values(BANKROLL_KEYS)) {
    db.deleteCoreMemory(entity.name, key);
  }
  ctx.send(
    eid,
    "Bankroll cleared — trading is disabled until reconfigured. Start over with `bankroll set <usd>`, then `bankroll cap <usd>` and `bankroll floor <usd>`.",
  );
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
