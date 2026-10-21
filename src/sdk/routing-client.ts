// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  ResidentAttentionReport,
  ResidentCredential,
  ResidentEnrolInput,
  ResidentEnrolment,
  RoutingSyncInput,
  RoutingSyncResult,
  RuntimeControl,
  RuntimeState,
} from "./routing-runtime-types";
import type {
  RoutingChannelPage,
  RoutingChannelReceipt,
  RoutingEvent,
  RoutingEventInput,
  RoutingEventPage,
  RoutingJoin,
  RoutingMessage,
  RoutingOverview,
  RoutingSend,
  RoutingSession,
  RoutingSessionPage,
} from "./routing-types";

export type * from "./routing-runtime-types";
export type * from "./routing-types";

export class RoutingApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** A routing-only supervision credential (supervised residents). */
export interface SupervisionCredentialGrant {
  credentialId: string;
  token: string;
  expiresAt: number;
}
export interface RoutingClientOptions {
  url: string;
  /** Existing Marina world-account credential; never placed in the URL. */
  token: string | (() => string);
  fetch?: typeof fetch;
}

/** Generic HTTP client. It neither launches a process nor executes received messages. */
export class MarinaRoutingClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: RoutingClientOptions) {
    const url = new URL(options.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Routing URL must be an HTTP(S) base URL without credentials, query or fragment",
      );
    }
    this.base = options.url.replace(/\/$/, "");
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
  }
  private async request<T>(path: string, value?: unknown, signal?: AbortSignal): Promise<T> {
    const token =
      typeof this.options.token === "function" ? this.options.token() : this.options.token;
    const response = await this.fetcher(`${this.base}/api/routing${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: `HTTP ${response.status}` }))) as {
        code?: string;
        error?: string;
      };
      throw new RoutingApiError(
        response.status,
        error.code ?? "http_error",
        error.error ?? `HTTP ${response.status}`,
      );
    }
    return response.json() as Promise<T>;
  }
  join(input: RoutingJoin, signal?: AbortSignal) {
    return this.request<RoutingSession>("/sessions", input, signal);
  }
  discover(after = "", limit = 100, signal?: AbortSignal) {
    return this.request<RoutingSessionPage>(
      `/sessions?after=${encodeURIComponent(after)}&limit=${limit}`,
      undefined,
      signal,
    );
  }
  overview(after = "", attention = false, signal?: AbortSignal) {
    return this.request<RoutingOverview>(
      `/overview?after=${encodeURIComponent(after)}&limit=100&attention=${attention}`,
      undefined,
      signal,
    );
  }
  session(id: string, signal?: AbortSignal) {
    return this.request<RoutingSession>(this.path(id), undefined, signal);
  }
  heartbeat(id: string, signal?: AbortSignal) {
    return this.request<RoutingSession>(`${this.path(id)}/heartbeat`, {}, signal);
  }
  leave(id: string, signal?: AbortSignal) {
    return this.request<RoutingSession>(`${this.path(id)}/leave`, {}, signal);
  }
  async publish(
    id: string,
    events: RoutingEventInput[],
    signal?: AbortSignal,
  ): Promise<RoutingEvent[]> {
    return (
      await this.request<{ events: RoutingEvent[] }>(`${this.path(id)}/events`, { events }, signal)
    ).events;
  }
  events(id: string, after = 0, limit = 100, signal?: AbortSignal) {
    return this.request<RoutingEventPage>(
      `${this.path(id)}/events?after=${after}&limit=${limit}`,
      undefined,
      signal,
    );
  }
  send(id: string, input: RoutingSend, signal?: AbortSignal) {
    return this.request<RoutingMessage>(`${this.path(id)}/messages`, input, signal);
  }
  async inbox(id: string, limit = 100, signal?: AbortSignal) {
    return (
      await this.request<{ messages: RoutingMessage[] }>(
        `${this.path(id)}/inbox?limit=${limit}`,
        undefined,
        signal,
      )
    ).messages;
  }
  async deliveries(id: string, limit = 100, signal?: AbortSignal) {
    return (
      await this.request<{ messages: RoutingMessage[] }>(
        `${this.path(id)}/deliveries?limit=${limit}`,
        undefined,
        signal,
      )
    ).messages;
  }
  receipt(id: string, messageId: string, signal?: AbortSignal) {
    return this.request<RoutingMessage>(
      `${this.path(id)}/messages/${encodeURIComponent(messageId)}`,
      undefined,
      signal,
    );
  }
  acknowledge(id: string, messageId: string, signal?: AbortSignal) {
    return this.request<RoutingMessage>(
      `${this.path(id)}/messages/${encodeURIComponent(messageId)}/ack`,
      {},
      signal,
    );
  }
  channels(id: string, signal?: AbortSignal) {
    return this.request<{ channels: { id: string; name: string }[] }>(
      `${this.path(id)}/channels`,
      undefined,
      signal,
    );
  }
  channelMessages(id: string, channelId: string, after = 0, limit = 100, signal?: AbortSignal) {
    return this.request<RoutingChannelPage>(
      `${this.path(id)}/channels/${encodeURIComponent(channelId)}/messages?after=${after}&limit=${limit}`,
      undefined,
      signal,
    );
  }
  sendChannel(
    id: string,
    channelId: string,
    input: { clientMessageId: string; text: string },
    signal?: AbortSignal,
  ) {
    return this.request<RoutingChannelReceipt>(
      `${this.path(id)}/channels/${encodeURIComponent(channelId)}/messages`,
      input,
      signal,
    );
  }
  sync(input: RoutingSyncInput, signal?: AbortSignal) {
    return this.request<RoutingSyncResult>("/sync", input, signal);
  }
  runtime(id: string, signal?: AbortSignal) {
    return this.request<{ state: RuntimeState | null }>(
      `${this.path(id)}/runtime`,
      undefined,
      signal,
    );
  }
  control(
    sourceId: string,
    targetId: string,
    clientMessageId: string,
    control: RuntimeControl,
    signal?: AbortSignal,
  ) {
    return this.request<RoutingMessage>(
      `${this.path(sourceId)}/control`,
      { targetId, clientMessageId, control },
      signal,
    );
  }
  /** Enrol a run's agent as its own world account (servers with supervised residents on). */
  enrolResident(input: ResidentEnrolInput, signal?: AbortSignal) {
    return this.request<ResidentEnrolment>("/residents", input, signal);
  }
  /** A fresh credential for a live owned run; the previous one stops working. */
  renewResident(name: string, sessionId: string, signal?: AbortSignal) {
    return this.request<{ name: string; credential: ResidentCredential }>(
      `/residents/${encodeURIComponent(name)}/renew`,
      { sessionId },
      signal,
    );
  }
  /**
   * Exchange this client's world session for a supervision credential: the
   * routing API only, never replaced by a later login of the same person.
   */
  issueSupervision(signal?: AbortSignal) {
    return this.request<SupervisionCredentialGrant>("/supervision", {}, signal);
  }
  /** Replace the presented supervision credential with a fresh one. */
  renewSupervision(signal?: AbortSignal) {
    return this.request<SupervisionCredentialGrant>("/supervision/renew", {}, signal);
  }
  /** Revoke the presented supervision credential. */
  revokeSupervision(signal?: AbortSignal) {
    return this.request<{ revoked: boolean }>("/supervision/revoke", {}, signal);
  }
  /** End this run's hold on the resident: credentials and session tokens are revoked. */
  revokeResident(name: string, sessionId: string, signal?: AbortSignal) {
    return this.request<{ name: string; revoked: number }>(
      `/residents/${encodeURIComponent(name)}/revoke`,
      { sessionId },
      signal,
    );
  }
  /** Report the run's attention-bridge decisions and the resident's presence. */
  reportResidentAttention(name: string, report: ResidentAttentionReport, signal?: AbortSignal) {
    return this.request<{ name: string; recorded: number }>(
      `/residents/${encodeURIComponent(name)}/attention`,
      report,
      signal,
    );
  }
  private path(id: string) {
    return `/sessions/${encodeURIComponent(id)}`;
  }

  /** Resumable polling subscription. Persist nextCursor after processing each page.
   * Errors surface to the consumer; retry with its last saved cursor. No hidden ack/retries.
   */
  async *watch(
    id: string,
    options: { after?: number; intervalMs?: number; signal: AbortSignal },
  ): AsyncGenerator<RoutingEventPage> {
    let after = options.after ?? 0;
    const interval = options.intervalMs ?? 2000;
    if (!Number.isFinite(interval) || interval < 1000)
      throw new Error("Poll interval must be at least 1000 ms");
    while (!options.signal.aborted) {
      const page = await this.events(id, after, 100, options.signal);
      if (page.events.length || page.gap) yield page;
      after = page.nextCursor;
      if (!page.hasMore)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            options.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, interval);
          options.signal.addEventListener("abort", done, { once: true });
          if (options.signal.aborted) done();
        });
    }
  }
}
