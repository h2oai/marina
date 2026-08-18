// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Blackboard Provider — per-question shared pool + graph-linked analyses.
 *
 * Fully Marina-native: uses pools, note links (supports/contradicts/part_of),
 * and graph-weight selection. Every question leaves a reasoning-trace graph in
 * the world; future questions can recall it. Harness-written outcome notes
 * (stage 4) close the reinforcement loop.
 *
 * Flow per request:
 *   1. Create per-question pool `bench-q-<reqId>`
 *   2. Post the question as the root note (capture its ID)
 *   3. Round 1 — each of N analyst roles emits an analysis into the pool.
 *      Each analysis = structured: reasoning + candidate letter/answer.
 *      Each analysis links to the root question via `part_of`.
 *   4. Round 2 — for each pair of analyses, classify "supports|contradicts|neutral"
 *      via a cheap LLM judge. Create note links accordingly.
 *   5. Round 3 — select winner by graph weight:
 *         score(A) = supports_in(A) - contradicts_in(A)
 *      On ties, LLM-judge decides.
 *   6. Return winner's full response.
 *
 * The pool + graph persist. Future questions with overlapping vocabulary
 * will pull relevant prior analyses via pool recall + spreading activation.
 *
 * Env:
 *   BLACKBOARD_ROLES      — comma-separated substrate:role pairs
 *     e.g. marina:sonnet@scholar,marina:haiku@skeptic,marina:qwen@calculator,marina:gemma@domain
 *     default: 4 cheap substrates with distinct personas
 *   BLACKBOARD_JUDGE      — substrate for pairwise link classification + tiebreak
 *     default: marina:haiku (cheap)
 *   BLACKBOARD_TEMPERATURE — default 0
 *   BLACKBOARD_TRACE      — "true" logs full round-by-round
 *   BLACKBOARD_POOL_PREFIX — pool name prefix (default "bench-q-")
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "BlackboardProvider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const ROLES_ENV =
  process.env.BLACKBOARD_ROLES ??
  "marina:haiku@scholar,marina:qwen@skeptic,marina:gemma@calculator,marina:kimi@domain";
const JUDGE = process.env.BLACKBOARD_JUDGE ?? "marina:haiku";
const TEMPERATURE = Number.parseFloat(process.env.BLACKBOARD_TEMPERATURE ?? "0");
const TRACE = process.env.BLACKBOARD_TRACE === "true";
const POOL_PREFIX = process.env.BLACKBOARD_POOL_PREFIX ?? "bench-q-";
const COMMAND_DRAIN_MS = Number.parseInt(process.env.COMMAND_DRAIN_MS ?? "2500", 10);

interface Role {
  substrate: string;
  role: string;
  persona: string;
}

const PERSONAS: Record<string, string> = {
  scholar:
    "You are a careful academic reasoner. Work from first principles. State the reasoning step by step, cite relevant formulas or doctrines, conclude with a final answer.",
  skeptic:
    "You are a skeptical reviewer. Distrust the obvious answer. For each plausible choice, ask 'what would have to be true for this to be wrong?' Look for plausible-sounding traps. Conclude with your best answer.",
  calculator:
    "You are a precise calculator. Extract numeric or logical relationships. Show work. If the question is not numeric, reason formally. Conclude with a final answer.",
  domain:
    "You are a domain specialist. Identify which domain (law, medicine, finance, physics, logic, etc.) this falls into and apply that domain's canonical reasoning. Conclude with a final answer.",
};

