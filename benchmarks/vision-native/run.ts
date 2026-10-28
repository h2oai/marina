// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Native vision vs described vision — one agent task per item, both modes,
 * one agent model.
 *
 *   OPENROUTER_API_KEY=… bun benchmarks/vision-native/run.ts \
 *     --model anthropic/claude-opus-5.5 --per-kind 3 --budget 2 [--set easy|hard]
 *     [--kinds count,code,…] [--modes describe,native] [--describe-model <id>]
 *     [--concurrency 4] [--pilot 5] [--out file.json]
 *   bun benchmarks/vision-native/run.ts --set hard --per-kind 10 --rescore file.json
 *   bun benchmarks/vision-native/run.ts --set hard --dry --images-dir /tmp/vision-items
 *
 * Each task gives the model a `marina_see` tool and asset references, never
 * the images themselves. The tool answers the way Marina does for each mode:
 *
 * - `describe`: the same body `describeVisual` sends (`visionRequest`, the
 *   original bytes as `prepareVisual` prepares them) to the describe model —
 *   by default the agent's own model, which is what `visionModelCandidates`
 *   tries first; the tool result is the description text.
 * - `native`: the image prepared by `viewVisual` (`AGENT_VIEW_IMAGE_LIMITS`)
 *   with the `viewHeader` text, sent the way pi-ai sends tool-result images
 *   over chat completions (the tool message, then a user message with the
 *   image parts).
 *
 * `--set easy` is the original five-kind set; `--set hard` (items-hard.ts)
 * adds multi-image tasks, so a task may name several assets and the agent
 * looks at each by reference.
 *
 * Cost control: `--pilot N` runs N tasks in both modes first, projects the
 * whole run from their cost, and stops before starting when the projection
 * passes `--budget` USD; during the run no task starts once the spend plus the
 * in-flight estimate would pass it. Results (task ids, answers, scores, costs;
 * no image bytes) go to `--out` or `benchmarks/results/` (gitignored), with
 * per-mode Wilson intervals and the paired McNemar / bootstrap comparison.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  prepareVisual,
  type VisualSource,
  viewHeader,
  viewVisual,
  visionRequest,
} from "../../src/engine/media/vision";
import { defaultOutputTokens, requireFinishedOutput } from "../../src/model/output";
import { DEFAULT_KINDS, scoreAnswer, type VisualTaskKind, visualTasks } from "./items";
import { HARD_FAMILY, HARD_KINDS, type HardKind, hardTasks, scoreHard } from "./items-hard";
import { type ResultRow, summarize } from "./summary";

type Mode = "describe" | "native";
type Msg = Record<string, unknown>;

/** One task as the runner sees it, whichever set it came from. */
interface EvalTask {
  id: string;
  kind: string;
  question: string;
  answer: string;
  images: Array<{ png: Uint8Array; width: number; height: number }>;
  score: (raw: string) => boolean;
}

interface Args {
  set: "easy" | "hard";
  model: string;
  describeModel?: string;
  perKind: number;
  budget: number;
  modes: Mode[];
  kinds?: string[];
  concurrency: number;
  pilot: number;
  out?: string;
  dry: boolean;
  imagesDir?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const set = get("set") === "hard" ? "hard" : "easy";
  return {
    set,
    model: get("model") ?? "anthropic/claude-opus-5.5",
    ...(get("describe-model") ? { describeModel: get("describe-model") } : {}),
    perKind: Number(get("per-kind") ?? 3),
    budget: Number(get("budget") ?? 2),
    modes: (get("modes") ?? "describe,native").split(",") as Mode[],
    ...(get("kinds") ? { kinds: get("kinds")!.split(",") } : {}),
    concurrency: Math.max(1, Number(get("concurrency") ?? 4)),
    pilot: Math.max(0, Number(get("pilot") ?? 0)),
    ...(get("out") ? { out: get("out") } : {}),
    dry: argv.includes("--dry"),
    ...(get("images-dir") ? { imagesDir: get("images-dir") } : {}),
  };
}

async function loadTasks(args: Args): Promise<EvalTask[]> {
  if (args.set === "hard") {
    const kinds = (args.kinds as HardKind[] | undefined) ?? [...HARD_KINDS];
    return (await hardTasks(args.perKind, kinds)).map((t) => ({
      id: t.id,
      kind: t.kind,
      question: t.question,
      answer: t.answer,
      images: t.images,
      score: (raw) => scoreHard(t, raw),
    }));
  }
  const kinds = (args.kinds as VisualTaskKind[] | undefined) ?? [...DEFAULT_KINDS];
  return (await visualTasks(args.perKind, kinds)).map((t) => ({
    id: t.id,
    kind: t.kind,
    question: t.question,
    answer: t.answer,
    images: [{ png: t.png, width: t.width, height: t.height }],
    score: (raw) => scoreAnswer(t, raw),
  }));
}

/** The asset ids a task's images are published under. */
function assetIds(task: EvalTask): string[] {
  return task.images.length === 1 ? [task.id] : task.images.map((_, i) => `${task.id}-${i + 1}`);
}

