// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Worker side of `corpus-pool.ts`: answers search / get on its own read-only handle. */

import { getCorpusDocument, searchCorpus } from "../../src/engine/search-providers/corpus";

declare const self: Worker;

interface Request {
  id: number;
  op: "search" | "get";
  corpus: string;
  dir?: string;
  query?: string;
  docid?: string;
  k?: number;
  chars?: number;
}

self.onmessage = (ev: MessageEvent<Request>) => {
  const r = ev.data;
  try {
    const result =
      r.op === "search"
        ? searchCorpus(r.corpus, r.query ?? "", { dir: r.dir, k: r.k, leadChars: r.chars })
        : (getCorpusDocument(r.corpus, r.docid ?? "", { dir: r.dir, maxChars: r.chars }) ?? null);
    self.postMessage({ id: r.id, result });
  } catch (e) {
    self.postMessage({ id: r.id, error: e instanceof Error ? e.message : String(e) });
  }
};
