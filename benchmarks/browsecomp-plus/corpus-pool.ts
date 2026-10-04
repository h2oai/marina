// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A pool of workers answering corpus tool calls. SQLite queries are
 * synchronous, and a BM25 query over a 100k-document index can take most of a
 * second; in-process, every agent would wait on every other agent's search.
 * Each worker opens its own read-only handle, so searches run in parallel.
 */

import type { CorpusDoc, CorpusHit } from "../../src/engine/search-providers/corpus";
import type { CorpusBackend } from "./agent";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface CorpusPool extends CorpusBackend {
  close(): void;
}

export function workerPool(corpus: string, dir: string | undefined, size: number): CorpusPool {
  const workers: Worker[] = [];
  const load: number[] = [];
  const pending = new Map<number, Pending & { worker: number }>();
  let nextId = 1;
  for (let i = 0; i < Math.max(1, size); i++) {
    const w = new Worker(new URL("./corpus-worker.ts", import.meta.url).href);
    w.onmessage = (ev: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      load[p.worker]!--;
      if (ev.data.error) p.reject(new Error(ev.data.error));
      else p.resolve(ev.data.result);
    };
    workers.push(w);
    load.push(0);
  }
  const call = (msg: Record<string, unknown>): Promise<unknown> => {
    // Least-loaded worker.
    let best = 0;
    for (let i = 1; i < load.length; i++) if (load[i]! < load[best]!) best = i;
    const id = nextId++;
    load[best]!++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, worker: best });
      workers[best]!.postMessage({ id, corpus, dir, ...msg });
    });
  };
  return {
    search: async (query, k, chars, offset) =>
      (await call({ op: "search", query, k, chars, ...(offset ? { offset } : {}) })) as CorpusHit[],
    get: async (docid, chars, offset) =>
      ((await call({ op: "get", docid, chars, ...(offset ? { offset } : {}) })) as
        | (CorpusDoc & { totalChars?: number })
        | null) ?? undefined,
    close: () => {
      for (const w of workers) w.terminate();
      for (const p of pending.values()) p.reject(new Error("corpus pool closed"));
      pending.clear();
    },
  };
}