const SEE_TOOL = {
  type: "function",
  function: {
    name: "marina_see",
    description:
      "Inspect a workspace image, canvas source or URL. When your model reads images you get the image itself; otherwise a description.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Asset id, canvas node id or URL" },
        question: { type: "string", description: "What to look for or answer" },
      },
      required: ["source"],
    },
  },
};

const SYSTEM =
  "You are an agent working in a shared world. Images are not in your prompt: look at them with the marina_see tool. When you have the answer, reply with only the final answer and nothing else.";

let spent = 0;

async function chat(
  key: string,
  body: Record<string, unknown>,
): Promise<{ message: Msg; cost: number }> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, usage: { include: true } }),
      signal: AbortSignal.timeout(240_000),
    }).catch((error: unknown) => error as Error);
    if (resp instanceof Error) {
      last = resp.message;
      continue;
    }
    const data = (await resp.json().catch(() => ({}))) as {
      choices?: { finish_reason?: unknown; message?: Msg }[];
      usage?: { cost?: number };
      error?: { message?: string };
    };
    const cost = Number(data.usage?.cost ?? 0);
    spent += cost;
    if (resp.ok && data.choices?.[0]?.message) {
      if (data.choices[0].finish_reason !== "tool_calls")
        requireFinishedOutput(data.choices[0].finish_reason, "Vision benchmark");
      return { message: data.choices[0].message, cost };
    }
    last = `HTTP ${resp.status}: ${data.error?.message ?? "no message"}`;
    if (resp.status < 500 && resp.status !== 429) break;
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
  }
  throw new Error(last);
}

async function seeTool(
  key: string,
  describeModel: string,
  mode: Mode,
  src: VisualSource,
  question: string,
): Promise<{ tool: string; extra?: Msg; cost: number }> {
  if (mode === "native") {
    const view = await viewVisual(src, { ref: `asset:${src.assetId}` });
    const header = viewHeader(src.label, view.images, { question, notes: view.notes });
    return {
      tool: header,
      extra: {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          ...view.images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mime};base64,${img.data}` },
          })),
        ],
      },
      cost: 0,
    };
  }
  const input = await prepareVisual(src);
  const { message, cost } = await chat(
    key,
    visionRequest(describeModel, question, input, src.label),
  );
  return { tool: `${String(message.content ?? "").trim()}\nmodel: ${describeModel}`, cost };
}

interface TaskResult {
  answer: string;
  correct: boolean;
  cost: number;
  calls: number;
  looks: number;
}

async function runTask(key: string, args: Args, mode: Mode, task: EvalTask): Promise<TaskResult> {
  const ids = assetIds(task);
  const sources = new Map<string, VisualSource>(
    ids.map((id, i) => [
      id,
      { data: task.images[i]!.png, mime: "image/png", label: `${id}.png`, assetId: id },
    ]),
  );
  const intro =
    ids.length === 1
      ? `Asset asset:${ids[0]} is an image.`
      : `Assets ${ids.map((id, i) => `asset:${id} (image ${i + 1})`).join(", ")} are images.`;
  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${intro} ${task.question}` },
  ];
  let cost = 0;
  let calls = 0;
  let looks = 0;
  const maxTurns = 3 + ids.length * 2;
  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await chat(key, {
      model: args.model,
      max_tokens: defaultOutputTokens(),
      messages,
      tools: [SEE_TOOL],
    });
    cost += result.cost;
    calls++;
    const toolCalls = result.message.tool_calls as
      | { id: string; function: { name: string; arguments: string } }[]
      | undefined;
    if (!toolCalls?.length) {
      const answer = String(result.message.content ?? "").trim();
      return { answer, correct: task.score(answer), cost, calls, looks };
    }
    messages.push({
      role: "assistant",
      content: result.message.content ?? null,
      tool_calls: toolCalls,
    });
    const extras: Msg[] = [];
    for (const call of toolCalls) {
      let input: { source?: string; question?: string } = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        // allow-empty-catch: malformed arguments look with no question
      }
      const ref = String(input.source ?? "")
        .trim()
        .replace(/^asset:/, "");
      const src = sources.get(ref) ?? (ids.length === 1 ? sources.get(ids[0]!) : undefined);
      if (!src) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `No such source "${input.source ?? ""}". Available: ${ids.map((id) => `asset:${id}`).join(", ")}.`,
        });
        continue;
      }
      looks++;
      const describeModel = args.describeModel ?? args.model;
      const seen = await seeTool(key, describeModel, mode, src, input.question ?? "");
      cost += seen.cost;
      if (seen.cost) calls++;
      messages.push({ role: "tool", tool_call_id: call.id, content: seen.tool });
      if (seen.extra) extras.push(seen.extra);
    }
    messages.push(...extras);
  }
  return { answer: "", correct: false, cost, calls, looks };
}

type Row = ResultRow & Record<string, unknown>;

