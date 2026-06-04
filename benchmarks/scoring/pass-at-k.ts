import type { ResultItem } from "../types";

export interface PassAtKResult {
  overall: number;
  breakdown: Record<string, number>;
}

/**
 * Compute pass@k metric.
 * For pass@1 with a single sample per task, this is simply the fraction of tasks that pass.
 */
export function computePassAtK(items: ResultItem[], k = 1): PassAtKResult {
  if (items.length === 0) return { overall: 0, breakdown: {} };

  // Group by task ID (for multiple samples per task)
  const tasks = new Map<string, ResultItem[]>();
  for (const item of items) {
    const existing = tasks.get(item.id) ?? [];
    existing.push(item);
    tasks.set(item.id, existing);
  }

  let totalPassRate = 0;
  for (const [, samples] of tasks) {
    const n = samples.length;
    const c = samples.filter((s) => s.correct).length;
    // pass@k = 1 - C(n-c, k) / C(n, k)
    if (n < k) {
      totalPassRate += c > 0 ? 1 : 0;
    } else if (c === 0) {
      totalPassRate += 0;
    } else {
      totalPassRate += 1 - comb(n - c, k) / comb(n, k);
    }
  }

  const overall = totalPassRate / tasks.size;
  return { overall, breakdown: { [`pass@${k}`]: overall } };
}

function comb(n: number, k: number): number {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}
