// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Foundry Provider — worker answers, Gate reviewer approves or rejects. Retry-on-reject.
 *
 * Per request:
 *   Round 1: Worker produces an answer.
 *   Round 1: Gate reviewer scrutinizes — does it obey the stated constraints /
 *            match any verifiable truth criterion? Emit APPROVE or REJECT
 *            with a reason.
 *   Round 2 (if REJECT): Worker retries with the Gate's feedback.
 *   Round 2: Gate final-checks. Return either round's answer.
 *
 * Quality-gated pattern: best for IFEval (explicit constraint verification)
 * and HumanEval-style code (review catches bugs). Trades latency for
 * correctness under constraints.
 *
 * Env:
 *   FOUNDRY_WORKER    — worker model (default marina:sonnet)
 *   FOUNDRY_REVIEWER  — Gate reviewer model (default marina:haiku)
 *   FOUNDRY_MAX_ROUNDS — default 2 (1 = no retry, 2 = one retry)
 *   FOUNDRY_TEMPERATURE — default 0
 *   FOUNDRY_TRACE     — "true" logs the Gate review loop
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "FoundryProvider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const WORKER = process.env.FOUNDRY_WORKER ?? "marina:sonnet";
const REVIEWER = process.env.FOUNDRY_REVIEWER ?? "marina:haiku";
const MAX_ROUNDS = Math.max(1, Number.parseInt(process.env.FOUNDRY_MAX_ROUNDS ?? "2", 10));
const TEMPERATURE = Number.parseFloat(process.env.FOUNDRY_TEMPERATURE ?? "0");
const TRACE = process.env.FOUNDRY_TRACE === "true";

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

async function work(original: Message[], feedback?: string): Promise<string> {
  if (!feedback) return callMarina(WORKER, original, TEMPERATURE);
  const retry: Message[] = [
    ...original,
    {
      role: "user",
      content: `A reviewer found problems with a previous attempt:\n${feedback}\n\nGiven this feedback, produce the corrected answer to the original question.`,
    },
  ];
  return callMarina(WORKER, retry, TEMPERATURE);
}

async function review(
  original: Message[],
  answer: string,
): Promise<{ approve: boolean; reason: string }> {
  const systemMsg = original.find((m) => m.role === "system")?.content ?? "";
  const userMsg = original.find((m) => m.role === "user")?.content ?? "";
  const prompt = `You are a strict reviewer. Does this answer faithfully obey the stated instructions and appear correct?

ORIGINAL SYSTEM INSTRUCTION: ${systemMsg || "(none)"}

REQUEST:
${userMsg.slice(0, 2000)}

ANSWER:
${answer.slice(0, 2000)}

Respond with exactly one line, the first word being APPROVE or REJECT, followed by a short reason. Example:
APPROVE the answer follows all constraints and appears correct.
REJECT the answer uses commas despite the prohibition.

Your review:`;
  const verdict = await callMarina(REVIEWER, [{ role: "user", content: prompt }], TEMPERATURE);
  const trimmed = verdict.trim();
  const approve = /^APPROVE/i.test(trimmed);
  return { approve, reason: trimmed };
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

  let answer = await work(messages);
  let rounds = 1;
  let finalVerdict = "";
  for (; rounds <= MAX_ROUNDS; rounds++) {
    const { approve, reason } = await review(messages, answer).catch(() => ({
      approve: true,
      reason: "reviewer failed — accepting",
    }));
    finalVerdict = reason;
    if (approve || rounds === MAX_ROUNDS) break;
    answer = await work(messages, reason);
  }

  const dt = Math.round(performance.now() - t0);
  console.log(
    `[foundry] ${request.id} rounds=${rounds} verdict=${finalVerdict.slice(0, 60).replace(/\n/g, " ")} in ${dt}ms`,
  );
  if (TRACE) console.log(`  answer: ${answer.slice(0, 120).replace(/\n/g, " ")}`);
  return answer;
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[foundry] logged in as ${session.name} (${session.entityId})`);
  console.log(`[foundry] worker=${WORKER} reviewer=${REVIEWER} max_rounds=${MAX_ROUNDS}`);

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
      console.error(`[foundry] ${request.id} error:`, err);
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
  console.error("[foundry] fatal:", e);
  process.exit(1);
});
