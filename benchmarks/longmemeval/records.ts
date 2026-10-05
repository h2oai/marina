// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LongMemEval-V2 trajectories → canonical memory records, and retrieved records →
 * reader context. Pure functions: no database, no model, no benchmark metadata.
 *
 * A trajectory (one web-agent run: goal, outcome, ordered states with URL, thought,
 * action and accessibility tree) becomes:
 * - one `observation` record per state: its header plus the page's accessibility tree,
 *   so page content is searchable;
 * - one `episode` record: goal, outcome and the compact action sequence, so workflow
 *   and failure questions can match a whole run.
 *
 * Nothing here reads a question id, type or gold answer; the memory system only ever
 * sees trajectories (insert) and question text (query), as the benchmark requires.
 */

import { queryTerms } from "../../src/memory/unified-context";

/** The canonical record content limit is 65,536 bytes; stay below it with margin. */
export const MAX_RECORD_BYTES = 60_000;

export interface LmeState {
  state_index?: number;
  step?: number | null;
  url?: string | null;
  action?: string | null;
  thought?: string | null;
  accessibility_tree?: string | null;
}

export interface LmeTrajectory {
  id: string;
  domain?: string;
  environment?: string;
  goal?: unknown;
  outcome?: string | null;
  start_url?: string | null;
  states?: LmeState[];
}

export type RecordKind = "state" | "episode";

export interface TrajectoryRecord {
  /** Idempotency key: one record per (trajectory, state) or per trajectory. */
  key: string;
  kind: RecordKind;
  trajectoryId: string;
  stateIndex?: number;
  input: {
    content: string;
    type: "observation" | "episode";
    subject: string;
    metadata: Record<string, unknown>;
  };
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes - 3) lo = mid;
    else hi = mid - 1;
  }
  // Never end on a lone high surrogate.
  const code = text.charCodeAt(lo - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo;
  return `${text.slice(0, end)}…`;
}

export function goalText(goal: unknown): string {
  if (typeof goal === "string") return goal.trim();
  if (goal && typeof goal === "object") {
    const g = goal as Record<string, unknown>;
    for (const key of ["text", "goal", "utterance"])
      if (typeof g[key] === "string") return (g[key] as string).trim();
    return JSON.stringify(goal);
  }
  return "";
}

const oneLine = (text: string | null | undefined, max: number) =>
  truncateBytes((text ?? "").replace(/\s+/g, " ").trim(), max);

function stateHeader(t: LmeTrajectory, s: LmeState, index: number, total: number): string {
  return [
    `[trajectory ${t.id} · state ${index + 1} of ${total}${s.step != null ? ` · step ${s.step}` : ""}]`,
    `goal: ${oneLine(goalText(t.goal), 1500)}`,
    `outcome: ${t.outcome ?? "unknown"}`,
    `url: ${s.url ?? ""}`,
    `thought: ${oneLine(s.thought, 2000) || "(none)"}`,
    `action: ${oneLine(s.action, 1000) || "(none)"}`,
  ].join("\n");
}

/** The compact action sequence of a run (one line per state), used by episodes and slices. */
export function actionSequence(t: LmeTrajectory, thoughtBytes = 240): string {
  const states = t.states ?? [];
  return states
    .map((s, i) => {
      const action = oneLine(s.action, 300) || "(start)";
      const thought = oneLine(s.thought, thoughtBytes);
      return `${i + 1}. ${action}${thought ? ` — ${thought}` : ""}`;
    })
    .join("\n");
}

/** Every canonical record a trajectory contributes, in insertion order. */
export function trajectoryRecords(t: LmeTrajectory): TrajectoryRecord[] {
  const states = t.states ?? [];
  const subject = `lme-trajectory:${t.id}`.slice(0, 256);
  const out: TrajectoryRecord[] = states.map((s, i) => {
    const header = stateHeader(t, s, i, states.length);
    const page = (s.accessibility_tree ?? "").trim();
    const content = truncateBytes(page ? `${header}\npage:\n${page}` : header, MAX_RECORD_BYTES);
    return {
      key: `lme:${t.id}:${i}`,
      kind: "state" as const,
      trajectoryId: t.id,
      stateIndex: i,
      input: {
        content,
        type: "observation" as const,
        subject,
        metadata: { lme: "state", trajectory_id: t.id, state_index: i },
      },
    };
  });
  const episode = [
    `[trajectory ${t.id} · episode of ${states.length} states]`,
    `goal: ${goalText(t.goal)}`,
    `outcome: ${t.outcome ?? "unknown"}`,
    `start url: ${t.start_url ?? states[0]?.url ?? ""}`,
    "actions:",
    actionSequence(t),
  ].join("\n");
  out.push({
    key: `lme:${t.id}:episode`,
    kind: "episode",
    trajectoryId: t.id,
    input: {
      content: truncateBytes(episode, MAX_RECORD_BYTES),
      type: "episode",
      subject,
      metadata: { lme: "episode", trajectory_id: t.id, state_count: states.length },
    },
  });
  return out;
}

/**
 * An extractive excerpt of a long record: the header lines always, then the body
 * lines that share the most distinct query terms, in their original order, until the
 * byte budget is spent. Gaps are marked `…`. Short records come back whole.
 */
