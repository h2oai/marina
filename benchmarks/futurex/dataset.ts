// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * FutureX datasets on Hugging Face, read through Hugging Face's own APIs:
 *
 *   - the dataset's commit sha from `huggingface.co/api/datasets/<repo>`;
 *   - its rows, page by page, from `datasets-server.huggingface.co/rows`.
 *
 * Only the published datasets are read — never the competition website. The
 * sha is read before and after the rows; when they differ, a release landed
 * mid-read and the fetch is retried, so the rows always match the recorded sha.
 * Rows are stored outside the repository (`data/` is ignored); benchmark
 * questions are never committed.
 */

export const ONLINE_REPO = "futurex-ai/Futurex-Online";
export const PAST_REPO = "futurex-ai/Futurex-Past";

export interface FuturexRow {
  id: string;
  prompt: string;
  /** ISO time (with offset) the event ends / resolves. */
  end_time: string;
  level: number;
  en_title?: string;
  /** Past rows only: the resolved answer (a label set, a number, a string or a list). */
  ground_truth?: unknown;
  /** Past rows only: the scale the dataset gives for a numeric answer. */
  std?: unknown;
}

export interface FuturexBatch {
  repo: string;
  sha: string;
  fetchedAt: string;
  rows: FuturexRow[];
}

type Fetcher = (url: string) => Promise<Response>;

const PAGE = 100;

export async function datasetSha(repo: string, fetcher: Fetcher = fetch): Promise<string> {
  const res = await fetcher(`https://huggingface.co/api/datasets/${repo}`);
  if (!res.ok) throw new Error(`Hugging Face ${repo}: HTTP ${res.status}`);
  const data = (await res.json()) as { sha?: unknown };
  if (typeof data.sha !== "string" || !data.sha) throw new Error(`Hugging Face ${repo}: no sha`);
  return data.sha;
}

async function rowsPage(
  repo: string,
  offset: number,
  fetcher: Fetcher,
): Promise<{ rows: FuturexRow[]; total: number }> {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(repo)}&config=default&split=train&offset=${offset}&length=${PAGE}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`datasets-server ${repo} offset ${offset}: HTTP ${res.status}`);
  const data = (await res.json()) as {
    rows?: Array<{ row?: Record<string, unknown> }>;
    num_rows_total?: number;
  };
  const rows = (data.rows ?? [])
    .map((r) => r.row ?? {})
    .map(toRow)
    .filter((r) => r !== undefined);
  return { rows, total: Number(data.num_rows_total ?? rows.length) };
}

function toRow(r: Record<string, unknown>): FuturexRow | undefined {
  if (typeof r.id !== "string" || typeof r.prompt !== "string") return undefined;
  return {
    id: r.id,
    prompt: r.prompt,
    end_time: String(r.end_time ?? ""),
    level: Number(r.level),
    ...(typeof r.en_title === "string"
      ? { en_title: r.en_title }
      : typeof r.title === "string"
        ? { en_title: r.title }
        : {}),
    ...(r.ground_truth !== undefined ? { ground_truth: r.ground_truth } : {}),
    ...(r.std !== undefined ? { std: r.std } : {}),
  };
}

/** Every row of `repo` at one consistent sha (retried when a release lands mid-read). */
export async function fetchBatch(
  repo: string,
  opts: { fetcher?: Fetcher; now?: () => Date; maxRows?: number } = {},
): Promise<FuturexBatch> {
  const fetcher = opts.fetcher ?? fetch;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await datasetSha(repo, fetcher);
    const rows: FuturexRow[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total && offset < (opts.maxRows ?? 50_000); offset += PAGE) {
      const page = await rowsPage(repo, offset, fetcher);
      total = page.total;
      rows.push(...page.rows);
      if (page.rows.length === 0) break;
    }
    const after = await datasetSha(repo, fetcher);
    if (before === after) {
      return {
        repo,
        sha: before,
        fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
        rows: opts.maxRows ? rows.slice(0, opts.maxRows) : rows,
      };
    }
  }
  throw new Error(`${repo} changed during every read; try again`);
}
