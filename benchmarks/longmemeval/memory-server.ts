#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LongMemEval-V2 memory sidecar: the official Python harness's memory backend
 * (`marina_memory.py`) talks to this process over stdio, one JSON object per line.
 *
 *   bun benchmarks/longmemeval/memory-server.ts --db <path> [--mode lexical|hybrid]
 *     [--retrieval unified|raw] [--gate off|observe|on] [--gate-max 8]
 *     [--gate-backend auto|decisions|model|mechanical] [--gate-model <id>]
 *     [--gate-base-url http://localhost:3300/v1] [--gate-api-key-env OPENAI_API_KEY]
 *     [--search-limit 40] [--context-bytes 160000] [--state-bytes 10000]
 *     [--episode-bytes 6000] [--radius 1]
 *     [--index-concurrency 8] [--drain-timeout-ms 21600000]
 *     [--ingest-notes off|on] [--notes-model <id>] [--notes-base-url http://localhost:3300/v1]
 *     [--notes-api-key-env OPENAI_API_KEY] [--notes-max-bytes 48000]
 *
 * `--retrieval unified` (default) serves through `buildUnifiedContext`, Marina's
 * resident retrieval path; `raw` is the pilot's ungated search. The relevance gate
 * runs only in the unified path; a model gate's spend is recorded where it leaves
 * Marina (point `--gate-base-url` at a Marina `/v1`, or the decision layer's metered
 * provider with `DB_PATH`'s ledger attached).
 *
 * `--ingest-notes on` writes ingest-time notes (`src/memory/ingest-notes.ts`) after
 * each trajectory: one call of `--notes-model` (behind `--notes-base-url`, a Marina
 * `/v1` so spend lands on its ledger; the key comes from the variable named by
 * `--notes-api-key-env`) per 12 KB chunk of the run's compact view, or, with no
 * model named, the mechanical extractor. The insert reply carries the note counts.
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
import { attachCliSpendLedger } from "../../src/engine/cli-spend-ledger";
import { DEFAULT_CONTEXT } from "./records";
import {
  DEFAULT_NOTES_MAX_BYTES,
  type GateBackend,
  gateProvider,
  LmeMemoryStore,
  notesWriter,
  type Retrieval,
} from "./store";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: "string" },
    mode: { type: "string", default: "lexical" },
    retrieval: { type: "string", default: "unified" },
    gate: { type: "string", default: "off" },
    "gate-max": { type: "string", default: "8" },
    "gate-backend": { type: "string", default: "auto" },
    "gate-model": { type: "string" },
    "gate-base-url": { type: "string", default: "http://localhost:3300/v1" },
    "gate-api-key-env": { type: "string", default: "OPENAI_API_KEY" },
    "search-limit": { type: "string", default: "40" },
    "index-concurrency": { type: "string", default: "8" },
    "drain-timeout-ms": { type: "string", default: String(6 * 3_600_000) },
    "context-bytes": { type: "string", default: String(DEFAULT_CONTEXT.contextBytes) },
    "state-bytes": { type: "string", default: String(DEFAULT_CONTEXT.stateBytes) },
    "episode-bytes": { type: "string", default: String(DEFAULT_CONTEXT.episodeBytes) },
    radius: { type: "string", default: String(DEFAULT_CONTEXT.radius) },
    "ingest-notes": { type: "string", default: "off" },
    "notes-model": { type: "string" },
    "notes-base-url": { type: "string", default: "http://localhost:3300/v1" },
    "notes-api-key-env": { type: "string", default: "OPENAI_API_KEY" },
    "notes-max-bytes": { type: "string", default: String(DEFAULT_NOTES_MAX_BYTES) },
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
const pick = <T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
): T => {
  if (allowed.includes(raw as T)) return raw as T;
  throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
};
const retrieval = pick<Retrieval>("retrieval", values.retrieval, ["unified", "raw"]);
const gateMode = pick("gate", values.gate, ["off", "observe", "on"] as const);
const backend = pick<GateBackend>("gate-backend", values["gate-backend"], [
  "auto",
  "decisions",
  "model",
  "mechanical",
]);
const ingestNotes = pick("ingest-notes", values["ingest-notes"], ["off", "on"] as const);
// A throwaway benchmark database: WAL without an fsync per commit.
process.env.MARINA_DB_DURABILITY ??= "normal";
// The decision layer's metered provider and a paid embedder (hybrid) record into
// the world ledger (DB_PATH), where the daily and scope caps also refuse them.
if ((gateMode !== "off" && backend !== "mechanical") || mode === "hybrid")
  attachCliSpendLedger("longmemeval memory sidecar");
// The note writer checks the daily cap against the same ledger before each chunk.
else if (ingestNotes === "on" && values["notes-model"])
  attachCliSpendLedger("longmemeval ingest notes");

const store = LmeMemoryStore.open(dbPath, {
  mode,
  retrieval,
  ...(gateMode === "off"
    ? {}
    : {
        gate: {
          mode: gateMode,
          maxItems: positive("gate-max", values["gate-max"]),
          provider: gateProvider({
            backend,
            ...(values["gate-model"] ? { model: values["gate-model"] } : {}),
            baseUrl: values["gate-base-url"] ?? "http://localhost:3300/v1",
            apiKeyEnv: values["gate-api-key-env"] ?? "OPENAI_API_KEY",
          }),
        },
      }),
  ...(ingestNotes === "on"
    ? {
        notes: {
          writer: notesWriter({
            ...(values["notes-model"] ? { model: values["notes-model"] } : {}),
            baseUrl: values["notes-base-url"] ?? "http://localhost:3300/v1",
            apiKeyEnv: values["notes-api-key-env"] ?? "OPENAI_API_KEY",
          }),
          maxBytes: positive("notes-max-bytes", values["notes-max-bytes"], 1024),
        },
      }
    : {}),
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
      case "insert": {
        const inserted = store.insert(request.trajectory as never);
        const notes = await store.writeNotes(request.trajectory as never);
        write({
          id,
          ok: true,
          ...inserted,
          ...(notes
            ? {
                notes: {
                  outcome: notes.outcome,
                  ...(notes.reason ? { reason: notes.reason } : {}),
                  ...(notes.fallback ? { fallback: notes.fallback } : {}),
                  writer: notes.writer,
                  chunks: notes.chunks,
                  calls: notes.calls,
                  truncated: notes.truncated,
                  written: notes.written,
                  ungrounded: notes.ungrounded,
                  duplicates: notes.duplicates,
                  ms: Math.round(notes.ms),
                },
              }
            : {}),
        });
        return true;
      }
      case "query":
        write({ id, ok: true, ...(await store.query(String(request.query ?? ""))) });
        return true;
      case "drain":
        write({
          id,
          ok: true,
          ...(await store.drainIndex({
            concurrency: positive("index-concurrency", values["index-concurrency"]),
            timeoutMs: positive("drain-timeout-ms", values["drain-timeout-ms"]),
          })),
        });
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