async function runOne(key: string, args: Args, mode: Mode, task: EvalTask): Promise<Row> {
  try {
    const r = await runTask(key, args, mode, task);
    return { task: task.id, kind: task.kind, mode, expected: task.answer, ...r };
  } catch (error) {
    return {
      task: task.id,
      kind: task.kind,
      mode,
      expected: task.answer,
      error: error instanceof Error ? error.message : String(error),
      correct: false,
      cost: 0,
    };
  }
}

/** Run `jobs` with bounded concurrency; `admit` may refuse to start the next one. */
async function pool<T>(
  jobs: Array<() => Promise<T>>,
  concurrency: number,
  admit: (inFlight: number) => boolean,
): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  let inFlight = 0;
  let stopped = false;
  const worker = async () => {
    while (next < jobs.length && !stopped) {
      if (!admit(inFlight)) {
        stopped = true;
        return;
      }
      const job = jobs[next++]!;
      inFlight++;
      try {
        out.push(await job());
      } finally {
        inFlight--;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = await loadTasks(args);
  const rescore = process.argv.indexOf("--rescore");
  if (rescore >= 0) {
    // Re-score a saved run's answers with the current scorer (no model calls).
    const file = process.argv[rescore + 1]!;
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      summary: Record<string, unknown>;
      rows: Row[];
    };
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const rows = saved.rows.map((r) => {
      const t = byId.get(r.task);
      return t && !r.error ? { ...r, correct: t.score(String(r.answer ?? "")) } : r;
    });
    const family = args.set === "hard" ? HARD_FAMILY : undefined;
    const summary = { ...saved.summary, stats: summarize(rows, family ? { family } : {}) };
    writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\nrescored: ${file}\n`);
    return;
  }
  if (args.imagesDir) {
    mkdirSync(args.imagesDir, { recursive: true });
    for (const t of tasks) {
      for (const [i, id] of assetIds(t).entries()) {
        writeFileSync(join(args.imagesDir, `${id}.png`), t.images[i]!.png);
      }
    }
  }
  if (args.dry) {
    for (const t of tasks) {
      const dims = t.images.map((i) => `${i.width}x${i.height}`).join(",");
      process.stdout.write(`${t.id}\t${dims}\t${t.answer}\n`);
    }
    return;
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required (or pass --dry).");
  const describeModel = args.describeModel ?? args.model;
  const rows: Row[] = [];
  const log = (row: Row) => {
    rows.push(row);
    process.stdout.write(
      `${row.task}\t${row.mode}\t${row.correct ? "ok " : "MISS"}\texpected=${String(row.expected)}\tgot=${JSON.stringify(row.answer ?? row.error)}\t$${Number(row.cost ?? 0).toFixed(4)}\t(total $${spent.toFixed(4)})\n`,
    );
    return row;
  };
  const jobsFor = (ts: EvalTask[]) =>
    ts.flatMap((task) =>
      args.modes.map((mode) => async () => log(await runOne(key, args, mode, task))),
    );
  // The pilot is spread across seeds AND kinds (tasks are seed-major, so an
  // even stride would land on one kind) so its cost is representative.
  const pilotN = Math.min(args.pilot, tasks.length);
  const stride = Math.floor(tasks.length / Math.max(1, pilotN)) + 1;
  const pilotIdx = new Set(Array.from({ length: pilotN }, (_, i) => (i * stride) % tasks.length));
  const pilot = tasks.filter((_, i) => pilotIdx.has(i));
  const rest = tasks.filter((_, i) => !pilotIdx.has(i));
  let aborted: string | undefined;
  if (pilot.length) {
    await pool(jobsFor(pilot), args.concurrency, () => true);
    const perTask = spent / pilot.length;
    const projected = perTask * tasks.length;
    process.stdout.write(
      `pilot: ${pilot.length} tasks, $${spent.toFixed(4)} ⇒ projected $${projected.toFixed(2)} for ${tasks.length} tasks (budget $${args.budget})\n`,
    );
    if (projected > args.budget)
      aborted = `projected $${projected.toFixed(2)} > budget $${args.budget}`;
  }
  if (!aborted) {
    const done = () => rows.length || 1;
    await pool(jobsFor(rest), args.concurrency, (inFlight) => {
      const perRun = spent / done();
      if (spent + perRun * (inFlight + 1) > args.budget) {
        aborted = `budget: spent $${spent.toFixed(4)} + in-flight estimate would pass $${args.budget}`;
        return false;
      }
      return true;
    });
  }
  if (aborted) process.stdout.write(`stopped: ${aborted}\n`);
  const family = args.set === "hard" ? HARD_FAMILY : undefined;
  const stats = summarize(rows, { ...(family ? { family } : {}) });
  const summary = {
    set: args.set,
    model: args.model,
    describeModel,
    perKind: args.perKind,
    tasks: tasks.length,
    spentUsd: spent,
    ...(aborted ? { aborted } : {}),
    stats,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  const out =
    args.out ??
    join("benchmarks", "results", `vision-native-${args.set}-${new Date().toISOString()}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  process.stdout.write(`results: ${out}\n`);
}

await main();
