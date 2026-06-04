import { query } from "../modes/passthrough";

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
  const userContent = buildJudgePrompt(question, reference, response);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const judgeReply = await query(
        judgeConfig.endpoint,
        judgeConfig.model,
        [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        apiKey,
        30000,
      );

      const score = parseScore(judgeReply);
      if (score !== null) return score;
    } catch {
      // Retry on error
    }
  }

  // Default to 5 if judge fails
  return 5;
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
    const score = Number.parseInt(match[1], 10);
    if (score >= 1 && score <= 10) return score;
  }
  return null;
}
