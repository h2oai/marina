// ─── Resolver primitive ─────────────────────────────────────────────────────
//
// A resolver evaluates a question about external state and returns a typed
// Sample. Resolvers are pure — they read from the world (HTTP, DB), classify
// the result, and return. They never mutate engine state, never emit events,
// never call commands. The sample-writer handles persistence + feed events.
//
// Five callers converge on the same resolve(): the in-world `probe` command,
// the watching role on its tick, the MCP `probe` tool, the HTTP /api/probe
// route, and other resolvers via ctx.probe(kind, args) for composition. This
// is the integration surface — agents, external scripts, and the watcher all
// use the same primitive.

import type { MarinaDB } from "../persistence/database";

// ─── Sample (resolver output, persisted as a note) ──────────────────────────

export type SampleStatus =
  | "resolved" // closure-relevant: a binary/categorical event has settled
  | "changed" // value differs from previousSample (time-series tick)
  | "no-change" // nothing observably new since previousSample
  | "error"; // resolver failed (network, parse, auth) — retry-eligible

export type Sample = {
  kind: string; // resolver kind (gerund: resolving / sampling / monitoring / tracing / verifying)
  id: string; // canonical id from resolver.idFromArgs(args)
  ts: number; // observation time, unix ms
  status: SampleStatus;
  value?: unknown; // present for resolved / changed
  source: string; // URL or stable identifier of the observed source
  rawHash?: string; // sha256 of raw response — dedup + cache key
  reason?: string; // present for status=error
};

// ─── Resolver context (slim by design) ──────────────────────────────────────

export type ResolverContext = {
  db: MarinaDB;
  // Resolvers import clients (kalshi-client, polymarket-client) and SSRF-
  // guarded fetch (validateFetchUrl) directly. We deliberately do not pass
  // engine, perceptions, or commands — resolvers are pure.
};

export type ResolverInput<A = unknown> = {
  args: A;
  previousSample?: Sample; // last sample for this (kind, id) — enables change detection
  ctx: ResolverContext;
};

export type ResolverOutput =
  | { status: "resolved"; value: unknown; source: string; rawHash?: string }
  | { status: "changed"; value: unknown; source: string; rawHash?: string }
  | { status: "no-change"; source: string }
  | { status: "error"; reason: string; retryAfter?: number };

// ─── Argument parsing (no runtime dep — keep it simple) ─────────────────────

/**
 * Result of an argument parse. On success, args is the typed argument shape
 * the resolver expects. On failure, error is a human-readable reason.
 */
export type ArgParseResult<A> = { ok: true; args: A } | { ok: false; error: string };

// ─── Resolver definition ────────────────────────────────────────────────────

export interface Resolver<A = unknown> {
  /** Kind discriminator — single-word gerund. Voice-friendly per the
   *  natural-language-identifiers convention (no hyphens, no underscores). */
  kind: string;

  /** One-line description for `probe --help` / MCP tool listing. */
  description: string;

  /** Validate raw key:value args from the caller into the typed shape.
   *  Hand-rolled (no zod dep) — each resolver coerces and bounds-checks. */
  parseArgs(raw: Record<string, string>): ArgParseResult<A>;

  /** Canonical, stable id for the watched thing. Used as Sample.id and as
   *  the dedup key for the watch spec note. Must be deterministic from args. */
  idFromArgs(args: A): string;

  /** Which statuses retire a watch with retirement=resolved. Most kinds
   *  close on "resolved"; sampling kinds close on nothing (forever). */
  closesOn: SampleStatus[];

  /** The resolver itself. Never throws — return status:error instead. */
  resolve(input: ResolverInput<A>): Promise<ResolverOutput>;
}
