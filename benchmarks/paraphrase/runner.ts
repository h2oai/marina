// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Paraphrase retrieval gate — the evidence behind "turning hybrid on is
 * evidence-gated (paraphrase hit@3 vs BM25 on both silos)" in CLAUDE.md.
 *
 * Every path is scored on the same frozen corpus (`corpus.json`), inserted
 * twice into one temporary MarinaDB: as legacy notes for one entity and as
 * durable records in one world account's resident space. No model is called
 * unless an embedding provider is explicitly supplied; nothing is downloaded.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingProvider } from "../../src/memory/embeddings";
import {
  expandedFtsQueries,
  fuseRecallResults,
  memoryQueryExpansion,
} from "../../src/memory/query-expansion";
import { worldMemoryService } from "../../src/memory/world-service";
import { MarinaDB } from "../../src/persistence/database";
import { buildFtsQuery } from "../../src/persistence/fts";
import { expandMemoryQuery, type MemoryQueryVocabulary } from "../../src/sdk/memory-expansion";
import type { MemorySearchResult } from "../../src/sdk/memory-types";

export interface ParaphraseTriple {
  id: string;
  domain: string;
  fact: string;
  paraphrase: string;
  distractor: string;
}
export interface ParaphraseCorpus {
  schema: "marina.paraphrase.corpus.v1";
  description: string;
  domains: string[];
  triples: ParaphraseTriple[];
}

export const CORPUS_PATH = join(import.meta.dir, "corpus.json");

export function corpusHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function loadCorpus(path = CORPUS_PATH): { corpus: ParaphraseCorpus; hash: string } {
  const text = readFileSync(path, "utf8");
  const corpus = JSON.parse(text) as ParaphraseCorpus;
  if (corpus.schema !== "marina.paraphrase.corpus.v1" || !Array.isArray(corpus.triples))
    throw new Error(`Not a paraphrase corpus: ${path}`);
  return { corpus, hash: corpusHash(text) };
}

export type ParaphrasePath =
  | "legacy-fts-plain"
  | "legacy-fts-porter"
  | "legacy-recall"
  | "legacy-recall+expansion"
  | "durable-lexical"
  | "durable-hybrid";

export const PARAPHRASE_PATHS: ParaphrasePath[] = [
  "legacy-fts-plain",
  "legacy-fts-porter",
  "legacy-recall",
  "legacy-recall+expansion",
  "durable-lexical",
  "durable-hybrid",
];

export interface PathResult {
  path: ParaphrasePath;
  /** Fraction of triples whose fact is in the top 3 for its paraphrase. */
  hitAt3: number;
  hitAt1: number;
  /** Fraction whose fact ranks first for the distractor query (lower is better). */
  distractorAt1: number;
  evaluated: number;
  byDomain: Record<string, { hitAt3: number; evaluated: number }>;
  skipped?: string;
}

export interface ParaphraseReport {
  schema: "marina.paraphrase.report.v1";
  corpusHash: string;
  triples: number;
  ranAt: string;
  results: PathResult[];
}

export interface ParaphraseRunOptions {
  /** File path for the temporary MarinaDB (must be file-backed). */
  dbPath: string;
  triples: ParaphraseTriple[];
  /** Optional caller vocabulary for the legacy expansion path. */
  vocabulary?: MemoryQueryVocabulary;
  /** Configured provider for the durable hybrid path, or a skip reason. */
  embeddings?: { provider: EmbeddingProvider; env: Record<string, string> } | { skipped: string };
  /** Restrict to a subset of paths (default: all). */
  paths?: ParaphrasePath[];
}

const LEGACY_ENTITY = "paraphrase-bench";
const WORLD_ACCOUNT = "ParaphraseBench";

type Ranker = (query: string) => Promise<string[]> | string[];

