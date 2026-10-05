// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { asJudge, queryWithUsage } from "../modes/passthrough";
import type { ItemUsage } from "../types";
import { addCallUsage } from "../usage";

const JUDGE_SYSTEM_PROMPT = `You are a fair and impartial judge evaluating the quality of AI responses.
Rate the response on a scale of 1-10 based on accuracy, helpfulness, and relevance.
Consider the reference answer when available, but also reward creative and comprehensive responses.

Scoring guide:
- 1-3: Incorrect, irrelevant, or harmful
- 4-5: Partially correct but missing key information
- 6-7: Mostly correct and helpful
- 8-9: Excellent, accurate, and comprehensive
- 10: Perfect response

Reply with ONLY a single integer score (1-10).`;

export async function judgeResponse(
  question: string,
  reference: string,
  response: string,
  judgeConfig: { model: string; endpoint: string },
  apiKey?: string,
): Promise<number> {
  return (await judgeResponseWithUsage(question, reference, response, judgeConfig, apiKey)).score;
}

/** `judgeResponse` plus the usage the judge's calls reported. */
export async function judgeResponseWithUsage(
  question: string,
  reference: string,
  response: string,
  judgeConfig: { model: string; endpoint: string },
  apiKey?: string,
): Promise<{ score: number; usage: ItemUsage | undefined }> {
  const userContent = buildJudgePrompt(question, reference, response);
  let usage: ItemUsage | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const judgeReply = await asJudge(() =>
        queryWithUsage(
          judgeConfig.endpoint,
          judgeConfig.model,
          [
            { role: "system", content: JUDGE_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          apiKey,
          30000,
        ),
      );
      usage = addCallUsage(usage, judgeReply.usage);

      const score = parseScore(judgeReply.content);
      if (score !== null) return { score, usage };
    } catch {
      // Retry on error
    }
  }

  // Default to 5 if judge fails
  return { score: 5, usage };
}

function buildJudgePrompt(question: string, reference: string, response: string): string {
  let prompt = `Question: ${question}\n\n`;
  if (reference) {
    prompt += `Reference answer: ${reference}\n\n`;
  }
  prompt += `Model response: ${response}\n\nScore (1-10):`;
  return prompt;
}

function parseScore(text: string): number | null {
  const cleaned = text.trim();
  // Try to find a number 1-10
  const match = cleaned.match(/\b(10|[1-9])\b/);
  if (match) {
    const score = Number.parseInt(match[1] ?? "", 10);
    if (score >= 1 && score <= 10) return score;
  }
  return null;
}

// --- Answer equivalence (strict yes/no) ---

const EQUIVALENCE_SYSTEM_PROMPT = `You grade one answer against a reference answer.
Decide only whether the response's FINAL answer means the same thing as the reference answer.
Accept equivalent forms (algebraically equal expressions, numbers equal within the precision the reference implies, the same entity named differently).
Reject answers that are vaguer, hedge between options, add a conflicting claim, or differ in substance.
Do not solve the problem yourself and do not judge the reasoning.
Reply with exactly one word: CORRECT or INCORRECT.`;

export interface EquivalenceVerdict {
  verdict: "correct" | "incorrect" | "error";
  usage: ItemUsage | undefined;
}

/** Parse a CORRECT / INCORRECT reply; the last verdict word wins. Anything else is null. */
export function parseEquivalenceVerdict(reply: string): "correct" | "incorrect" | null {
  const words = reply.toUpperCase().match(/\b(INCORRECT|CORRECT)\b/g);
  if (!words || words.length === 0) return null;
  return words[words.length - 1] === "CORRECT" ? "correct" : "incorrect";
}

/**
 * Strict equivalence judge for short answers whose reference is not an exact
 * string match. Uses the run's judge model/endpoint (`--judge-model`,
 * `--judge-endpoint`). A judge that fails twice returns `error` — the caller
 * scores it as wrong and records the failure, never a silent pass.
 */
export async function judgeEquivalence(
  question: string,
  reference: string,
  response: string,
  judgeConfig: { model: string; endpoint: string },
  apiKey?: string,
): Promise<EquivalenceVerdict> {
  let usage: ItemUsage | undefined;
  const user = `Question:\n${question}\n\nReference answer:\n${reference}\n\nResponse:\n${response}\n\nVerdict (CORRECT or INCORRECT):`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await asJudge(() =>
        queryWithUsage(
          judgeConfig.endpoint,
          judgeConfig.model,
          [
            { role: "system", content: EQUIVALENCE_SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
          apiKey,
          120_000,
        ),
      );
      usage = addCallUsage(usage, reply.usage);
      const verdict = parseEquivalenceVerdict(reply.content);
      if (verdict) return { verdict, usage };
    } catch {
      // allow-empty-catch: one retry, then the verdict is "error"
    }
  }
  return { verdict: "error", usage };
}
