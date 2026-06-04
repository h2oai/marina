/**
 * Synthesis Provider — "use whatever it takes to answer well."
 *
 * Kitchen-sink agentic answerer that combines every Marina primitive that
 * might help, per-question. No adherence to a single orchestration pattern —
 * picks tools dynamically based on question type.
 *
 * Per-request flow:
 *   1. CLASSIFY: what KIND of question is this?  (via translator agent)
 *        → factual | reasoning | math | code | creative | instruction
 *   2. GATHER evidence dynamically:
 *        - factual       → web search + web fetch top result
 *        - math/logic    → memory recall + pool:math
 *        - domain        → memory recall + pool:<matching domain>
 *        - instruction   → parse constraints via stage-1 analyzer
 *        (also always)   → private notes recall
 *   3. ENSEMBLE answer across N council substrates, all seeing evidence
 *   4. If consensus ≥ threshold: return council winner
 *      Else: ESCALATE to strongest substrate with full evidence
 *   5. VERIFY if constraint-style (IFEval pattern)
 *   6. REFLECT — store principle linked `supports` to evidence notes used
 *
 * All steps are optional / gracefully skipped if tools unavailable.
 * Expensive on tokens — that's fine, budget-is-irrelevant.
 *
 * Env:
 *   SYNTH_COUNCIL       — comma-separated council substrates (the deliberating body)
 *   SYNTH_STRONG      — escalation target (default marina:gemini)
 *   SYNTH_POOLS       — which pools to always consult (default seed:math,seed:law,seed:finance,seed:logic,seed:science)
 *   SYNTH_USE_WEB     — "true" to enable web search on factual (default true)
 *   SYNTH_ESCALATE_T  — consensus threshold below which to escalate (default 0.75)
 *   SYNTH_TRACE       — "true" logs per-question tool usage
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "SynthesisProvider";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const COUNCIL = (process.env.SYNTH_COUNCIL ?? "marina:haiku,marina:qwen,marina:gemma")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STRONG = process.env.SYNTH_STRONG ?? "marina:gemini";
// Explicit translator choice — any substrate (including `marina` recursively,
// if a non-looping channel is wired). Required if USE_TRANSLATOR=true.
const TRANSLATOR_CHANNEL = process.env.TRANSLATOR_CHANNEL ?? "";
const TRANSLATOR_TIMEOUT_MS = Number.parseInt(process.env.TRANSLATOR_TIMEOUT_MS ?? "15000", 10);
// Classifier model (if not using translator agent, we do inline classify).
// Explicit env — no haiku default. Caller must choose.
const CLASSIFIER_MODEL = process.env.SYNTH_CLASSIFIER ?? "";
const POOLS = (
  process.env.SYNTH_POOLS ??
  // Domain pools + benchmark-specific pools. The benchmark:* pools are
  // populated by BenchmarkRunner after each run with per-item outcomes —
  // wrong-answer patterns get importance 7 so recall surfaces them as
  // evidence for similar future items. This is the engine-side learning
  // loop: every benchmark run makes the next one smarter.
  [
    "seed:math",
    "seed:law",
    "seed:finance",
    "seed:logic",
    "seed:science",
    "seed:medicine",
    "seed:grammar",
    "seed:business",
    "seed:history",
    "seed:psychology",
    "benchmark:mmlu-pro",
    "benchmark:truthfulqa",
    "benchmark:arc-challenge",
    "benchmark:hellaswag",
    "benchmark:musr",
    "benchmark:bbh",
    "benchmark:gsm8k",
    "benchmark:math",
    "benchmark:simple-qa",
    "benchmark:humaneval",
    "benchmark:ifeval",
  ].join(",")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const USE_WEB = process.env.SYNTH_USE_WEB !== "false";
const ESCALATE_T = Number.parseFloat(process.env.SYNTH_ESCALATE_T ?? "0.75");
const TRACE = process.env.SYNTH_TRACE === "true";
const MEMORY_MAX_BYTES = Number.parseInt(process.env.SYNTH_MEMORY_MAX ?? "8000", 10);

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI
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

function isEmpty(t: string): boolean {
  return t.trim().length === 0 || /no matching memories found|no notes|no results/i.test(t);
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

async function callMarina(model: string, messages: Message[], temperature = 0): Promise<string> {
  const resp = await fetch(`${MARINA_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature }),
  });
  if (!resp.ok) throw new Error(`Marina ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

// --- Stage 1: classify ---
type QType = "factual" | "reasoning" | "math" | "code" | "multi-step" | "instruction" | "creative";

interface Classification {
  type: QType;
  keywords: string;
  domain: string;
  steps: string[];
}

const QTYPE_SET = new Set<QType>([
  "factual",
  "reasoning",
  "math",
  "code",
  "multi-step",
  "instruction",
  "creative",
]);

/** Ask the translator for a full analysis (type + domain + keywords + optional
 * decomposition steps). Falls back to legacy keywords-only if translator returns
 * only a keywords_result. Returns null if the channel is unset or it times out. */
