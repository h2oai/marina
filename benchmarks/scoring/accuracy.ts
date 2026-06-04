import type { ResultItem } from "../types";

export interface AccuracyBreakdown {
  overall: number;
  breakdown: Record<string, number>;
}

export function computeAccuracy(items: ResultItem[]): AccuracyBreakdown {
  if (items.length === 0) return { overall: 0, breakdown: {} };

  // Overall accuracy
  const correct = items.filter((i) => i.correct).length;
  const overall = correct / items.length;

  // Per-category breakdown
  const categories = new Map<string, { correct: number; total: number }>();
  for (const item of items) {
    const cat = item.category ?? "unknown";
    const entry = categories.get(cat) ?? { correct: 0, total: 0 };
    entry.total++;
    if (item.correct) entry.correct++;
    categories.set(cat, entry);
  }

  const breakdown: Record<string, number> = {};
  for (const [cat, { correct: c, total }] of categories) {
    breakdown[cat] = c / total;
  }

  return { overall, breakdown };
}

export function computeJudgeScore(items: ResultItem[]): AccuracyBreakdown {
  if (items.length === 0) return { overall: 0, breakdown: {} };

  const scored = items.filter((i) => i.score !== undefined);
  if (scored.length === 0) return { overall: 0, breakdown: {} };

  const overall = scored.reduce((sum, i) => sum + (i.score ?? 0), 0) / scored.length;

  const categories = new Map<string, { sum: number; count: number }>();
  for (const item of scored) {
    const cat = item.category ?? "unknown";
    const entry = categories.get(cat) ?? { sum: 0, count: 0 };
    entry.sum += item.score ?? 0;
    entry.count++;
    categories.set(cat, entry);
  }

  const breakdown: Record<string, number> = {};
  for (const [cat, { sum, count }] of categories) {
    breakdown[cat] = sum / count;
  }

  return { overall, breakdown };
}
