/**
 * Adaptive Provider — confidence-based escalation.
 *
 * Per request:
 *   1. Ask N council substrates in parallel (temp spread for diversity)
 *   2. Compute consensus: what fraction agreed on the same answer letter?
 *   3. If consensus ≥ ESCALATE_THRESHOLD: return the council consensus
 *   4. If below threshold: escalate — ask the escalator substrate
 *      and return its answer (expensive path)
 *
 * Budget-aware: on easy questions, the council agrees → no escalation.
 * On hard/ambiguous questions, the council splits → escalate.
 * Roughly 60-80% of items stay within the council on benchmarks like MMLU-Pro.
 *
 * The "confidence" signal here is agreement between independent council
 * members, which correlates with item difficulty. Future upgrade: use
 * TabH2O `market forecast` pattern to predict item difficulty from
 * historical council-vs-correct outcomes.
 *
 * Env:
 *   ADAPTIVE_COUNCIL      — comma-separated council substrates (the deliberating body)
 *                           default "marina:haiku,marina:qwen,marina:gemma,marina:kimi"
 *   ADAPTIVE_STRONG       — escalator substrate, consulted when council splits
 *                           default "marina:sonnet"
 *   ADAPTIVE_TEMPS        — temps per council substrate
 *                           default "0,0,0,0"
 *   ADAPTIVE_THRESHOLD    — consensus fraction (0..1) to skip escalation
 *                           default 0.75 (3 of 4 agree → trust)
 *   ADAPTIVE_TRACE        — "true" logs per-item decisions
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "AdaptiveProvider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const COUNCIL = (
  process.env.ADAPTIVE_COUNCIL ?? "marina:haiku,marina:qwen,marina:gemma,marina:kimi"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEMPS = (process.env.ADAPTIVE_TEMPS ?? COUNCIL.map(() => "0").join(","))
  .split(",")
  .map((s) => Number.parseFloat(s.trim()) || 0);
const STRONG = process.env.ADAPTIVE_STRONG ?? "marina:sonnet";
const THRESHOLD = Number.parseFloat(process.env.ADAPTIVE_THRESHOLD ?? "0.75");
const TRACE = process.env.ADAPTIVE_TRACE === "true";

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

  // Cheap round
  const councilResults = await Promise.all(
    COUNCIL.map(async (model, i) => {
      const temp = TEMPS[i] ?? 0;
      try {
        const response = await callMarina(model, messages, temp);
        return { model, response, letter: extractLetter(response), ok: true };
      } catch (err) {
        return { model, response: "", letter: "", ok: false, error: String(err).slice(0, 80) };
      }
    }),
  );
  const tally: Record<string, number> = {};
  for (const r of councilResults) if (r.letter) tally[r.letter] = (tally[r.letter] ?? 0) + 1;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const topLetter = sorted[0]?.[0] ?? "";
  const topCount = sorted[0]?.[1] ?? 0;
  const totalVotes = councilResults.filter((r) => r.letter).length;
  const consensus = totalVotes > 0 ? topCount / totalVotes : 0;

  const dt1 = Math.round(performance.now() - t0);

  // Free-form case (no letter extracted from any cheap response): always escalate
  // to strong model, since we can't measure agreement without a letter.
  const hasLetters = totalVotes > 0;

  if (hasLetters && consensus >= THRESHOLD) {
    const councilWinner = councilResults.find((r) => r.letter === topLetter);
    console.log(
      `[adaptive] ${request.id} council-consensus consensus=${consensus.toFixed(2)} (${topLetter}:${topCount}/${totalVotes}) in ${dt1}ms`,
    );
    if (TRACE) {
      for (const r of councilResults) {
        console.log(`  [${r.model}] letter=${r.letter}`);
      }
    }
    return councilWinner?.response ?? "";
  }

  // Escalate
  let strongResp = "";
  try {
    strongResp = await callMarina(STRONG, messages, 0);
  } catch (err) {
    // Escalator substrate failed — return best council answer we have
    const fallback =
      councilResults.find((r) => r.response)?.response ?? `ERROR: ${String(err).slice(0, 200)}`;
    console.log(`[adaptive] ${request.id} ESCALATION FAILED -> fallback council answer`);
    return fallback;
  }
  const strongLetter = extractLetter(strongResp);
  const dt2 = Math.round(performance.now() - t0);
  console.log(
    `[adaptive] ${request.id} escalated consensus=${consensus.toFixed(2)} (${totalVotes ? `${topLetter}:${topCount}/${totalVotes}` : "free-form"}) -> strong=${strongLetter} in ${dt2}ms`,
  );
  if (TRACE) {
    for (const r of councilResults) console.log(`  [council ${r.model}] letter=${r.letter}`);
    console.log(
      `  [escalator ${STRONG}] letter=${strongLetter} resp=${strongResp.slice(0, 120).replace(/\n/g, " ")}`,
    );
  }
  return strongResp;
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[adaptive] logged in as ${session.name} (${session.entityId})`);
  console.log(
    `[adaptive] council: ${COUNCIL.join(",")} | escalator: ${STRONG} | threshold: ${THRESHOLD}`,
  );

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
      console.error(`[adaptive] ${request.id} error:`, err);
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
  console.error("[adaptive] fatal:", e);
  process.exit(1);
});
