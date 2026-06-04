import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatasetItem } from "./types";

const DATASETS_DIR = join(import.meta.dir, "datasets");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function cachePath(name: string): string {
  return join(DATASETS_DIR, `${name}.json`);
}

function loadCache(name: string): DatasetItem[] | null {
  const path = cachePath(name);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  return null;
}

function saveCache(name: string, items: DatasetItem[]): void {
  ensureDir(DATASETS_DIR);
  writeFileSync(cachePath(name), JSON.stringify(items, null, 2));
}

async function fetchHuggingFace(
  dataset: string,
  config: string,
  split: string,
  maxRows: number,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const batchSize = Math.min(100, maxRows);
  let offset = 0;

  // HF_TOKEN unlocks gated datasets (e.g., GPQA Idavidrein/gpqa). Required
  // by those dataset's licenses — the HF datasets-server honors the same
  // Bearer token as the HuggingFace Hub API.
  const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  const headers: Record<string, string> = {};
  if (hfToken) headers.Authorization = `Bearer ${hfToken}`;

  while (rows.length < maxRows) {
    const remaining = maxRows - rows.length;
    const length = Math.min(batchSize, remaining);
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`;

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const body = await resp.text();
      const hint =
        resp.status === 401 || resp.status === 403
          ? " (gated dataset — set HF_TOKEN with access to this dataset)"
          : "";
      throw new Error(`HuggingFace API error ${resp.status}${hint}: ${body}`);
    }
    const data = (await resp.json()) as { rows: { row: unknown }[] };
    if (!data.rows || data.rows.length === 0) break;

    for (const r of data.rows) {
      rows.push(r.row);
    }
    offset += data.rows.length;
    if (data.rows.length < length) break;
  }

  return rows;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    const j = s % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const MMLU_MIN_POOL = 2000;

export async function downloadMMLUPro(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "mmlu-pro";
  const cached = loadCache(name);
  if (cached && cached.length >= MMLU_MIN_POOL) {
    console.log(`  Using cached ${name} (${cached.length} items, pool for seed/shuffle)`);
    return cached;
  }

  console.log(`  Downloading MMLU-Pro from HuggingFace (pool size ${MMLU_MIN_POOL})...`);
  const maxRows = Math.max(MMLU_MIN_POOL, limit ?? 0);
  const raw = (await fetchHuggingFace("TIGER-Lab/MMLU-Pro", "default", "test", maxRows)) as {
    question_id?: number;
    question: string;
    options: string[];
    answer: string;
    category: string;
  }[];

  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `mmlu-pro-${r.question_id ?? i}`,
    question: r.question,
    choices: r.options,
    answer: r.answer,
    category: r.category,
  }));

  saveCache(name, items);
  console.log(`  Downloaded ${items.length} MMLU-Pro items`);
  return items;
}

export async function downloadIFEval(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "ifeval";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return limit ? cached.slice(0, limit) : cached;
  }

  console.log("  Downloading IFEval from HuggingFace...");
  const raw = (await fetchHuggingFace("google/IFEval", "default", "train", 600)) as {
    key?: number;
    prompt: string;
    instruction_id_list: string[];
    kwargs: Record<string, unknown>[];
  }[];

  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `ifeval-${r.key ?? i}`,
    question: r.prompt,
    answer: "",
    metadata: {
      instruction_id_list: r.instruction_id_list,
      kwargs: r.kwargs,
    },
  }));

  saveCache(name, items);
  console.log(`  Downloaded ${items.length} IFEval items`);
  return limit ? items.slice(0, limit) : items;
}

export async function downloadTruthfulQA(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "truthfulqa";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return limit ? cached.slice(0, limit) : cached;
  }

  console.log("  Downloading TruthfulQA from HuggingFace...");
  const raw = (await fetchHuggingFace(
    "truthfulqa/truthful_qa",
    "multiple_choice",
    "validation",
    900,
  )) as {
    question: string;
    mc2_targets: { choices: string[]; labels: number[] };
  }[];

  const items: DatasetItem[] = raw.map((r, i) => {
    const correctIndices = r.mc2_targets.labels
      .map((l: number, idx: number) => (l === 1 ? idx : -1))
      .filter((idx: number) => idx >= 0);
    return {
      id: `truthfulqa-${i}`,
      question: r.question,
      choices: r.mc2_targets.choices,
      answer: correctIndices.join(","),
      metadata: {
        labels: r.mc2_targets.labels,
        numCorrect: correctIndices.length,
      },
    };
  });

  saveCache(name, items);
  console.log(`  Downloaded ${items.length} TruthfulQA items`);
  return limit ? items.slice(0, limit) : items;
}

export async function downloadHumanEval(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "humaneval";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return limit ? cached.slice(0, limit) : cached;
  }

  console.log("  Downloading HumanEval from HuggingFace...");
  const raw = (await fetchHuggingFace(
    "openai/openai_humaneval",
    "openai_humaneval",
    "test",
    200,
  )) as {
    task_id: string;
    prompt: string;
    canonical_solution: string;
    test: string;
    entry_point: string;
  }[];

  const items: DatasetItem[] = raw.map((r) => ({
    id: r.task_id,
    question: r.prompt,
    answer: r.canonical_solution,
    metadata: {
      test: r.test,
      entry_point: r.entry_point,
      prompt: r.prompt,
    },
  }));

  saveCache(name, items);
  console.log(`  Downloaded ${items.length} HumanEval items`);
  return limit ? items.slice(0, limit) : items;
}

export async function downloadNarrativeQA(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "narrativeqa";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return limit ? cached.slice(0, limit) : cached;
  }

  console.log("  Downloading NarrativeQA from HuggingFace...");
  const maxRows = limit || 200;
  const raw = (await fetchHuggingFace("deepmind/narrativeqa", "default", "test", maxRows)) as {
    document: { summary?: { text?: string } };
    question: { text: string };
    answers: { text: string }[];
  }[];

  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `narrativeqa-${i}`,
    question: r.question.text,
    answer: r.answers?.[0]?.text ?? "",
    metadata: {
      summary: r.document?.summary?.text ?? "",
      allAnswers: r.answers?.map((a: { text: string }) => a.text) ?? [],
    },
  }));

  saveCache(name, items);
  console.log(`  Downloaded ${items.length} NarrativeQA items`);
  return limit ? items.slice(0, limit) : items;
}

export async function downloadMTBench(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "mt-bench";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return limit ? cached.slice(0, limit) : cached;
  }

  console.log("  Downloading MT-Bench from HuggingFace...");
  const raw = (await fetchHuggingFace(
    "HuggingFaceH4/mt_bench_prompts",
    "default",
    "train",
    100,
  )) as {
    prompt_id?: string;
    prompt: string[];
    category: string;
    reference?: string[];
  }[];

  const items: DatasetItem[] = raw.map((r, i) => ({
    id: r.prompt_id ?? `mt-bench-${i}`,
    question: r.prompt[0],
    answer: r.reference?.[0] ?? "",
    category: r.category,
    metadata: {
      turns: r.prompt,
      references: r.reference ?? [],
    },
  }));

  saveCache(name, items);
  console.log(`  Downloaded ${items.length} MT-Bench items`);
  return limit ? items.slice(0, limit) : items;
}

export function loadRetentionBenchmark(_dir: string, limit?: number): DatasetItem[] {
  const tasks = generateRetentionTasks();
  return limit ? tasks.slice(0, limit) : tasks;
}

// ─── New benchmark downloaders ──────────────────────────────────────────────

/** GPQA Diamond — 198 graduate-level physics/bio/chem MC questions. */
export async function downloadGPQA(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "gpqa";
  const cached = loadCache(name);
  if (cached && cached.length >= 198) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading GPQA Diamond from HuggingFace...");
  const raw = (await fetchHuggingFace("Idavidrein/gpqa", "gpqa_diamond", "train", 300)) as {
    Question: string;
    "Correct Answer": string;
    "Incorrect Answer 1": string;
    "Incorrect Answer 2": string;
    "Incorrect Answer 3": string;
    Subdomain?: string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => {
    // Randomize letter assignment deterministically by question index to avoid position bias.
    const choices = [
      r["Correct Answer"],
      r["Incorrect Answer 1"],
      r["Incorrect Answer 2"],
      r["Incorrect Answer 3"],
    ];
    // Pseudo-shuffle by index so answer letter varies but is deterministic across runs.
    const seed = i;
    const order = [0, 1, 2, 3].sort((a, b) => ((a + 1) * 2654435761 * (seed + 1)) % 7919 - ((b + 1) * 2654435761 * (seed + 1)) % 7919);
    const shuffled = order.map((o) => choices[o]!);
    const correctIdx = order.indexOf(0);
    return {
      id: `gpqa-${i}`,
      question: r.Question,
      choices: shuffled,
      answer: "ABCD"[correctIdx]!,
      category: r.Subdomain ?? "unknown",
    };
  });
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} GPQA items`);
  return items;
}

