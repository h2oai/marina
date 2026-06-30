/**
 * Smart Provider Agent — a memory-using responder on the model channel.
 *
 * Same protocol as provider.ts, but before forwarding to the substrate LLM,
 * this agent consults its own memory (private notes + optional shared pools)
 * and injects relevant context as a system message. After each response, it
 * writes a compact Q→A note so future queries benefit from accumulated
 * reasoning. All features are composable via env flags.
 *
 * This proves: "does wrapping any LLM in a Marina memory-using agent
 * make it better?" Swap PROVIDER_URL/KEY/MODEL to aim at any substrate
 * (Anthropic, OpenAI, Gemini, OpenRouter, local Ollama, etc.).
 *
 * Usage:
 *   PROVIDER_URL=https://openrouter.ai/api/v1 \
 *   PROVIDER_KEY=sk-or-... \
 *   PROVIDER_MODEL=anthropic/claude-sonnet-4.5 \
 *   MEMORY_POOLS=mmlu-knowledge,general-knowledge \
 *   bun run src/sdk/examples/smart-provider.ts
 *
 * Env:
 *   WS_URL          — Marina WS (default ws://localhost:3300)
 *   AGENT_NAME      — character name (default SmartProvider)
 *   MODEL_CHANNEL   — channel to join (default "model")
 *   PROVIDER_URL    — OpenAI-compatible base URL (default http://localhost:11434/v1)
 *   PROVIDER_KEY    — bearer key for substrate
 *   PROVIDER_MODEL  — model name at the substrate
 *   SYSTEM_PROMPT   — optional extra system prompt
 *   MEMORY_POOLS    — comma-separated shared pools to consult (default: none)
 *   MEMORY_LEARN    — "false" disables learning (default: true)
 *   MEMORY_MODE     — "reflect" (distill a reusable principle per Q&A) |
 *                     "qa" (store raw Q&A pairs) — default "reflect"
 *   MEMORY_TOPK     — how many chars of question to use as recall topic (default 200)
 *   MEMORY_MAX_BYTES — cap on injected memory size (default 6000); prevents
 *                      unbounded context growth as knowledge accumulates
 *   MEMORY_TRACE    — "true" logs recall contents and distilled principles
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "SmartProvider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const PROVIDER_URL = (process.env.PROVIDER_URL ?? "http://localhost:11434/v1").replace(/\/$/, "");
const PROVIDER_KEY = process.env.PROVIDER_KEY ?? "";
const PROVIDER_MODEL = process.env.PROVIDER_MODEL ?? "llama3";
const PROVIDER_FORMAT = (process.env.PROVIDER_FORMAT ?? "openai").toLowerCase(); // "openai" | "anthropic"
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ?? "";
const POOLS = (process.env.MEMORY_POOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LEARN = process.env.MEMORY_LEARN !== "false";
const LEARN_MODE = (process.env.MEMORY_MODE ?? "reflect").toLowerCase(); // "reflect" | "qa"
const TOPK = Number.parseInt(process.env.MEMORY_TOPK ?? "200", 10);
const MEMORY_MAX_BYTES = Number.parseInt(process.env.MEMORY_MAX_BYTES ?? "6000", 10);
const TRACE = process.env.MEMORY_TRACE === "true";
const TRANSLATOR_CHANNEL = process.env.TRANSLATOR_CHANNEL ?? "translator";
const USE_TRANSLATOR = process.env.USE_TRANSLATOR !== "false";
const TRANSLATOR_TIMEOUT_MS = Number.parseInt(process.env.TRANSLATOR_TIMEOUT_MS ?? "8000", 10);
// Reflection should use a lighter substrate so it doesn't compete with the
// answerer for the authoritative model. Default routes reflection through the
// marina endpoint at model=marina:haiku — same self-referential pattern,
// different channel/substrate. Set REFLECTION_PROVIDER_URL to point off-host.
const REFLECTION_PROVIDER_URL = (
  process.env.REFLECTION_PROVIDER_URL ?? "http://localhost:3300/v1"
).replace(/\/$/, "");
const REFLECTION_PROVIDER_MODEL = process.env.REFLECTION_PROVIDER_MODEL ?? "marina:haiku";

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

function topicFrom(content: string): string {
  return content.slice(0, TOPK).replace(/\s+/g, " ").trim();
}

/**
 * Ask the TranslatorAgent on TRANSLATOR_CHANNEL for retrieval keywords. Returns
 * null on timeout or error — caller falls back to the raw question topic.
 *
 * Protocol: send {type:"extract_keywords", id, text} then await matching
 * {type:"keywords_result", id, keywords} on the same channel.
 */
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
        /* not our payload */
      }
    };
    const timer = setTimeout(() => {
      agent.offPerception(handler);
      resolve(null);
    }, TRANSLATOR_TIMEOUT_MS);
    agent.onPerception(handler);
    // Fire-and-forget send; translator responds on the same channel.
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
  // Private notes
  try {
    const priv = perceptionsToText(await agent.recall(topic));
    if (!isEmptyRecall(priv)) chunks.push(`[private]\n${priv}`);
  } catch (e) {
    if (TRACE) console.error("[smart-provider] private recall failed:", e);
  }
  // Shared pools
  for (const pool of POOLS) {
    try {
      const perc = await agent.command(`pool ${pool} recall ${topic}`);
      const text = perceptionsToText(perc);
      if (!isEmptyRecall(text)) chunks.push(`[pool:${pool}]\n${text}`);
    } catch (e) {
      if (TRACE) console.error(`[smart-provider] pool ${pool} recall failed:`, e);
    }
  }
  let joined = chunks.join("\n\n");
  if (joined.length > MEMORY_MAX_BYTES) {
    joined = `${joined.slice(0, MEMORY_MAX_BYTES)}\n…[truncated]`;
  }
  if (TRACE && joined) console.log(`[smart-provider] recalled ${joined.length} chars:\n${joined}`);
  return joined;
}

