// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Formations in a room — a room's turn rule, set as a room property
 * (`RoomModule.formation`, by a world definition, a template or
 * `build formation`).
 *
 * The crew formation mediators (`crew-formations.ts`) react to crew events; a
 * room formation reacts to speech in the room. On each `say` the mediator
 * posts at most ONE structural line in the room, `[formation-mediator] …`,
 * naming the next actor with `@name`. That line is ordinary room speech
 * addressed to them, so attention (`src/agent/attention.ts`) wakes and owes it
 * like any addressed request — for in-process agents and supervised residents
 * alike; nothing else delivers it. A round ends on its own closing move (the
 * judge's ruling, the merge, the delivered fix) and the mediator goes quiet
 * until someone speaks again. No timers, no model calls, no caps.
 *
 * Pure functions over the speaker's name and who is present; the room's round
 * state is returned, never stored here.
 */

import {
  canonicalFormationName,
  ROOM_FORMATION_NAMES,
  type RoomFormationName,
} from "../orchestration/formations/catalogue";

/**
 * Formations a room can run: the catalogue entries marked `room` (each is
 * also a crew formation of the same name).
 */
export const ROOM_FORMATIONS: readonly RoomFormationName[] = ROOM_FORMATION_NAMES;
export type RoomFormation = RoomFormationName;

/** The canonical room formation for a name (legacy aliases normalized), or undefined. */
export function roomFormationName(name: string | undefined): RoomFormation | undefined {
  if (!name) return undefined;
  const canonical = canonicalFormationName(name);
  return (ROOM_FORMATIONS as readonly string[]).includes(canonical)
    ? (canonical as RoomFormation)
    : undefined;
}

/** Room store key for a formation set in-world (`build formation`); `off` clears the module's. */
export const ROOM_FORMATION_KEY = "formation";

/**
 * The formation a room runs: the in-world setting (persisted with the room's
 * store, so it survives a restart for world-defined rooms too), else the
 * room module's own `formation`.
 */
export function roomFormationOf(room: {
  module: { formation?: string };
  store?: { get<T = unknown>(key: string): T | undefined };
}): RoomFormation | undefined {
  const stored = room.store?.get<string>(ROOM_FORMATION_KEY);
  if (stored === "off") return undefined;
  return roomFormationName(stored ?? room.module.formation);
}

/** One round in progress: who has spoken, in order, and whether it is closing. */
export interface RoomRound {
  formation: RoomFormation;
  /** Speakers this round, first contribution each, in order. */
  spoke: string[];
  /** The one participant whose next message closes the round. */
  closer?: string;
  /** Verification only: the checkers' parsed `pass|fail` verdicts so far. */
  checks?: { pass: number; fail: number; by: string[] };
}

/**
 * The mechanical result a round closed with, when its formation defines one.
 * Only `verification` does: its checkers' `aspect: <aspect> pass|fail` lines.
 * A debate's ruling is free text (who won, not whether the method worked) and
 * a chorus merge has no verdict, so neither has a result.
 */
export interface RoomRoundResult {
  formation: RoomFormation;
  /** Whose work the round was about (the verification drafter). */
  owner: string;
  /** The checkers whose verdict parsed. */
  checkers: string[];
  pass: number;
  fail: number;
}

export interface RoomTurn {
  /** The structural line (without the `[formation-mediator]` prefix), if any. */
  line?: string;
  /** The names the line addresses — the actors now owed. */
  next: string[];
  /** The round after this message; undefined when the round closed. */
  round?: RoomRound;
  phase: "open" | "turn" | "close" | "closed" | "quiet";
  /** Set when the round closed with a mechanical result (see `RoomRoundResult`). */
  result?: RoomRoundResult;
}

const at = (names: readonly string[]) => names.map((name) => `@${name}`).join(" ");

/**
 * A verification checker's verdict from its message, in the grammar the
 * mediator asks for (`aspect: <aspect> pass|fail — <reason>`); undefined for
 * anything else. Read once, as a label: the words are never kept.
 */
export function aspectCheck(message: string | undefined): "pass" | "fail" | undefined {
  const m = /^\s*aspect\s*:\s*[\w-]+\s*[:—–-]?\s*(pass|fail)\b/i.exec(message ?? "");
  return m ? (m[1]!.toLowerCase() as "pass" | "fail") : undefined;
}

/**
 * The mediator's response to `speaker` saying something in a room running
 * `formation`, with `present` the names of everyone there (the speaker
 * included). Returns the round to keep for the next message. `check` is the
 * speaker's parsed verification verdict (`aspectCheck`), when it gave one.
 */
export function roomFormationTurn(
  formation: RoomFormation,
  round: RoomRound | undefined,
  speaker: string,
  present: readonly string[],
  check?: "pass" | "fail",
): RoomTurn {
  const current = round?.formation === formation ? round : undefined;
  if (current?.closer) {
    if (current.closer.toLowerCase() !== speaker.toLowerCase())
      return { next: [], round: current, phase: "quiet" };
    const checks = current.checks;
    const drafter = current.spoke[0];
    return {
      line: `${formation}: round closed by ${speaker}.`,
      next: [],
      phase: "closed",
      ...(formation === "verification" && drafter && checks && checks.pass + checks.fail > 0
        ? {
            result: {
              formation,
              owner: drafter,
              checkers: [...checks.by],
              pass: checks.pass,
              fail: checks.fail,
            },
          }
        : {}),
    };
  }
  const others = present.filter((name) => name.toLowerCase() !== speaker.toLowerCase());
  const spoke = current?.spoke ?? [];
  if (spoke.some((name) => name.toLowerCase() === speaker.toLowerCase()))
    return { next: [], round: current, phase: "quiet" };
  const nextSpoke = [...spoke, speaker];
  const unheard = (names: readonly string[]) =>
    names.filter((name) => !nextSpoke.some((s) => s.toLowerCase() === name.toLowerCase()));

  switch (formation) {
    case "debate": {
      if (nextSpoke.length === 1) {
        const opponent = others[0];
        if (!opponent) return { next: [], round: { formation, spoke: nextSpoke }, phase: "open" };
        return {
          line:
            `debate: ${speaker} took a position. ${at([opponent])}: answer it with your own ` +
            `position in one message; then a non-author judges.`,
          next: [opponent],
          round: { formation, spoke: nextSpoke },
          phase: "open",
        };
      }
      const [first, second] = nextSpoke;
      const judge = unheard(present)[0];
      if (!judge)
        return {
          line: `debate: both positions are in (${first}, ${second}). No one else is here to judge.`,
          next: [],
          phase: "closed",
        };
      return {
        line:
          `debate: both positions are in (${first}, ${second}). ${at([judge])}: judge in one ` +
          `message — pick one, with the reason; final.`,
        next: [judge],
        round: { formation, spoke: nextSpoke, closer: judge },
        phase: "close",
      };
    }
    case "chorus": {
      const pending = unheard(present);
      if (pending.length) {
        const lead = nextSpoke[0]!;
        return {
          line:
            nextSpoke.length === 1
              ? `chorus: ${speaker} started. ${at(pending)}: post your own part in one message, ` +
                `in parallel; ${lead} merges when all are in.`
              : `chorus: ${speaker} posted. Still to post: ${at(pending)}.`,
          next: pending,
          round: { formation, spoke: nextSpoke },
          phase: nextSpoke.length === 1 ? "open" : "turn",
        };
      }
      const lead = nextSpoke[0]!;
      if (nextSpoke.length === 1) return { next: [], phase: "quiet" };
      return {
        line: `chorus: every part is in. ${at([lead])}: merge them into one result and deliver it.`,
        next: [lead],
        round: { formation, spoke: nextSpoke, closer: lead },
        phase: "close",
      };
    }
    case "verification": {
      const drafter = nextSpoke[0]!;
      const pending = unheard(present);
      // A checker's first message is its check: keep its verdict (a label) when it parsed.
      const prior = current?.checks ?? { pass: 0, fail: 0, by: [] };
      const checks =
        nextSpoke.length > 1 && check
          ? {
              pass: prior.pass + (check === "pass" ? 1 : 0),
              fail: prior.fail + (check === "fail" ? 1 : 0),
              by: [...prior.by, speaker],
            }
          : prior;
      const kept = checks.by.length ? { checks } : {};
      if (nextSpoke.length === 1) {
        if (!pending.length) return { next: [], phase: "quiet" };
        return {
          line:
            `verification: ${drafter} posted a draft. ${at(pending)}: check ONE aspect each ` +
            `(correctness, requirements, evidence, safety) — \`say aspect: <aspect> ` +
            `pass|fail — <reason>\`.`,
          next: pending,
          round: { formation, spoke: nextSpoke },
          phase: "open",
        };
      }
      if (pending.length)
        return {
          line: `verification: ${speaker} checked. Still to check: ${at(pending)}.`,
          next: pending,
          round: { formation, spoke: nextSpoke, ...kept },
          phase: "turn",
        };
      return {
        line:
          `verification: every aspect is checked. ${at([drafter])}: fix any fail once, then ` +
          `deliver.`,
        next: [drafter],
        round: { formation, spoke: nextSpoke, closer: drafter, ...kept },
        phase: "close",
      };
    }
  }
}
