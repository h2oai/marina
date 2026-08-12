#!/usr/bin/env bun
/**
 * Small, fast, on-demand prompt/agent A/B eval — NOT a benchmark sweep.
 *
 * Runs a frozen 15-item micro-set (benchmarks/smoke-eval.json) against a
 * running Marina model endpoint and reports a score. The point is to make
 * prompt/agent changes *measurable* without the cost of a full benchmark run:
 * snapshot a baseline, change a system/continuation prompt (or the crew), run
 * again, compare. Keep the item set frozen so scores stay comparable.
 *
 * Targets a model id served by /v1/chat/completions:
 *   - marina:answerer  → agent-served (exercises the Answerer crew + its prompts) [default]
 *   - marina           → raw upstream passthrough (the bare model, no agent prompts)
 *   - any other served model id
 *
 * Usage (or via the `bun run eval-prompt` alias):
 *   bun run eval-prompt                                  # marina:answerer @ localhost
 *   bun run eval-prompt marina                           # the raw model
 *   bun run eval-prompt marina:answerer --url http://host:3300 --key sk-...
 *   bun run eval-prompt --limit 5 --json                 # first 5, machine-readable
 *   bun run eval-prompt --min-score 15                   # fail below a release threshold
 *
 * Exit code is 0 unless --min-score is set and missed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Check =
  | { type: "contains" | "not_contains" | "regex" | "exact"; value: string }
  | { type: "numeric"; value: number };
export interface EvalItem {
  id: string;
  category: string;
  prompt: string;
  check: Check;
}

/** Score a single model output against an item's check. Pure — unit-tested. */
export function score(check: Check, out: string): boolean {
  const lower = out.toLowerCase();
  switch (check.type) {
    case "contains":
      return lower.includes(check.value.toLowerCase());
    case "not_contains":
      return !lower.includes(check.value.toLowerCase());
    case "regex":
      return new RegExp(check.value, "i").test(out);
    case "exact":
      return out.trim() === check.value;
    case "numeric": {
      // Accept the target number anywhere in the output (tolerates "= 391.").
      const nums = out.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g) ?? [];
      return nums.some((n) => Number(n) === check.value);
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") flags.set("json", true);
    else if (a.startsWith("--")) flags.set(a.slice(2), args[++i] ?? "");
    else positional.push(a);
  }

  const model = positional[0] ?? "marina:answerer";
  const port = Number(process.env.WS_PORT) || 3300;
  const url = (flags.get("url") as string) || process.env.MARINA_URL || `http://localhost:${port}`;
  const key = (flags.get("key") as string) || process.env.MODEL_API_KEYS?.split(",")[0]?.trim();
  const limit = flags.get("limit") ? Number(flags.get("limit")) : Number.POSITIVE_INFINITY;
  const asJson = flags.get("json") === true;
  const timeoutMs = Number(process.env.EVAL_TIMEOUT_MS) || 120_000;
  const minScore = flags.get("min-score") ? Number(flags.get("min-score")) : 0;

  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "benchmarks", "smoke-eval.json"), "utf8"),
  ) as { items: EvalItem[] };
  const items = fixture.items.slice(0, limit);

  const ask = async (prompt: string): Promise<{ content: string; error?: string }> => {
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok)
        return { content: "", error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return { content: data.choices?.[0]?.message?.content ?? "" };
    } catch (e) {
      return { content: "", error: e instanceof Error ? e.message : String(e) };
    }
  };

  const results: {
    id: string;
    category: string;
    pass: boolean;
    error?: string;
    output: string;
  }[] = [];
  for (const item of items) {
    const { content, error } = await ask(item.prompt);
    const pass = !error && score(item.check, content);
    results.push({ id: item.id, category: item.category, pass, error, output: content });
    if (!asJson) {
      const mark = pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      const note = error ? `\x1b[31m${error}\x1b[0m` : content.replace(/\s+/g, " ").slice(0, 70);
      console.log(`${mark} [${item.category}] ${item.id.padEnd(10)} ${note}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const byCat = new Map<string, { p: number; n: number }>();
  for (const r of results) {
    const c = byCat.get(r.category) ?? { p: 0, n: 0 };
    c.n++;
    if (r.pass) c.p++;
    byCat.set(r.category, c);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          model,
          url,
          score: passed,
          total: results.length,
          minScore,
          qualified: passed >= minScore,
          byCategory: Object.fromEntries([...byCat].map(([k, v]) => [k, `${v.p}/${v.n}`])),
          results: results.map(({ output, ...r }) => ({ ...r, output: output.slice(0, 200) })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Model: ${model}   Score: ${passed}/${results.length}`);
    console.log(`By category: ${[...byCat].map(([k, v]) => `${k} ${v.p}/${v.n}`).join("  ")}`);
  }

  if (passed < minScore) process.exit(1);
}
