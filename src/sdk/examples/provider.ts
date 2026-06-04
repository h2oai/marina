/**
 * Provider Agent — an agent that joins a model channel and forwards
 * requests to an external OpenAI-compatible LLM provider.
 *
 * This makes Marina itself an LLM endpoint: callers hit /v1/chat/completions,
 * the request routes to this agent via the model channel, and this agent
 * forwards it to the configured provider (OpenAI, Anthropic, Ollama, etc.).
 *
 * Multiple provider agents can coexist with regular agents in the same channel,
 * enabling hybrid "brains" where some requests go to LLMs and others to
 * agent orchestrations.
 *
 * Usage:
 *   bun run src/sdk/examples/provider.ts
 *
 * Environment:
 *   WS_URL           — Marina WebSocket URL (default: ws://localhost:3300)
 *   AGENT_NAME       — Character name (default: Provider)
 *   MODEL_CHANNEL    — Channel to join (default: model)
 *   PROVIDER_URL     — External LLM base URL (default: http://localhost:11434/v1)
 *   PROVIDER_KEY     — API key for external provider (default: none)
 *   PROVIDER_MODEL   — Model name at the provider (default: llama3)
 *   SYSTEM_PROMPT    — Optional system prompt prepended to every request
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "Provider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const PROVIDER_URL = (process.env.PROVIDER_URL ?? "http://localhost:11434/v1").replace(/\/$/, "");
const PROVIDER_KEY = process.env.PROVIDER_KEY ?? "";
const PROVIDER_MODEL = process.env.PROVIDER_MODEL ?? "llama3";
const PROVIDER_FORMAT = (process.env.PROVIDER_FORMAT ?? "openai").toLowerCase(); // "openai" | "anthropic"
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ?? "";

// ─── Parse model_request from channel perception ─────────────────────────────

/** Strip ANSI escape codes from text */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires ESC control char
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Extract JSON payload from a channel message perception.
 *  Channel messages arrive as "[channel] sender: content" with ANSI codes. */
function extractChannelPayload(
  text: string,
): { channel: string; sender: string; content: string } | undefined {
  const clean = stripAnsi(text);
  const match = clean.match(/^\[([^\]]+)\]\s+([^:]+):\s+(.*)/s);
  if (!match) return undefined;
  return { channel: match[1]!, sender: match[2]!.trim(), content: match[3]!.trim() };
}

// ─── Provider call ───────────────────────────────────────────────────────────

interface Message {
  role: string;
  content: string;
}

async function callProvider(
  messages: Message[],
  stream: boolean,
): Promise<string | ReadableStream<Uint8Array>> {
  if (PROVIDER_FORMAT === "anthropic") {
    // Anthropic /v1/messages — system is separate, no streaming in this branch.
    const systemMsgs = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .concat(SYSTEM_PROMPT ? [SYSTEM_PROMPT] : []);
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
      throw new Error(`Provider error ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  const url = `${PROVIDER_URL}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PROVIDER_KEY) headers.Authorization = `Bearer ${PROVIDER_KEY}`;

  const allMessages: Message[] = [];
  if (SYSTEM_PROMPT) allMessages.push({ role: "system", content: SYSTEM_PROMPT });
  allMessages.push(...messages);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: PROVIDER_MODEL,
      messages: allMessages,
      stream,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Provider error ${resp.status}: ${body.slice(0, 200)}`);
  }

  if (stream && resp.body) return resp.body;

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/** Stream from provider, emitting model_response_chunk messages on the channel. */
async function streamProviderResponse(
  agent: MarinaAgent,
  channel: string,
  requestId: string,
  messages: Message[],
): Promise<void> {
  const body = await callProvider(messages, true);
  if (typeof body === "string") {
    // Provider didn't stream — send as single response
    agent.channel(
      channel,
      JSON.stringify({ type: "model_response", id: requestId, content: body }),
    );
    return;
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        await agent.channel(channel, JSON.stringify({ type: "model_response_end", id: requestId }));
        return;
      }

      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          await agent.channel(
            channel,
            JSON.stringify({ type: "model_response_chunk", id: requestId, content }),
          );
        }
      } catch {}
    }
  }

  // Ensure we always send an end marker
  await agent.channel(channel, JSON.stringify({ type: "model_response_end", id: requestId }));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });

  console.log(`[provider] Connecting to ${WS_URL} as ${AGENT_NAME}...`);
  const session = await agent.connect(AGENT_NAME);
  console.log(`[provider] Logged in as ${session.name} (${session.entityId})`);
  console.log(`[provider] Provider: ${PROVIDER_URL} model=${PROVIDER_MODEL}`);

  // Ensure channel exists, then join. create is idempotent-ish (returns error
  // if the channel already exists, which is fine — we join either way).
  await agent.command(`channel create ${MODEL_CHANNEL}`);
  await agent.command(`channel join ${MODEL_CHANNEL}`);
  console.log(`[provider] Joined channel: ${MODEL_CHANNEL}`);

  // Listen for model requests
  agent.onPerception(async (p: Perception) => {
    if (p.kind !== "message" || !p.data?.text) return;

    const text = p.data.text as string;
    const parsed = extractChannelPayload(text);
    if (!parsed) return;
    if (parsed.channel !== MODEL_CHANNEL) return;
    if (parsed.sender === session.name) return; // ignore own messages

    // Try to parse as model_request
    let request: {
      type: string;
      id: string;
      content: string;
      target?: string;
      context?: string;
      history?: Array<{ role: string; content: string }>;
      stream?: boolean;
    };
    try {
      request = JSON.parse(parsed.content);
    } catch {
      return; // Not JSON, ignore
    }
    if (request.type !== "model_request") return;

    // Only respond if targeted at us (or no specific target)
    if (request.target && request.target !== session.entityId) return;

    console.log(`[provider] Request ${request.id}: "${request.content.slice(0, 80)}..."`);

    // Build messages array
    const messages: Message[] = [];
    if (request.context) messages.push({ role: "system", content: request.context });
    if (request.history) {
      for (const entry of request.history) {
        messages.push({ role: entry.role, content: entry.content });
      }
    }
    messages.push({ role: "user", content: request.content });

    try {
      if (request.stream) {
        await streamProviderResponse(agent, MODEL_CHANNEL, request.id, messages);
      } else {
        const response = await callProvider(messages, false);
        await agent.channel(
          MODEL_CHANNEL,
          JSON.stringify({ type: "model_response", id: request.id, content: response }),
        );
      }
      console.log(`[provider] Response sent for ${request.id}`);
    } catch (err) {
      console.error(`[provider] Error handling ${request.id}: ${err}`);
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

  console.log("[provider] Listening for model requests...");

  // Keep alive
  process.on("SIGINT", () => {
    console.log("[provider] Shutting down...");
    agent.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
