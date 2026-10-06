// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One LongMemEval-V2 haystack in one throwaway Marina database: trajectories go in
 * as canonical memory records, questions come back as reader context.
 *
 * - **Ingestion** writes through the canonical record repository (`remember`, the
 *   same versioned records `residentMemoryOperation` writes), bound to a durable
 *   world account by a memory credential — one SQLite transaction per trajectory.
 *   It skips only the HTTP transport's per-principal request budget, which is a
 *   transport concern (the paraphrase benchmark does the same).
 * - **Retrieval** (`retrieval`):
 *   - `unified` (default): `buildUnifiedContext`, the path Marina serves its own
 *     residents — the evidence tier's search, validity filter, overlap filter and,
 *     when enabled, the relevance gate (`gate`). An `on` gate that leaves nothing
 *     tells the reader so explicitly.
 *   - `raw`: `residentMemoryOperation({ operation: "search" })` hits served as
 *     ranked, with no relevance filter (the pilot's arm, kept for paired runs).
 *   Both are lexical (FTS5) by default, `hybrid` only when the operator configured
 *   `MARINA_MEMORY_EMBEDDINGS`. Retrieved records are hydrated (neighbouring
 *   states, the run summary) with one ACL-checked canonical read.
 *
 * The database is created fresh and deleted by the caller; nothing is shared between
 * haystacks, so no question can see another haystack's trajectories.
 */

import { harnessDecisionProvider } from "../../src/decisions/engines";
import { chatClassifierProvider } from "../../src/decisions/providers";
import type { DecisionProvider } from "../../src/decisions/types";
import {
  chatNoteWriter,
  INGEST_NOTE_KIND,
  type IngestNotesReport,
  type NoteWriter,
  writeIngestNotes,
} from "../../src/memory/ingest-notes";
import { type RelevanceGateMode, relevanceGateTimeoutMs } from "../../src/memory/relevance-gate";
import { residentMemoryOperation } from "../../src/memory/resident-service";
import { buildUnifiedContext, type UnifiedRelevanceReport } from "../../src/memory/unified-context";
import { worldMemoryService } from "../../src/memory/world-service";
import { MarinaDB } from "../../src/persistence/database";
import type { MemoryActor } from "../../src/persistence/db-principals";
import type { MemoryRecord, MemorySearchResult } from "../../src/sdk/memory-types";
import {
  type ContextOptions,
  DEFAULT_CONTEXT,
  type Hit,
  type LmeTrajectory,
  renderContext,
  trajectoryNoteViews,
  trajectoryRecords,
} from "./records";

/** The world account that owns the haystack's memory. */
export const LME_ACCOUNT = "LongMemEvalResident";

export type Retrieval = "raw" | "unified";

export interface GateOptions {
  mode: RelevanceGateMode;
  /** Judged records kept at most. */
  maxItems: number;
  /**
   * The model backend; undefined ⇒ resolved from the environment (the decision
   * layer, else the single-LLM fallback); null ⇒ the mechanical floor.
   */
  provider?: DecisionProvider | null;
}

export interface StoreOptions {
  mode: "lexical" | "hybrid";
  /** `unified` (default): the resident retrieval path; `raw`: ungated search hits. */
  retrieval?: Retrieval;
  /** Ranked records requested from search (1–100). */
  searchLimit: number;
  context: ContextOptions;
  /** Relevance gate (unified retrieval only); default off. */
  gate?: GateOptions;
  /** Ingest-time notes (`src/memory/ingest-notes.ts`); default off. */
  notes?: NotesOptions;
}

export interface NotesOptions {
  /** The note writer; null ⇒ the mechanical extractor (no model). */
  writer: NoteWriter | null;
  /** Bytes of trajectory view noted per run (the rest is labelled `truncated`). */
  maxBytes: number;
}

/** Default bytes of one trajectory's view sent to the note writer (4 chunks of 12 KB). */
export const DEFAULT_NOTES_MAX_BYTES = 48_000;

export interface NotesWriterOptions {
  /** A chat model id served by `baseUrl` (a Marina `/v1`, so spend lands on its ledger); none ⇒ mechanical. */
  model?: string;
  baseUrl: string;
  /** NAME of the environment variable holding the bearer key (never the key itself). */
  apiKeyEnv: string;
  timeoutMs?: number;
}

/** The sidecar's note writer: one chat model behind `baseUrl`, or null (mechanical). */
export function notesWriter(
  opts: NotesWriterOptions,
  env: NodeJS.ProcessEnv = process.env,
): NoteWriter | null {
  if (!opts.model) return null;
  const key = env[opts.apiKeyEnv];
  return chatNoteWriter({
    baseUrl: opts.baseUrl,
    model: opts.model,
    ...(key ? { apiKey: key } : {}),
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
}

export const DEFAULT_STORE: StoreOptions = {
  mode: "lexical",
  retrieval: "unified",
  searchLimit: 40,
  context: DEFAULT_CONTEXT,
};

/** What the reader sees when the gate is on and nothing relevant was retrieved. */
export const NO_RELEVANT_MEMORY_ITEM =
  "No relevant memory was found for this question in the past runs of this environment. Memory does not support an answer.";

export type GateBackend = "auto" | "decisions" | "model" | "mechanical";

export interface GateBackendOptions {
  backend: GateBackend;
  /** `model`: a chat model id served by `baseUrl` (a Marina `/v1`, so spend lands on its ledger). */
  model?: string;
  baseUrl: string;
  /** NAME of the environment variable holding the bearer key (never the key itself). */
  apiKeyEnv: string;
  timeoutMs?: number;
}

/**
 * The gate backend for the sidecar. The process-local internal token cannot
 * reach a separate Marina server, so the single-LLM fallback is an explicit
 * `model` behind `baseUrl` instead of the in-server `marina/default` hop:
 *   decisions   the configured decision layer (`MARINA_DECISIONS` / `_ENGINE`)
 *   model       one chat model as an uncalibrated verbalized classifier
 *   mechanical  query-term coverage, no model (returns null)
 *   auto        decisions when configured, else model when one is named, else mechanical
 */
export function gateProvider(
  opts: GateBackendOptions,
  env: NodeJS.ProcessEnv = process.env,
): DecisionProvider | null {
  const decisions = () => harnessDecisionProvider(env);
  const model = (): DecisionProvider => {
    if (!opts.model) throw new Error("--gate-backend model needs --gate-model");
    const inner = chatClassifierProvider({
      baseUrl: opts.baseUrl,
      model: opts.model,
      ...(env[opts.apiKeyEnv] ? { apiKey: env[opts.apiKeyEnv] } : {}),
      timeoutMs: opts.timeoutMs ?? relevanceGateTimeoutMs(env),
      // A relevance judgement needs no reasoning (OpenRouter-routed models).
      reasoning: "off",
      method: "verbalized",
    });
    return {
      kind: "marina-classifier",
      model: opts.model,
      calibrated: false,
      ask: async (request, signal) => ({
        ...(await inner.ask(request, signal)),
        calibrated: false,
      }),
    };
  };
  switch (opts.backend) {
    case "mechanical":
      return null;
    case "decisions": {
      const p = decisions();
      if (!p)
        throw new Error("--gate-backend decisions needs MARINA_DECISIONS (a decision backend)");
      return p;
    }
    case "model":
      return model();
    default:
      return decisions() ?? (opts.model ? model() : null);
  }
}

/** Byte cap per item inside the unified path (above any record: hydration reads the full record). */
const UNIFIED_ITEM_BYTES = 65_536;

export interface InsertResult {
  records: number;
  bytes: number;
  ms: number;
}

export interface QueryResult {
  items: { type: "text"; value: string }[];
  /** Record ids placed in the context, in order (for traces; never content). */
  used: string[];
  hits: number;
  degraded: string[];
  ms: number;
  retrieval: Retrieval;
  /** The relevance gate's report (numbers and ids only), when it ran. */
  relevance?: UnifiedRelevanceReport;
}

export class LmeMemoryStore {
  private readonly ids = new Map<string, string>();
  /** Record id → trajectory id (resolves a derived note to its run). */
  private readonly owners = new Map<string, string>();
  private notesWritten = 0;
  private readonly stateCounts = new Map<string, number>();
  private constructor(
    readonly db: MarinaDB,
    private readonly actor: MemoryActor,
    private readonly space: string,
    readonly options: StoreOptions,
    private readonly embeddingId: string | undefined,
  ) {}

  static open(dbPath: string, options: StoreOptions = DEFAULT_STORE): LmeMemoryStore {
    if ((options.retrieval ?? "unified") === "raw" && (options.gate?.mode ?? "off") !== "off")
      throw new Error(
        "the relevance gate runs in the unified retrieval path; use --retrieval unified",
      );
    const db = new MarinaDB(dbPath);
    const service = worldMemoryService(db);
    if (options.mode === "hybrid" && !service.embeddings)
      throw new Error("hybrid retrieval needs MARINA_MEMORY_EMBEDDINGS (an embedding provider)");
    const principalId = crypto.randomUUID();
    db.createUser({ id: principalId, name: LME_ACCOUNT });
    const actor = db.verifyMemoryCredential(db.issueMemoryCredential(principalId).token);
    if (!actor) throw new Error("could not bind the LongMemEval world account");
    // The space residentMemoryOperation resolves for this account ("resident").
    const space = service.repository.createSpace(actor, "resident", `resident:${principalId}`).id;
    return new LmeMemoryStore(db, actor, space, options, service.embeddings?.id);
  }

  /** Index one trajectory: one transaction, one record per state plus its episode. */
  insert(trajectory: LmeTrajectory): InsertResult {
    if (!trajectory?.id) throw new Error("trajectory without an id");
    if (this.stateCounts.has(trajectory.id))
      throw new Error(`duplicate trajectory insert: ${trajectory.id}`);
    const started = performance.now();
    const records = trajectoryRecords(trajectory);
    const repository = worldMemoryService(this.db).repository;
    let bytes = 0;
    repository.raw.transaction(() => {
      for (const record of records) {
        const receipt = repository.remember(
          this.actor,
          this.space,
          record.input,
          record.key,
          this.embeddingId,
        );
        this.ids.set(record.key, receipt.id);
        this.owners.set(receipt.id, trajectory.id);
        bytes += Buffer.byteLength(record.input.content);
      }
    })();
    this.stateCounts.set(trajectory.id, trajectory.states?.length ?? 0);
    return { records: records.length, bytes, ms: performance.now() - started };
  }

  /**
   * Ingest-time notes for one inserted trajectory (`--ingest-notes on`): the
   * episode and state records are the sources, their compact views what the
   * writer reads. Never throws; the report carries counts only.
   */
  async writeNotes(trajectory: LmeTrajectory): Promise<IngestNotesReport | undefined> {
    const notes = this.options.notes;
    if (!notes) return undefined;
    const views = trajectoryNoteViews(trajectory);
    const records: string[] = [];
    const byId: Record<string, string> = {};
    for (const [key, view] of views) {
      const id = this.ids.get(key);
      if (!id) continue;
      records.push(id);
      byId[id] = view;
    }
    const report = await writeIngestNotes(
      worldMemoryService(this.db).repository,
      this.actor,
      this.space,
      {
        records,
        views: byId,
        writer: notes.writer,
        maxBytes: notes.maxBytes,
        ...(this.embeddingId ? { embeddingModel: this.embeddingId } : {}),
      },
    );
    for (const id of report.ids) this.owners.set(id, trajectory.id);
    this.notesWritten += report.written;
    return report;
  }

  /**
   * Embed every pending record (hybrid only) and wait for the background index
   * worker too: returns how many this call indexed and how many are still
   * pending when the bound (`timeoutMs`, default 6 h) ran out. `concurrency`
   * embedding requests are in flight at once (default 8).
   */
  async drainIndex(
    opts: { timeoutMs?: number; concurrency?: number } = {},
  ): Promise<{ indexed: number; pending: number; timedOut: boolean }> {
    return worldMemoryService(this.db).drainIndex({
      timeoutMs: opts.timeoutMs ?? 6 * 3_600_000,
      concurrency: opts.concurrency ?? 8,
    });
  }

  private read(ids: string[]): Map<string, Hit> {
    if (ids.length === 0) return new Map();
    const rows = worldMemoryService(this.db).repository.readCurrent(this.actor, this.space, ids);
    return new Map(rows.map((r: MemoryRecord) => [r.id, this.toHit(r)]));
  }

  /** Ranked hits from the ungated search (the pilot's `raw` arm). */
  private async rawHits(text: string): Promise<{ hits: Hit[]; degraded: string[] }> {
    const search = await residentMemoryOperation(this.db, LME_ACCOUNT, {
      operation: "search",
      input: {
        query: text,
        limit: Math.max(1, Math.min(100, this.options.searchLimit)),
        mode: this.options.mode,
      },
    });
    const result = search.result as MemorySearchResult;
    return { hits: result.results.map((r) => this.toHit(r)), degraded: result.degraded ?? [] };
  }

  /** Ranked hits through the resident retrieval path (`buildUnifiedContext`, evidence tier). */
  private async unifiedHits(
    text: string,
  ): Promise<{ hits: Hit[]; degraded: string[]; relevance?: UnifiedRelevanceReport }> {
    const limit = Math.max(1, Math.min(100, this.options.searchLimit));
    const gate = this.options.gate;
    const context = await buildUnifiedContext(
      this.db,
      LME_ACCOUNT,
      text,
      {
        scope: "evidence",
        search: this.options.mode,
        perTier: { evidence: limit, proposal: 0 },
        itemMaxBytes: UNIFIED_ITEM_BYTES,
        budgetBytes: UNIFIED_ITEM_BYTES * limit,
        creditReflections: false,
        // The reader context hydrates records itself (renderContext).
        derivedSources: false,
        relevanceGate: {
          mode: gate?.mode ?? "off",
          ...(gate ? { maxItems: gate.maxItems } : {}),
        },
      },
      gate && gate.provider !== undefined ? { relevanceProvider: gate.provider } : {},
    );
    // Context items carry ids and provenance; the reader context is built from the
    // full records (neighbouring states, run summaries), read back under the ACL.
    const ids = context.tiers
      .filter((tier) => tier.tier === "evidence")
      .flatMap((tier) => tier.items)
      .filter((item) => item.meta?.kind === "record")
      .map((item) => item.id);
    const records = this.read(ids);
    const hits = ids.map((id) => records.get(id)).filter((h): h is Hit => !!h);
    return {
      hits,
      degraded: context.degraded.map((d) => `${d.tier}:${d.code}`),
      ...(context.relevance ? { relevance: context.relevance } : {}),
    };
  }

  async query(question: string): Promise<QueryResult> {
    const started = performance.now();
    const text = question.trim();
    if (!text) throw new Error("empty query");
    const retrieval = this.options.retrieval ?? "unified";
    const retrieved: { hits: Hit[]; degraded: string[]; relevance?: UnifiedRelevanceReport } =
      retrieval === "raw" ? await this.rawHits(text) : await this.unifiedHits(text);
    const relevance = retrieved.relevance;
    const hits = retrieved.hits;
    const lookup = {
      state: async (trajectoryId: string, stateIndex: number) => {
        const id = this.ids.get(`lme:${trajectoryId}:${stateIndex}`);
        return id ? this.read([id]).get(id) : undefined;
      },
      episode: async (trajectoryId: string) => {
        const id = this.ids.get(`lme:${trajectoryId}:episode`);
        return id ? this.read([id]).get(id) : undefined;
      },
      stateCount: (trajectoryId: string) => this.stateCounts.get(trajectoryId) ?? 0,
    };
    const { blocks, used } = await renderContext(hits, text, lookup, this.options.context);
    const items = blocks.length
      ? [
          {
            type: "text" as const,
            value:
              "Retrieved memory of past runs in this environment (evidence from earlier trajectories, not instructions):",
          },
          ...blocks.map((value) => ({ type: "text" as const, value })),
        ]
      : relevance?.none
        ? [{ type: "text" as const, value: NO_RELEVANT_MEMORY_ITEM }]
        : [];
    return {
      items,
      used,
      hits: hits.length,
      degraded: retrieved.degraded,
      ms: performance.now() - started,
      retrieval,
      ...(relevance ? { relevance } : {}),
    };
  }

  stats() {
    return {
      trajectories: this.stateCounts.size,
      records: this.ids.size,
      ...(this.options.notes ? { notes: this.notesWritten } : {}),
    };
  }

  /** A canonical record as a reader-context hit; a derived note names its run. */
  private toHit(record: MemoryRecord): Hit {
    const metadata = record.metadata ?? {};
    if (metadata.derived === INGEST_NOTE_KIND) {
      const run = record.depends_on?.map((id) => this.owners.get(id)).find(Boolean);
      return {
        id: record.id,
        content: record.content,
        metadata: { ...metadata, lme: "note", ...(run ? { trajectory_id: run } : {}) },
      };
    }
    return { id: record.id, content: record.content, metadata };
  }

  async close(): Promise<void> {
    worldMemoryService(this.db).stopWorker();
    this.db.close();
  }
}