const ROLES: Role[] = ROLES_ENV.split(",").map((s) => {
  const [substrate, role] = s.trim().split("@");
  return {
    substrate: substrate!.trim(),
    role: (role ?? "scholar").trim(),
    persona: PERSONAS[(role ?? "scholar").trim()] ?? PERSONAS.scholar!,
  };
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (t: string) => t.replace(ANSI_RE, "");

function extractChannelPayload(
  text: string,
): { channel: string; sender: string; content: string } | undefined {
  const clean = stripAnsi(text);
  const match = clean.match(/^\[([^\]]+)\]\s+([^:]+):\s+(.*)/s);
  if (!match) return undefined;
  return { channel: match[1]!, sender: match[2]!.trim(), content: match[3]!.trim() };
}

function perceptionsToText(ps: Perception[]): string {
  return ps
    .map((p) => (typeof p.data?.text === "string" ? (p.data.text as string) : ""))
    .map(stripAnsi)
    .filter((t) => t.length > 0)
    .join("\n");
}

function extractLetter(response: string): string {
  const cleaned = response.trim().toUpperCase();
  const explicit = [...cleaned.matchAll(/ANSWER\s*(?:IS|:|=|WOULD BE)\s*\(?\**([A-J])\**\)?/g)];
  if (explicit.length > 0) return explicit[explicit.length - 1]![1]!;
  if (cleaned.length <= 5) {
    const m = cleaned.match(/\b([A-J])\b/);
    if (m) return m[1]!;
  }
  const all = [...cleaned.matchAll(/\b([A-J])\b/g)];
  if (all.length > 0) return all[all.length - 1]![1]!;
  if (cleaned.length > 0 && /[A-J]/.test(cleaned[0]!)) return cleaned[0]!;
  return "";
}

interface Message {
  role: string;
  content: string;
}

async function callMarina(
  model: string,
  messages: Message[],
  temperature: number,
): Promise<string> {
  const resp = await fetch(`${MARINA_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature }),
  });
  if (!resp.ok) throw new Error(`Marina ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

/** Parse "Added note #<id> to pool..." response for the note id. */
function parseNoteId(cmdResp: string): number | null {
  const m = cmdResp.match(/#(\d+)/);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

interface Analysis {
  role: Role;
  response: string;
  letter: string;
  poolNoteId: number | null;
}

async function round1Analyses(
  agent: MarinaAgent,
  poolName: string,
  questionNoteId: number | null,
  question: string,
  systemMsg: string,
): Promise<Analysis[]> {
  return Promise.all(
    ROLES.map(async (role) => {
      const messages: Message[] = [
        { role: "system", content: `${role.persona}\n\n${systemMsg}` },
        { role: "user", content: question },
      ];
      let response = "";
      try {
        response = await callMarina(role.substrate, messages, TEMPERATURE);
      } catch (e) {
        response = `ERROR: ${String(e).slice(0, 120)}`;
      }
      const letter = extractLetter(response);
      // Store analysis into the pool with role tag, capture note id.
      const analysisNote = `[${role.role}] answer=${letter || "?"}\n${response.slice(0, 1500)}`;
      let poolNoteId: number | null = null;
      try {
        const resp = perceptionsToText(
          await agent.command(`pool ${poolName} add ${analysisNote} importance 6`),
        );
        poolNoteId = parseNoteId(resp);
        // Link this analysis to the root question via "part_of"
        if (poolNoteId !== null && questionNoteId !== null) {
          await agent.command(`note link ${poolNoteId} ${questionNoteId} part_of`);
        }
      } catch (e) {
        if (TRACE) console.error(`[blackboard] failed to store ${role.role} analysis:`, e);
      }
      return { role, response, letter, poolNoteId };
    }),
  );
}

/** Classify A vs B: does A's reasoning support, contradict, or is neutral to B's?
 *  Returns one of "supports" | "contradicts" | null. */
async function classifyPair(a: Analysis, b: Analysis): Promise<"supports" | "contradicts" | null> {
  if (!a.response || !b.response) return null;
  const prompt = `You are classifying the relationship between two answers to the same question.

ANSWER 1 (by ${a.role.role}):
${a.response.slice(0, 1200)}

ANSWER 2 (by ${b.role.role}):
${b.response.slice(0, 1200)}

Does Answer 1 SUPPORT, CONTRADICT, or is it NEUTRAL toward Answer 2's conclusion and reasoning? Respond with exactly one word: SUPPORTS, CONTRADICTS, or NEUTRAL.`;
  try {
    const verdict = await callMarina(JUDGE, [{ role: "user", content: prompt }], 0);
    const w = verdict.trim().toUpperCase();
    if (w.startsWith("SUPPORTS")) return "supports";
    if (w.startsWith("CONTRADICTS")) return "contradicts";
    return null;
  } catch {
    return null;
  }
}

async function round2Links(
  agent: MarinaAgent,
  analyses: Analysis[],
): Promise<Record<string, { supports: number; contradicts: number }>> {
  const stats: Record<string, { supports: number; contradicts: number }> = {};
  for (const a of analyses) stats[a.role.role] = { supports: 0, contradicts: 0 };

  const pairs: Array<Promise<void>> = [];
  for (const a of analyses) {
    for (const b of analyses) {
      if (a === b) continue;
      if (a.poolNoteId === null || b.poolNoteId === null) continue;
      pairs.push(
        (async () => {
          const rel = await classifyPair(a, b);
          if (!rel) return;
          try {
            await agent.command(`note link ${a.poolNoteId} ${b.poolNoteId} ${rel}`);
            stats[b.role.role]![rel === "supports" ? "supports" : "contradicts"]++;
          } catch {
            /* ignore link failure */
          }
        })(),
      );
    }
  }
  await Promise.all(pairs);
  return stats;
}

async function selectWinner(
  analyses: Analysis[],
  stats: Record<string, { supports: number; contradicts: number }>,
  question: string,
  systemMsg: string,
): Promise<Analysis> {
  // Graph-weight score
  const ranked = analyses
    .filter((a) => a.letter)
    .map((a) => ({
      a,
      score: (stats[a.role.role]?.supports ?? 0) - (stats[a.role.role]?.contradicts ?? 0),
    }))
    .sort((x, y) => y.score - x.score);

  if (ranked.length === 0) {
    // No letter extracted anywhere — return first non-empty response
    return analyses.find((a) => a.response) ?? analyses[0]!;
  }
  const topScore = ranked[0]!.score;
  const tied = ranked.filter((r) => r.score === topScore);
  if (tied.length === 1) return tied[0]!.a;

  // LLM tiebreak among tied
  const prompt = `Multiple analyses tied on graph support. Pick the most correct final answer.\n\nQUESTION:\n${question}\n\n${tied
    .map((t, i) => `OPTION ${i + 1} (${t.a.role.role}):\n${t.a.response.slice(0, 1000)}`)
    .join("\n\n")}\n\nRespond with: OPTION <N> — one integer, no preamble.`;
  try {
    const resp = await callMarina(
      JUDGE,
      [
        { role: "system", content: `${systemMsg}` },
        { role: "user", content: prompt },
      ],
      0,
    );
    const m = resp.match(/OPTION\s*(\d+)/i);
    if (m) {
      const idx = Number.parseInt(m[1]!, 10) - 1;
      if (idx >= 0 && idx < tied.length) return tied[idx]!.a;
    }
  } catch {
    /* fall through */
  }
  return tied[0]!.a;
}

async function handleRequest(
  agent: MarinaAgent,
  request: {
    id: string;
    content: string;
    context?: string;
    history?: Array<{ role: string; content: string }>;
  },
): Promise<string> {
  const t0 = performance.now();
  const systemMsg = request.context ?? "";
  const question = request.content;
  const poolName = `${POOL_PREFIX}${request.id}`;

  // 1. Create pool for this question
  try {
    await agent.command(`pool create ${poolName}`);
  } catch {
    /* already exists is fine */
  }

  // 2. Post question as root note
  let questionNoteId: number | null = null;
  try {
    const resp = perceptionsToText(
      await agent.command(`pool ${poolName} add [question] ${question.slice(0, 800)} importance 9`),
    );
    questionNoteId = parseNoteId(resp);
  } catch {
    /* proceed without link root */
  }

  // 3. Round 1: analyses
  const analyses = await round1Analyses(agent, poolName, questionNoteId, question, systemMsg);

  // 4. Round 2: cross-links (pairwise support/contradict)
  const stats = await round2Links(agent, analyses);

  // 5. Select winner by graph weight (with LLM tiebreak)
  const winner = await selectWinner(analyses, stats, question, systemMsg);
  const dt = Math.round(performance.now() - t0);

  const letterStr = analyses.map((a) => `${a.role.role}=${a.letter || "?"}`).join(" ");
  const statsStr = Object.entries(stats)
    .map(([r, s]) => `${r}:+${s.supports}/-${s.contradicts}`)
    .join(" ");
  console.log(
    `[blackboard] ${request.id} winner=${winner.role.role}(${winner.letter || "?"}) letters=[${letterStr}] graph=[${statsStr}] in ${dt}ms`,
  );
  if (TRACE) {
    for (const a of analyses) {
      console.log(
        `  [${a.role.role} ${a.role.substrate}] note=#${a.poolNoteId} letter=${a.letter} ${a.response.slice(0, 80).replace(/\n/g, " ")}`,
      );
    }
  }
  return winner.response;
}

async function main() {
  const agent = new MarinaAgent(WS_URL, {
    autoReconnect: true,
    commandDrainTimeout: COMMAND_DRAIN_MS,
  });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[blackboard] logged in as ${session.name} (${session.entityId})`);
  console.log(`[blackboard] ${ROLES.length} roles:`);
  ROLES.forEach((r, i) => {
    console.log(`  [${i}] ${r.substrate} @ ${r.role}`);
  });
  console.log(`[blackboard] judge: ${JUDGE} | pool prefix: ${POOL_PREFIX}`);
  console.log(`[blackboard] answering on channel: ${MODEL_CHANNEL}`);

  await agent.command(`channel create ${MODEL_CHANNEL}`);
  await agent.command(`channel join ${MODEL_CHANNEL}`);

  agent.onPerception(async (p: Perception) => {
    if (p.kind !== "message" || !p.data?.text) return;
    const parsed = extractChannelPayload(p.data.text as string);
    if (!parsed || parsed.channel !== MODEL_CHANNEL || parsed.sender === session.name) return;

    let request: {
      type: string;
      id: string;
      content: string;
      target?: string;
      context?: string;
      history?: Array<{ role: string; content: string }>;
    };
    try {
      request = JSON.parse(parsed.content);
    } catch {
      return;
    }
    if (request.type !== "model_request") return;
    if (request.target && request.target !== session.entityId) return;

    try {
      const answer = await handleRequest(agent, request);
      await agent.channel(
        MODEL_CHANNEL,
        JSON.stringify({ type: "model_response", id: request.id, content: answer }),
      );
    } catch (err) {
      console.error(`[blackboard] ${request.id} error:`, err);
      await agent.channel(
        MODEL_CHANNEL,
        JSON.stringify({
          type: "model_response",
          id: request.id,
          content: `Error: ${String(err).slice(0, 200)}`,
        }),
      );
    }
  });

  process.on("SIGINT", () => {
    agent.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[blackboard] fatal:", e);
  process.exit(1);
});