async function distillPrinciple(question: string, answer: string): Promise<string> {
  // Reflection routes through a separate (cheaper) substrate so it doesn't
  // compete with the answerer's expensive model under load. Default:
  // marina:haiku via the local endpoint.
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
  if (!resp.ok) {
    throw new Error(`Reflection ${resp.status}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? "";
  return text.trim().split(/\n+/)[0]?.slice(0, 500) ?? "";
}

async function learnFrom(agent: MarinaAgent, question: string, answer: string): Promise<void> {
  if (!LEARN) return;
  try {
    if (LEARN_MODE === "qa") {
      const q = question.slice(0, 300).replace(/\s+/g, " ").trim();
      const a = answer.slice(0, 500).replace(/\s+/g, " ").trim();
      await agent.command(`note Q: ${q} | A: ${a}`);
      return;
    }
    // Reflect mode: distill the principle AND ask the translator for retrieval
    // keywords from the original question. Both are stored in the same note so
    // future recall (which also routes through the translator) matches keyword-
    // to-keyword in a shared abstract vocabulary — not principle-to-question.
    const [principle, keywords] = await Promise.all([
      distillPrinciple(question, answer),
      USE_TRANSLATOR ? askTranslator(agent, question) : Promise.resolve(null),
    ]);
    if (!principle) return;
    const body = keywords ? `[keywords] ${keywords}\n[principle] ${principle}` : principle;
    if (TRACE) console.log(`[smart-provider] learn: ${body.slice(0, 120)}...`);
    await agent.command(`note ${body}`);
  } catch (e) {
    if (TRACE) console.error("[smart-provider] learn failed:", e);
  }
}

interface Message {
  role: string;
  content: string;
}

async function callProvider(messages: Message[]): Promise<string> {
  if (PROVIDER_FORMAT === "anthropic") {
    // Anthropic /v1/messages — system is separate, messages are user/assistant only.
    const systemMsgs = messages.filter((m) => m.role === "system").map((m) => m.content);
    const nonSystem = messages.filter((m) => m.role !== "system");
    const url = PROVIDER_URL.endsWith("/v1")
      ? `${PROVIDER_URL}/messages`
      : `${PROVIDER_URL}/v1/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": PROVIDER_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: PROVIDER_MODEL,
        max_tokens: 4096,
        temperature: 0,
        ...(systemMsgs.length > 0 ? { system: systemMsgs.join("\n\n") } : {}),
        messages: nonSystem.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Provider ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  // Default: OpenAI-compatible
  const url = `${PROVIDER_URL}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PROVIDER_KEY) headers.Authorization = `Bearer ${PROVIDER_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: PROVIDER_MODEL, messages, temperature: 0 }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Provider ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[smart-provider] logged in as ${session.name} (${session.entityId})`);
  console.log(`[smart-provider] substrate: ${PROVIDER_URL} model=${PROVIDER_MODEL}`);
  console.log(`[smart-provider] pools: ${POOLS.length > 0 ? POOLS.join(",") : "(none)"}`);
  console.log(`[smart-provider] learn: ${LEARN}`);
  console.log(
    `[smart-provider] translator: ${USE_TRANSLATOR ? `enabled on channel "${TRANSLATOR_CHANNEL}"` : "disabled"}`,
  );

  await agent.command(`channel create ${MODEL_CHANNEL}`);
  await agent.command(`channel join ${MODEL_CHANNEL}`);
  if (USE_TRANSLATOR) {
    // Member of translator channel so we can hear keywords_result replies.
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

    const t0 = performance.now();
    console.log(
      `[smart-provider] ${request.id}: ${request.content.slice(0, 80).replace(/\n/g, " ")}...`,
    );

    try {
      // Ask the TranslatorAgent for better recall keywords. If it's offline,
      // times out, or returns nothing, fall back to raw-question vocabulary.
      let topic = topicFrom(request.content);
      if (USE_TRANSLATOR) {
        const translated = await askTranslator(agent, request.content);
        if (translated) {
          topic = translated;
          if (TRACE) console.log(`[smart-provider] ${request.id} topic: "${translated}"`);
        }
      }
      const memory = await gatherMemory(agent, topic);

      const messages: Message[] = [];
      if (SYSTEM_PROMPT) messages.push({ role: "system", content: SYSTEM_PROMPT });
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

      const answer = await callProvider(messages);
      await agent.channel(
        MODEL_CHANNEL,
        JSON.stringify({ type: "model_response", id: request.id, content: answer }),
      );

      const dt = Math.round(performance.now() - t0);
      console.log(
        `[smart-provider] ${request.id} done in ${dt}ms (memory=${memory.length}B, answer=${answer.length}B)`,
      );

      // Fire-and-forget reflection — doesn't block the next request.
      learnFrom(agent, request.content, answer).catch((e) => {
        if (TRACE) console.error("[smart-provider] learn error:", e);
      });
    } catch (err) {
      console.error(`[smart-provider] ${request.id} error:`, err);
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

  console.log("[smart-provider] listening for model_request on channel:", MODEL_CHANNEL);
  process.on("SIGINT", () => {
    console.log("[smart-provider] shutting down...");
    agent.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[smart-provider] fatal:", e);
  process.exit(1);
});
