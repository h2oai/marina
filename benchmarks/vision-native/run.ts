// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Native vision vs described vision — one agent turn per task, both modes,
 * one model.
 *
 *   OPENROUTER_API_KEY=… bun benchmarks/vision-native/run.ts \
 *     --model anthropic/claude-opus-5.5 --per-kind 3 --budget 2 [--kinds count,code,chart,grid,dense]
 *     [--modes describe,native] [--out file.json]
 *   bun benchmarks/vision-native/run.ts --dry --images-dir /tmp/vision-items
 *
 * Each task gives the model a `marina_see` tool and an asset reference, never
 * the image itself. The tool answers the way Marina does for each mode:
 *
 * - `describe`: the same body `describeVisual` sends (`visionRequest`, the
 *   original bytes as `prepareVisual` prepares them) to the same model; the
 *   tool result is the description text.
 * - `native`: the image prepared by `viewVisual` (`AGENT_VIEW_IMAGE_LIMITS`)
 *   with the `viewHeader` text, sent the way pi-ai sends tool-result images
 *   over chat completions (the tool message, then a user message with the
 *   image parts).
 *
 * Reports accuracy and OpenRouter-reported cost per mode, and stops before the
 * cumulative cost passes `--budget` USD. Results (task ids, answers, scores,
 * costs; no image bytes) go to `--out` or `benchmarks/results/` (gitignored).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  prepareVisual,
  type VisualSource,
  viewHeader,
  viewVisual,
  visionRequest,
} from "../../src/engine/media/vision";
import {
  DEFAULT_KINDS,
  scoreAnswer,
  type VisualTask,
  type VisualTaskKind,
  visualTasks,
} from "./items";

type Mode = "describe" | "native";
type Msg = Record<string, unknown>;

interface Args {
  model: string;
  perKind: number;
  budget: number;
  modes: Mode[];
  kinds: VisualTaskKind[];
  out?: string;
  dry: boolean;
  imagesDir?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const modes = (get("modes") ?? "describe,native").split(",") as Mode[];
  return {
    model: get("model") ?? "anthropic/claude-opus-5.5",
    perKind: Number(get("per-kind") ?? 3),
    budget: Number(get("budget") ?? 2),
    modes,
    kinds: (get("kinds")?.split(",") as VisualTaskKind[] | undefined) ?? [...DEFAULT_KINDS],
    ...(get("out") ? { out: get("out") } : {}),
    dry: argv.includes("--dry"),
    ...(get("images-dir") ? { imagesDir: get("images-dir") } : {}),
  };
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
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, usage: { include: true } }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    choices?: { message?: Msg }[];
    usage?: { cost?: number };
    error?: { message?: string };
  };
  const cost = Number(data.usage?.cost ?? 0);
  spent += cost;
  if (!resp.ok || !data.choices?.[0]?.message) {
    throw new Error(`HTTP ${resp.status}: ${data.error?.message ?? "no message"}`);
  }
  return { message: data.choices[0].message, cost };
}

async function seeTool(
  key: string,
  model: string,
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
  const { message, cost } = await chat(key, visionRequest(model, question, input, src.label));
  return { tool: `${String(message.content ?? "").trim()}\nmodel: ${model}`, cost };
}

async function runTask(
  key: string,
  model: string,
  mode: Mode,
  task: VisualTask,
): Promise<{ answer: string; correct: boolean; cost: number; calls: number; looks: number }> {
  const src: VisualSource = {
    data: task.png,
    mime: "image/png",
    label: `${task.id}.png`,
    assetId: task.id,
  };
  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Asset asset:${task.id} is an image. ${task.question}`,
    },
  ];
  let cost = 0;
  let calls = 0;
  let looks = 0;
  for (let turn = 0; turn < 4; turn++) {
    const result = await chat(key, {
      model,
      max_tokens: 2048,
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
      return { answer, correct: scoreAnswer(task, answer), cost, calls, looks };
    }
    messages.push({
      role: "assistant",
      content: result.message.content ?? null,
      tool_calls: toolCalls,
    });
    const extras: Msg[] = [];
    for (const call of toolCalls) {
      let args: { question?: string } = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // allow-empty-catch: malformed arguments look with no question
      }
      looks++;
      const seen = await seeTool(key, model, mode, src, args.question ?? "");
      cost += seen.cost;
      if (seen.cost) calls++;
      messages.push({ role: "tool", tool_call_id: call.id, content: seen.tool });
      if (seen.extra) extras.push(seen.extra);
    }
    messages.push(...extras);
  }
  return { answer: "", correct: false, cost, calls, looks };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = await visualTasks(args.perKind, args.kinds);
  if (args.imagesDir) {
    mkdirSync(args.imagesDir, { recursive: true });
    for (const t of tasks) writeFileSync(join(args.imagesDir, `${t.id}.png`), t.png);
  }
  if (args.dry) {
    for (const t of tasks) process.stdout.write(`${t.id}\t${t.width}x${t.height}\t${t.answer}\n`);
    return;
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required (or pass --dry).");
  const rows: Array<Record<string, unknown>> = [];
  const totals: Record<string, { n: number; correct: number; cost: number; calls: number }> = {};
  outer: for (const task of tasks) {
    for (const mode of args.modes) {
      if (spent >= args.budget * 0.9) {
        process.stdout.write(`budget reached ($${spent.toFixed(4)}); stopping\n`);
        break outer;
      }
      let row: Record<string, unknown>;
      try {
        const r = await runTask(key, args.model, mode, task);
        row = { task: task.id, kind: task.kind, mode, expected: task.answer, ...r };
      } catch (error) {
        row = {
          task: task.id,
          kind: task.kind,
          mode,
          expected: task.answer,
          error: error instanceof Error ? error.message : String(error),
          correct: false,
          cost: 0,
        };
      }
      rows.push(row);
      const t = (totals[mode] ??= { n: 0, correct: 0, cost: 0, calls: 0 });
      t.n++;
      t.correct += row.correct ? 1 : 0;
      t.cost += Number(row.cost ?? 0);
      t.calls += Number(row.calls ?? 0);
      process.stdout.write(
        `${task.id}\t${mode}\t${row.correct ? "ok " : "MISS"}\texpected=${task.answer}\tgot=${JSON.stringify(row.answer ?? row.error)}\t$${Number(row.cost ?? 0).toFixed(4)}\n`,
      );
    }
  }
  const summary = { model: args.model, perKind: args.perKind, spentUsd: spent, totals };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  const out =
    args.out ?? join("benchmarks", "results", `vision-native-${new Date().toISOString()}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  process.stdout.write(`results: ${out}\n`);
}

await main();
