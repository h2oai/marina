#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LongMemEval-V2 memory sidecar: the official Python harness's memory backend
 * (`marina_memory.py`) talks to this process over stdio, one JSON object per line.
 *
 *   bun benchmarks/longmemeval/memory-server.ts --db <path> [--mode lexical|hybrid]
 *     [--search-limit 40] [--context-bytes 160000] [--state-bytes 10000]
 *     [--episode-bytes 6000] [--radius 1]
 *
 * Requests: {"id":n,"op":"insert","trajectory":{…}} | {"id":n,"op":"query","query":"…"}
 *           | {"id":n,"op":"drain"} | {"id":n,"op":"stats"} | {"id":n,"op":"close"}
 * Replies:  {"id":n,"ok":true,…} or {"id":n,"ok":false,"error":"…"}
 *
 * stdout carries only replies; logs go to stderr. The database at --db must not
 * exist yet: one haystack, one fresh database.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_CONTEXT } from "./records";
import { LmeMemoryStore } from "./store";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: "string" },
    mode: { type: "string", default: "lexical" },
    "search-limit": { type: "string", default: "40" },
    "context-bytes": { type: "string", default: String(DEFAULT_CONTEXT.contextBytes) },
    "state-bytes": { type: "string", default: String(DEFAULT_CONTEXT.stateBytes) },
    "episode-bytes": { type: "string", default: String(DEFAULT_CONTEXT.episodeBytes) },
    radius: { type: "string", default: String(DEFAULT_CONTEXT.radius) },
  },
});

function positive(name: string, raw: string | undefined, min = 1): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer ≥ ${min}`);
  return n;
}

const dbPath = values.db;
if (!dbPath) throw new Error("--db is required");
if (existsSync(dbPath))
  throw new Error(`--db ${dbPath} exists; each haystack gets a fresh database`);
const mode = values.mode === "hybrid" ? "hybrid" : values.mode === "lexical" ? "lexical" : null;
if (!mode) throw new Error("--mode must be lexical or hybrid");
// A throwaway benchmark database: WAL without an fsync per commit.
process.env.MARINA_DB_DURABILITY ??= "normal";

const store = LmeMemoryStore.open(dbPath, {
  mode,
  searchLimit: positive("search-limit", values["search-limit"]),
  context: {
    contextBytes: positive("context-bytes", values["context-bytes"], 1024),
    stateBytes: positive("state-bytes", values["state-bytes"], 512),
    episodeBytes: positive("episode-bytes", values["episode-bytes"], 512),
    radius: positive("radius", values.radius, 0),
  },
});

const write = (reply: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(reply)}\n`);

async function handle(line: string): Promise<boolean> {
  let id: unknown = null;
  try {
    const request = JSON.parse(line) as { id?: unknown; op?: string } & Record<string, unknown>;
    id = request.id ?? null;
    switch (request.op) {
      case "insert":
        write({ id, ok: true, ...store.insert(request.trajectory as never) });
        return true;
      case "query":
        write({ id, ok: true, ...(await store.query(String(request.query ?? ""))) });
        return true;
      case "drain":
        write({ id, ok: true, indexed: await store.drainIndex() });
        return true;
      case "stats":
        write({ id, ok: true, ...store.stats() });
        return true;
      case "close":
        await store.close();
        write({ id, ok: true });
        return false;
      default:
        throw new Error(`unknown op ${String(request.op)}`);
    }
  } catch (error) {
    write({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

// Requests are handled strictly in order: an insert finishes before the next query.
const decoder = new TextDecoder();
let buffer = "";
let open = true;
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0 && open) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) open = await handle(line);
    newline = buffer.indexOf("\n");
  }
  if (!open) break;
}
if (open) await store.close();
process.exit(0);