export function excerpt(content: string, query: string, maxBytes: number, headerLines = 6): string {
  if (Buffer.byteLength(content) <= maxBytes) return content;
  const lines = content.split("\n");
  const head = lines.slice(0, headerLines).join("\n");
  const terms = queryTerms(query).filter((t) => t.length > 2);
  const body = lines.slice(headerLines);
  const scored = body.map((line, i) => {
    const lower = line.toLowerCase();
    let hits = 0;
    for (const t of terms) if (lower.includes(t)) hits++;
    return { i, hits };
  });
  let budget = maxBytes - Buffer.byteLength(head) - 1;
  const keep = new Set<number>();
  for (const { i, hits } of [...scored].sort((a, b) => b.hits - a.hits || a.i - b.i)) {
    if (hits === 0 || budget <= 0) break;
    // A matching line brings its immediate neighbours (labels sit next to values).
    for (const j of [i - 1, i, i + 1]) {
      if (j < 0 || j >= body.length || keep.has(j)) continue;
      const cost = Buffer.byteLength(body[j]!) + 1;
      if (cost > budget) continue;
      keep.add(j);
      budget -= cost;
    }
  }
  // Fill what is left with the top of the page (navigation and title context).
  for (let j = 0; j < body.length && budget > 0; j++) {
    if (keep.has(j)) continue;
    const cost = Buffer.byteLength(body[j]!) + 1;
    if (cost > budget) break;
    keep.add(j);
    budget -= cost;
  }
  const parts: string[] = [head];
  let last = -1;
  for (const j of [...keep].sort((a, b) => a - b)) {
    if (j !== last + 1) parts.push("…");
    parts.push(body[j]!);
    last = j;
  }
  if (last !== body.length - 1) parts.push("…");
  return truncateBytes(parts.join("\n"), maxBytes);
}

export interface ContextOptions {
  /** Total bytes of reader context (all blocks). */
  contextBytes: number;
  /** Bytes per state in a slice (page excerpt included). */
  stateBytes: number;
  /** Bytes of an episode block (goal, outcome, actions). */
  episodeBytes: number;
  /** States on each side of a retrieved state. */
  radius: number;
}

export const DEFAULT_CONTEXT: ContextOptions = {
  contextBytes: 160_000,
  stateBytes: 10_000,
  episodeBytes: 6_000,
  radius: 1,
};

export interface Hit {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

/** What context assembly needs from the store: a record by (trajectory, state). */
export interface RecordLookup {
  state(trajectoryId: string, stateIndex: number): Promise<Hit | undefined>;
  episode(trajectoryId: string): Promise<Hit | undefined>;
  stateCount(trajectoryId: string): number;
}

/**
 * Ranked hits → reader context blocks, in rank order, within the byte budget. A
 * state hit is shown as a slice (± `radius` states, each an excerpt) under its run's
 * goal, outcome and action sequence; an episode hit as the run summary. No state or
 * run summary is shown twice.
 */
export async function renderContext(
  hits: readonly Hit[],
  query: string,
  lookup: RecordLookup,
  options: ContextOptions = DEFAULT_CONTEXT,
): Promise<{ blocks: string[]; used: string[] }> {
  const blocks: string[] = [];
  const used: string[] = [];
  const shownStates = new Set<string>();
  const shownEpisodes = new Set<string>();
  let remaining = options.contextBytes;
  const push = (block: string, ids: string[]) => {
    const size = Buffer.byteLength(block) + 2;
    if (size > remaining) return false;
    blocks.push(block);
    used.push(...ids);
    remaining -= size;
    return true;
  };
  for (const hit of hits) {
    if (remaining <= 512) break;
    const trajectoryId = String(hit.metadata.trajectory_id ?? "");
    if (!trajectoryId) continue;
    const episode = shownEpisodes.has(trajectoryId)
      ? undefined
      : hit.metadata.lme === "episode"
        ? hit
        : await lookup.episode(trajectoryId);
    const summary = episode
      ? excerpt(episode.content, query, Math.min(options.episodeBytes, remaining - 256), 3)
      : undefined;
    if (hit.metadata.lme === "episode") {
      if (!summary || shownEpisodes.has(trajectoryId)) continue;
      if (push(`### Past run ${trajectoryId} (summary)\n${summary}`, [hit.id]))
        shownEpisodes.add(trajectoryId);
      continue;
    }
    const center = Number(hit.metadata.state_index);
    if (!Number.isInteger(center) || shownStates.has(`${trajectoryId}:${center}`)) continue;
    const total = lookup.stateCount(trajectoryId);
    const slice: Hit[] = [];
    for (let i = center - options.radius; i <= center + options.radius; i++) {
      if (i < 0 || (total > 0 && i >= total) || shownStates.has(`${trajectoryId}:${i}`)) continue;
      const record = i === center ? hit : await lookup.state(trajectoryId, i);
      if (record) slice.push(record);
    }
    const parts = [`### Past run ${trajectoryId}, around state ${center + 1}`];
    const ids: string[] = [];
    if (summary && !shownEpisodes.has(trajectoryId)) {
      parts.push(summary);
      if (episode) ids.push(episode.id);
    }
    let budget = remaining - Buffer.byteLength(parts.join("\n")) - 64;
    const included: Hit[] = [];
    for (const record of slice) {
      if (budget <= 256) break;
      const text = excerpt(record.content, query, Math.min(options.stateBytes, budget));
      parts.push(text);
      ids.push(record.id);
      included.push(record);
      budget -= Buffer.byteLength(text) + 1;
    }
    if (included.length === 0) continue;
    if (push(parts.join("\n\n"), ids)) {
      if (summary) shownEpisodes.add(trajectoryId);
      for (const record of included)
        shownStates.add(`${trajectoryId}:${Number(record.metadata.state_index)}`);
    }
  }
  return { blocks, used };
}
