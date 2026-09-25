// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The discovery loop — what found the Civiqs nowcast, run by Marina itself:
 * propose a signal, backtest it without leakage, promote it only if it wins
 * where the proposer could not look.
 *
 *   1. resolved numeric rounds of one family (answers public at lock excluded),
 *      split BY TIME: older → discovery, newer → holdout
 *   2. a proposer model sees the family, the signal language, the incumbent's
 *      and every earlier attempt's DISCOVERY score — never a holdout score
 *   3. each valid, new proposal is scored on both halves
 *   4. promote only if it beats the incumbent on the holdout by a margin that
 *      GROWS with the number of signals tried for the family (fishing costs),
 *      and does not lose on discovery
 *   5. every attempt — winners and losers — is kept as a note, so the next
 *      round of discovery starts from what was learnt and nothing is retried
 *
 * Promotion is necessary, not sufficient: a promoted signal is a candidate for
 * the forward shadow test (`arena shadow`), which is the only test on
 * outcomes no one had seen.
 */

import type { NotesStore } from "../../persistence/interfaces/notes-store";
import type { ArenaData } from "../data";
import { outcomePublicBeforeLock } from "../evaluate";
import { PERSISTENCE_SD } from "../forecast";
import { parseReply } from "../model-forecaster";
import { crpsNormal, skill } from "../score";
import type { ArenaRound } from "../types";
import { applySignal, type SignalSpec, signalKey, validateSignal } from "./signals";

export const DISCOVERY_ENTITY = "arena-discovery";
const NOTE_TYPE = "signal";
const DISCOVERY_SHARE = 0.6;
const MIN_HOLDOUT = 3;
/** The production forecaster (the nowcast over the calibrated baseline), in the signal language. */
export const INCUMBENT: SignalSpec = { centre: "nowcast", spread: "baseline" };

export interface Score {
  skill: number;
  n: number;
  wins: number;
}

export interface SignalRecord {
  spec: SignalSpec;
  key: string;
  rationale?: string;
  discovery?: Score;
  holdout?: Score;
  incumbent?: { discovery: Score; holdout: Score };
  margin?: number;
  verdict: "promoted" | "rejected" | "invalid" | "duplicate";
  reason: string;
  at: number;
}

export type Proposer = (prompt: string) => Promise<string>;

interface ScoredRound {
  round: ArenaRound;
  outcome: number;
}

/** Resolved, clean numeric rounds of a family, oldest lock first. */
export async function familyRounds(data: ArenaData, tracker: string): Promise<ScoredRound[]> {
  const resolved = await data.resolutions();
  return (await data.rounds())
    .filter(
      (r) =>
        r.tracker === tracker &&
        r.target_type === "continuous_normal" &&
        typeof resolved[r.round_id]?.value === "number" &&
        !outcomePublicBeforeLock(r, resolved[r.round_id]?.observed_date),
    )
    .sort((a, b) => a.lock_at.localeCompare(b.lock_at))
    .map((round) => ({ round, outcome: resolved[round.round_id]!.value as number }));
}

export async function scoreSignal(
  spec: SignalSpec,
  rounds: ScoredRound[],
  data: ArenaData,
): Promise<Score> {
  const skills: number[] = [];
  for (const { round, outcome } of rounds) {
    const lock = await data.lock(round.round_id).catch(() => undefined);
    const history = lock?.answer_history ?? lock?.history ?? [];
    if (!lock || history.length === 0) continue;
    const pers = crpsNormal(history.at(-1)!.value, PERSISTENCE_SD, outcome);
    try {
      const f = await applySignal(spec, round, lock, data);
      skills.push(skill(crpsNormal(f.mean, f.sd, outcome), pers));
    } catch {
      // A signal that cannot answer a round simply has no score there.
    }
  }
  const n = skills.length;
  return {
    skill: n ? skills.reduce((a, b) => a + b, 0) / n : Number.NaN,
    n,
    wins: skills.filter((s) => s > 0).length,
  };
}

/** Every recorded attempt for a family, oldest first. */
export function pastAttempts(notes: NotesStore, tracker: string): SignalRecord[] {
  return notes
    .getNotesByType(DISCOVERY_ENTITY, NOTE_TYPE, 2_000)
    .map((n) => {
      try {
        return JSON.parse(n.content.replace(/^\[signal\]\s*/, "")) as SignalRecord;
      } catch {
        return undefined;
      }
    })
    .filter((r): r is SignalRecord => !!r && (r.spec.tracker ?? "*") === tracker)
    .sort((a, b) => a.at - b.at);
}

/** The best promoted signal per family (by holdout skill). */
export function promotedSignals(notes: NotesStore): Map<string, SignalRecord> {
  const best = new Map<string, SignalRecord>();
  for (const n of notes.getNotesByType(DISCOVERY_ENTITY, NOTE_TYPE, 2_000)) {
    try {
      const r = JSON.parse(n.content.replace(/^\[signal\]\s*/, "")) as SignalRecord;
      const t = r.spec.tracker;
      if (r.verdict !== "promoted" || !t) continue;
      const cur = best.get(t);
      if (!cur || (r.holdout?.skill ?? -1) > (cur.holdout?.skill ?? -1)) best.set(t, r);
    } catch {
      // Not a discovery record.
    }
  }
  return best;
}

/** The margin a new signal must clear: fishing through more candidates raises the bar. */
export function promotionMargin(triedBefore: number): number {
  return 0.02 + 0.01 * Math.log2(1 + triedBefore);
}