/** ARC-Challenge — 1172 grade-school science MC. */
export async function downloadARC(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "arc-challenge";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading ARC-Challenge from HuggingFace...");
  const raw = (await fetchHuggingFace("allenai/ai2_arc", "ARC-Challenge", "test", 1200)) as {
    id: string;
    question: string;
    choices: { text: string[]; label: string[] };
    answerKey: string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `arc-${r.id ?? i}`,
    question: r.question,
    choices: r.choices.text,
    answer: r.answerKey,
    category: "science",
  }));
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} ARC items`);
  return items;
}

/** HellaSwag — 10042 commonsense sentence-completion. Cache 2000. */
export async function downloadHellaSwag(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "hellaswag";
  const MIN = 2000;
  const cached = loadCache(name);
  if (cached && cached.length >= MIN) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading HellaSwag from HuggingFace...");
  const raw = (await fetchHuggingFace("Rowan/hellaswag", "default", "validation", Math.max(MIN, limit ?? 0))) as {
    ind: number;
    ctx: string;
    endings: string[];
    label: string;
    activity_label?: string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `hellaswag-${r.ind ?? i}`,
    question: `${r.ctx}\n\nWhich ending is most natural?`,
    choices: r.endings,
    answer: "ABCD"[Number.parseInt(r.label, 10)] ?? "A",
    category: r.activity_label ?? "general",
  }));
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} HellaSwag items`);
  return items;
}

