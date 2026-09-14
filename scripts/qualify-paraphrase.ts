// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Paraphrase retrieval gate — hit@3 across legacy FTS, porter+stop-words,
 * vocabulary expansion, durable lexical and (opt-in) durable hybrid.
 *
 *   bun run qualify:paraphrase
 *   bun run scripts/qualify-paraphrase.ts --vocab benchmarks/paraphrase/vocab.example.json
 *   bun run scripts/qualify-paraphrase.ts --embeddings local --model-cache data/memory-models
 *
 * Never calls a paid model. `--embeddings local` requires the optional
 * extension (bun install --cwd extensions/local-embeddings --frozen-lockfile);
 * when it is absent the hybrid row prints "skipped". Exit code is always 0 —
 * this reports evidence, it does not gate CI.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  loadCorpus,
  type ParaphraseReport,
  type ParaphraseRunOptions,
  renderTable,
  runParaphraseBenchmark,
} from "../benchmarks/paraphrase/runner";
import { getErrorMessage } from "../src/engine/errors";
import {
  EMBEDDING_ENV,
  type EmbeddingConfig,
  embeddingProviderFromConfig,
} from "../src/memory/embedding-config";
import type { MemoryQueryVocabulary } from "../src/sdk/memory-expansion";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    corpus: { type: "string" },
    vocab: { type: "string" },
    embeddings: { type: "string", default: "none" },
    "model-cache": { type: "string", default: "data/memory-models" },
    "local-only": { type: "boolean", default: false },
    "embedding-url": { type: "string" },
    "embedding-model": { type: "string" },
    "embedding-revision": { type: "string" },
    out: { type: "string", default: "data/scratch/paraphrase-hit3.json" },
    limit: { type: "string" },
  },
});

const { corpus, hash } = loadCorpus(values.corpus ? resolve(values.corpus) : undefined);
const triples = values.limit ? corpus.triples.slice(0, Number(values.limit)) : corpus.triples;

let vocabulary: MemoryQueryVocabulary | undefined;
if (values.vocab) {
  vocabulary = JSON.parse(readFileSync(resolve(values.vocab), "utf8")) as MemoryQueryVocabulary;
  if (typeof vocabulary.policy !== "string" || !Array.isArray(vocabulary.rules))
    throw new Error("--vocab must be a JSON object with policy and rules");
}

let embeddings: ParaphraseRunOptions["embeddings"];
if (values.embeddings !== "none") {
  if (!["local", "ollama"].includes(values.embeddings))
    throw new Error("--embeddings must be none, local or ollama");
  const config: EmbeddingConfig =
    values.embeddings === "local"
      ? {
          kind: "local",
          cacheDirectory: resolve(values["model-cache"]),
          localOnly: values["local-only"],
        }
      : {
          kind: "ollama",
          url: values["embedding-url"] ?? "http://127.0.0.1:11434",
          model: values["embedding-model"] ?? "",
          revision: values["embedding-revision"] ?? "",
        };
  try {
    const provider = await embeddingProviderFromConfig(config);
    if (!provider) throw new Error("no provider constructed");
    // Prove the provider answers before spending 400 searches on it.
    await provider.embed("paraphrase gate warm-up");
    const env: Record<string, string> =
      config.kind === "local"
        ? {
            [EMBEDDING_ENV.kind]: "local",
            [EMBEDDING_ENV.cache]: config.cacheDirectory,
            [EMBEDDING_ENV.localOnly]: String(config.localOnly),
          }
        : {
            [EMBEDDING_ENV.kind]: "ollama",
            [EMBEDDING_ENV.url]: config.url,
            [EMBEDDING_ENV.model]: config.model,
            [EMBEDDING_ENV.revision]: config.revision,
          };
    embeddings = { provider, env };
  } catch (error) {
    embeddings = { skipped: getErrorMessage(error) };
  }
}

const directory = mkdtempSync(join(tmpdir(), "marina-paraphrase-"));
try {
  const results = await runParaphraseBenchmark({
    dbPath: join(directory, "bench.db"),
    triples,
    vocabulary,
    embeddings,
  });
  const report: ParaphraseReport = {
    schema: "marina.paraphrase.report.v1",
    corpusHash: hash,
    triples: triples.length,
    ranAt: new Date().toISOString(),
    results,
  };
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`corpus sha256 ${hash} (${triples.length} triples)`);
  console.log(renderTable(results));
  console.log(`json → ${out}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
