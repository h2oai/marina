// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * NSED + Memory Provider — full-stack answerer:
 *   translator → recall → ensemble(N) → vote → reflect.
 *
 * Combines the ensemble voting of nsed-provider with the memory/translator
 * scaffolding of smart-provider. All substrates see the same
 * memory-augmented prompt, so recalled principles inform every ensemble
 * member before voting.
 *
 * Flow per request:
 *   1. Ask TranslatorAgent for retrieval keywords (falls back to raw topic).
 *   2. Recall relevant prior principles (private notes + optional pools).
 *   3. Build memory-augmented messages.
 *   4. Send to N substrates in parallel (negotiate).
 *   5. Extract answer letter from each, majority-vote (select).
 *   6. Return the winning ballot's full response (execute).
 *   7. Fire-and-forget: distill principle via cheaper substrate, store as
 *      [keywords]::[principle] note (debrief).
 *
 * Env:
 *   WS_URL, MARINA_ENDPOINT      — defaults to local Marina
 *   AGENT_NAME                     — default NSEDSmartProvider
 *   MODEL_CHANNEL                  — default "model"
 *   NSED_SUBSTRATES                — comma-separated, e.g. marina:haiku,marina:qwen,marina:gemma,marina:sonnet
 *   NSED_TEMPERATURES              — comma-separated, default 0 for each
 *   TRANSLATOR_CHANNEL             — default "translator"
 *   USE_TRANSLATOR                 — "false" to disable
 *   TRANSLATOR_TIMEOUT_MS          — default 8000
 *   MEMORY_POOLS                   — comma-separated pool names (default: none)
 *   MEMORY_MAX_BYTES               — default 6000
 *   MEMORY_LEARN                   — "false" disables reflection
 *   REFLECTION_PROVIDER_URL/MODEL  — default self, marina:haiku
 *   NSED_TRACE                     — "true" logs vote tallies
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "NSEDSmartProvider";
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
const TRANSLATOR_CHANNEL = process.env.TRANSLATOR_CHANNEL ?? "translator";
const USE_TRANSLATOR = process.env.USE_TRANSLATOR !== "false";
const TRANSLATOR_TIMEOUT_MS = Number.parseInt(process.env.TRANSLATOR_TIMEOUT_MS ?? "8000", 10);
const POOLS = (process.env.MEMORY_POOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MEMORY_MAX_BYTES = Number.parseInt(process.env.MEMORY_MAX_BYTES ?? "6000", 10);
const LEARN = process.env.MEMORY_LEARN !== "false";
const REFLECTION_PROVIDER_URL = (
  process.env.REFLECTION_PROVIDER_URL ?? "http://localhost:3300/v1"
).replace(/\/$/, "");
const REFLECTION_PROVIDER_MODEL = process.env.REFLECTION_PROVIDER_MODEL ?? "marina:haiku";
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

function perceptionsToText(ps: Perception[]): string {
  return ps
    .map((p) => (typeof p.data?.text === "string" ? (p.data.text as string) : ""))
    .map(stripAnsi)
    .filter((t) => t.length > 0)
    .join("\n");
}

function isEmptyRecall(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || /no matching memories found/i.test(t) || /no notes/i.test(t);
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

async function askTranslator(agent: MarinaAgent, text: string): Promise<string | null> {
  if (!USE_TRANSLATOR) return null;
  const reqId = `trans-${crypto.randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify({ type: "extract_keywords", id: reqId, text });
  return new Promise<string | null>((resolve) => {
    const handler = (p: Perception) => {
      if (p.kind !== "message" || !p.data?.text) return;
      const parsed = extractChannelPayload(p.data.text as string);
      if (!parsed || parsed.channel !== TRANSLATOR_CHANNEL) return;
      try {
        const msg = JSON.parse(parsed.content) as { type?: string; id?: string; keywords?: string };
        if (msg.type === "keywords_result" && msg.id === reqId) {
          clearTimeout(timer);
          agent.offPerception(handler);
          resolve(
            typeof msg.keywords === "string" && msg.keywords.length > 0 ? msg.keywords : null,
          );
        }
      } catch {
        /* not ours */
      }
    };
    const timer = setTimeout(() => {
      agent.offPerception(handler);
      resolve(null);
    }, TRANSLATOR_TIMEOUT_MS);
    agent.onPerception(handler);
    agent.channel(TRANSLATOR_CHANNEL, payload).catch(() => {
      clearTimeout(timer);
      agent.offPerception(handler);
      resolve(null);
    });
  });
}

async function gatherMemory(agent: MarinaAgent, topic: string): Promise<string> {
  if (!topic) return "";
  const chunks: string[] = [];
  try {
    const perc = await agent.recall(topic);
    const priv = perceptionsToText(perc);
    if (TRACE)
      console.log(
        `[nsed-smart] recall("${topic.slice(0, 60)}...") -> ${perc.length} perceptions, ${priv.length} chars: "${priv.slice(0, 120)}"`,
      );
    if (!isEmptyRecall(priv)) chunks.push(`[private]\n${priv}`);
  } catch (e) {
    if (TRACE) console.error("[nsed-smart] private recall failed:", e);
  }
  for (const pool of POOLS) {
    try {
      const perc = await agent.command(`pool ${pool} recall ${topic}`);
      const text = perceptionsToText(perc);
      if (!isEmptyRecall(text)) chunks.push(`[pool:${pool}]\n${text}`);
    } catch (e) {
      if (TRACE) console.error(`[nsed-smart] pool ${pool} recall failed:`, e);
    }
  }
  let joined = chunks.join("\n\n");
  if (joined.length > MEMORY_MAX_BYTES) {
    joined = `${joined.slice(0, MEMORY_MAX_BYTES)}\n…[truncated]`;
  }
  return joined;
}

async function distillPrinciple(question: string, answer: string): Promise<string> {
  const prompt = `Given this question and the reasoning used to answer it, extract ONE general, reusable principle, formula, or heuristic that could help solve similar questions. State it as a single sentence. Do not mention the specific question. No preamble.

QUESTION:
${question.slice(0, 2000)}

REASONING/ANSWER:
${answer.slice(0, 2000)}

PRINCIPLE:`;
  const messages = [
    { role: "system", content: "You extract concise, reusable reasoning principles." },
    { role: "user", content: prompt },
  ];
  const resp = await fetch(`${REFLECTION_PROVIDER_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: REFLECTION_PROVIDER_MODEL, messages, temperature: 0 }),
  });
  if (!resp.ok) throw new Error(`Reflection ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? "";
  return text.trim().split(/\n+/)[0]?.slice(0, 500) ?? "";
}

async function learnFrom(
  agent: MarinaAgent,
  question: string,
  winnerAnswer: string,
): Promise<void> {
  if (!LEARN) return;
  try {
    const [principle, keywords] = await Promise.all([
      distillPrinciple(question, winnerAnswer),
      USE_TRANSLATOR ? askTranslator(agent, question) : Promise.resolve(null),
    ]);
    if (!principle) return;
    const body = keywords ? `[keywords] ${keywords}\n[principle] ${principle}` : principle;
    if (TRACE) console.log(`[nsed-smart] learn: ${body.slice(0, 120)}...`);
    await agent.command(`note ${body}`);
  } catch (e) {
    if (TRACE) console.error("[nsed-smart] learn failed:", e);
  }
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
  const winnerBallot =
    ballots
      .filter((b) => b.letter === winnerLetter)
      .sort((a, b) => a.temperature - b.temperature)[0] ?? null;
  return { winnerLetter, winnerBallot, tally };
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

  // Translator → keywords → recall
  let topic = request.content.slice(0, 200).replace(/\s+/g, " ").trim();
  if (USE_TRANSLATOR) {
    const translated = await askTranslator(agent, request.content);
    if (translated) topic = translated;
  }
  const memory = await gatherMemory(agent, topic);

  // Build memory-augmented messages
  const messages: Message[] = [];
  if (request.context) messages.push({ role: "system", content: request.context });
  if (memory) {
    messages.push({
      role: "system",
      content: `Relevant prior knowledge from your memory:\n${memory}`,
    });
  }
  if (request.history) {
    for (const entry of request.history) {
      messages.push({ role: entry.role, content: entry.content });
    }
  }
  messages.push({ role: "user", content: request.content });

  // Negotiate → Select
  const ballots = await negotiate(messages);
  const { winnerLetter, winnerBallot, tally } = select(ballots);

  const dt = Math.round(performance.now() - t0);
  const tallyStr = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l}:${n}`)
    .join(" ");
  const consensus = winnerLetter ? (tally[winnerLetter]! / ballots.length).toFixed(2) : "0";
  console.log(
    `[nsed-smart] ${request.id} winner=${winnerLetter || "?"} consensus=${consensus} tally=[${tallyStr}] mem=${memory.length}B in ${dt}ms`,
  );
  if (TRACE) {
    for (const b of ballots) {
      console.log(
        `  [${b.substrate} t=${b.temperature}] letter=${b.letter} ${b.error ? `err=${b.error}` : `resp=${b.response.slice(0, 80).replace(/\n/g, " ")}`}`,
      );
    }
  }

  // Execute: return winner's full response
  const answer =
    winnerBallot?.response ??
    ballots.find((b) => b.response)?.response ??
    "ERROR: all substrates failed";

  // Debrief: learn from the ensemble's consensus answer
  learnFrom(agent, request.content, answer).catch((e) => {
    if (TRACE) console.error("[nsed-smart] learn error:", e);
  });

  return answer;
}

