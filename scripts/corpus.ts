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
 * Input JSONL: one document per line, `{"docid", "text", "title"?, "url"?}`.
 * Corpora live in MARINA_CORPUS_DIR (default ~/.local/share/marina/corpora),
 * never under the temp dir.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  buildCorpus,
  type CorpusDoc,
  corpusDir,
  getCorpusDocument,
  isUnderTempDir,
  listCorpora,
  searchCorpus,
} from "../src/engine/search-providers/corpus";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    replace: { type: "boolean" },
    source: { type: "string" },
    k: { type: "string" },
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
      for (const h of searchCorpus(name, q.join(" "), { dir, k, leadChars: 0 })) {
        console.log(`${h.docid}\t${h.score.toFixed(2)}\t${h.title}\n  ${h.passage}`);
      }
      return 0;
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
      throw new Error("usage: bun run corpus build|list|search|get (see scripts/corpus.ts)");
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  },
);
