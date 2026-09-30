// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Formation adherence scorer — did a crew follow its formation's protocol?
 *
 * The 2026-09 orchestration sweep measured whether crews FUNCTION under a
 * formation (answered / completed). This scorer measures whether they
 * FOLLOW it: for one crew-task window it reads the world database (crew
 * channel, tells, agent commands, board posts, pool notes, tasks) and scores
 * each step of the formation's runtime brief (`CREW_BRIEFS`) 0–1, plus the
 * project-convention markers of its pool template.
 *
 * Two layers, reported separately. `brief` steps are the protocol a crew is
 * expected to follow: the runtime brief and the per-task `[crew-task]`
 * dispatch restate them, and they alone make up the headline score
 * (`summarizeAdherence().brief`). `convention` markers come from the pool
 * templates, which are advisory reference material members may read on
 * joining; they are kept as a reported diagnostic (`.convention`) and are
 * excluded from the headline.
 *
 * Deterministic checks run here. Steps that need judgement (e.g. "the lead
 * picked the strongest proposal") are returned as `method: "judge"` with a
 * question and no score; `buildJudgePacket()` renders the window transcript
 * for an external judge model, so the scorer itself never calls a model.
 *
 * Usage:
 *   bun run benchmarks/formation-adherence.ts --db world.db --formation delphi \
 *     --since <epoch-s> --until <epoch-s> [--crew answerer] [--pool eval-artifacts] \
 *     [--oracle "17*23,144/12"] [--runnable] [--json] [--packet out.json]
 */

import { Database } from "bun:sqlite";

// ─── Transcript ──────────────────────────────────────────────────────────────

export type EventKind = "chan" | "tell" | "cmd" | "board" | "note" | "task";

export interface TranscriptEvent {
  t: number; // epoch ms
  kind: EventKind;
  actor: string;
  target?: string; // tell recipient
  text: string;
  pool?: string; // note pool name
  tags?: string; // board tags JSON
}

export interface Transcript {
  crew: string;
  members: string[];
  lead?: string;
  deliverablePool: string;
  start: number;
  end: number;
  events: TranscriptEvent[];
  /** Oracle expressions for a task with a mechanical checker (e.g. calc lines). */
  oracle?: string[];
  /** Expected corrected deliverable for an oracle task (regex source). */
  oracleOk?: string;
  /** Whether the task has claims that can be checked by running something. */
  runnable?: boolean;
}

/** System senders that are never crew contributions. */
const SYSTEM_SENDERS = new Set(["crew", "__crew_manager__", "Operator", "system"]);

export function loadTranscript(
  dbPath: string,
  opts: {
    crew?: string;
    since: number;
    until: number;
    pool?: string;
    oracle?: string[];
    oracleOk?: string;
    runnable?: boolean;
  },
): Transcript {
  const db = new Database(dbPath, { readonly: true });
  try {
    const crewName = opts.crew ?? "answerer";
    const crew = db.query("SELECT id, channel_id FROM crews WHERE name = ?").get(crewName) as {
      id: string;
      channel_id: string | null;
    } | null;
    if (!crew) throw new Error(`crew "${crewName}" not found`);
    const memberRows = db
      .query("SELECT agent_name, role FROM crew_members WHERE crew_id = ?")
      .all(crew.id) as { agent_name: string; role: string }[];
    const members = memberRows.map((m) => m.agent_name);
    const lead = memberRows.find((m) => m.role === "lead")?.agent_name;
    const memberSet = new Set(members);
    const start = opts.since;
    const end = opts.until;
    const events: TranscriptEvent[] = [];

    if (crew.channel_id) {
      for (const r of db
        .query(
          "SELECT sender_name, content, created_at FROM channel_messages WHERE channel_id = ? AND created_at BETWEEN ? AND ? ORDER BY id",
        )
        .all(crew.channel_id, start, end) as {
        sender_name: string;
        content: string;
        created_at: number;
      }[]) {
        events.push({ t: r.created_at, kind: "chan", actor: r.sender_name, text: r.content });
      }
    }
    for (const r of db
      .query(
        "SELECT sender_name, target_name, content, created_at FROM direct_messages WHERE created_at BETWEEN ? AND ? ORDER BY id",
      )
      .all(start, end) as {
      sender_name: string;
      target_name: string;
      content: string;
      created_at: number;
    }[]) {
      if (!memberSet.has(r.sender_name) && !memberSet.has(r.target_name)) continue;
      events.push({
        t: r.created_at,
        kind: "tell",
        actor: r.sender_name,
        target: r.target_name,
        text: r.content,
      });
    }
    const names = new Map<string, string>();
    for (const r of db.query("SELECT id, name FROM entities").all() as {
      id: string;
      name: string;
    }[])
      names.set(r.id, r.name);
    for (const r of db
      .query(
        "SELECT data, timestamp FROM event_log WHERE type = 'command' AND timestamp BETWEEN ? AND ? ORDER BY id",
      )
      .all(start, end) as { data: string; timestamp: number }[]) {
      let d: { entity?: string; input?: string };
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      const actor = d.entity ? (names.get(d.entity) ?? d.entity) : "";
      const input = d.input ?? "";
      if (!memberSet.has(actor) || input.startsWith("memory api ")) continue;
      events.push({ t: r.timestamp, kind: "cmd", actor, text: input });
    }
    for (const r of db
      .query(
        "SELECT author_name, title, body, tags, created_at FROM board_posts WHERE created_at BETWEEN ? AND ? ORDER BY id",
      )
      .all(start, end) as {
      author_name: string;
      title: string;
      body: string;
      tags: string;
      created_at: number;
    }[]) {
      events.push({
        t: r.created_at,
        kind: "board",
        actor: r.author_name,
        text: `${r.title} ${r.body}`.trim(),
        tags: r.tags,
      });
    }
    for (const r of db
      .query(
        "SELECT n.entity_name, n.content, n.created_at, p.name AS pool FROM numeric_notes n JOIN memory_pools p ON p.id = n.pool_id WHERE n.created_at BETWEEN ? AND ? ORDER BY n.id",
      )
      .all(start, end) as {
      entity_name: string;
      content: string;
      created_at: number;
      pool: string;
    }[]) {
      events.push({
        t: r.created_at,
        kind: "note",
        actor: r.entity_name,
        text: r.content ?? "",
        pool: r.pool,
      });
    }
    for (const r of db
      .query(
        "SELECT creator_name, title, description, created_at FROM tasks WHERE created_at BETWEEN ? AND ? ORDER BY id",
      )
      .all(start, end) as {
      creator_name: string;
      title: string;
      description: string;
      created_at: number;
    }[]) {
      if (!memberSet.has(r.creator_name)) continue;
      events.push({
        t: r.created_at,
        kind: "task",
        actor: r.creator_name,
        text: `${r.title} | ${r.description}`,
      });
    }
    events.sort((a, b) => a.t - b.t);
    return {
      crew: crewName,
      members,
      lead,
      deliverablePool: opts.pool ?? "eval-artifacts",
      start,
      end,
      events,
      oracle: opts.oracle,
      oracleOk: opts.oracleOk,
      runnable: opts.runnable,
    };
  } finally {
    db.close();
  }
}

// ─── Step definitions ────────────────────────────────────────────────────────

export interface StepResult {
  step: string;
  layer: "brief" | "convention";
  method: "det" | "judge";
  /** 0–1, or null when the step does not apply (N/A) or awaits a judge. */
  score: number | null;
  evidence: string;
  question?: string;
}

interface Step {
  id: string;
  layer: "brief" | "convention";
  /** Deterministic check; omitted for judged steps. */
  check?: (v: View) => { score: number | null; evidence: string };
  /** Judge question for steps that need judgement. */
  question?: string;
}

/** Derived, formation-independent view of a transcript. */
interface View {
  tr: Transcript;
  nonLead: string[];
  /** Crew channel posts by members (system and operator lines excluded). */
  posts: TranscriptEvent[];
  tellsToMembers: TranscriptEvent[];
  cmds: TranscriptEvent[];
  deliverables: TranscriptEvent[];
  firstDeliverable?: TranscriptEvent;
  contributions: TranscriptEvent[];
}

function buildView(tr: Transcript): View {
  const memberSet = new Set(tr.members);
  const posts = tr.events.filter(
    (e) => e.kind === "chan" && memberSet.has(e.actor) && !SYSTEM_SENDERS.has(e.actor),
  );
  const tellsToMembers = tr.events.filter(
    (e) => e.kind === "tell" && memberSet.has(e.actor) && memberSet.has(e.target ?? ""),
  );
  const deliverables = tr.events.filter(
    (e) => e.kind === "note" && e.pool === tr.deliverablePool && memberSet.has(e.actor),
  );
  const contributions = [...posts, ...tellsToMembers].sort((a, b) => a.t - b.t);
  return {
    tr,
    nonLead: tr.members.filter((m) => m !== tr.lead),
    posts,
    tellsToMembers,
    cmds: tr.events.filter((e) => e.kind === "cmd"),
    deliverables,
    firstDeliverable: deliverables[0],
    contributions,
  };
}

const clip = (s: string, n = 140) =>
  (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ");
const quote = (e: TranscriptEvent | undefined) =>
  e ? `${e.actor}${e.target ? `→${e.target}` : ""} (${e.kind}): "${clip(e.text)}"` : "none";
const frac = (n: number, d: number) => (d <= 0 ? null : Math.min(1, n / d));
const before = (e: TranscriptEvent, t: number | undefined) => t === undefined || e.t <= t;

/** Normalize a calc expression for oracle matching. */
const normExpr = (s: string) => s.replace(/\s+/g, "").replace(/\*\*/g, "^");

function calcCoverage(cmds: TranscriptEvent[], oracle: string[]): Set<string> {
  const want = new Map(oracle.map((o) => [normExpr(o), o]));
  const hit = new Set<string>();
  for (const c of cmds) {
    if (!/^(batch\s+)?calc\b/i.test(c.text) && !/;\s*calc\b/i.test(c.text)) continue;
    const body = normExpr(c.text);
    for (const [k, o] of want) if (body.includes(k)) hit.add(o);
  }
  return hit;
}

function tagged(v: View, tag: RegExp, kinds: EventKind[]): TranscriptEvent[] {
  return v.tr.events.filter(
    (e) => kinds.includes(e.kind) && (tag.test(e.text) || (e.tags ? tag.test(e.tags) : false)),
  );
}

const cmdMatching = (v: View, re: RegExp) => v.cmds.filter((c) => re.test(c.text));

/** Presence check over the given event kinds, for convention markers. */
function marker(id: string, re: RegExp, kinds: EventKind[]): Step {
  return {
    id,
    layer: "convention",
    check: (v) => {
      const hits = tagged(v, re, kinds);
      return { score: hits.length > 0 ? 1 : 0, evidence: hits.length ? quote(hits[0]) : "absent" };
    },
  };
}

function cmdMarker(id: string, re: RegExp): Step {
  return {
    id,
    layer: "convention",
    check: (v) => {
      const hits = cmdMatching(v, re);
      return { score: hits.length > 0 ? 1 : 0, evidence: hits.length ? quote(hits[0]) : "absent" };
    },
  };
}

/** Exactly one deliverable: 1/count, 0 when none. */
const singleDeliverable: Step = {
  id: "single-deliverable",
  layer: "brief",
  check: (v) => ({
    score: v.deliverables.length === 0 ? 0 : 1 / v.deliverables.length,
    evidence: `${v.deliverables.length} deliverable(s): ${v.deliverables.map((d) => d.actor).join(", ") || "none"}`,
  }),
};

/** The lead wrote the deliverable (0.5 when someone else did). */
const leadDelivers: Step = {
  id: "lead-delivers",
  layer: "brief",
  check: (v) => {
    const d = v.firstDeliverable;
    if (!d) return { score: 0, evidence: "no deliverable" };
    return { score: d.actor === v.tr.lead ? 1 : 0.5, evidence: `first deliverable by ${d.actor}` };
  },
};

/** Fraction of members contributing on the channel before the deliverable. */
function membersPostBeforeDelivery(id: string): Step {
  return {
    id,
    layer: "brief",
    check: (v) => {
      const t = v.firstDeliverable?.t;
      const who = new Set(v.posts.filter((p) => before(p, t)).map((p) => p.actor));
      return {
        score: frac(who.size, v.tr.members.length),
        evidence: `${who.size}/${v.tr.members.length} members posted before delivery: ${[...who].join(", ")}`,
      };
    },
  };
}

const ranChecks: Step = {
  id: "ran-checks",
  layer: "brief",
  check: (v) => {
    if (!v.tr.runnable) return { score: null, evidence: "task has no runnable claim" };
    const calcs = cmdMatching(v, /(^|;\s*|batch\s+)calc\b/i);
    const author = v.firstDeliverable?.actor;
    const verifiers = new Set(calcs.filter((c) => c.actor !== author).map((c) => c.actor));
    return {
      score: verifiers.size > 0 ? 1 : calcs.length > 0 ? 0.5 : 0,
      evidence: `${calcs.length} calc run(s); by non-authors: ${[...verifiers].join(", ") || "none"}`,
    };
  },
};

/** A contribution with content, not a bare acknowledgement. */
const substantive = (e: TranscriptEvent) => e.text.trim().length >= 60;
const REVISION = /revis|updat|stick|keep|hold|stay|mov(e|ed|ing)|final|chang|\d/i;

/**
 * An actual shard post: the brief's `shard 1: <case>` line, or a `Shards: C3, C5`
 * list with something in it. A mention ("no shards needed", "shards: none") is not one.
 */
export const SHARD_POST = /\bshard\s*#?\d+\s*:|\bshards\s*:\s*(?!(?:none|n\/a|no|nothing)\b)\w/i;
/** A shard handed out as a task (`task create shard 2: C5 | …`). */
export const SHARD_TASK = /^\s*task\s+create\b.*\bshard\b/i;

/**
 * An aspect verdict: an aspect name and an explicit pass/fail within a few words of each other
 * ("correctness: pass", "requirements — FAIL", "PASS (evidence)"). Loose words such as
 * "verified" or "correct" alone are not verdicts.
 */
const ASPECT_VERDICT =
  /\b(correctness|requirements?|constraints?|format|evidence|citations?|safety)\b\W{0,4}(?:\w+\W{1,3}){0,2}(pass(?:es|ed)?|fail(?:s|ed)?)\b|\b(pass(?:es|ed)?|fail(?:s|ed)?)\b\W{0,4}(?:\w+\W{1,3}){0,2}(correctness|requirements?|constraints?|format|evidence|citations?|safety)\b/i;
const aspectOf = (text: string): string | undefined => {
  const m = text.match(ASPECT_VERDICT);
  const a = m?.[1] ?? m?.[4];
  return a?.toLowerCase().replace(/s$/, "");
};

export const FORMATION_STEPS: Record<string, Step[]> = {
  freeform: [
    {
      id: "talk-on-channel",
      layer: "brief",
      check: (v) => {
        const who = new Set(v.posts.map((p) => p.actor));
        return { score: frac(who.size, 2), evidence: `${who.size} member(s) posted` };
      },
    },
    {
      id: "divide-by-strength",
      layer: "brief",
      question:
        "Did members divide the work by strength (different members visibly took different parts or roles) rather than each doing the whole task independently?",
    },
    singleDeliverable,
  ],
  deliberation: [
    membersPostBeforeDelivery("one-proposal-each"),
    {
      id: "lead-picks",
      layer: "brief",
      question:
        "Did the lead explicitly pick (or merge) the strongest proposal in a message before the deliverable was written?",
    },
    {
      id: "one-round",
      layer: "brief",
      question:
        "Was there exactly one proposal round before execution (no second round of proposals or re-votes)?",
    },
    {
      id: "picked-owner-executes",
      layer: "brief",
      check: (v) => {
        const d = v.firstDeliverable;
        if (!d) return { score: 0, evidence: "no deliverable" };
        const proposers = new Set(v.posts.filter((p) => p.t <= d.t).map((p) => p.actor));
        return {
          score: proposers.size >= 2 ? 1 : 0.5,
          evidence: `deliverable by ${d.actor} after ${proposers.size} proposer(s)`,
        };
      },
    },
    {
      id: "debrief",
      layer: "brief",
      check: (v) => {
        const d = v.firstDeliverable;
        if (!d) return { score: 0, evidence: "no deliverable" };
        const hit = v.posts.find(
          (p) =>
            p.t > d.t && /debrief|lesson|what worked|went well|next time|learned/i.test(p.text),
        );
        return { score: hit ? 1 : 0, evidence: quote(hit) };
      },
    },
    marker("board-proposal", /\[proposal\]/i, ["board"]),
    cmdMarker("board-vote", /^board vote\b/i),
    marker("lesson-note", /\[lesson\]/i, ["note"]),
  ],
  chorus: [
    membersPostBeforeDelivery("partials-on-wall"),
    {
      id: "crossfire-review",
      layer: "brief",
      question:
        "Before completion, did members review/critique ANOTHER member's partial result (crossfire review)? Score the fraction of members who did.",
    },
    leadDelivers,
    marker("starting-broadcast", /\bstarting:/i, ["chan"]),
    marker("critique-tag", /\[critique\]|\[crossfire/i, ["chan", "board", "note"]),
  ],
  delphi: [
    {
      id: "private-estimate-first",
      layer: "brief",
      check: (v) => {
        const lead = v.tr.lead;
        let ok = 0;
        const detail: string[] = [];
        for (const m of v.nonLead) {
          const first = v.contributions.find((e) => e.actor === m && substantive(e));
          const priv = first?.kind === "tell" && first.target === lead;
          if (priv) ok++;
          detail.push(`${m}:${first ? (priv ? "tell→lead" : first.kind) : "silent"}`);
        }
        return { score: frac(ok, v.nonLead.length), evidence: detail.join(" ") };
      },
    },
    {
      id: "anonymized-summary",
      layer: "brief",
      check: (v) => {
        const sum = v.posts.find(
          (p) => p.actor === v.tr.lead && /summary|range|median/i.test(p.text),
        );
        if (!sum) return { score: 0, evidence: "no lead summary on channel" };
        const named = v.nonLead.filter((m) => new RegExp(`\\b${m}\\b`).test(sum.text));
        return {
          score: named.length === 0 ? 1 : 0.5,
          evidence: `${named.length ? `names ${named.join(",")}; ` : ""}${quote(sum)}`,
        };
      },
    },
    {
      id: "summary-before-delivery",
      layer: "brief",
      check: (v) => {
        const sum = v.posts.find(
          (p) => p.actor === v.tr.lead && /summary|range|median/i.test(p.text),
        );
        const d = v.firstDeliverable;
        if (!sum || !d) return { score: 0, evidence: "summary or deliverable missing" };
        return {
          score: sum.t <= d.t ? 1 : 0,
          evidence: `summary ${sum.t <= d.t ? "before" : "after"} delivery`,
        };
      },
    },
    {
      id: "members-revise",
      layer: "brief",
      check: (v) => {
        const sum = v.posts.find(
          (p) => p.actor === v.tr.lead && /summary|range|median/i.test(p.text),
        );
        if (!sum) return { score: 0, evidence: "no summary to revise against" };
        const revisers = new Set(
          v.contributions
            .filter((e) => e.t > sum.t && e.actor !== v.tr.lead && REVISION.test(e.text))
            .map((e) => e.actor),
        );
        return {
          score: frac(revisers.size, v.nonLead.length),
          evidence: `${revisers.size}/${v.nonLead.length} non-lead revised after summary: ${[...revisers].join(", ")}`,
        };
      },
    },
    {
      id: "dissent-kept",
      layer: "brief",
      question:
        "Does the final deliverable or the lead's final message keep at least one dissenting reason that survived revision (score 1), mention dissent vaguely (0.5), or drop it (0)? If there was no dissent at all, answer null.",
    },
    cmdMarker("private-draft-kv", /^memory kv set estimate\b/i),
    marker("estimate-tag", /\[estimate\]/i, ["tell"]),
    marker("delphi-summary-post", /\[delphi-summary\]/i, ["board", "note"]),
    marker("delphi-ruling-note", /\[delphi-ruling\]/i, ["note"]),
  ],
  tournament: [
    {
      id: "solo-candidates",
      layer: "brief",
      check: (v) => {
        const drafts = cmdMatching(v, /^crew artifact \S+ draft\b/i);
        const who = new Set(drafts.map((d) => d.actor));
        return {
          score: frac(who.size, Math.min(v.tr.members.length, 3)),
          evidence: `${drafts.length} draft artifact(s) by ${[...who].join(", ") || "nobody"}`,
        };
      },
    },
    {
      id: "distinct-candidates",
      layer: "brief",
      question:
        "Were there at least two DISTINCT candidates (different answers or designs), each produced by one member alone?",
    },
    {
      id: "pairwise-rulings",
      layer: "brief",
      question:
        "Did the lead pair candidates and did a NON-author pick the stronger of each pair in one message per match, until one remained?",
    },
    singleDeliverable,
    {
      id: "graft-losers",
      layer: "brief",
      question:
        "Were the losing candidates' best ideas explicitly grafted into the winner before delivery?",
    },
    marker("candidate-post", /\[candidate\]/i, ["board"]),
    marker("match-post", /\[match\]/i, ["board"]),
    marker("ruling", /\[ruling\]/i, ["board", "note"]),
    marker("tournament-result", /\[tournament-result\]/i, ["note"]),
  ],
  verification: [
    {
      id: "single-drafter",
      layer: "brief",
      question:
        "Did exactly one member draft the candidate while the other members acted as verifiers (rather than everyone drafting their own answer)?",
    },
    {
      id: "aspects-separate",
      layer: "brief",
      check: (v) => {
        const author = v.firstDeliverable?.actor;
        const aspects = new Map<string, string>();
        for (const p of v.contributions) {
          if (p.actor === author) continue;
          const key = aspectOf(p.text);
          if (key && !aspects.has(key)) aspects.set(key, p.actor);
        }
        const need = Math.min(3, Math.max(1, v.tr.members.length - 1));
        return {
          score: frac(aspects.size, need),
          evidence: `aspects with verdicts: ${[...aspects].map(([k, m]) => `${k}(${m})`).join(", ") || "none"}`,
        };
      },
    },
    ranChecks,
    {
      id: "fail-returns-to-author",
      layer: "brief",
      question:
        "If any aspect FAILED, did it go back to the author and get fixed once before delivery? Answer null if no aspect failed.",
    },
    {
      id: "deliver-after-all-pass",
      layer: "brief",
      check: (v) => {
        const d = v.firstDeliverable;
        if (!d) return { score: 0, evidence: "no deliverable" };
        const verdicts = v.contributions.filter(
          (p) => p.actor !== d.actor && aspectOf(p.text) !== undefined,
        );
        if (verdicts.length === 0) return { score: 0, evidence: "delivered with no verdicts" };
        const afterDelivery = verdicts.filter((p) => p.t > d.t).length;
        return {
          score: afterDelivery === 0 ? 1 : 0.5,
          evidence: `${verdicts.length - afterDelivery} verdict(s) before delivery, ${afterDelivery} after`,
        };
      },
    },
    marker("candidate-post", /\[candidate\]/i, ["board"]),
    marker("verdict-post", /\[verdict\]/i, ["board", "chan"]),
    marker("verify-task", /^Verify\b/i, ["task"]),
    marker("verification-ruling", /\[verification-ruling\]/i, ["note"]),
  ],
  auction: [
    {
      id: "lots-posted",
      layer: "brief",
      check: (v) => {
        const lot = v.posts.find((p) => p.actor === v.tr.lead && /\b(piece|lot)s?\b/i.test(p.text));
        return { score: lot ? 1 : 0, evidence: quote(lot) };
      },
    },
    {
      id: "bids",
      layer: "brief",
      check: (v) => {
        const bidders = new Set(
          v.contributions
            .filter((p) => p.actor !== v.tr.lead && /\bbid\b|\bfit\b|effort|\bcost\b/i.test(p.text))
            .map((p) => p.actor),
        );
        return {
          score: frac(bidders.size, v.nonLead.length),
          evidence: `bidders: ${[...bidders].join(", ") || "none"}`,
        };
      },
    },
    {
      id: "award-by-tell",
      layer: "brief",
      check: (v) => {
        // An award only counts once lots exist: it must follow the lead's lots post.
        const lots = v.posts.find(
          (p) => p.actor === v.tr.lead && /\b(piece|lot)s?\b/i.test(p.text),
        );
        if (!lots) return { score: 0, evidence: "no lots were posted" };
        const award = v.tellsToMembers.find(
          (e) =>
            e.actor === v.tr.lead &&
            e.t > lots.t &&
            /\bawarded?\b|\byou(?:'re| are)? (?:assigned|awarded)\b|\byou take\b|\b(?:piece|lot)\b.{0,40}\byours\b/i.test(
              e.text,
            ),
        );
        return { score: award ? 1 : 0, evidence: quote(award) };
      },
    },
    {
      id: "winners-work",
      layer: "brief",
      question:
        "Did the members who were awarded pieces actually do their piece and report it (score the fraction of awardees who did)? Answer null if nothing was awarded.",
    },
    leadDelivers,
    marker("lot-post", /\[lot\]/i, ["board"]),
    marker("bid-post", /\[bid\]/i, ["board"]),
    marker("award-post", /\[award\]/i, ["board"]),
    marker("fit-check", /\[award-check\]/i, ["note"]),
  ],
  ledger: [
    {
      id: "plan-ledger",
      layer: "brief",
      check: (v) => {
        const p = v.posts.find(
          (e) =>
            e.actor === v.tr.lead && /\bplan\b/i.test(e.text) && /fact|step|owner/i.test(e.text),
        );
        return { score: p ? 1 : 0, evidence: quote(p) };
      },
    },
    {
      id: "progress-ledger",
      layer: "brief",
      check: (v) => {
        const ps = v.posts.filter(
          (e) =>
            e.actor === v.tr.lead &&
            /progress/i.test(e.text) &&
            /\bdone\b|in flight|in-flight|stuck/i.test(e.text),
        );
        return {
          score: ps.length > 0 ? 1 : 0,
          evidence: `${ps.length} progress post(s); ${quote(ps[0])}`,
        };
      },
    },
    {
      id: "progress-updated",
      layer: "brief",
      check: (v) => {
        const ps = v.posts.filter(
          (e) =>
            e.actor === v.tr.lead &&
            /progress/i.test(e.text) &&
            /\bdone\b|in flight|stuck/i.test(e.text),
        );
        return {
          score: ps.length >= 2 ? 1 : ps.length === 1 ? 0.5 : 0,
          evidence: `${ps.length} update(s)`,
        };
      },
    },
    {
      id: "stall-replan",
      layer: "brief",
      check: (v) => {
        const stall =
          cmdMatching(v, /^crew stall\b/i)[0] ??
          v.tr.events.find(
            (e) => e.kind === "chan" && /deposit your best current result NOW/i.test(e.text),
          );
        if (!stall) return { score: null, evidence: "no stall in window" };
        const replan = v.posts.find(
          (e) =>
            e.t > stall.t &&
            e.actor === v.tr.lead &&
            /replan|new plan|revised plan|plan v?2/i.test(e.text),
        );
        return {
          score: replan ? 1 : 0,
          evidence: `stall: ${quote(stall)}; replan: ${quote(replan)}`,
        };
      },
    },
    leadDelivers,
    marker("task-ledger-note", /\[task-ledger\]/i, ["note"]),
    marker("progress-ledger-note", /\[progress-ledger\]/i, ["note"]),
    marker("ledger-lesson", /\[ledger-lesson\]/i, ["note"]),
  ],
  sharding: [
    {
      id: "lead-runs-checker",
      layer: "brief",
      check: (v) => {
        if (!v.tr.oracle?.length) return { score: null, evidence: "task has no oracle" };
        const leadCmds = v.cmds.filter((c) => c.actor === v.tr.lead);
        const hit = calcCoverage(leadCmds, v.tr.oracle);
        return {
          score: frac(hit.size, v.tr.oracle.length),
          evidence: `lead ran ${hit.size}/${v.tr.oracle.length} oracle checks`,
        };
      },
    },
    {
      id: "shards-posted",
      layer: "brief",
      check: (v) => {
        const p =
          v.posts.find((e) => e.actor === v.tr.lead && SHARD_POST.test(e.text)) ??
          v.cmds.find((e) => e.actor === v.tr.lead && SHARD_TASK.test(e.text));
        return { score: p ? 1 : 0, evidence: quote(p) };
      },
    },
    {
      id: "members-claim",
      layer: "brief",
      check: (v) => {
        const claimers = new Set(
          v.contributions.filter((e) => /claiming\b/i.test(e.text)).map((e) => e.actor),
        );
        return {
          score: frac(claimers.size, v.nonLead.length),
          evidence: `claimers: ${[...claimers].join(", ") || "none"}`,
        };
      },
    },
    {
      id: "oracle-unedited",
      layer: "brief",
      check: (v) => {
        if (!v.tr.oracleOk) return { score: null, evidence: "task has no oracle" };
        const re = new RegExp(v.tr.oracleOk);
        const ok = v.deliverables.some((d) => re.test(d.text));
        return {
          score: v.deliverables.length ? (ok ? 1 : 0) : null,
          evidence: ok
            ? "deliverable passes the unedited checker"
            : `deliverable fails: ${quote(v.firstDeliverable)}`,
        };
      },
    },
    {
      id: "full-rerun",
      layer: "brief",
      check: (v) => {
        if (!v.tr.oracle?.length) return { score: null, evidence: "task has no oracle" };
        const firstClaim = v.contributions.find((e) => /claiming\b/i.test(e.text));
        const firstShard = v.posts.find((e) => /\bshards?\b|failing/i.test(e.text));
        const t0 = (firstClaim ?? firstShard ?? { t: v.tr.start }).t;
        const d = v.firstDeliverable?.t ?? v.tr.end;
        const after = v.cmds.filter((c) => c.t > t0 && c.t <= d);
        let best = 0;
        for (const m of v.tr.members) {
          best = Math.max(
            best,
            calcCoverage(
              after.filter((c) => c.actor === m),
              v.tr.oracle,
            ).size,
          );
        }
        return {
          score: best === v.tr.oracle.length ? 1 : best > 0 ? 0.5 : 0,
          evidence: `best single-agent re-run covered ${best}/${v.tr.oracle.length}`,
        };
      },
    },
    leadDelivers,
    marker("oracle-baseline", /\[oracle-baseline\]/i, ["note"]),
    marker("shard-task", /^Shard:/i, ["task"]),
    marker("sharding-result", /\[sharding-result\]/i, ["note"]),
  ],
};

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function scoreWindow(tr: Transcript, formation: string): StepResult[] {
  const steps = FORMATION_STEPS[formation];
  if (!steps) throw new Error(`no adherence steps for formation "${formation}"`);
  const v = buildView(tr);
  return steps.map((s) => {
    if (s.check) {
      const r = s.check(v);
      return { step: s.id, layer: s.layer, method: "det", score: r.score, evidence: r.evidence };
    }
    return {
      step: s.id,
      layer: s.layer,
      method: "judge",
      score: null,
      evidence: "",
      question: s.question,
    };
  });
}

/** Mean of the scored steps in one layer; null when none were scored. */
function layerMean(results: StepResult[], layer: StepResult["layer"]): number | null {
  const scored = results.filter((r) => r.layer === layer && r.score !== null);
  if (scored.length === 0) return null;
  return scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length;
}

/**
 * Headline and diagnostic scores for one window. `brief` (the headline) is
 * the mean over scored brief steps only; `convention` is the pool-template
 * diagnostic, reported but never folded into the headline.
 */
export function summarizeAdherence(results: StepResult[]): {
  brief: number | null;
  convention: number | null;
} {
  return { brief: layerMean(results, "brief"), convention: layerMean(results, "convention") };
}

/** Render the window as a compact transcript for a judge model. */
export function renderTranscript(tr: Transcript, maxChars = 14000): string {
  const t0 = tr.start;
  const lines = tr.events
    .filter((e) => e.kind !== "cmd" || !/^(look|brief|help|who|next|quest status)\b/.test(e.text))
    .map((e) => {
      const s = ((e.t - t0) / 1000).toFixed(0).padStart(4);
      const who = e.kind === "tell" ? `${e.actor}→${e.target}` : e.actor;
      const where = e.kind === "note" ? `note:${e.pool}` : e.kind;
      return `+${s}s [${where}] ${who}: ${e.text.replace(/\s+/g, " ").slice(0, 600)}`;
    });
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…(truncated)`;
  return out;
}

export interface JudgePacket {
  formation: string;
  brief: string;
  lead?: string;
  members: string[];
  questions: { step: string; question: string }[];
  transcript: string;
}

export function buildJudgePacket(
  tr: Transcript,
  formation: string,
  brief: string,
  results: StepResult[],
): JudgePacket {
  return {
    formation,
    brief,
    lead: tr.lead,
    members: tr.members,
    questions: results
      .filter((r) => r.method === "judge")
      .map((r) => ({ step: r.step, question: r.question ?? "" })),
    transcript: renderTranscript(tr),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dbPath = flag("db");
  const formation = flag("formation");
  const since = Number(flag("since"));
  const until = Number(flag("until"));
  if (!dbPath || !formation || !Number.isFinite(since) || !Number.isFinite(until)) {
    process.stderr.write(
      "usage: formation-adherence.ts --db <path> --formation <f> --since <epoch-s> --until <epoch-s> [--crew answerer] [--pool eval-artifacts] [--oracle a,b] [--oracle-ok <regex>] [--runnable] [--json] [--packet <out.json>]\n",
    );
    process.exit(2);
  }
  const tr = loadTranscript(dbPath, {
    crew: flag("crew"),
    since: since * 1000,
    until: until * 1000,
    pool: flag("pool"),
    oracle: flag("oracle")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    oracleOk: flag("oracle-ok"),
    runnable: args.includes("--runnable"),
  });
  const results = scoreWindow(tr, formation);
  const packetPath = flag("packet");
  if (packetPath) {
    const { CREW_BRIEFS } = await import("../src/coordination/crew-formations");
    const brief = (CREW_BRIEFS as Record<string, string>)[formation] ?? "";
    await Bun.write(
      packetPath,
      JSON.stringify(buildJudgePacket(tr, formation, brief, results), null, 2),
    );
  }
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } else {
    for (const r of results) {
      const score =
        r.score === null ? (r.method === "judge" ? "judge" : "n/a") : r.score.toFixed(2);
      process.stdout.write(
        `${r.layer.padEnd(10)} ${r.step.padEnd(26)} ${score.padStart(5)}  ${r.evidence}\n`,
      );
    }
    const summary = summarizeAdherence(results);
    const fmt = (n: number | null) => (n === null ? "n/a" : n.toFixed(2));
    process.stdout.write(
      `headline (brief steps) ${fmt(summary.brief)}; ` +
        `diagnostic (convention markers, excluded) ${fmt(summary.convention)}\n`,
    );
  }
}