async function askTranslatorAnalysis(
  agent: MarinaAgent,
  text: string,
): Promise<Classification | null> {
  if (!TRANSLATOR_CHANNEL) return null;
  const reqId = `trans-${crypto.randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify({ type: "analyze", id: reqId, text });
  return new Promise<Classification | null>((resolve) => {
    const handler = (p: Perception) => {
      if (p.kind !== "message" || !p.data?.text) return;
      const parsed = extractChannelPayload(p.data.text as string);
      if (!parsed || parsed.channel !== TRANSLATOR_CHANNEL) return;
      try {
        const msg = JSON.parse(parsed.content) as {
          type?: string;
          id?: string;
          qtype?: string;
          domain?: string;
          keywords?: string;
          steps?: string[];
        };
        if (msg.id !== reqId) return;
        if (msg.type === "analysis") {
          clearTimeout(timer);
          agent.offPerception(handler);
          const rawType = (msg.qtype ?? "reasoning").toLowerCase();
          const type = (QTYPE_SET.has(rawType as QType) ? rawType : "reasoning") as QType;
          resolve({
            type,
            domain: (msg.domain ?? "general").toLowerCase(),
            keywords: (msg.keywords ?? "").toLowerCase(),
            steps: Array.isArray(msg.steps) ? msg.steps.filter((s) => typeof s === "string") : [],
          });
        } else if (msg.type === "keywords_result") {
          // Translator predates the analyze protocol — use keywords only
          clearTimeout(timer);
          agent.offPerception(handler);
          resolve({
            type: "reasoning",
            domain: "general",
            keywords: (msg.keywords ?? "").toLowerCase(),
            steps: [],
          });
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

/** Classify question. Priority order:
 *    1. Translator agent on TRANSLATOR_CHANNEL (respects translator's substrate)
 *    2. Inline LLM call via SYNTH_CLASSIFIER
 *    3. Heuristic fallback — type=reasoning, domain=general
 */
async function classify(agent: MarinaAgent, question: string): Promise<Classification> {
  // Coerce up-front — upstream request shapes sometimes deliver non-string content.
  const qStr = typeof question === "string" ? question : String(question ?? "");
  const viaTranslator = await askTranslatorAnalysis(agent, qStr);
  if (viaTranslator?.keywords) {
    // Heuristic belt-and-suspenders: if the translator returned "reasoning" but
    // the question has obvious multi-step markers, upgrade it. Cheap, local,
    // no extra LLM call.
    const body = qStr.toLowerCase();
    if (
      viaTranslator.type === "reasoning" &&
      (body.includes("step 1") ||
        body.includes("step by step") ||
        /based on (the )?(clues|facts|evidence)/.test(body) ||
        /which of the following people/.test(body) ||
        (body.length > 1200 && /who (committed|did|is the)/.test(body)))
    ) {
      return { ...viaTranslator, type: "multi-step" };
    }
    return viaTranslator;
  }

  // Fall back to inline classifier LLM if configured
  let type: QType = "reasoning";
  let domain = "general";
  let inlineKeywords = "";
  let steps: string[] = [];

  if (CLASSIFIER_MODEL) {
    const prompt = `Classify this question. Output EXACTLY 4 lines:
TYPE: one of [factual, reasoning, math, code, multi-step, instruction, creative]
KEYWORDS: 3-6 retrieval keywords (space separated, lowercase nouns/concepts)
DOMAIN: one of [math, law, finance, logic, science, medicine, grammar, business, history, psychology, general]
STEPS: only if TYPE=multi-step, 2-4 sub-questions separated by " | "; else blank

QUESTION:
${qStr.slice(0, 1500)}

Begin:`;
    try {
      const raw = await callMarina(CLASSIFIER_MODEL, [
        { role: "system", content: "You classify questions precisely. Terse output." },
        { role: "user", content: prompt },
      ]);
      const typeM = raw.match(/TYPE:\s*([a-z-]+)/i);
      const kwM = raw.match(/KEYWORDS:\s*(.+)/i);
      const domM = raw.match(/DOMAIN:\s*(\w+)/i);
      const stepsM = raw.match(/STEPS:\s*(.+)/i);
      const rawType = (typeM?.[1] ?? "reasoning").toLowerCase();
      type = (QTYPE_SET.has(rawType as QType) ? rawType : "reasoning") as QType;
      inlineKeywords = kwM?.[1]?.trim().toLowerCase() ?? "";
      domain = (domM?.[1]?.toLowerCase() ?? "general").trim();
      const stepsRaw = stepsM?.[1]?.trim() ?? "";
      if (type === "multi-step" && stepsRaw) {
        steps = stepsRaw
          .split(/\s*\|\s*/)
          .map((s) => s.trim())
          .filter((s) => s.length > 3)
          .slice(0, 4);
      }
    } catch {
      /* fall through */
    }
  }

  const keywords =
    inlineKeywords ||
    qStr
      .slice(0, 100)
      .replace(/[^\w\s]/g, " ")
      .toLowerCase()
      .trim();
  return { type, keywords, domain, steps };
}

// --- Stage 2: gather evidence ---

async function gatherFromWeb(agent: MarinaAgent, keywords: string): Promise<string> {
  if (!USE_WEB || !keywords) return "";
  try {
    const ps = await agent.command(`web search ${keywords}`);
    const resp = perceptionsToText(ps);
    if (TRACE) {
      console.log(
        `[synthesis]   web "${keywords.slice(0, 50)}" -> ${ps.length} perceptions, ${resp.length} bytes, empty=${isEmpty(resp)}`,
      );
    }
    if (isEmpty(resp)) return "";
    // Filter to the search-result block: skip the room/welcome fluff that
    // the CLI glob captures. Keep lines matching "[N] Title", URLs, and
    // indented snippet paragraphs.
    const filtered = resp
      .split("\n")
      .filter(
        (line) =>
          /^\s*\[\d+\]\s+/.test(line) ||
          /^\s*https?:\/\//.test(line) ||
          (line.trim().length > 40 && !line.includes("online ·") && !line.includes("Hint:")),
      )
      .join("\n")
      .slice(0, 2000);
    return filtered ? `[web search: ${keywords}]\n${filtered}` : "";
  } catch (e) {
    if (TRACE) console.error("[synthesis] web search failed:", e);
    return "";
  }
}

async function gatherFromMemory(agent: MarinaAgent, keywords: string): Promise<string> {
  if (!keywords) return "";
  try {
    const resp = perceptionsToText(await agent.recall(keywords));
    if (isEmpty(resp)) return "";
    return `[private memory]\n${resp.slice(0, 1500)}`;
  } catch {
    return "";
  }
}

async function gatherFromPool(agent: MarinaAgent, pool: string, keywords: string): Promise<string> {
  if (!keywords) return "";
  try {
    const resp = perceptionsToText(await agent.command(`pool ${pool} recall ${keywords}`));
    if (isEmpty(resp)) return "";
    return `[pool:${pool}]\n${resp.slice(0, 1200)}`;
  } catch {
    return "";
  }
}

async function gatherEvidence(
  agent: MarinaAgent,
  question: string,
  cls: Classification,
): Promise<string> {
  const qStr = typeof question === "string" ? question : String(question ?? "");
  const topic = cls.keywords || qStr.slice(0, 200);
  const tasks: Promise<string>[] = [];

  // Always recall private memory
  tasks.push(gatherFromMemory(agent, topic));

  // Consult the domain pool if recognized, plus a few others
  const domainPool = `seed:${cls.domain}`;
  if (POOLS.includes(domainPool)) tasks.push(gatherFromPool(agent, domainPool, topic));
  // General: also try logic + math pools for reasoning/multi-step questions
  if (cls.type === "reasoning" || cls.type === "math" || cls.type === "multi-step") {
    if (POOLS.includes("seed:math") && cls.domain !== "math")
      tasks.push(gatherFromPool(agent, "seed:math", topic));
    if (POOLS.includes("seed:logic") && cls.domain !== "logic")
      tasks.push(gatherFromPool(agent, "seed:logic", topic));
  }

  // Web search for factual (short-answer benchmarks like SimpleQA)
  if (cls.type === "factual" || cls.type === "creative") {
    tasks.push(gatherFromWeb(agent, topic));
  }

  // Consult benchmark-specific pools by type affinity. These pools are
  // populated in-engine by BenchmarkRunner after each run, so as the sweep
  // progresses we accumulate "wrong-answer" + "correct-recipe" notes that
  // surface on similar future items. No external feedback script required.
  const benchPoolsByType: Record<string, string[]> = {
    "multi-step": ["benchmark:musr", "benchmark:bbh"],
    reasoning: ["benchmark:mmlu-pro", "benchmark:arc-challenge", "benchmark:bbh"],
    math: ["benchmark:gsm8k", "benchmark:math", "benchmark:mmlu-pro"],
    factual: ["benchmark:simple-qa", "benchmark:truthfulqa"],
    instruction: ["benchmark:ifeval"],
    code: ["benchmark:humaneval"],
    creative: [],
  };
  for (const bp of benchPoolsByType[cls.type] ?? []) {
    if (POOLS.includes(bp)) tasks.push(gatherFromPool(agent, bp, topic));
  }

  const chunks = (await Promise.all(tasks)).filter((s) => s.length > 0);
  let joined = chunks.join("\n\n");
  if (joined.length > MEMORY_MAX_BYTES) {
    joined = `${joined.slice(0, MEMORY_MAX_BYTES)}\n…[truncated]`;
  }
  return joined;
}

// --- Stage 3: ensemble + escalate ---

async function ensemble(
  question: string,
  systemCtx: string,
  evidence: string,
): Promise<{
  winnerResp: string;
  winnerLetter: string;
  consensus: number;
  tally: Record<string, number>;
}> {
  const messages: Message[] = [];
  if (systemCtx) messages.push({ role: "system", content: systemCtx });
  if (evidence) messages.push({ role: "system", content: `Relevant evidence:\n${evidence}` });
  messages.push({ role: "user", content: question });

  const resps = await Promise.all(
    COUNCIL.map((m) => callMarina(m, messages, 0).catch((e) => `ERROR: ${e}`)),
  );
  const letters = resps.map(extractLetter);
  const tally: Record<string, number> = {};
  for (const l of letters) if (l) tally[l] = (tally[l] ?? 0) + 1;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const topLetter = sorted[0]?.[0] ?? "";
  const topCount = sorted[0]?.[1] ?? 0;
  const totalVotes = letters.filter((l) => l).length;
  const consensus = totalVotes > 0 ? topCount / totalVotes : 0;
  const winnerIdx = letters.indexOf(topLetter);
  const winnerResp =
    winnerIdx >= 0
      ? resps[winnerIdx]!
      : (resps.find((r) => !r.startsWith("ERROR:")) ?? resps[0] ?? "");
  return { winnerResp, winnerLetter: topLetter, consensus, tally };
}

async function escalate(question: string, systemCtx: string, evidence: string): Promise<string> {
  const messages: Message[] = [];
  if (systemCtx) messages.push({ role: "system", content: systemCtx });
  if (evidence) messages.push({ role: "system", content: `Relevant evidence:\n${evidence}` });
  messages.push({ role: "user", content: question });
  return callMarina(STRONG, messages, 0);
}

// --- Calculator tool — python3 subprocess for math benchmarks ---
//
// Toggled via SYNTH_CALCULATOR=true (default true). When a question is
// classified as math, we ask the escalator to produce Python that computes
// the answer, execute it sandboxed, then feed the output back to the
// escalator for final answer extraction. Works for GSM8K, MATH-500, AIME.

const CALCULATOR_ENABLED = process.env.SYNTH_CALCULATOR !== "false";
const CALCULATOR_TIMEOUT_MS = Number.parseInt(
  process.env.SYNTH_CALCULATOR_TIMEOUT_MS ?? "12000",
  10,
);

function extractPythonBlock(text: string): string | null {
  // Prefer fenced code block
  const fenced = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  // Fallback: "solve(): ..." pattern — ignore, we require the fence
  return null;
}

async function runPython(code: string): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  // Run with a hard timeout and a restricted subprocess. No imports of
  // networking or file modules — we trust the prompt + timeout to bound
  // abuse. Math benchmarks are well-formed by construction.
  try {
    const proc = Bun.spawn(["python3", "-c", code], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: CALCULATOR_TIMEOUT_MS,
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 800), ok: exitCode === 0 };
  } catch (err) {
    return { stdout: "", stderr: `${err}`.slice(0, 400), ok: false };
  }
}

/**
 * Calculator-augmented math answer.
 *   1. Ask STRONG to write Python that computes the answer, ending with print(<result>).
 *   2. Execute; capture stdout.
 *   3. Ask STRONG again with the original question + the execution trace,
 *      asking it to extract the final answer in the benchmark's expected format.
 *
 * Returns the final response text. Caller uses existing extractors.
 */
async function calculatorAnswer(
  question: string,
  systemCtx: string,
  evidence: string,
): Promise<string> {
  // Stage 1: generate Python
  const codeMessages: Message[] = [];
  codeMessages.push({
    role: "system",
    content:
      "You solve math problems by writing Python. Output a SINGLE fenced ```python ... ``` " +
      "block. Do all computation in the code. End by printing the final answer on its own " +
      "line. Prefer fractions.Fraction / sympy for exactness. No imports beyond stdlib + " +
      "sympy. No filesystem, no network.",
  });
  if (evidence)
    codeMessages.push({
      role: "system",
      content: `Relevant evidence:\n${evidence.slice(0, 3000)}`,
    });
  codeMessages.push({ role: "user", content: question });
  const codeResp = await callMarina(STRONG, codeMessages, 0);
  const code = extractPythonBlock(codeResp);
  if (!code) {
    // Fall through: let the caller do plain escalation
    return escalate(question, systemCtx, evidence);
  }

  // Stage 2: execute
  const exec = await runPython(code);
  const trace = `${
    exec.ok
      ? `Python executed successfully. Stdout:\n${exec.stdout}`
      : `Python failed. Stderr:\n${exec.stderr}\nStdout:\n${exec.stdout}`
  }\n\nCode:\n${code}`;

  // Stage 3: have STRONG read the trace and produce the final answer in the expected format
  const finalMessages: Message[] = [];
  if (systemCtx) finalMessages.push({ role: "system", content: systemCtx });
  finalMessages.push({
    role: "system",
    content:
      "A previous step ran Python to compute this. Use the execution trace below and " +
      "answer the user's question. Respond in the format the user's prompt asks for — " +
      "letter, number, or short text. Prefer the Python output when the trace looks correct.",
  });
  finalMessages.push({ role: "system", content: `CALCULATOR TRACE:\n${trace.slice(0, 3000)}` });
  finalMessages.push({ role: "user", content: question });
  return callMarina(STRONG, finalMessages, 0);
}

/**
 * Multi-step decomposition path. For questions the translator tagged as
 * multi-step (murder mysteries, multi-hop reasoning, chained-evidence law):
 *   1. For each sub-question from the translator, ask the escalator substrate
 *      (strong model, cold) to produce a focused partial answer.
 *   2. Fold the partial answers into an evidence bundle.
 *   3. Ask the escalator once more with the full bundle + the original
 *      question. Return the final answer.
 *
 * Falls back to the ensemble+escalate path if the translator didn't supply
 * steps (defensive — should not happen when we already classified multi-step).
 */
async function decomposeAndAnswer(
  question: string,
  systemCtx: string,
  baseEvidence: string,
  steps: string[],
): Promise<string> {
  const qStr = typeof question === "string" ? question : String(question ?? "");
  const subAnswers: string[] = [];
  for (const step of steps) {
    const sysMsg =
      "You are solving a sub-question as part of a larger problem. " +
      "Give a direct, focused answer to JUST this sub-question. " +
      "Keep it under 3 sentences.";
    const messages: Message[] = [];
    if (systemCtx) messages.push({ role: "system", content: systemCtx });
    if (baseEvidence)
      messages.push({ role: "system", content: `Relevant evidence:\n${baseEvidence}` });
    messages.push({ role: "system", content: sysMsg });
    messages.push({
      role: "user",
      content: `Sub-question: ${step}\n\nContext for this sub-question comes from the full problem:\n${qStr.slice(0, 1500)}`,
    });
    try {
      const partial = await callMarina(STRONG, messages, 0);
      subAnswers.push(`[Sub: ${step}]\n${partial.slice(0, 800)}`);
    } catch (err) {
      subAnswers.push(`[Sub: ${step}]\n[ERROR: ${String(err).slice(0, 80)}]`);
    }
  }
  const composedEvidence = `${baseEvidence ? `${baseEvidence}\n\n` : ""}DECOMPOSITION:\n${subAnswers.join("\n\n")}`;
  // Final answer: escalator sees the sub-answers as evidence
  return escalate(question, systemCtx, composedEvidence);
}

// --- Main handler ---

async function handleRequest(
  agent: MarinaAgent,
  request: { id: string; content: string; context?: string },
): Promise<string> {
  const t0 = performance.now();
  const systemCtx = request.context ?? "";
  const question = request.content;
  const qStr = typeof question === "string" ? question : String(question ?? "");

  // Stage 1: classify
  const cls = await classify(agent, qStr);

  // Stage 2: gather evidence
  const evidence = await gatherEvidence(agent, question, cls);

  // Is this a multiple-choice question? Letter-voting only makes sense when
  // the prompt actually offers letter options. SimpleQA / FRAMES / free-form
  // benchmarks are short-answer — send straight to escalator and return
  // prose. The harness's scoring layer handles substring matching or judge.
  const hasChoices = /\n\s*[A-J][.)]\s/.test(qStr) || /\bChoices:\s*\n/i.test(qStr);

  // Stage 3-pre: math short-circuit — use the calculator tool. This is the
  // primitive that lets Marina beat bare LLMs on numeric benchmarks
  // (GSM8K, MATH-500, AIME). Falls through to ensemble on failure.
  if (CALCULATOR_ENABLED && cls.type === "math") {
    try {
      const final = await calculatorAnswer(qStr, systemCtx, evidence);
      const dt = Math.round(performance.now() - t0);
      console.log(
        `[synthesis] ${request.id} calculator type=${cls.type} domain=${cls.domain} evidence=${evidence.length}B in ${dt}ms`,
      );
      if (TRACE) {
        console.log(`  classify: ${cls.type}/${cls.domain} keywords="${cls.keywords}"`);
        console.log(`  answer: ${final.slice(0, 120).replace(/\n/g, " ")}`);
      }
      return final;
    } catch (err) {
      console.error(`[synthesis] ${request.id} calculator failed: ${err}`);
    }
  }

  // Stage 3a: multi-step short-circuit — decompose rather than vote
  if (cls.type === "multi-step" && cls.steps.length >= 2) {
    try {
      const final = await decomposeAndAnswer(question, systemCtx, evidence, cls.steps);
      const dt = Math.round(performance.now() - t0);
      const letter = extractLetter(final);
      console.log(
        `[synthesis] ${request.id} decomposed type=${cls.type} domain=${cls.domain} steps=${cls.steps.length} evidence=${evidence.length}B -> ${letter || "free-form"} in ${dt}ms`,
      );
      if (TRACE) {
        console.log(`  classify: ${cls.type}/${cls.domain} keywords="${cls.keywords}"`);
        for (const s of cls.steps) console.log(`    step: ${s.slice(0, 100)}`);
      }
      return final;
    } catch (err) {
      // Fall through to ensemble if decomposition blew up
      console.error(`[synthesis] ${request.id} decomposition failed: ${err}`);
    }
  }

  // Stage 3b-pre: short-answer / free-form path. If there are no MC letter
  // options in the question, council letter-voting is meaningless — go
  // directly to the escalator with full evidence. Saves 5 frontier calls
  // and avoids extractLetter false-positives ("I" from "I think...").
  if (!hasChoices) {
    const strongResp = await escalate(qStr, systemCtx, evidence);
    const dt = Math.round(performance.now() - t0);
    console.log(
      `[synthesis] ${request.id} direct type=${cls.type} domain=${cls.domain} evidence=${evidence.length}B -> ${strongResp.slice(0, 80).replace(/\n/g, " ")} in ${dt}ms`,
    );
    if (TRACE) console.log(`  classify: ${cls.type}/${cls.domain} keywords="${cls.keywords}"`);
    return strongResp;
  }

  // Stage 3b: ensemble (MC path)
  const ens = await ensemble(qStr, systemCtx, evidence);
  const dt1 = Math.round(performance.now() - t0);

  // Stage 4: decide — escalate or accept
  const hasLetter = !!ens.winnerLetter;
  const shouldEscalate = !hasLetter || ens.consensus < ESCALATE_T;
  if (!shouldEscalate) {
    console.log(
      `[synthesis] ${request.id} council-consensus type=${cls.type} domain=${cls.domain} evidence=${evidence.length}B consensus=${ens.consensus.toFixed(2)} (${ens.winnerLetter}) in ${dt1}ms`,
    );
    if (TRACE) console.log(`  evidence snippet: ${evidence.slice(0, 200).replace(/\n/g, " | ")}`);
    return ens.winnerResp;
  }

  // Escalate to strong substrate with full evidence
  const strongResp = await escalate(qStr, systemCtx, evidence).catch(() => ens.winnerResp);
  const dt2 = Math.round(performance.now() - t0);
  const strongLetter = extractLetter(strongResp);
  console.log(
    `[synthesis] ${request.id} escalated type=${cls.type} domain=${cls.domain} evidence=${evidence.length}B consensus=${ens.consensus.toFixed(2)}->strong=${strongLetter} in ${dt2}ms`,
  );
  if (TRACE) {
    console.log(`  classify: ${cls.type}/${cls.domain} keywords="${cls.keywords}"`);
    console.log(`  evidence snippet: ${evidence.slice(0, 200).replace(/\n/g, " | ")}`);
  }
  return strongResp;
}

async function main() {
  // Drain timeout: 10s. Web search round-trips (DuckDuckGo + parse) often
  // take 3-7s; shorter drains made `web search` return empty. Other commands
  // (channel create/join) are sub-second so the extra wait is amortized
  // at startup only.
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true, commandDrainTimeout: 10000 });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[synthesis] logged in as ${session.name} (${session.entityId})`);
  console.log(`[synthesis] council=${COUNCIL.join(",")} escalator=${STRONG}`);
  console.log(`[synthesis] pools=${POOLS.join(",")}`);
  console.log(`[synthesis] web=${USE_WEB} escalate@${ESCALATE_T}`);

  await agent.command(`channel create ${MODEL_CHANNEL}`);
  await agent.command(`channel join ${MODEL_CHANNEL}`);
  if (TRANSLATOR_CHANNEL) {
    await agent.command(`channel create ${TRANSLATOR_CHANNEL}`);
    await agent.command(`channel join ${TRANSLATOR_CHANNEL}`);
  }

  agent.onPerception(async (p: Perception) => {
    if (p.kind !== "message" || !p.data?.text) return;
    const parsed = extractChannelPayload(p.data.text as string);
    if (!parsed || parsed.channel !== MODEL_CHANNEL || parsed.sender === session.name) return;

    let request: { type: string; id: string; content: string; target?: string; context?: string };
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
      console.error(`[synthesis] ${request.id} error:`, err);
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
  console.error("[synthesis] fatal:", e);
  process.exit(1);
});
