// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { sameResidentName } from "../engine/entity-name";
import { hasCorrelationTag } from "../sdk/client";
import type { Perception } from "../sdk/protocol";

export interface OutstandingRequest {
  id: string;
  text: string;
  kind: "tell" | "channel" | "say";
  target: string;
  /** Who asked (a channel ask's `target` is the channel). A tell to the
   *  speaker settles the ask on any surface. */
  speaker?: string;
  correlation?: string;
  modelRequestId?: string;
  presented: boolean;
  /**
   * Epoch ms when the request was first recorded. Persisted in the checkpoint
   * ledger so the TTL runs from the original intake, not from a restore.
   */
  recordedAt: number;
}

/**
 * How long an unsettled reply obligation keeps forcing the fast tick, the
 * "Reply still owed" section and the ACTION REQUIRED nudges. A request no
 * delivery can settle (the peer left, the id is unmatchable) must not pin an
 * agent to its fastest cadence forever.
 */
export const OUTSTANDING_REQUEST_TTL_MS = 30 * 60_000;

/** Most reply obligations tracked at once; the oldest are evicted first. */
export const MAX_OUTSTANDING_REQUESTS = 32;

export interface RequestLimits {
  ttlMs?: number;
  maxRequests?: number;
}

/**
 * Drop expired requests, then keep at most `maxRequests`, evicting the
 * oldest first. Returns the kept list plus what was dropped and why.
 */
export function limitRequests(
  requests: readonly OutstandingRequest[],
  now = Date.now(),
  limits: RequestLimits = {},
): {
  kept: OutstandingRequest[];
  dropped: Array<{ request: OutstandingRequest; reason: "expired" | "evicted" }>;
} {
  const ttlMs = limits.ttlMs ?? OUTSTANDING_REQUEST_TTL_MS;
  const maxRequests = limits.maxRequests ?? MAX_OUTSTANDING_REQUESTS;
  const dropped: Array<{ request: OutstandingRequest; reason: "expired" | "evicted" }> = [];
  const live: OutstandingRequest[] = [];
  for (const request of requests) {
    if (now - request.recordedAt >= ttlMs) dropped.push({ request, reason: "expired" });
    else live.push(request);
  }
  if (live.length <= maxRequests) return { kept: live, dropped };
  // Stable sort: equal timestamps keep their insertion order.
  const byAge = [...live].sort((a, b) => a.recordedAt - b.recordedAt);
  const evicted = new Set(byAge.slice(0, live.length - maxRequests).map((r) => r.id));
  for (const request of live)
    if (evicted.has(request.id)) dropped.push({ request, reason: "evicted" });
  return { kept: live.filter((r) => !evicted.has(r.id)), dropped };
}

export interface RequestLedger {
  version: 1;
  requests: OutstandingRequest[];
}

/**
 * An absent ledger is a pre-upgrade checkpoint; malformed state must not erase
 * obligations. An entry written before `recordedAt` existed starts its TTL at
 * `now` (the first read after the upgrade), and keeps that stamp once rewritten.
 */
export function readRequestLedger(value: unknown, now = Date.now()): OutstandingRequest[] {
  if (value === undefined) return [];
  const ledger = value as RequestLedger | null;
  if (
    ledger?.version !== 1 ||
    !Array.isArray(ledger.requests) ||
    ledger.requests.some(
      (r) =>
        !r ||
        typeof r.id !== "string" ||
        !r.id ||
        typeof r.text !== "string" ||
        typeof r.target !== "string" ||
        !["tell", "channel", "say"].includes(r.kind) ||
        (r.correlation !== undefined && typeof r.correlation !== "string") ||
        (r.speaker !== undefined && typeof r.speaker !== "string") ||
        (r.modelRequestId !== undefined && typeof r.modelRequestId !== "string") ||
        (r.recordedAt !== undefined &&
          (typeof r.recordedAt !== "number" || !Number.isFinite(r.recordedAt))),
    )
  )
    throw new Error("Invalid outstanding-request checkpoint; cannot safely resume replies");
  return ledger.requests.map((r) => ({ ...r, recordedAt: r.recordedAt ?? now }));
}

/** Merge a ledger update; expired and over-cap obligations are pruned on every write. */
export function updateRequestLedger(
  previous: unknown,
  added: OutstandingRequest[] = [],
  completed: readonly string[] = [],
  now = Date.now(),
): RequestLedger {
  const requests = new Map(readRequestLedger(previous, now).map((r) => [r.id, r]));
  for (const request of added)
    if (!requests.has(request.id))
      requests.set(request.id, { ...request, recordedAt: request.recordedAt ?? now });
  for (const id of completed) requests.delete(id);
  return { version: 1, requests: limitRequests([...requests.values()], now).kept };
}

