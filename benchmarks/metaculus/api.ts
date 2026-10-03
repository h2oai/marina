// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Metaculus API, as a bot uses it (list a tournament's open questions,
 * read one, post a forecast, post its reasoning comment). The token comes from
 * the operator's environment only (`METACULUS_TOKEN`) and never appears in an
 * error, a log line or a record.
 */

export const METACULUS_API = "https://www.metaculus.com/api";

/** Tournament slugs/ids a bot commonly enters; pass any id or slug with `--tournament`. */
export const TOURNAMENTS = {
  /** FutureEval (AI Benchmark) Fall 2026. */
  fall2026: 33121,
  minibench: "minibench",
  /** Practice questions: forecasts there never count. */
  test: "bot-testing-area",
} as const;

export type QuestionType = "binary" | "multiple_choice" | "numeric" | "discrete" | "date";

export interface MetaculusScaling {
  range_min: number | null;
  range_max: number | null;
  zero_point: number | null;
  inbound_outcome_count?: number | null;
}

export interface MetaculusQuestion {
  id: number;
  type: QuestionType;
  title: string;
  status?: string;
  description?: string;
  resolution_criteria?: string;
  fine_print?: string;
  unit?: string | null;
  options?: string[] | null;
  scaling?: MetaculusScaling;
  open_upper_bound?: boolean | null;
  open_lower_bound?: boolean | null;
  scheduled_close_time?: string | null;
  scheduled_resolve_time?: string | null;
  /** When forecasting opened (a backtest freezes evidence here). */
  open_time?: string | null;
  /** Present once resolved: "yes"/"no", an option label, a number, or "annulled"/"ambiguous". */
  resolution?: string | number | null;
  my_forecasts?: { latest?: { start_time?: number; forecast_values?: unknown } | null } | null;
}

export interface MetaculusPost {
  id: number;
  title?: string;
  question?: MetaculusQuestion;
}

/** The body of one forecast, as `POST /questions/forecast/` takes it. */
export interface ForecastPayload {
  question: number;
  source: "api";
  probability_yes: number | null;
  probability_yes_per_category: Record<string, number> | null;
  continuous_cdf: number[] | null;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface MetaculusClient {
  /** A tournament's posts with questions in `status` (open, or resolved for a backtest). */
  posts(tournament: string | number, status?: "open" | "resolved"): Promise<MetaculusPost[]>;
  post(postId: number): Promise<MetaculusPost>;
  forecast(payload: ForecastPayload): Promise<void>;
  comment(postId: number, text: string): Promise<void>;
}

/** A read-only client over saved posts (dry runs without a token, tests). It never posts. */
export function fixtureClient(posts: MetaculusPost[]): MetaculusClient {
  return {
    posts: async (_t, status = "open") =>
      posts.filter((p) => (p.question?.status ?? "open") === status),
    post: async (id) => {
      const p = posts.find((x) => x.id === id);
      if (!p) throw new Error(`fixture has no post ${id}`);
      return p;
    },
    forecast: async () => {
      throw new Error("a fixture client never posts");
    },
    comment: async () => {
      throw new Error("a fixture client never posts");
    },
  };
}

export function metaculusClient(opts: {
  token: string;
  fetcher?: Fetcher;
  base?: string;
}): MetaculusClient {
  const fetcher = opts.fetcher ?? fetch;
  const base = (opts.base ?? METACULUS_API).replace(/\/+$/, "");
  const headers = {
    Authorization: `Token ${opts.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const scrub = (s: string) => (opts.token ? s.split(opts.token).join("[token]") : s);
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await fetcher(`${base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `metaculus ${init.method ?? "GET"} ${path} → ${res.status}: ${scrub(text).slice(0, 300)}`,
      );
    }
    return text ? JSON.parse(text) : undefined;
  };
  return {
    posts: async (tournament, status = "open") => {
      const out: MetaculusPost[] = [];
      for (let offset = 0; offset < 2_000; offset += 50) {
        const q = new URLSearchParams({
          limit: "50",
          offset: String(offset),
          order_by: "-hotness",
          forecast_type: "binary,multiple_choice,numeric,discrete",
          tournaments: String(tournament),
          statuses: status,
          include_description: "true",
        });
        const page = (await call(`/posts/?${q}`)) as { results?: MetaculusPost[]; next?: string };
        out.push(...(page.results ?? []));
        if (!page.next || (page.results?.length ?? 0) < 50) break;
      }
      return out;
    },
    post: async (postId) => (await call(`/posts/${postId}/`)) as MetaculusPost,
    forecast: async (payload) => {
      await call("/questions/forecast/", { method: "POST", body: JSON.stringify([payload]) });
    },
    comment: async (postId, text) => {
      await call("/comments/create/", {
        method: "POST",
        body: JSON.stringify({
          text,
          parent: null,
          included_forecast: true,
          is_private: true,
          on_post: postId,
        }),
      });
    },
  };
}