async function main() {
  // Longer drain so recall responses aren't lost under load — the default 500ms
  // can expire before the server's recall reply arrives when many concurrent
  // commands are in flight (4 parallel substrate HTTP calls, translator, etc).
  const drainTimeout = Number.parseInt(process.env.COMMAND_DRAIN_MS ?? "2000", 10);
  const agent = new MarinaAgent(WS_URL, {
    autoReconnect: true,
    commandDrainTimeout: drainTimeout,
  });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[nsed-smart] logged in as ${session.name} (${session.entityId})`);
  console.log(`[nsed-smart] ensemble of ${SUBSTRATES.length}:`);
  SUBSTRATES.forEach((s, i) => {
    console.log(`  [${i}] ${s} @ t=${TEMPERATURES[i] ?? 0}`);
  });
  console.log(
    `[nsed-smart] translator=${USE_TRANSLATOR ? TRANSLATOR_CHANNEL : "off"} learn=${LEARN} reflection=${REFLECTION_PROVIDER_MODEL}`,
  );
  console.log(`[nsed-smart] answering on channel: ${MODEL_CHANNEL}`);

  await agent.command(`channel create ${MODEL_CHANNEL}`);
  await agent.command(`channel join ${MODEL_CHANNEL}`);
  if (USE_TRANSLATOR) {
    await agent.command(`channel create ${TRANSLATOR_CHANNEL}`);
    await agent.command(`channel join ${TRANSLATOR_CHANNEL}`);
  }

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
      console.error(`[nsed-smart] ${request.id} error:`, err);
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
    console.log("[nsed-smart] shutting down...");
    agent.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[nsed-smart] fatal:", e);
  process.exit(1);
});
