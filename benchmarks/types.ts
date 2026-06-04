export interface BenchmarkConfig {
  name: string;
  dataset: string;
  adapter: "multiple-choice" | "code-gen" | "ifeval" | "free-form" | "numeric" | "short-answer";
  scoring: "accuracy" | "pass-at-k" | "ifeval" | "judge" | "numeric-match" | "normalized-match";
  mode: "passthrough" | "memory";
  model: string;
  endpoint: string;
  apiKey?: string;
  concurrency: number;
  limit?: number;
  seed?: number;
  judge?: { model: string; endpoint: string };
}

export interface BenchmarkResult {
  config: BenchmarkConfig;
  timestamp: number;
  duration_ms: number;
  scores: {
    overall: number;
    breakdown: Record<string, number>;
  };
  metadata: {
    total: number;
    answered: number;
    timeouts: number;
    errors: number;
    avgLatencyMs: number;
  };
  items: ResultItem[];
}

export interface ResultItem {
  id: string;
  question: string;
  expected: string;
  actual: string;
  /** Raw model response for adapters that summarize `actual` (ifeval, code-gen).
   *  Capped at ~4KB per item. Diagnostic only — not used for scoring. */
  rawResponse?: string;
  correct: boolean;
  score?: number;
  latencyMs: number;
  category?: string;
}

export interface DatasetItem {
  id: string;
  question: string;
  choices?: string[];
  answer: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BenchmarkDefinition {
  name: string;
  dataset: string;
  adapter: BenchmarkConfig["adapter"];
  scoring: BenchmarkConfig["scoring"];
  description: string;
  phase: "A" | "B";
  download: (dir: string, limit?: number) => Promise<DatasetItem[]>;
}
