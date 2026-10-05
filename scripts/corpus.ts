#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local corpora — build and inspect offline BM25 indexes that agents search
 * with `web search engines:corpus:<name>` (src/engine/search-providers/corpus.ts).
 *
 *   bun run corpus build <name> <docs.jsonl> [--replace] [--source <label>]
 *   bun run corpus list
 *   bun run corpus search <name> <query…> [--k 5]
 *   bun run corpus get <name> <docid>
 *
 * Optional dense vectors for hybrid (BM25 + dense) search — see
 * src/engine/search-providers/corpus-vectors.ts:
 *
 *   bun run corpus embed <name> [--format int8|f32] [--dims N] [--max-chars 16000]
 *                               [--query-prefix "…"] [--batch 16] [--limit N]
 *       embeds every document without a vector, with the MARINA_CORPUS_EMBEDDINGS
 *       provider (local, ollama or any OpenAI-compatible endpoint); resumable.
 *   bun run corpus vectors <name>                                   list vector sets
 *   bun run corpus vectors import <name> <vectors.f32> <docids.txt> --model <provider id>
 *                               --source-dims N [--dims N] [--format int8|f32] [--query-prefix "…"]
 *   bun run corpus vectors drop <name> <provider id>
 *
 * `corpus search` uses the hybrid ranking when it applies and says which ran.
 *
 * Input JSONL: one document per line, `{"docid", "text", "title"?, "url"?}`.
 * Corpora live in MARINA_CORPUS_DIR (default ~/.local/share/marina/corpora),
 * never under the temp dir.
 */

import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  buildCorpus,
  type CorpusDoc,
  corpusDir,
  corpusVectors,
  getCorpusDocument,
  isCorpusName,
  isUnderTempDir,
  listCorpora,
  searchCorpusHybridPage,
} from "../src/engine/search-providers/corpus";
import {
  corpusEmbedder,
  corpusEmbeddingStatus,
  dropCorpusVectors,
  embedCorpus,
  importCorpusVectors,
} from "../src/engine/search-providers/corpus-vectors";
import { isVectorFormat, type VectorFormat } from "../src/retrieval/vectors";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    replace: { type: "boolean" },
    source: { type: "string" },
    k: { type: "string" },
    format: { type: "string" },
    dims: { type: "string" },
    "source-dims": { type: "string" },
    "max-chars": { type: "string" },
    "query-prefix": { type: "string" },
    batch: { type: "string" },
    limit: { type: "string" },
    model: { type: "string" },
  },
});