/** GSM8K — 1319 grade-school math word problems (test split). */
export async function downloadGSM8K(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "gsm8k";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading GSM8K from HuggingFace...");
  const raw = (await fetchHuggingFace("openai/gsm8k", "main", "test", 1400)) as {
    question: string;
    answer: string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => {
    // GSM8K answers are "<reasoning>#### <number>"
    const m = r.answer.match(/####\s*(-?[\d,.]+)/);
    const num = m ? m[1]!.replace(/,/g, "") : r.answer.trim();
    return {
      id: `gsm8k-${i}`,
      question: r.question,
      answer: num,
      category: "math",
    };
  });
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} GSM8K items`);
  return items;
}

/** MATH — competition math problems (test split of MATH-500 subset). */
export async function downloadMATH(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "math";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading MATH-500 from HuggingFace...");
  const raw = (await fetchHuggingFace("HuggingFaceH4/MATH-500", "default", "test", 500)) as {
    problem: string;
    answer: string;
    subject?: string;
    level?: number;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `math-${i}`,
    question: r.problem,
    answer: r.answer,
    category: r.subject ?? "math",
    metadata: { level: r.level ?? 0 },
  }));
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} MATH items`);
  return items;
}

/** SimpleQA — 4326 short-answer factual questions (OpenAI). */
export async function downloadSimpleQA(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "simpleqa";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading SimpleQA from HuggingFace...");
  const raw = (await fetchHuggingFace("basicv8vc/SimpleQA", "default", "test", 500)) as {
    problem: string;
    answer: string;
    metadata?: string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `simpleqa-${i}`,
    question: r.problem,
    answer: r.answer,
    category: "factual",
  }));
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} SimpleQA items`);
  return items;
}

/** MuSR — Multi-step soft reasoning (team_allocation task). */
export async function downloadMuSR(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "musr";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading MuSR from HuggingFace...");
  const raw = (await fetchHuggingFace("TAUR-Lab/MuSR", "default", "murder_mysteries", 300)) as {
    narrative: string;
    question: string;
    choices: string;
    answer_index: number;
    answer_choice: string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => {
    const choices = typeof r.choices === "string"
      ? (() => {
          try { return JSON.parse(r.choices); } catch { return r.choices.split("|"); }
        })()
      : r.choices;
    return {
      id: `musr-${i}`,
      question: `${r.narrative}\n\n${r.question}`,
      choices: Array.isArray(choices) ? choices : [String(choices)],
      answer: "ABCDEFG"[r.answer_index] ?? "A",
      category: "reasoning",
    };
  });
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} MuSR items`);
  return items;
}

