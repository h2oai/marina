// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  InvestigationAccess,
  InvestigationAttempt,
  InvestigationCase,
  InvestigationContent,
  InvestigationEventPage,
  InvestigationRequest,
  InvestigationSnapshot,
} from "./investigation-types";

export type * from "./investigation-types";

export class InvestigationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface InvestigationClientOptions {
  url: string;
  /** Authenticated Marina session, never a provider credential. */
  token: string | (() => string);
  fetch?: typeof fetch;
}

/** Reads and replay never dispatch work. Starting/retrying always needs an explicit request key. */
export class MarinaInvestigationClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: InvestigationClientOptions) {
    const url = new URL(options.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Investigation URL must be an HTTP(S) base URL without credentials, query or fragment",
      );
    this.base = options.url.replace(/\/$/, "");
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
  }
  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const token =
      typeof this.options.token === "function" ? this.options.token() : this.options.token;
    const response = await this.fetcher(`${this.base}/api/investigations${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: `HTTP ${response.status}` }))) as {
        code?: string;
        error?: string;
      };
      throw new InvestigationApiError(
        response.status,
        error.code ?? "http_error",
        error.error ?? `HTTP ${response.status}`,
      );
    }
    return response.json() as Promise<T>;
  }
  start(request: InvestigationRequest, idempotencyKey: string, signal?: AbortSignal) {
    return this.request<{ attempt: InvestigationAttempt; created: boolean }>(
      "",
      "POST",
      { ...request, idempotencyKey },
      signal,
    );
  }
  list(before?: number, signal?: AbortSignal) {
    return this.request<{ cases: InvestigationCase[] }>(
      before === undefined ? "" : `?before=${before}`,
      "GET",
      undefined,
      signal,
    );
  }
  get(caseId: string, attemptId?: string, signal?: AbortSignal) {
    return this.request<InvestigationSnapshot>(
      `/${encodeURIComponent(caseId)}${attemptId ? `?attempt=${encodeURIComponent(attemptId)}` : ""}`,
      "GET",
      undefined,
      signal,
    );
  }
  attempt(id: string, signal?: AbortSignal) {
    return this.request<InvestigationAttempt>(
      `/attempts/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      signal,
    );
  }
  events(id: string, after = 0, signal?: AbortSignal) {
    return this.request<InvestigationEventPage>(
      `/attempts/${encodeURIComponent(id)}/events?after=${after}`,
      "GET",
      undefined,
      signal,
    );
  }
  content(id: string, signal?: AbortSignal) {
    return this.request<InvestigationContent>(
      `/content/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      signal,
    );
  }
  cancel(id: string, signal?: AbortSignal) {
    return this.request<{ cancelled: string[] }>(
      `/attempts/${encodeURIComponent(id)}/cancel`,
      "POST",
      {},
      signal,
    );
  }
  select(id: string, signal?: AbortSignal) {
    return this.request<InvestigationSnapshot>(
      `/attempts/${encodeURIComponent(id)}/select`,
      "POST",
      {},
      signal,
    );
  }
  grant(caseId: string, name: string, access: InvestigationAccess | null, signal?: AbortSignal) {
    return this.request<{ name: string; access: InvestigationAccess | null }>(
      `/${encodeURIComponent(caseId)}/grants`,
      "POST",
      { name, access },
      signal,
    );
  }
  erase(caseId: string, signal?: AbortSignal) {
    return this.request<{ erased: boolean }>(
      `/${encodeURIComponent(caseId)}`,
      "DELETE",
      undefined,
      signal,
    );
  }
  review(id: string, text: string, signal?: AbortSignal) {
    return this.request<import("./investigation-types").InvestigationEvent>(
      `/attempts/${encodeURIComponent(id)}/review`,
      "POST",
      { text },
      signal,
    );
  }
  resolve(id: string, value: unknown, signal?: AbortSignal) {
    return this.request<{ answerId: number; loss: number | null }>(
      `/attempts/${encodeURIComponent(id)}/resolve`,
      "POST",
      { value },
      signal,
    );
  }
}
