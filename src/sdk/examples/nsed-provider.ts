// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * NSED Ensemble Provider — answers the Marina LLM endpoint by calling N
 * substrates in parallel (Negotiate), majority-voting on the extracted
 * answer (Select), returning the winner's full response (Execute), and
 * optionally noting any disagreements (Debrief).
 *
 * Self-referential: every substrate call goes through Marina's own
 * /v1/chat/completions. Change NSED_SUBSTRATES to swap models/providers.
 *
 * For MCQ benchmarks: the response letter is extracted from each substrate's
 * text and votes are taken on the letter. The WINNER's full response is
 * returned (so downstream letter-extraction still sees correct reasoning).
 *
 * Usage:
 *   # 4 Haikus at different temperatures (diversity ensemble)
 *   NSED_SUBSTRATES=marina:haiku,marina:haiku,marina:haiku,marina:haiku \
 *   NSED_TEMPERATURES=0,0.3,0.7,1.0 \
 *   bun run src/sdk/examples/nsed-provider.ts
 *
 *   # Mixed-model heterogeneous ensemble
 *   NSED_SUBSTRATES=marina:haiku,marina:qwen,marina:gemma,marina:kimi \
 *   NSED_TEMPERATURES=0,0,0,0 \
 *   bun run src/sdk/examples/nsed-provider.ts
 *
 * Env:
 *   WS_URL           — Marina WS (default ws://localhost:3300)
 *   MARINA_ENDPOINT — default http://localhost:3300
 *   AGENT_NAME       — character (default NSEDProvider)
 *   MODEL_CHANNEL    — channel to answer on (default "model")
 *   NSED_SUBSTRATES  — comma-separated model names for each parallel call
 *   NSED_TEMPERATURES — comma-separated temps per call (default 0 for all)
 *   NSED_TRACE       — "true" logs vote tallies per request
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "NSEDProvider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const SUBSTRATES = (
  process.env.NSED_SUBSTRATES ?? "marina:haiku,marina:haiku,marina:haiku,marina:haiku"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEMPERATURES = (process.env.NSED_TEMPERATURES ?? SUBSTRATES.map(() => "0").join(","))
  .split(",")
  .map((s) => Number.parseFloat(s.trim()) || 0);
const TRACE = process.env.NSED_TRACE === "true";

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

/** Same extractor as MC adapter — prefers explicit answer patterns, falls
 * back to last isolated [A-J]. */
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
  if (!resp.ok) {
    throw new Error(`Marina ${resp.status}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

interface Ballot {
  idx: number;
  substrate: string;
  temperature: number;
  response: string;
  letter: string;
  error?: string;
}

async function negotiate(messages: Message[]): Promise<Ballot[]> {
  return Promise.all(
    SUBSTRATES.map(async (substrate, i) => {
      const temperature = TEMPERATURES[i] ?? 0;
      try {
        const response = await callMarina(substrate, messages, temperature);
        return { idx: i, substrate, temperature, response, letter: extractLetter(response) };
      } catch (err) {
        return {
          idx: i,
          substrate,
          temperature,
          response: "",
          letter: "",
          error: String(err).slice(0, 120),
        };
      }
    }),
  );
}

function select(ballots: Ballot[]): {
  winnerLetter: string;
  winnerBallot: Ballot | null;
  tally: Record<string, number>;
} {
  const tally: Record<string, number> = {};
  for (const b of ballots) {
    if (b.letter) tally[b.letter] = (tally[b.letter] ?? 0) + 1;
  }
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const winnerLetter = sorted[0]?.[0] ?? "";
  // Prefer a winning ballot with temperature=0 (most deterministic reasoning)
  const winnerBallot =
    ballots
      .filter((b) => b.letter === winnerLetter)
      .sort((a, b) => a.temperature - b.temperature)[0] ?? null;
  return { winnerLetter, winnerBallot, tally };
}

async function handleRequest(request: {
  id: string;
  content: string;
  context?: string;
  history?: Array<{ role: string; content: string }>;
}): Promise<string> {
  const messages: Message[] = [];
  if (request.context) messages.push({ role: "system", content: request.context });
  if (request.history) {
    for (const entry of request.history) {
      messages.push({ role: entry.role, content: entry.content });
    }
  }
  messages.push({ role: "user", content: request.content });

  const t0 = performance.now();
  const ballots = await negotiate(messages);
  const { winnerLetter, winnerBallot, tally } = select(ballots);
  const dt = Math.round(performance.now() - t0);

  const tallyStr = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l}:${n}`)
    .join(" ");
  const consensus = winnerLetter ? (tally[winnerLetter]! / ballots.length).toFixed(2) : "0";
  console.log(
    `[nsed] ${request.id} winner=${winnerLetter || "?"} consensus=${consensus} tally=[${tallyStr}] in ${dt}ms`,
  );
  if (TRACE) {
    for (const b of ballots) {
      console.log(
        `  [${b.substrate} t=${b.temperature}] letter=${b.letter} ${b.error ? `err=${b.error}` : `resp=${b.response.slice(0, 80).replace(/\n/g, " ")}`}`,
      );
    }
  }

  // Return the winner's full response so MC extractor downstream sees it.
  if (winnerBallot) return winnerBallot.response;
  // Degenerate: no letter could be extracted from any ballot — return first non-empty
  const fallback = ballots.find((b) => b.response)?.response ?? "ERROR: all substrates failed";
  return fallback;
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[nsed] logged in as ${session.name} (${session.entityId})`);
  console.log(`[nsed] ensemble of ${SUBSTRATES.length}:`);
  SUBSTRATES.forEach((s, i) => {
    console.log(`  [${i}] ${s} @ t=${TEMPERATURES[i] ?? 0}`);
  });
  console.log(`[nsed] answering on channel: ${MODEL_CHANNEL}`);

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
      const answer = await handleRequest(request);
      await agent.channel(
        MODEL_CHANNEL,
        JSON.stringify({ type: "model_response", id: request.id, content: answer }),
      );
    } catch (err) {
      console.error(`[nsed] ${request.id} error:`, err);
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
    console.log("[nsed] shutting down...");
    agent.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[nsed] fatal:", e);
  process.exit(1);
});