async function* readJsonl(path: string): AsyncGenerator<CorpusDoc> {
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    if (typeof r.docid !== "string" && typeof r.docid !== "number") continue;
    if (typeof r.text !== "string") continue;
    yield {
      docid: String(r.docid),
      text: r.text,
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      ...(typeof r.url === "string" ? { url: r.url } : {}),
    };
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = positionals;
  const dir = corpusDir();
  switch (cmd) {
    case "build": {
      const [name, file] = rest;
      if (!name || !file) throw new Error("usage: bun run corpus build <name> <docs.jsonl>");
      if (isUnderTempDir(dir)) {
        console.error(`warning: ${dir} is under the temp dir (often a small tmpfs)`);
      }
      const started = Date.now();
      const info = await buildCorpus(name, readJsonl(file), {
        dir,
        replace: values.replace === true,
        source: values.source ?? file,
        onProgress: (n) => {
          if (n % 20_000 === 0) console.error(`  ${n} documents…`);
        },
      });
      console.log(
        `built corpus ${info.name}: ${info.docs} documents → ${info.path} (${((Date.now() - started) / 1000).toFixed(0)} s)`,
      );
      return 0;
    }
    case "list": {
      const all = listCorpora(dir);
      if (all.length === 0) console.log(`No corpora in ${dir}.`);
      for (const c of all) console.log(`${c.name}\t${c.docs} docs\t${c.builtAt ?? ""}\t${c.path}`);
      return 0;
    }
    case "search": {
      const [name, ...q] = rest;
      if (!name || q.length === 0) throw new Error("usage: bun run corpus search <name> <query>");
      const k = values.k ? Number(values.k) : 5;
      const page = await searchCorpusHybridPage(name, q.join(" "), { dir, k, leadChars: 0 });
      console.error(
        `ranking: ${page.mode}${page.model ? ` (${page.model})` : ""}${page.degraded ? ` — fell back to BM25: ${page.degraded}` : ""}`,
      );
      for (const h of page.hits) {
        console.log(`${h.docid}\t${h.score.toFixed(4)}\t${h.title}\n  ${h.passage}`);
      }
      return 0;
    }
    case "embed": {
      const [name] = rest;
      if (!name || !isCorpusName(name)) throw new Error("usage: bun run corpus embed <name>");
      const status = corpusEmbeddingStatus();
      if (status.state !== "configured")
        throw new Error(
          status.state === "invalid"
            ? status.error!
            : "no corpus embedding model: set MARINA_CORPUS_EMBEDDINGS (local, ollama or openai) — see config/environment.reference",
        );
      const provider = corpusEmbedder()!;
      const started = Date.now();
      const result = await embedCorpus(join(dir, `${name}.db`), provider, {
        format: vectorFormat(values.format),
        ...(values.dims ? { dims: positiveInt(values.dims, "--dims") } : {}),
        ...(values["max-chars"]
          ? { maxChars: positiveInt(values["max-chars"], "--max-chars") }
          : {}),
        ...(values["query-prefix"] !== undefined ? { queryPrefix: values["query-prefix"] } : {}),
        ...(values.batch ? { batch: positiveInt(values.batch, "--batch") } : {}),
        ...(values.limit ? { limit: positiveInt(values.limit, "--limit") } : {}),
        onProgress: (done, total) => {
          if (done % 1_000 < (values.batch ? Number(values.batch) : 16) || done === total)
            console.error(`  ${done}/${total} documents embedded…`);
        },
      });
      console.log(
        `embedded ${result.embedded} documents (${result.total} with vectors) for ${result.info.model} as ${result.info.format}/${result.info.dims}d (${((Date.now() - started) / 1000).toFixed(0)} s)`,
      );
      return 0;
    }
    case "vectors": {
      const [sub, name, ...args] = rest;
      if (sub && !["import", "drop"].includes(sub) && rest.length === 1) {
        for (const v of corpusVectors(sub, dir))
          console.log(
            `${v.model}\t${v.count} docs\t${v.format}/${v.dims}d\tquery prefix ${JSON.stringify(v.queryPrefix)}\t${v.maxChars || "?"} chars`,
          );
        return 0;
      }
      if (!name || !isCorpusName(name))
        throw new Error("usage: bun run corpus vectors <name> | vectors import|drop <name> …");
      const path = join(dir, `${name}.db`);
      if (sub === "drop") {
        const [model] = args;
        if (!model) throw new Error("usage: bun run corpus vectors drop <name> <provider id>");
        console.log(`dropped ${dropCorpusVectors(path, model)} vectors`);
        return 0;
      }
      if (sub === "import") {
        const [f32, ids] = args;
        if (!f32 || !ids || !values.model || !values["source-dims"])
          throw new Error(
            "usage: bun run corpus vectors import <name> <vectors.f32> <docids.txt> --model <id> --source-dims N",
          );
        const result = importCorpusVectors(path, f32, ids, {
          model: values.model,
          sourceDims: positiveInt(values["source-dims"], "--source-dims"),
          ...(values.dims ? { dims: positiveInt(values.dims, "--dims") } : {}),
          format: vectorFormat(values.format),
          ...(values["query-prefix"] !== undefined ? { queryPrefix: values["query-prefix"] } : {}),
          ...(values["max-chars"]
            ? { maxChars: positiveInt(values["max-chars"], "--max-chars") }
            : {}),
          onProgress: (n) => {
            if (n % 20_000 < 5_000) console.error(`  ${n} vectors…`);
          },
        });
        console.log(
          `imported ${result.imported} vectors (${result.unknown} docids not in the corpus) for ${result.info.model} as ${result.info.format}/${result.info.dims}d`,
        );
        return 0;
      }
      throw new Error("usage: bun run corpus vectors <name> | vectors import|drop <name> …");
    }
    case "get": {
      const [name, docid] = rest;
      if (!name || !docid) throw new Error("usage: bun run corpus get <name> <docid>");
      const d = getCorpusDocument(name, docid, { dir });
      if (!d) {
        console.error(`no document ${docid} in ${name}`);
        return 1;
      }
      console.log(`${d.docid} · ${d.title} · ${d.url}\n\n${d.text}`);
      return 0;
    }
    default:
      throw new Error(
        "usage: bun run corpus build|list|search|get|embed|vectors (see scripts/corpus.ts)",
      );
  }
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function vectorFormat(raw: string | undefined): VectorFormat {
  const f = raw ?? "int8";
  if (!isVectorFormat(f)) throw new Error("--format must be int8 or f32");
  return f;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  },
);