function jsonEnvelope(text: string, allowPrefix = false): Record<string, unknown> | undefined {
  const start = allowPrefix ? text.indexOf("{") : 0;
  if (start < 0) return;
  try {
    const value = JSON.parse(text.slice(start));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The endpoint envelope a perception carries (`model_request`, `model_response`, …). */
export interface ModelEnvelope {
  type: string;
  id: string;
  /** The one member a `model_request` is addressed to (an entity id, or a name). */
  target?: string;
}

/**
 * The `model_*` envelope in a perception's message, when it has one with an
 * id. Endpoint requests arrive as plain channel messages, so the shape is
 * read from the content (an optional display prefix before the JSON is allowed).
 */
export function modelEnvelopeOf(p: Perception): ModelEnvelope | undefined {
  const raw = p.data?.message ?? p.data?.content;
  if (typeof raw !== "string" || !raw.includes('"type":"model_')) return undefined;
  const envelope = jsonEnvelope(raw, true);
  if (typeof envelope?.type !== "string" || !envelope.type.startsWith("model_")) return undefined;
  if (typeof envelope.id !== "string" || !envelope.id) return undefined;
  const target = typeof envelope.target === "string" ? envelope.target.trim() : "";
  return { type: envelope.type, id: envelope.id, ...(target ? { target } : {}) };
}

/**
 * A measurement request: a `model_request` envelope carrying the `eval`
 * marker the model API adds for `x-marina-eval` traffic (`evalEnvelope` in
 * `src/net/model-api/routing.ts`). Its turn is quarantined from memory.
 */
export function isEvalModelRequest(p: Perception): boolean {
  const raw = p.data?.message ?? p.data?.content;
  if (typeof raw !== "string" || !raw.includes('"type":"model_request"')) return false;
  const envelope = jsonEnvelope(raw, true);
  const marker = envelope?.eval as { benchmark?: unknown } | undefined;
  return (
    envelope?.type === "model_request" &&
    !!marker &&
    typeof marker === "object" &&
    typeof marker.benchmark === "string"
  );
}

/** Text a measurement request is stored under in the durable ledger (never its content). */
export function withheldEvalRequestText(request: OutstandingRequest): string {
  return `model_request ${request.modelRequestId ?? request.id} (measurement content withheld from memory)`;
}

/** Response obligations survive prompt consumption, observations, failures and run yields. */
export interface OutstandingRequestsOptions extends RequestLimits {
  /** Clock (tests inject one). */
  now?: () => number;
  /** Told once per request the TTL or the size cap removed. */
  onDrop?: (request: OutstandingRequest, reason: "expired" | "evicted") => void;
}

export class OutstandingRequests {
  private requests = new Map<string, OutstandingRequest>();
  private session = crypto.randomUUID();
  private readonly now: () => number;

  constructor(private readonly options: OutstandingRequestsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Expired or over-cap requests stop counting the moment they lapse. */
  private prune(): void {
    if (!this.requests.size) return;
    const { kept, dropped } = limitRequests([...this.requests.values()], this.now(), this.options);
    if (!dropped.length) return;
    this.requests = new Map(kept.map((r) => [r.id, r]));
    for (const { request, reason } of dropped) this.options.onDrop?.(request, reason);
  }

  get size(): number {
    this.prune();
    return this.requests.size;
  }
  clear(): void {
    this.requests.clear();
  }
  entries(): OutstandingRequest[] {
    this.prune();
    return [...this.requests.values()];
  }
  restore(value: unknown): void {
    // The replacement model must actually see a request before a reply can settle it.
    // The original `recordedAt` is kept, so the TTL does not restart on a restore.
    const restored = readRequestLedger(value, this.now()).map(
      (r) => [r.id, { ...r, presented: false }] as const,
    );
    this.requests = new Map([...restored, ...this.requests]);
    this.prune();
  }
  completedIds(details: unknown, eligible: ReadonlySet<string>): string[] {
    const copy = new OutstandingRequests({ ...this.options, now: this.now, onDrop: undefined });
    copy.requests = new Map(this.requests);
    copy.settle(details, eligible);
    return [...this.requests.keys()].filter((id) => !copy.requests.has(id));
  }
  complete(ids: readonly string[]): void {
    for (const id of ids) this.requests.delete(id);
  }
  /** The endpoint request ids (`model_request` ids) this ledger still owes a reply to. */
  modelRequestIds(): Set<string> {
    const ids = new Set<string>();
    for (const request of this.entries())
      if (request.modelRequestId) ids.add(request.modelRequestId);
    return ids;
  }
  /** The ledger ids that track the endpoint request `modelRequestId`. */
  idsForModelRequest(modelRequestId: string): string[] {
    return this.entries()
      .filter((request) => request.modelRequestId === modelRequestId)
      .map((request) => request.id);
  }
  /**
   * The ledger ids of the conversational replies owed to `peer` (a tell or
   * say asked by them; endpoint requests excluded), matched by normalised
   * resident name.
   */
  idsForPeer(peer: string): string[] {
    return this.entries()
      .filter(
        (request) =>
          !request.modelRequestId &&
          request.kind !== "channel" &&
          sameResidentName(request.speaker ?? request.target, peer),
      )
      .map((request) => request.id);
  }
  presentedIds(): Set<string> {
    return new Set(
      this.entries()
        .filter((request) => request.presented)
        .map((request) => request.id),
    );
  }

  add(p: Perception, sequence: number, text: string): string | undefined {
    return this.track(p, sequence, text)?.id;
  }

  /**
   * {@link add}, also reporting whether the request is newly tracked. A
   * repeated delivery of a tracked id is not new; with the cap full, a new
   * request still is (the oldest was evicted), even though `size` is unchanged.
   */
  track(p: Perception, sequence: number, text: string): { id: string; isNew: boolean } | undefined {
    if (p.data.untrusted || p.command_request_id || p.data.delivery) return;
    const clean = Bun.stripANSI(text);
    const message = String(p.data.message ?? p.data.content ?? clean);
    const channel = typeof p.data.channel === "string" ? p.data.channel : undefined;
    const envelope = jsonEnvelope(message, true);
    if (typeof envelope?.type === "string" && envelope.type.startsWith("model_response")) return;
    const tell = clean.match(/(?:^|>\s*)(\S+) tells you:/);
    const speaker =
      typeof p.data.senderName === "string"
        ? p.data.senderName
        : (tell?.[1] ?? clean.match(/^(\S+) says:/)?.[1]);
    const asker = speaker ?? (typeof p.data.from === "string" ? p.data.from : undefined);
    const kind = channel ? "channel" : tell || p.tag === "tell" || p.data.to ? "tell" : "say";
    const target = channel ?? speaker;
    if (!target) return;
    const modelRequestId =
      envelope?.type === "model_request" && typeof envelope.id === "string"
        ? envelope.id
        : undefined;
    const id = modelRequestId
      ? `model:${channel}:${modelRequestId}`
      : p.data.messageId
        ? `tell:${p.data.messageId}`
        : `event:${this.session}:${sequence}`;
    this.prune();
    if (this.requests.has(id)) return { id, isNew: false };
    this.requests.set(id, {
      id,
      kind,
      target,
      text: clean,
      ...(asker ? { speaker: asker } : {}),
      modelRequestId,
      correlation: /\[re:([a-z0-9]+)\]/i.exec(message)?.[1],
      presented: false,
      recordedAt: this.now(),
    });
    this.prune();
    // Evicted on arrival (the cap is full of newer work): nothing to track.
    return this.requests.has(id) ? { id, isNew: true } : undefined;
  }

  present(id: string): void {
    const request = this.requests.get(id);
    if (request) request.presented = true;
  }

  /** Only server delivery receipts from a durably journaled successful tool can settle work.
   *  A delivery to the asker settles: the same surface, or a tell to the speaker. */
  settle(details: unknown, eligible: ReadonlySet<string>): void {
    if (!details || typeof details !== "object") return;
    const deliveries = (details as { deliveries?: unknown }).deliveries;
    if (!Array.isArray(deliveries)) return;
    for (const receipt of deliveries) {
      if (!receipt || typeof receipt.message !== "string" || typeof receipt.target !== "string")
        continue;
      const target = receipt.target.toLowerCase();
      // Same surface (the channel, the room, a tell to the asker) — or, for a
      // conversational ask, ANY tell to the person who asked: answering a
      // channel question privately still answers it.
      const candidates = this.entries().filter(
        (request) =>
          eligible.has(request.id) &&
          ((request.kind === receipt.kind &&
            (request.kind === "say" || request.target.toLowerCase() === target)) ||
            (receipt.kind === "tell" &&
              !request.modelRequestId &&
              (request.speaker ?? request.target).toLowerCase() === target)),
      );
      const envelope = jsonEnvelope(receipt.message);
      const matched = candidates.find((request) => {
        if (request.modelRequestId)
          return (
            (envelope?.type === "model_response" || envelope?.type === "model_response_end") &&
            envelope.id === request.modelRequestId
          );
        if (request.correlation) return hasCorrelationTag(receipt.message, request.correlation);
        // Untagged conversations settle oldest-first, one request per receipt.
        return true;
      });
      if (matched) this.requests.delete(matched.id);
    }
  }
}