/** FRAMES — multi-hop factual retrieval benchmark. Open-ended questions,
 *  answer requires composing facts from multiple Wikipedia articles. */
export async function downloadFRAMES(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "frames";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading FRAMES from HuggingFace...");
  const raw = (await fetchHuggingFace("google/frames-benchmark", "default", "test", 1000)) as {
    Prompt: string;
    Answer: string;
    reasoning_types?: string;
    wikipedia_link_1?: string;
    wikipedia_link_2?: string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `frames-${i}`,
    question: r.Prompt,
    answer: (r.Answer ?? "").toString().trim(),
    category: (r.reasoning_types ?? "multi-hop").split(/[,/]/)[0]?.trim() || "multi-hop",
    metadata: {
      sources: [r.wikipedia_link_1, r.wikipedia_link_2].filter(Boolean).join("|"),
    },
  }));
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} FRAMES items`);
  return items;
}

/** AIME 2024 — American Invitational Math Examination 2024, integer answer 0-999. */
export async function downloadAIME(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "aime-2024";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading AIME-2024 from HuggingFace...");
  const raw = (await fetchHuggingFace("Maxwell-Jia/AIME_2024", "default", "train", 50)) as {
    ID: string;
    Problem: string;
    Answer: number | string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `aime-${r.ID ?? i}`,
    question: r.Problem,
    answer: String(r.Answer),
    category: "olympiad-math",
  }));
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} AIME items`);
  return items;
}

