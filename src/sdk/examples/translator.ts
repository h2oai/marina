// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Translator Agent — semantic bridge between request vocabulary and memory.
 *
 * Self-referential: makes its own LLM calls through Marina's /v1/chat/completions
 * (model=marina:haiku by default). Whichever ThinProvider sits on that channel
 * defines the actual substrate. Same pattern as in-world room agents.
 *
 * Wired to the world intelligence loop:
 * - Its own notes store — principles about translation, not task content
 * - Its own recall — consults past translations before answering
 * - Its own reflection — fire-and-forget "what kind of text was this and what
 *   keywords worked" learning, so the translator improves over time
 *
 * Protocol (messages on TRANSLATOR_CHANNEL, default "translator"):
 *   Legacy (kept for back-compat with earlier orchestrators):
 *     IN:  {type: "extract_keywords", id: "...", text: "..."}
 *     OUT: {type: "keywords_result", id: "...", keywords: "..."}
 *
 *   Rich analysis (used by synthesis-provider to drive classification +
 *   decomposition, so translator substrate choice actually matters):
 *     IN:  {type: "analyze", id: "...", text: "..."}
 *     OUT: {type: "analysis", id: "...",
 *           qtype: "factual|reasoning|math|code|multi-step|instruction|creative",
 *           domain: "math|law|finance|logic|science|medicine|grammar|business|history|psychology|general",
 *           keywords: "space separated lowercase terms",
 *           steps: ["sub-question 1", ...]   // empty unless qtype == multi-step
 *          }
 *
 * Usage:
 *   MARINA_MODEL=marina:haiku bun run src/sdk/examples/translator.ts
 *
 * Env:
 *   WS_URL            — Marina WS (default ws://localhost:3300)
 *   MARINA_ENDPOINT — Marina HTTP endpoint (default http://localhost:3300)
 *   MARINA_MODEL    — model name on the Marina endpoint (default marina:haiku)
 *   AGENT_NAME        — character name (default Translator)
 *   TRANSLATOR_CHANNEL — channel to listen on (default "translator")
 *   MEMORY_LEARN      — "false" disables reflection (default: true)
 *   MEMORY_MAX_BYTES  — cap on injected prior-translation context (default 2000)
 *   MEMORY_TRACE      — "true" logs recall + principle output
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const MARINA_MODEL = process.env.MARINA_MODEL;
if (!MARINA_MODEL) {
  console.error(
    "[translator] MARINA_MODEL is required — choose any substrate: marina:haiku, marina:gemini, marina:nemotron, marina:sonnet, marina:qwen, or recursively: marina (if a non-looping route is configured)",
  );
  process.exit(1);
}
const AGENT_NAME = process.env.AGENT_NAME ?? `Translator-${MARINA_MODEL.replace(/[:.]/g, "-")}`;
const TRANSLATOR_CHANNEL =
  process.env.TRANSLATOR_CHANNEL ?? `translator-${MARINA_MODEL.replace(/^marina:/, "")}`;
const LEARN = process.env.MEMORY_LEARN !== "false";
const MEMORY_MAX_BYTES = Number.parseInt(process.env.MEMORY_MAX_BYTES ?? "2000", 10);
const TRACE = process.env.MEMORY_TRACE === "true";

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

// The translator talks to Marina's own endpoint. Whichever ThinProvider sits
// on the target channel defines the actual model behind it. This is the
// "Marina is LLM" pattern — self-referential, substrate-agnostic.
async function callMarina(messages: Array<{ role: string; content: string }>): Promise<string> {
  const resp = await fetch(`${MARINA_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MARINA_MODEL, messages, temperature: 0 }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Marina ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

async function gatherPriorTranslations(agent: MarinaAgent, text: string): Promise<string> {
  // Consult the translator's own memory: "what patterns worked for similar texts?"
  // Recall uses the first slice of the text as a topic — shared vocabulary with
  // past-translated texts will surface relevant prior notes.
  const str = typeof text === "string" ? text : String(text ?? "");
  const topic = str.slice(0, 200).replace(/\s+/g, " ").trim();
  if (!topic) return "";
  try {
    const recalled = perceptionsToText(await agent.recall(topic));
    if (isEmptyRecall(recalled)) return "";
    if (recalled.length > MEMORY_MAX_BYTES) {
      return `${recalled.slice(0, MEMORY_MAX_BYTES)}\n…[truncated]`;
    }
    return recalled;
  } catch (e) {
    if (TRACE) console.error("[translator] recall failed:", e);
    return "";
  }
}

interface AnalysisResult {
  qtype: string;
  domain: string;
  keywords: string;
  steps: string[];
}

const QTYPES = ["factual", "reasoning", "math", "code", "multi-step", "instruction", "creative"];
const DOMAINS = [
  "math",
  "law",
  "finance",
  "logic",
  "science",
  "medicine",
  "grammar",
  "business",
  "history",
  "psychology",
  "general",
];

async function analyzeQuestion(agent: MarinaAgent, text: string): Promise<AnalysisResult> {
  const str = typeof text === "string" ? text : String(text ?? "");
  const prior = await gatherPriorTranslations(agent, str);
  const systemMsg =
    "You analyze questions to route them through an orchestration system. " +
    "Output EXACTLY this shape (no prose, no markdown):\n" +
    "TYPE: <one of factual | reasoning | math | code | multi-step | instruction | creative>\n" +
    "DOMAIN: <one of math | law | finance | logic | science | medicine | grammar | business | history | psychology | general>\n" +
    "KEYWORDS: <3-6 lowercase noun phrases, space separated>\n" +
    "STEPS: <only if TYPE=multi-step — 2-4 sub-questions separated by ` | `. Else blank.>\n\n" +
    "TYPE meaning:\n" +
    "- factual: single lookup fact\n" +
    "- reasoning: single-pass inference\n" +
    "- math: numeric computation\n" +
    "- code: programming\n" +
    "- multi-step: requires decomposition into ordered sub-questions (e.g., murder mysteries, chain-of-evidence law, multi-hop reasoning)\n" +
    "- instruction: format/constraint-following\n" +
    "- creative: open-ended generation";
  const userMsg = prior
    ? `PRIOR TRANSLATION PATTERNS (may help):\n${prior}\n\nQUESTION:\n${str.slice(0, 1500)}\n\nANALYZE:`
    : `QUESTION:\n${str.slice(0, 1500)}\n\nANALYZE:`;
  const raw = await callMarina([
    { role: "system", content: systemMsg },
    { role: "user", content: userMsg },
  ]);
  const typeM = raw.match(/TYPE:\s*([a-z-]+)/i);
  const domM = raw.match(/DOMAIN:\s*(\w+)/i);
  const kwM = raw.match(/KEYWORDS:\s*(.+)/i);
  const stepsM = raw.match(/STEPS:\s*(.+)/i);

  const rawType = (typeM?.[1] ?? "").toLowerCase().trim();
  const qtype = QTYPES.includes(rawType) ? rawType : "reasoning";
  const rawDomain = (domM?.[1] ?? "").toLowerCase().trim();
  const domain = DOMAINS.includes(rawDomain) ? rawDomain : "general";
  const keywords = (kwM?.[1] ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 10)
    .join(" ");
  const stepsRaw = (stepsM?.[1] ?? "").trim();
  const steps =
    qtype === "multi-step" && stepsRaw
      ? stepsRaw
          .split(/\s*\|\s*/)
          .map((s) => s.trim())
          .filter((s) => s.length > 3)
          .slice(0, 4)
      : [];

  if (TRACE) {
    console.log(
      `[translator] analyzed: type=${qtype} domain=${domain} keywords="${keywords}" steps=${steps.length}`,
    );
  }
  return { qtype, domain, keywords, steps };
}

async function extractKeywords(agent: MarinaAgent, text: string): Promise<string> {
  const str = typeof text === "string" ? text : String(text ?? "");
  const prior = await gatherPriorTranslations(agent, str);
  const systemMsg =
    "You extract retrieval keywords. Given a text, return 3-6 concise noun phrases (space-separated, lowercase) that would retrieve relevant prior knowledge from a keyword index. Focus on abstract concepts, formulas, doctrines, domain terms — not proper nouns or incidental details. Respond with only the keywords, nothing else.";
  const userMsg = prior
    ? `PRIOR TRANSLATION PATTERNS:\n${prior}\n\nTEXT TO TRANSLATE:\n${str.slice(0, 1500)}\n\nKEYWORDS:`
    : `TEXT TO TRANSLATE:\n${str.slice(0, 1500)}\n\nKEYWORDS:`;
  const raw = await callMarina([
    { role: "system", content: systemMsg },
    { role: "user", content: userMsg },
  ]);
  // Clean: keep only words, deduplicate, cap to 10.
  const cleaned = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 10)
    .join(" ");
  if (TRACE) console.log(`[translator] "${str.slice(0, 60)}..." -> "${cleaned}"`);
  return cleaned;
}

async function reflectOnTranslation(
  agent: MarinaAgent,
  text: string,
  keywords: string,
): Promise<void> {
  if (!LEARN) return;
  const str = typeof text === "string" ? text : String(text ?? "");
  try {
    const prompt = `Given the text below and the keywords I extracted, write ONE sentence describing (a) the kind of text this is and (b) what makes these keywords good retrieval anchors. This will be stored for future translation tasks. No preamble.

TEXT: ${str.slice(0, 800)}

KEYWORDS: ${keywords}

PATTERN:`;
    const principle = await callMarina([
      { role: "system", content: "You summarize translation patterns concisely." },
      { role: "user", content: prompt },
    ]);
    const note = principle.trim().split(/\n+/)[0]?.slice(0, 500);
    if (!note) return;
    // Store the principle alongside the keywords so future recall on similar
    // vocabulary surfaces both.
    const body = `[kind] ${keywords} :: ${note}`;
    await agent.command(`note ${body}`);
    if (TRACE) console.log(`[translator] learned: ${body.slice(0, 100)}...`);
  } catch (e) {
    if (TRACE) console.error("[translator] reflect failed:", e);
  }
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[translator] logged in as ${session.name} (${session.entityId})`);
  console.log(`[translator] self-referential substrate: ${MARINA_ENDPOINT} model=${MARINA_MODEL}`);
  console.log(`[translator] listening on channel: ${TRANSLATOR_CHANNEL} (learn=${LEARN})`);

  await agent.command(`channel create ${TRANSLATOR_CHANNEL}`);
  await agent.command(`channel join ${TRANSLATOR_CHANNEL}`);

  agent.onPerception(async (p: Perception) => {
    if (p.kind !== "message" || !p.data?.text) return;
    const parsed = extractChannelPayload(p.data.text as string);
    if (!parsed || parsed.channel !== TRANSLATOR_CHANNEL || parsed.sender === session.name) return;

    let request: { type: string; id: string; text: string };
    try {
      request = JSON.parse(parsed.content);
    } catch {
      return;
    }
    if (!request.id) return;
    if (request.type !== "extract_keywords" && request.type !== "analyze") return;

    const t0 = performance.now();
    try {
      if (request.type === "analyze") {
        const analysis = await analyzeQuestion(agent, request.text ?? "");
        await agent.channel(
          TRANSLATOR_CHANNEL,
          JSON.stringify({
            type: "analysis",
            id: request.id,
            qtype: analysis.qtype,
            domain: analysis.domain,
            keywords: analysis.keywords,
            steps: analysis.steps,
          }),
        );
        const dt = Math.round(performance.now() - t0);
        console.log(
          `[translator] ${request.id} analyze -> type=${analysis.qtype} domain=${analysis.domain} steps=${analysis.steps.length} in ${dt}ms`,
        );
        reflectOnTranslation(agent, request.text ?? "", analysis.keywords).catch((e) => {
          if (TRACE) console.error("[translator] reflect error:", e);
        });
      } else {
        const keywords = await extractKeywords(agent, request.text ?? "");
        await agent.channel(
          TRANSLATOR_CHANNEL,
          JSON.stringify({ type: "keywords_result", id: request.id, keywords }),
        );
        const dt = Math.round(performance.now() - t0);
        console.log(`[translator] ${request.id} -> "${keywords}" in ${dt}ms`);
        reflectOnTranslation(agent, request.text ?? "", keywords).catch((e) => {
          if (TRACE) console.error("[translator] reflect error:", e);
        });
      }
    } catch (err) {
      console.error(`[translator] ${request.id} error:`, err);
      const errorPayload =
        request.type === "analyze"
          ? {
              type: "analysis",
              id: request.id,
              qtype: "reasoning",
              domain: "general",
              keywords: "",
              steps: [],
              error: String(err).slice(0, 200),
            }
          : {
              type: "keywords_result",
              id: request.id,
              keywords: "",
              error: String(err).slice(0, 200),
            };
      await agent.channel(TRANSLATOR_CHANNEL, JSON.stringify(errorPayload));
    }
  });

  process.on("SIGINT", () => {
    console.log("[translator] shutting down...");
    agent.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[translator] fatal:", e);
  process.exit(1);
});
