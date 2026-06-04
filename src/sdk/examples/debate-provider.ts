/**
 * Debate Provider — 2 proposers argue opposing positions, a judge picks.
 *
 * Architecture per request:
 *   1. Proposer A answers as "confident first-instinct reasoner"
 *   2. Proposer B answers as "skeptical second-look reasoner"
 *   3. If A and B agree → return that answer (no debate needed)
 *   4. If they disagree → Judge reads both answers+reasoning, decides
 *
 * Designed for TruthfulQA (plausible-wrong-answer detection) and MMLU-Pro
 * controversial questions. Adversarial reasoning exposes flaws majority
 * vote can't catch.
 *
 * Env:
 *   WS_URL, MARINA_ENDPOINT     — local defaults
 *   AGENT_NAME                    — DebateProvider
 *   MODEL_CHANNEL                 — "model"
 *   DEBATE_PROPOSER_A             — model e.g. marina:haiku
 *   DEBATE_PROPOSER_B             — model e.g. marina:qwen
 *   DEBATE_JUDGE                  — model e.g. marina:sonnet (stronger)
 *   DEBATE_TEMPERATURE            — default 0
 *   DEBATE_TRACE                  — "true" logs the debate
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "DebateProvider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const PROPOSER_A = process.env.DEBATE_PROPOSER_A ?? "marina:haiku";
const PROPOSER_B = process.env.DEBATE_PROPOSER_B ?? "marina:qwen";
const JUDGE = process.env.DEBATE_JUDGE ?? "marina:sonnet";
const TEMPERATURE = Number.parseFloat(process.env.DEBATE_TEMPERATURE ?? "0");
const TRACE = process.env.DEBATE_TRACE === "true";

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

async function propose(model: string, persona: string, messages: Message[]): Promise<string> {
  const proposerMessages: Message[] = [
    {
      role: "system",
      content: `${persona}\n\n${messages.find((m) => m.role === "system")?.content ?? ""}`,
    },
    ...messages.filter((m) => m.role !== "system"),
  ];
  return callMarina(model, proposerMessages, TEMPERATURE);
}

async function judge(
  model: string,
  original: Message[],
  responseA: string,
  responseB: string,
): Promise<string> {
  const userMsg = original.find((m) => m.role === "user")?.content ?? "";
  const systemMsg = original.find((m) => m.role === "system")?.content ?? "";
  const prompt = `You are a careful judge deciding between two reasoners' answers to a question. They disagree. Read both, evaluate their reasoning, then give YOUR final answer.

ORIGINAL INSTRUCTION: ${systemMsg}

QUESTION:
${userMsg}

REASONER A's answer:
${responseA}

REASONER B's answer:
${responseB}

Weigh each reasoner's logic. Which answer is better supported? Which might be a plausible-sounding trap? Your final answer:`;
  return callMarina(model, [{ role: "user", content: prompt }], TEMPERATURE);
}

async function handleRequest(request: {
  id: string;
  content: string;
  context?: string;
  history?: Array<{ role: string; content: string }>;
}): Promise<string> {
  const t0 = performance.now();
  const messages: Message[] = [];
  if (request.context) messages.push({ role: "system", content: request.context });
  if (request.history) {
    for (const entry of request.history) {
      messages.push({ role: entry.role, content: entry.content });
    }
  }
  messages.push({ role: "user", content: request.content });

  // Parallel propose with different personas
  const [respA, respB] = await Promise.all([
    propose(
      PROPOSER_A,
      "You reason carefully from first principles and state a confident answer.",
      messages,
    ).catch((e) => `ERROR: ${e}`),
    propose(
      PROPOSER_B,
      "You are skeptical of obvious answers and check whether the apparent answer has hidden flaws.",
      messages,
    ).catch((e) => `ERROR: ${e}`),
  ]);

  const letterA = extractLetter(respA);
  const letterB = extractLetter(respB);

  // If they agree, no debate needed
  if (letterA && letterA === letterB) {
    const dt = Math.round(performance.now() - t0);
    console.log(`[debate] ${request.id} agree=${letterA} in ${dt}ms`);
    if (TRACE) console.log(`  A: ${respA.slice(0, 100).replace(/\n/g, " ")}`);
    return respA;
  }

  // Disagreement — invoke judge
  const judgeResp = await judge(JUDGE, messages, respA, respB).catch((e) => `ERROR: ${e}`);
  const letterJ = extractLetter(judgeResp);
  const dt = Math.round(performance.now() - t0);
  console.log(`[debate] ${request.id} A=${letterA} B=${letterB} -> judge=${letterJ} in ${dt}ms`);
  if (TRACE) {
    console.log(`  A (${PROPOSER_A}): ${respA.slice(0, 120).replace(/\n/g, " ")}`);
    console.log(`  B (${PROPOSER_B}): ${respB.slice(0, 120).replace(/\n/g, " ")}`);
    console.log(`  J (${JUDGE}): ${judgeResp.slice(0, 120).replace(/\n/g, " ")}`);
  }
  return judgeResp;
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[debate] logged in as ${session.name} (${session.entityId})`);
  console.log(`[debate] proposers: A=${PROPOSER_A} B=${PROPOSER_B} | judge=${JUDGE}`);
  console.log(`[debate] answering on: ${MODEL_CHANNEL}`);

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
      console.error(`[debate] ${request.id} error:`, err);
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
  console.error("[debate] fatal:", e);
  process.exit(1);
});
