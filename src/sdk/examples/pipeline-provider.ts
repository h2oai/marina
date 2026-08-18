// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline Provider — sequential stages: parse → reason → verify.
 *
 * Per request:
 *   Stage 1 (PARSE, cheap): extract structure — what's asked, which domain,
 *           which formulas/constraints apply, any hidden requirements.
 *   Stage 2 (REASON, strong): reason through the question given the
 *           extracted structure, produce a candidate answer + justification.
 *   Stage 3 (VERIFY, cheap): sanity-check the answer against the original
 *           question + extracted constraints. If violation, flag it but
 *           still return the reasoned answer (we don't retry here — that's
 *           Gastown's pattern).
 *
 * Designed for IFEval (explicit parsing of constraints before generation)
 * and hard MMLU-Pro questions that need structural decomposition.
 *
 * Env:
 *   PIPELINE_PARSE    — model for structure extraction (default marina:haiku)
 *   PIPELINE_REASON   — model for answer reasoning (default marina:sonnet)
 *   PIPELINE_VERIFY   — model for sanity check (default marina:haiku)
 *   PIPELINE_TEMPERATURE — default 0
 *   PIPELINE_TRACE    — "true" logs stages
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "PipelineProvider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const PARSE_MODEL = process.env.PIPELINE_PARSE ?? "marina:haiku";
const REASON_MODEL = process.env.PIPELINE_REASON ?? "marina:sonnet";
const VERIFY_MODEL = process.env.PIPELINE_VERIFY ?? "marina:haiku";
const TEMPERATURE = Number.parseFloat(process.env.PIPELINE_TEMPERATURE ?? "0");
const TRACE = process.env.PIPELINE_TRACE === "true";

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

async function stageParse(question: string, systemMsg: string): Promise<string> {
  const prompt = `Analyze the request below and extract its structure. Be concise. Output 3-5 short lines covering:
- TYPE: (multiple-choice | instruction-following | free-form | calculation | other)
- DOMAIN: (finance | law | science | coding | grammar | format | other)
- KEY CONSTRAINTS: explicit rules the answer must satisfy (word count, format, forbidden words, required keywords, etc.)
- RELEVANT PRINCIPLES: formulas, doctrines, or frameworks that apply
- HIDDEN TRAPS: common wrong answers or misinterpretations to avoid

ORIGINAL SYSTEM: ${systemMsg || "(none)"}

REQUEST:
${question}

STRUCTURE:`;
  return callMarina(PARSE_MODEL, [{ role: "user", content: prompt }], TEMPERATURE);
}

async function stageReason(original: Message[], structure: string): Promise<string> {
  const systemMsg = original.find((m) => m.role === "system")?.content ?? "";
  const enriched: Message[] = [
    { role: "system", content: systemMsg },
    {
      role: "system",
      content: `STRUCTURE ANALYSIS (from a prior stage — use this to guide your reasoning):\n${structure}`,
    },
    ...original.filter((m) => m.role !== "system"),
  ];
  return callMarina(REASON_MODEL, enriched, TEMPERATURE);
}

async function stageVerify(
  question: string,
  structure: string,
  candidate: string,
): Promise<string> {
  const prompt = `You are a verifier. A candidate answer has been produced. Your job: did it obey the extracted constraints?

QUESTION: ${question.slice(0, 1500)}

EXTRACTED STRUCTURE:
${structure}

CANDIDATE ANSWER:
${candidate.slice(0, 2000)}

Briefly: are there obvious violations of KEY CONSTRAINTS or HIDDEN TRAPS? Answer YES or NO, then one-sentence reason. If NO violations, echo the candidate's final letter / main conclusion. No preamble.`;
  return callMarina(VERIFY_MODEL, [{ role: "user", content: prompt }], TEMPERATURE);
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

  const systemMsg = request.context ?? "";
  const structure = await stageParse(request.content, systemMsg);
  const candidate = await stageReason(messages, structure);
  // Verify stage runs but we return the reasoned candidate — verifier is
  // advisory, not a retry gate (that's Gastown's job).
  const verdict = await stageVerify(request.content, structure, candidate).catch(() => "");

  const dt = Math.round(performance.now() - t0);
  console.log(
    `[pipeline] ${request.id} done in ${dt}ms (struct=${structure.length}B, ans=${candidate.length}B)`,
  );
  if (TRACE) {
    console.log(`  STRUCTURE: ${structure.slice(0, 200).replace(/\n/g, " | ")}`);
    console.log(`  REASONED: ${candidate.slice(0, 120).replace(/\n/g, " ")}`);
    console.log(`  VERDICT: ${verdict.slice(0, 120).replace(/\n/g, " ")}`);
  }
  return candidate;
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[pipeline] logged in as ${session.name} (${session.entityId})`);
  console.log(`[pipeline] parse=${PARSE_MODEL} reason=${REASON_MODEL} verify=${VERIFY_MODEL}`);

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
      console.error(`[pipeline] ${request.id} error:`, err);
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
  console.error("[pipeline] fatal:", e);
  process.exit(1);
});