export function buildProposal(
  tracker: string,
  rounds: number,
  incumbentDiscovery: Score,
  attempts: SignalRecord[],
  sample: number[],
  n: number,
): string {
  const tried = attempts
    .filter((a) => a.discovery)
    .map(
      (a) =>
        `- centre ${a.spec.centre}, spread ${a.spec.spread}: discovery skill ${a.discovery!.skill.toFixed(3)} (${a.discovery!.wins}/${a.discovery!.n} beat persistence)`,
    );
  return [
    `You are designing forecasting signals for the "${tracker}" family of a live benchmark scored by CRPS against persistence (last value, sd 1.5); skill 0 ties persistence, above 0 beats it.`,
    `There are ${rounds} resolved rounds; you only ever see results on the older part of them.`,
    `A recent history of one series in this family (oldest first): ${sample.map((x) => Math.round(x * 100) / 100).join(", ")}`,
    "",
    "The signal language (choose one centre and one spread):",
    "  centre: last | nowcast (freshest daily reading where the source publishes one) | ewma:<alpha 0.05-1> | mean:<k 2-12> | median:<k 3-12> | trend:<k 3-12> | nowcast-shrink:<w 0-1>",
    "  spread: arena (fixed 1.5) | baseline (calibrated from the series) | rms:<window 6-52> | mad:<window 6-52> | scale:<k 0.3-3> (times baseline)",
    "",
    `The incumbent (centre nowcast, spread baseline) scores ${incumbentDiscovery.skill.toFixed(3)} on the discovery rounds.`,
    tried.length ? `Already tried (do not repeat):\n${tried.join("\n")}` : "Nothing tried yet.",
    "",
    `Propose ${n} NEW signals likely to beat the incumbent, each with a one-sentence rationale grounded in how this family behaves.`,
    'Reply with ONE JSON object: {"signals": [{"centre": "...", "spread": "...", "rationale": "..."}]}',
  ].join("\n");
}

export async function discover(opts: {
  data: ArenaData;
  notes: NotesStore;
  tracker: string;
  propose: Proposer;
  n?: number;
  now?: () => number;
}): Promise<{ records: SignalRecord[]; note?: string }> {
  const { data, notes, tracker } = opts;
  const now = opts.now ?? Date.now;
  const rounds = await familyRounds(data, tracker);
  const cut = Math.floor(rounds.length * DISCOVERY_SHARE);
  const discovery = rounds.slice(0, cut);
  const holdout = rounds.slice(cut);
  if (holdout.length < MIN_HOLDOUT || discovery.length < MIN_HOLDOUT) {
    return {
      records: [],
      note: `${tracker}: ${rounds.length} clean resolved rounds — too few to split into discovery and holdout (need ${2 * MIN_HOLDOUT})`,
    };
  }
  const incumbent = {
    discovery: await scoreSignal(INCUMBENT, discovery, data),
    holdout: await scoreSignal(INCUMBENT, holdout, data),
  };
  const past = pastAttempts(notes, tracker);
  const seen = new Set(past.map((p) => p.key));
  const lock = await data.lock(discovery.at(-1)!.round.round_id).catch(() => undefined);
  const sample = (lock?.answer_history ?? lock?.history ?? []).slice(-20).map((p) => p.value);
  const prompt = buildProposal(
    tracker,
    rounds.length,
    incumbent.discovery,
    past,
    sample,
    opts.n ?? 5,
  );

  const reply = parseReply(await opts.propose(prompt));
  const proposals = Array.isArray(reply?.signals)
    ? (reply.signals as Array<Record<string, unknown>>)
    : [];
  const records: SignalRecord[] = [];
  let tried = past.filter((p) => p.verdict === "promoted" || p.verdict === "rejected").length;
  for (const p of proposals.slice(0, 12)) {
    const spec: SignalSpec = {
      centre: String(p.centre ?? ""),
      spread: String(p.spread ?? ""),
      tracker,
    };
    const key = signalKey(spec);
    const rationale = typeof p.rationale === "string" ? p.rationale.slice(0, 300) : undefined;
    const base = { spec, key, ...(rationale ? { rationale } : {}), at: now() };
    const invalid = validateSignal(spec);
    let record: SignalRecord;
    if (invalid) {
      record = { ...base, verdict: "invalid", reason: invalid };
    } else if (seen.has(key)) {
      record = { ...base, verdict: "duplicate", reason: "already tried" };
    } else {
      seen.add(key);
      const d = await scoreSignal(spec, discovery, data);
      const h = await scoreSignal(spec, holdout, data);
      const margin = promotionMargin(tried);
      tried++;
      const wins =
        h.skill >= incumbent.holdout.skill + margin && d.skill >= incumbent.discovery.skill;
      record = {
        ...base,
        discovery: d,
        holdout: h,
        incumbent,
        margin,
        verdict: wins ? "promoted" : "rejected",
        reason: wins
          ? `holdout ${h.skill.toFixed(3)} ≥ incumbent ${incumbent.holdout.skill.toFixed(3)} + ${margin.toFixed(3)}`
          : `holdout ${h.skill.toFixed(3)} vs incumbent ${incumbent.holdout.skill.toFixed(3)} (+${margin.toFixed(3)} needed); discovery ${d.skill.toFixed(3)} vs ${incumbent.discovery.skill.toFixed(3)}`,
      };
    }
    records.push(record);
    if (record.verdict === "promoted" || record.verdict === "rejected") {
      notes.createNote(DISCOVERY_ENTITY, `[signal] ${JSON.stringify(record)}`, undefined, {
        noteType: NOTE_TYPE,
        importance: record.verdict === "promoted" ? 8 : 4,
        skipDedup: true,
      });
    }
  }
  return { records };
}
