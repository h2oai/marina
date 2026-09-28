// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { hasCorrelationTag } from "../sdk/client";
import type { Perception } from "../sdk/protocol";

export interface OutstandingRequest {
  id: string;
  text: string;
  kind: "tell" | "channel" | "say";
  target: string;
  correlation?: string;
  modelRequestId?: string;
  presented: boolean;
}

export interface RequestLedger {
  version: 1;
  requests: OutstandingRequest[];
}

/** An absent ledger is a pre-upgrade checkpoint; malformed state must not erase obligations. */
export function readRequestLedger(value: unknown): OutstandingRequest[] {
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
        (r.modelRequestId !== undefined && typeof r.modelRequestId !== "string"),
    )
  )
    throw new Error("Invalid outstanding-request checkpoint; cannot safely resume replies");
  return ledger.requests.map((r) => ({ ...r }));
}

export function updateRequestLedger(
  previous: unknown,
  added: OutstandingRequest[] = [],
  completed: readonly string[] = [],
): RequestLedger {
  const requests = new Map(readRequestLedger(previous).map((r) => [r.id, r]));
  for (const request of added) if (!requests.has(request.id)) requests.set(request.id, request);
  for (const id of completed) requests.delete(id);
  return { version: 1, requests: [...requests.values()] };
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

/** Response obligations survive prompt consumption, observations, failures and run yields. */
export class OutstandingRequests {
  private requests = new Map<string, OutstandingRequest>();
  private session = crypto.randomUUID();

  get size(): number {
    return this.requests.size;
  }
  clear(): void {
    this.requests.clear();
  }
  entries(): OutstandingRequest[] {
    return [...this.requests.values()];
  }
  restore(value: unknown): void {
    // The replacement model must actually see a request before a reply can settle it.
    const restored = readRequestLedger(value).map(
      (r) => [r.id, { ...r, presented: false }] as const,
    );
    this.requests = new Map([...restored, ...this.requests]);
  }
  completedIds(details: unknown, eligible: ReadonlySet<string>): string[] {
    const copy = new OutstandingRequests();
    copy.requests = new Map(this.requests);
    copy.settle(details, eligible);
    return [...this.requests.keys()].filter((id) => !copy.requests.has(id));
  }
  complete(ids: readonly string[]): void {
    for (const id of ids) this.requests.delete(id);
  }
  presentedIds(): Set<string> {
    return new Set(
      this.entries()
        .filter((request) => request.presented)
        .map((request) => request.id),
    );
  }

  add(p: Perception, sequence: number, text: string): string | undefined {
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
    if (!this.requests.has(id))
      this.requests.set(id, {
        id,
        kind,
        target,
        text: clean,
        modelRequestId,
        correlation: /\[re:([a-z0-9]+)\]/i.exec(message)?.[1],
        presented: false,
      });
    return id;
  }

  present(id: string): void {
    const request = this.requests.get(id);
    if (request) request.presented = true;
  }

  /** Only server delivery receipts from a durably journaled successful tool can settle work. */
  settle(details: unknown, eligible: ReadonlySet<string>): void {
    if (!details || typeof details !== "object") return;
    const deliveries = (details as { deliveries?: unknown }).deliveries;
    if (!Array.isArray(deliveries)) return;
    for (const receipt of deliveries) {
      if (!receipt || typeof receipt.message !== "string" || typeof receipt.target !== "string")
        continue;
      const candidates = this.entries().filter(
        (request) =>
          eligible.has(request.id) &&
          request.kind === receipt.kind &&
          (request.kind === "say" || request.target.toLowerCase() === receipt.target.toLowerCase()),
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