/** AIME 2025 — latest AIME, integer answer 0-999. 30 problems. */
export async function downloadAIME2025(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "aime-2025";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading AIME-2025 from HuggingFace...");
  // yentinglin/aime_2025 default/train has all 30 problems in one split.
  // Fields: { id, problem, answer, solution, url }.
  const raw = (await fetchHuggingFace("yentinglin/aime_2025", "default", "train", 50)) as {
    id: number | string;
    problem: string;
    answer: number | string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => ({
    id: `aime2025-${r.id ?? i}`,
    question: r.problem,
    answer: String(r.answer),
    category: "olympiad-math",
  }));
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} AIME-2025 items`);
  return items;
}

/** BIG-Bench Hard — subset (boolean_expressions is MC-like). */
export async function downloadBBH(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const name = "bbh";
  const cached = loadCache(name);
  if (cached) {
    console.log(`  Using cached ${name} (${cached.length} items)`);
    return cached;
  }
  console.log("  Downloading BBH (logical_deduction_five_objects) from HuggingFace...");
  const raw = (await fetchHuggingFace(
    "lukaemon/bbh",
    "logical_deduction_five_objects",
    "test",
    300,
  )) as {
    input: string;
    target: string;
  }[];
  const items: DatasetItem[] = raw.map((r, i) => {
    // BBH targets are "(A)" format; question already contains options
    const m = r.target.match(/\(([A-Z])\)/);
    const ans = m ? m[1]! : r.target.trim();
    return {
      id: `bbh-${i}`,
      question: r.input,
      answer: ans,
      category: "logical-deduction",
    };
  });
  saveCache(name, items);
  console.log(`  Downloaded ${items.length} BBH items`);
  return items;
}

function generateRetentionTasks(): DatasetItem[] {
  const facts = [
    { teach: "The vault code is 7249", recall: "What is the vault code?", answer: "7249" },
    {
      teach: "My favorite color is cerulean blue",
      recall: "What is my favorite color?",
      answer: "cerulean blue",
    },
    {
      teach: "The secret password is 'luminous-cascade-42'",
      recall: "What is the secret password?",
      answer: "luminous-cascade-42",
    },
    {
      teach: "The meeting is scheduled for March 15th at 3pm",
      recall: "When is the meeting scheduled?",
      answer: "March 15th at 3pm",
    },
    {
      teach: "Project codename is Operation Nightingale",
      recall: "What is the project codename?",
      answer: "Operation Nightingale",
    },
    {
      teach: "The server IP address is 192.168.42.17",
      recall: "What is the server IP address?",
      answer: "192.168.42.17",
    },
    {
      teach: "My employee ID is EMP-8847-XZ",
      recall: "What is my employee ID?",
      answer: "EMP-8847-XZ",
    },
    {
      teach: "The emergency contact number is 555-0137",
      recall: "What is the emergency contact number?",
      answer: "555-0137",
    },
    {
      teach: "The database backup runs at 02:30 UTC daily",
      recall: "When does the database backup run?",
      answer: "02:30 UTC daily",
    },
    {
      teach: "The API rate limit is 1000 requests per minute",
      recall: "What is the API rate limit?",
      answer: "1000 requests per minute",
    },
    {
      teach: "The warehouse is located at 742 Evergreen Terrace",
      recall: "Where is the warehouse located?",
      answer: "742 Evergreen Terrace",
    },
    {
      teach: "The CEO's birthday is November 3rd",
      recall: "When is the CEO's birthday?",
      answer: "November 3rd",
    },
    {
      teach: "The maximum file upload size is 256MB",
      recall: "What is the maximum file upload size?",
      answer: "256MB",
    },
    {
      teach: "The company was founded in 1987",
      recall: "When was the company founded?",
      answer: "1987",
    },
    {
      teach: "The WiFi password is 'quantum-fox-99'",
      recall: "What is the WiFi password?",
      answer: "quantum-fox-99",
    },
    {
      teach: "The quarterly report is due on April 1st",
      recall: "When is the quarterly report due?",
      answer: "April 1st",
    },
    {
      teach: "The build server uses port 8443",
      recall: "What port does the build server use?",
      answer: "8443",
    },
    {
      teach: "The encryption key rotation happens every 90 days",
      recall: "How often does encryption key rotation happen?",
      answer: "every 90 days",
    },
    {
      teach: "The lunch budget is $25 per person",
      recall: "What is the lunch budget per person?",
      answer: "$25",
    },
    {
      teach: "The staging environment URL is staging.example.io",
      recall: "What is the staging environment URL?",
      answer: "staging.example.io",
    },
    {
      teach: "The support ticket SLA is 4 hours",
      recall: "What is the support ticket SLA?",
      answer: "4 hours",
    },
    {
      teach: "The default timeout is 30 seconds",
      recall: "What is the default timeout?",
      answer: "30 seconds",
    },
    {
      teach: "The office door code is 4521#",
      recall: "What is the office door code?",
      answer: "4521#",
    },
    {
      teach: "The vendor contact is Sarah Chen at ext 2847",
      recall: "Who is the vendor contact and their extension?",
      answer: "Sarah Chen at ext 2847",
    },
    {
      teach: "The data retention policy is 7 years",
      recall: "What is the data retention policy?",
      answer: "7 years",
    },
    {
      teach: "The sprint duration is 2 weeks",
      recall: "What is the sprint duration?",
      answer: "2 weeks",
    },
    {
      teach: "The primary DNS server is 10.0.0.53",
      recall: "What is the primary DNS server?",
      answer: "10.0.0.53",
    },
    {
      teach: "The monthly cloud budget cap is $15,000",
      recall: "What is the monthly cloud budget cap?",
      answer: "$15,000",
    },
    {
      teach: "The CI pipeline timeout is 45 minutes",
      recall: "What is the CI pipeline timeout?",
      answer: "45 minutes",
    },
    {
      teach: "The release train departs every Tuesday at 10am",
      recall: "When does the release train depart?",
      answer: "every Tuesday at 10am",
    },
    {
      teach: "The monitoring dashboard is at grafana.internal:3000",
      recall: "Where is the monitoring dashboard?",
      answer: "grafana.internal:3000",
    },
    {
      teach: "The disaster recovery RTO is 4 hours",
      recall: "What is the disaster recovery RTO?",
      answer: "4 hours",
    },
    {
      teach: "The production database is on host db-prod-07",
      recall: "What host is the production database on?",
      answer: "db-prod-07",
    },
    {
      teach: "The compliance audit is scheduled for June 15th",
      recall: "When is the compliance audit scheduled?",
      answer: "June 15th",
    },
    {
      teach: "The API version prefix is /v3/",
      recall: "What is the API version prefix?",
      answer: "/v3/",
    },
    {
      teach: "The maximum concurrent connections is 500",
      recall: "What is the maximum concurrent connections?",
      answer: "500",
    },
    {
      teach: "The backup encryption algorithm is AES-256-GCM",
      recall: "What is the backup encryption algorithm?",
      answer: "AES-256-GCM",
    },
    {
      teach: "The team standup is at 9:15am in Room B",
      recall: "When and where is the team standup?",
      answer: "9:15am in Room B",
    },
    {
      teach: "The log rotation happens at midnight UTC",
      recall: "When does log rotation happen?",
      answer: "midnight UTC",
    },
    {
      teach: "The SSO provider is Okta with tenant ID acme-prod",
      recall: "What is the SSO provider and tenant ID?",
      answer: "Okta with tenant ID acme-prod",
    },
    {
      teach: "The feature flag service is at flags.internal:8080",
      recall: "Where is the feature flag service?",
      answer: "flags.internal:8080",
    },
    {
      teach: "The cache TTL for user sessions is 15 minutes",
      recall: "What is the cache TTL for user sessions?",
      answer: "15 minutes",
    },
    {
      teach: "The PagerDuty escalation policy is P1-critical",
      recall: "What is the PagerDuty escalation policy?",
      answer: "P1-critical",
    },
    {
      teach: "The artifact registry is at artifacts.example.com",
      recall: "Where is the artifact registry?",
      answer: "artifacts.example.com",
    },
    {
      teach: "The database connection pool size is 20",
      recall: "What is the database connection pool size?",
      answer: "20",
    },
    {
      teach: "The security scan runs at 3am on Sundays",
      recall: "When does the security scan run?",
      answer: "3am on Sundays",
    },
    {
      teach: "The CDN origin shield is in us-east-1",
      recall: "Where is the CDN origin shield?",
      answer: "us-east-1",
    },
    {
      teach: "The on-call rotation is weekly starting Monday",
      recall: "How does the on-call rotation work?",
      answer: "weekly starting Monday",
    },
    {
      teach: "The load balancer health check interval is 10 seconds",
      recall: "What is the load balancer health check interval?",
      answer: "10 seconds",
    },
    {
      teach: "The mobile app minimum version is 3.2.1",
      recall: "What is the mobile app minimum version?",
      answer: "3.2.1",
    },
    {
      teach: "The Kafka topic partition count is 12",
      recall: "What is the Kafka topic partition count?",
      answer: "12",
    },
    {
      teach: "The Redis cluster has 6 nodes",
      recall: "How many nodes does the Redis cluster have?",
      answer: "6",
    },
    {
      teach: "The JWT token expiry is 1 hour",
      recall: "What is the JWT token expiry?",
      answer: "1 hour",
    },
    {
      teach: "The code freeze starts December 20th",
      recall: "When does the code freeze start?",
      answer: "December 20th",
    },
    {
      teach: "The test coverage requirement is 80%",
      recall: "What is the test coverage requirement?",
      answer: "80%",
    },
    {
      teach: "The Elasticsearch cluster name is search-prod-v2",
      recall: "What is the Elasticsearch cluster name?",
      answer: "search-prod-v2",
    },
    {
      teach: "The S3 bucket for backups is acme-dr-backups-us-east",
      recall: "What is the S3 bucket for backups?",
      answer: "acme-dr-backups-us-east",
    },
    {
      teach: "The internal wiki is at wiki.internal.example.com",
      recall: "Where is the internal wiki?",
      answer: "wiki.internal.example.com",
    },
    {
      teach: "The GraphQL schema version is 4.7.2",
      recall: "What is the GraphQL schema version?",
      answer: "4.7.2",
    },
    {
      teach: "The Terraform state bucket is tf-state-prod-2024",
      recall: "What is the Terraform state bucket?",
      answer: "tf-state-prod-2024",
    },
    {
      teach: "The container image registry is gcr.io/acme-prod",
      recall: "What is the container image registry?",
      answer: "gcr.io/acme-prod",
    },
    {
      teach: "The webhook retry policy is 3 attempts with exponential backoff",
      recall: "What is the webhook retry policy?",
      answer: "3 attempts with exponential backoff",
    },
    {
      teach: "The DNS TTL for production is 300 seconds",
      recall: "What is the DNS TTL for production?",
      answer: "300 seconds",
    },
    {
      teach: "The development branch naming convention is feat/TICKET-description",
      recall: "What is the development branch naming convention?",
      answer: "feat/TICKET-description",
    },
    {
      teach: "The shared drive is at //nas.internal/shared",
      recall: "Where is the shared drive?",
      answer: "//nas.internal/shared",
    },
    {
      teach: "The OpenTelemetry collector is at otel.internal:4317",
      recall: "Where is the OpenTelemetry collector?",
      answer: "otel.internal:4317",
    },
    {
      teach: "The maximum request body size is 10MB",
      recall: "What is the maximum request body size?",
      answer: "10MB",
    },
    {
      teach: "The Vault secret engine path is secret/data/prod",
      recall: "What is the Vault secret engine path?",
      answer: "secret/data/prod",
    },
    {
      teach: "The message queue dead letter threshold is 5 retries",
      recall: "What is the message queue dead letter threshold?",
      answer: "5 retries",
    },
    {
      teach: "The service mesh uses Istio version 1.19",
      recall: "What version of Istio does the service mesh use?",
      answer: "1.19",
    },
    {
      teach: "The database migration tool is Flyway",
      recall: "What is the database migration tool?",
      answer: "Flyway",
    },
    {
      teach: "The canary deployment percentage is 5%",
      recall: "What is the canary deployment percentage?",
      answer: "5%",
    },
    {
      teach: "The error budget for the quarter is 99.9% uptime",
      recall: "What is the error budget for the quarter?",
      answer: "99.9% uptime",
    },
    {
      teach: "The primary cloud region is eu-west-1",
      recall: "What is the primary cloud region?",
      answer: "eu-west-1",
    },
    {
      teach: "The API gateway is Kong version 3.4",
      recall: "What API gateway and version is used?",
      answer: "Kong version 3.4",
    },
    {
      teach: "The secrets rotation schedule is every 60 days",
      recall: "What is the secrets rotation schedule?",
      answer: "every 60 days",
    },
    {
      teach: "The performance budget for LCP is 2.5 seconds",
      recall: "What is the performance budget for LCP?",
      answer: "2.5 seconds",
    },
    {
      teach: "The incident commander for this week is Alex Park",
      recall: "Who is the incident commander this week?",
      answer: "Alex Park",
    },
    {
      teach: "The WAF rule set version is OWASP-3.3.4",
      recall: "What is the WAF rule set version?",
      answer: "OWASP-3.3.4",
    },
    {
      teach: "The batch processing window is 1am-5am UTC",
      recall: "What is the batch processing window?",
      answer: "1am-5am UTC",
    },
    {
      teach: "The synthetic monitoring check interval is 5 minutes",
      recall: "What is the synthetic monitoring check interval?",
      answer: "5 minutes",
    },
    {
      teach: "The blue-green deployment switch takes 30 seconds",
      recall: "How long does the blue-green deployment switch take?",
      answer: "30 seconds",
    },
    {
      teach: "The code review approval requirement is 2 reviewers",
      recall: "How many reviewers are required for code review approval?",
      answer: "2",
    },
    {
      teach: "The container CPU limit is 2 cores",
      recall: "What is the container CPU limit?",
      answer: "2 cores",
    },
    {
      teach: "The container memory limit is 4GB",
      recall: "What is the container memory limit?",
      answer: "4GB",
    },
    {
      teach: "The artifact retention period is 30 days",
      recall: "What is the artifact retention period?",
      answer: "30 days",
    },
    {
      teach: "The A/B test minimum sample size is 10,000 users",
      recall: "What is the A/B test minimum sample size?",
      answer: "10,000 users",
    },
    {
      teach: "The geographic failover target is us-west-2",
      recall: "What is the geographic failover target?",
      answer: "us-west-2",
    },
    {
      teach: "The TLS certificate expires on 2026-09-15",
      recall: "When does the TLS certificate expire?",
      answer: "2026-09-15",
    },
    {
      teach: "The config server is at consul.internal:8500",
      recall: "Where is the config server?",
      answer: "consul.internal:8500",
    },
    {
      teach: "The rate limiter uses a sliding window of 60 seconds",
      recall: "What window does the rate limiter use?",
      answer: "sliding window of 60 seconds",
    },
    {
      teach: "The deployment approval chain is dev→staging→prod",
      recall: "What is the deployment approval chain?",
      answer: "dev→staging→prod",
    },
    {
      teach: "The observability stack is Grafana+Loki+Tempo",
      recall: "What is the observability stack?",
      answer: "Grafana+Loki+Tempo",
    },
    {
      teach: "The SRE team Slack channel is #sre-incidents",
      recall: "What is the SRE team Slack channel?",
      answer: "#sre-incidents",
    },
    {
      teach: "The feature rollout percentage increment is 10%",
      recall: "What is the feature rollout percentage increment?",
      answer: "10%",
    },
    {
      teach: "The database replica count is 3",
      recall: "What is the database replica count?",
      answer: "3",
    },
    {
      teach: "The cross-region replication lag target is under 500ms",
      recall: "What is the cross-region replication lag target?",
      answer: "under 500ms",
    },
    {
      teach: "The chaos engineering experiment runs monthly on the first Wednesday",
      recall: "When does the chaos engineering experiment run?",
      answer: "monthly on the first Wednesday",
    },
    {
      teach: "The HTTP keep-alive timeout is 65 seconds",
      recall: "What is the HTTP keep-alive timeout?",
      answer: "65 seconds",
    },
    {
      teach: "The gitops repo is at github.com/acme/infrastructure",
      recall: "Where is the gitops repo?",
      answer: "github.com/acme/infrastructure",
    },
  ];

  const distractors = [
    "What is the capital of France?",
    "How many planets are in the solar system?",
    "What is 42 * 17?",
    "Describe the process of photosynthesis.",
    "What programming language was created by Guido van Rossum?",
    "Name three types of cloud computing services.",
    "What is the speed of light in meters per second?",
    "Explain the difference between TCP and UDP.",
    "Who wrote 'The Art of War'?",
    "What is the chemical formula for water?",
  ];

  return facts.map((f, i) => ({
    id: `retention-${i}`,
    question: f.recall,
    answer: f.answer,
    metadata: {
      teach: f.teach,
      distractors: distractors.slice(0, 5 + (i % 6)),
    },
  }));
}

export { seededShuffle };
