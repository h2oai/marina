// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "../modes/passthrough";
import type { BenchmarkConfig, DatasetItem, Message, ResultItem } from "../types";

function extractCode(response: string, entryPoint: string): string {
  // Try to extract Python code from markdown code block
  const codeBlockMatch = response.match(/```(?:python)?\s*\n([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // Try to find function definition
  const funcMatch = response.match(new RegExp(`(def ${entryPoint}[\\s\\S]*)`, "m"));
  if (funcMatch) return funcMatch[1].trim();

  // Return the whole response as a fallback
  return response.trim();
}

async function runPythonTest(
  code: string,
  test: string,
  entryPoint: string,
  timeoutMs = 60000,
): Promise<boolean> {
  const tmpDir = join(import.meta.dir, "..", ".tmp-humaneval");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const testFile = join(tmpDir, `test_${entryPoint}_${Date.now()}.py`);
  const fullCode = `${code}\n\n${test}\n\ncheck(${entryPoint})\n`;
  writeFileSync(testFile, fullCode);

  try {
    // Bun $ does not expose .timeout() as of 1.3.x — wire an AbortController
    // via Bun.spawn. A silent TypeError on .timeout() previously caused every
    // HumanEval item to score 0 regardless of correctness.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const proc = Bun.spawn(["python3", testFile], {
        stdout: "pipe",
        stderr: "pipe",
        signal: ac.signal,
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  } finally {
    try {
      rmSync(testFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

export async function runCodeGen(
  items: DatasetItem[],
  config: BenchmarkConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<ResultItem[]> {
  const results: ResultItem[] = [];
  let completed = 0;

  // Run sequentially to avoid Python process contention
  for (const item of items) {
    const prompt = (item.metadata?.prompt as string) ?? item.question;
    const test = (item.metadata?.test as string) ?? "";
    const entryPoint = (item.metadata?.entry_point as string) ?? "";

    const messages: Message[] = [
      {
        role: "system",
        content:
          "Complete the following Python function. Return ONLY the complete function implementation in a Python code block. Do not include test code.",
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    const start = performance.now();
    let actual = "";
    let rawResponse = "";
    let correct = false;

    try {
      const response = await query(config.endpoint, config.model, messages, config.apiKey);
      rawResponse = response;
      actual = extractCode(response, entryPoint);

      // If the model returned the full function (signature + body), use it as-is.
      // Otherwise it returned just the body — prepend the prompt (signature+docstring).
      // Prior behavior always prepended, which produced duplicated signatures and
      // invalid Python when models follow the common "return the complete function" style.
      const signatureRe = new RegExp(`^\\s*(?:from\\s+\\w+.*\\n)*\\s*def\\s+${entryPoint}\\b`, "m");
      const fullCode = signatureRe.test(actual) ? actual : `${prompt}${actual}`;
      correct = await runPythonTest(fullCode, test, entryPoint);
    } catch (e) {
      actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const latencyMs = performance.now() - start;
    results.push({
      id: item.id,
      question: prompt.slice(0, 200),
      expected: "(passes tests)",
      actual: actual.slice(0, 200),
      rawResponse: rawResponse.slice(0, 4000),
      correct,
      latencyMs,
      category: "code",
    });

    completed++;
    onProgress?.(completed, items.length);
  }

  // Cleanup tmp dir
  const tmpDir = join(import.meta.dir, "..", ".tmp-humaneval");
  if (existsSync(tmpDir)) {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Ignore
    }
  }

  return results;
}