function score(
  path: ParaphrasePath,
  triples: ParaphraseTriple[],
  rank: Ranker,
): Promise<PathResult> {
  return (async () => {
    let hit3 = 0;
    let hit1 = 0;
    let distractor1 = 0;
    const byDomain: PathResult["byDomain"] = {};
    for (const triple of triples) {
      const top = (await rank(triple.paraphrase)).slice(0, 3);
      const domain = (byDomain[triple.domain] ??= { hitAt3: 0, evaluated: 0 });
      domain.evaluated++;
      if (top.includes(triple.id)) {
        hit3++;
        domain.hitAt3++;
      }
      if (top[0] === triple.id) hit1++;
      const distractorTop = (await rank(triple.distractor)).slice(0, 1);
      if (distractorTop[0] === triple.id) distractor1++;
    }
    const n = triples.length || 1;
    for (const domain of Object.values(byDomain)) domain.hitAt3 /= domain.evaluated || 1;
    return {
      path,
      hitAt3: hit3 / n,
      hitAt1: hit1 / n,
      distractorAt1: distractor1 / n,
      evaluated: triples.length,
      byDomain,
    };
  })();
}

/** Runs every requested path against a fresh temporary database. */
export async function runParaphraseBenchmark(options: ParaphraseRunOptions): Promise<PathResult[]> {
  const paths = options.paths ?? PARAPHRASE_PATHS;
  const wanted = (path: ParaphrasePath) => paths.includes(path);
  const embeddingEnv =
    options.embeddings && "provider" in options.embeddings ? options.embeddings.env : {};
  const db = new MarinaDB(options.dbPath);
  const results: PathResult[] = [];
  try {
    // Bind the world service to the configured provider BEFORE any resident
    // operation memoizes it. `MARINA_MEMORY_EMBEDDINGS` unset → lexical only.
    const service = worldMemoryService(db, { ...embeddingEnv });

    // ── Legacy silo: one entity, one note per fact ───────────────────────
    const noteToTriple = new Map<number, string>();
    for (const triple of options.triples) {
      const id = db.createNote(LEGACY_ENTITY, triple.fact, undefined, {
        importance: 5,
        noteType: "fact",
        skipDedup: true,
      });
      noteToTriple.set(id, triple.id);
    }
    const legacyIds = (rows: { id: number }[]) =>
      rows.map((row) => noteToTriple.get(row.id)).filter((x): x is string => !!x);

    // Pre-112 shadow index: same content, unicode61 tokenizer, no stop-word
    // removal. Queried with pure FTS rank so the porter comparison isolates
    // exactly the tokenizer + query change.
    const raw = new Database(options.dbPath);
    try {
      raw.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS bench_notes_fts_plain USING fts5(content, content=notes, content_rowid=id, tokenize='unicode61')",
      );
      raw.exec("INSERT INTO bench_notes_fts_plain(bench_notes_fts_plain) VALUES('rebuild')");
      const rankRaw = (table: string, match: string | null) =>
        match
          ? (raw
              .query(
                `SELECT n.id FROM notes n JOIN ${table} f ON n.id = f.rowid
                 WHERE n.entity_name = ? AND ${table} MATCH ? ORDER BY f.rank LIMIT 3`,
              )
              .all(LEGACY_ENTITY, match) as { id: number }[])
          : [];
      if (wanted("legacy-fts-plain"))
        results.push(
          await score("legacy-fts-plain", options.triples, (q) =>
            legacyIds(
              rankRaw("bench_notes_fts_plain", buildFtsQuery(q, "or", { stopWords: false })),
            ),
          ),
        );
      if (wanted("legacy-fts-porter"))
        results.push(
          await score("legacy-fts-porter", options.triples, (q) =>
            legacyIds(rankRaw("notes_fts", buildFtsQuery(q, "or"))),
          ),
        );
    } finally {
      raw.close();
    }

    const recall = (q: string) => legacyIds(db.recallNotes(LEGACY_ENTITY, q));
    if (wanted("legacy-recall"))
      results.push(await score("legacy-recall", options.triples, recall));

    if (wanted("legacy-recall+expansion")) {
      if (!options.vocabulary)
        results.push({
          ...(await score("legacy-recall+expansion", [], recall)),
          skipped: "no --vocab supplied",
        });
      else {
        const vocabulary = options.vocabulary;
        results.push(
          await score("legacy-recall+expansion", options.triples, (q) => {
            const expansion = memoryQueryExpansion(q, expandMemoryQuery(q, vocabulary).expansion);
            const lists = expandedFtsQueries(q, expansion).map((query) =>
              db.recallNotes(LEGACY_ENTITY, query),
            );
            return legacyIds(fuseRecallResults(lists, (row) => row.id, 3));
          }),
        );
      }
    }

    // ── Durable silo: one world account, one record per fact ─────────────
    // Driven through MemoryService with a credential-derived actor (the same
    // binding resident commands use) rather than the HTTP client, whose
    // per-principal request budget is a transport concern, not a retrieval one.
    if (wanted("durable-lexical") || wanted("durable-hybrid")) {
      const principalId = crypto.randomUUID();
      db.createUser({ id: principalId, name: WORLD_ACCOUNT });
      const actor = db.verifyMemoryCredential(db.issueMemoryCredential(principalId).token);
      if (!actor) throw new Error("Could not bind the benchmark world account");
      const space = service.repository.createSpace(actor, "resident", `resident:${principalId}`).id;
      const recordToTriple = new Map<string, string>();
      for (const triple of options.triples) {
        const receipt = service.repository.remember(
          actor,
          space,
          { content: triple.fact, type: "fact", importance: 5 },
          `paraphrase:${triple.id}`,
          service.embeddings?.id,
        );
        recordToTriple.set(receipt.id, triple.id);
      }
      const durable = async (q: string, mode: "lexical" | "hybrid") => {
        const response: MemorySearchResult = await service.search(actor, space, {
          query: q,
          limit: 3,
          mode,
        });
        return response.results
          .map((record) => recordToTriple.get(record.id))
          .filter((x): x is string => !!x);
      };
      if (wanted("durable-lexical"))
        results.push(await score("durable-lexical", options.triples, (q) => durable(q, "lexical")));
      if (wanted("durable-hybrid")) {
        if (!options.embeddings || "skipped" in options.embeddings)
          results.push({
            ...(await score("durable-hybrid", [], recall)),
            skipped: options.embeddings?.skipped ?? "no --embeddings supplied",
          });
        else {
          // Drain the index queue so every record has a vector before searching.
          // Do NOT stop the worker first: stopWorker() sets the flag that makes
          // runIndexJobs() return immediately, which turned this drain into a
          // no-op and failed the hybrid path with `index_incomplete` (2026-09-14).
          // The worker keeps idling alongside; `finally` stops it after scoring.
          for (let guard = 0; guard < 10_000; guard++) {
            if ((await service.runIndexJobs(64)) === 0) break;
          }
          results.push(await score("durable-hybrid", options.triples, (q) => durable(q, "hybrid")));
        }
      }
    }
  } finally {
    worldMemoryService(db).stopWorker();
    db.close();
  }
  return results;
}

const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)}%`;

export function renderTable(results: PathResult[]): string {
  const lines = [
    `${"path".padEnd(26)} ${"hit@3".padStart(7)} ${"hit@1".padStart(7)} ${"distr@1".padStart(8)}  n`,
    "-".repeat(60),
  ];
  for (const result of results) {
    if (result.skipped) {
      lines.push(`${result.path.padEnd(26)} skipped — ${result.skipped}`);
      continue;
    }
    lines.push(
      `${result.path.padEnd(26)} ${pct(result.hitAt3).padStart(7)} ${pct(result.hitAt1).padStart(7)} ${pct(result.distractorAt1).padStart(8)}  ${result.evaluated}`,
    );
  }
  return lines.join("\n");
}
