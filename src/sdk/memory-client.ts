// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memoryRetryDelay, withMemoryAbort } from "./memory-abort";
import type {
  MemoryGraphAction,
  MemoryGraphInputs,
  MemoryGraphResults,
} from "./memory-knowledge-graph";
import type {
  MemoryTransferFilter,
  MemoryTransferHeader,
  MemoryTransferList,
  MemoryTransferPage,
  MemoryTransferStatus,
} from "./memory-transfer";
import type {
  ForgetMemoryInput,
  MemoryAdoptInput,
  MemoryAdoptResult,
  MemoryBundle,
  MemoryCacheInput,
  MemoryCacheResult,
  MemoryCacheWrite,
  MemoryCheckpoint,
  MemoryFederatedRead,
  MemoryFederatedResult,
  MemoryFederatedSearch,
  MemoryGraphQuery,
  MemoryGraphResult,
  MemoryJobStatus,
  MemoryPlan,
  MemoryPlanResult,
  MemoryPlanStep,
  MemoryQuery,
  MemoryQueryResult,
  MemoryReceipt,
  MemoryRecord,
  MemoryRecordInput,
  MemoryResolveInput,
  MemoryResolveResult,
  MemoryReviewResult,
  MemorySearchInput,
  MemorySearchResult,
  MemorySource,
  MemorySourceRange,
  MemorySourceSearch,
  MemorySourceSearchResult,
  MemorySpace,
  MemoryStorageUsage,
  MemoryVocabulary,
  MemoryVocabularyDefinition,
} from "./memory-types";

export class MemoryClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Fetch-only client. It never opens a DB, joins a world, or invokes a model. */
export class MarinaMemoryClient {
  constructor(
    readonly url: string,
    private token: string,
    private timeoutMs = 35_000,
    private fetcher: (request: Request) => Promise<Response> = fetch,
    private signal?: AbortSignal,
  ) {}
  /** A per-operation view; concurrent users of the original client are unaffected. */
  withSignal(signal: AbortSignal): MarinaMemoryClient {
    return new MarinaMemoryClient(this.url, this.token, this.timeoutMs, this.fetcher, signal);
  }
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    key: string = crypto.randomUUID(),
  ): Promise<T> {
    this.signal?.throwIfAborted();
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(this.signal ? [this.signal] : []),
    ]);
    const response = await withMemoryAbort(
      () =>
        this.fetcher(
          new Request(`${this.url.replace(/\/$/, "")}/v1/memory${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/json",
              "Idempotency-Key": key,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
            redirect: "error",
          }),
        ),
      signal,
    );
    const retryAfter = /^(\d+)(\.\d+)?$/.test(response.headers.get("Retry-After") ?? "")
      ? Number(response.headers.get("Retry-After")) * 1000
      : undefined;
    let result: T & { error?: { code: string; message: string } };
    try {
      result = await withMemoryAbort(() => response.json(), signal);
    } catch (error) {
      signal.throwIfAborted();
      // Proxies can return plain-text failures after an upstream write committed.
      // Preserve the status so explicit same-key retries can recover its receipt.
      if (!response.ok)
        throw new MemoryClientError(
          response.status,
          "request_failed",
          "Memory request failed",
          retryAfter,
        );
      if (error instanceof SyntaxError)
        throw new MemoryClientError(
          502,
          "invalid_response",
          "Memory service returned invalid JSON",
        );
      throw error;
    }
    if (!response.ok)
      throw new MemoryClientError(
        response.status,
        result?.error?.code ?? "request_failed",
        result?.error?.message ?? "Memory request failed",
        retryAfter,
      );
    return result;
  }
  private path(space: string, rest = "") {
    return `/spaces/${encodeURIComponent(space)}${rest}`;
  }
  knowledgeGraph<A extends MemoryGraphAction>(
    space: string,
    action: A,
    ...args: A extends "read_graph"
      ? [input?: MemoryGraphInputs[A], key?: string]
      : [input: MemoryGraphInputs[A], key?: string]
  ) {
    const [input = {}, key] = args;
    return this.request<MemoryGraphResults[A]>(
      this.path(space, "/knowledge_graph"),
      "POST",
      { ...input, action },
      key,
    );
  }
  review(
    space: string,
    input: {
      kind?: "all" | "stale" | "competing" | "pending";
      limit?: number;
      cursor?: string;
    } = {},
  ) {
    return this.request<MemoryReviewResult>(this.path(space, "/review"), "POST", input);
  }
  /** Adopt an answered assistance proposal as a record. `space` is the target
   * (pass `undefined` for the job's own space). Adopting into an institutional
   * space is a standing-gated ratification. Same job + same space ⇒ same record. */
  adopt(
    space: string | undefined,
    jobId: string,
    input: Omit<MemoryAdoptInput, "job_id"> = {},
    key?: string,
  ) {
    const body = { ...input, job_id: jobId };
    return space === undefined
      ? this.request<MemoryAdoptResult>(
          `/assistance/${encodeURIComponent(jobId)}/adopt`,
          "POST",
          body,
          key,
        )
      : this.request<MemoryAdoptResult>(this.path(space, "/adopt"), "POST", body, key);
  }
  /** Explicit contradiction resolution; `id` is the head record, `input.competing`
   * its rivals. Reuse `key` to replay the same decision idempotently. */
  resolve(space: string, id: string, input: MemoryResolveInput, key?: string) {
    return this.request<MemoryResolveResult>(
      this.path(space, "/resolve"),
      "POST",
      { ...input, id },
      key,
    );
  }
  reaffirm(
    space: string,
    id: string,
    expected_version: number,
    dependency_versions: Record<string, number>,
    content?: string,
    key?: string,
  ) {
    return this.request<MemoryReceipt>(
      this.path(space, "/reaffirm"),
      "POST",
      { id, expected_version, dependency_versions, content },
      key,
    );
  }
  cacheDelete(space: string, input: MemoryCacheInput, key?: string) {
    return this.request<MemoryReceipt & { removed: boolean }>(
      this.path(space, "/cache/delete"),
      "POST",
      input,
      key,
    );
  }
  cacheGet(space: string, input: MemoryCacheInput) {
    return this.request<MemoryCacheResult>(this.path(space, "/cache/get"), "POST", input);
  }
  cachePut(space: string, input: MemoryCacheWrite, key?: string) {
    return this.request<MemoryReceipt>(this.path(space, "/cache/put"), "POST", input, key);
  }
  acknowledge(space: string, keys: string[]) {
    return this.request<{ acknowledged: string[]; missing: string[] }>(
      this.path(space, "/acknowledge"),
      "POST",
      { keys },
    );
  }
  exportBundle(space: string) {
    return this.request<MemoryBundle>(this.path(space, "/bundle"));
  }
  exportTransferPage(space: string, cursor?: string) {
    return this.request<MemoryTransferPage>(
      this.path(space, `/transfer${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    );
  }
  async *exportTransferPages(space: string, cursor?: string): AsyncGenerator<MemoryTransferPage> {
    for (;;) {
      const page = await this.exportTransferPage(space, cursor);
      yield page;
      if (page.done) return;
      if (!page.next_cursor || page.next_cursor === cursor)
        throw new MemoryClientError(502, "invalid_transfer", "Export cursor did not advance");
      cursor = page.next_cursor;
    }
  }
  beginTransfer(space: string, header: MemoryTransferHeader, key?: string) {
    return this.request<MemoryTransferStatus>(this.path(space, "/transfers"), "POST", header, key);
  }
  transferStatus(space: string, id: string) {
    return this.request<MemoryTransferStatus>(
      this.path(space, `/transfers/${encodeURIComponent(id)}`),
    );
  }
  transfers(space: string, input: MemoryTransferFilter = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) params.set(key, String(value));
    return this.request<MemoryTransferList>(this.path(space, `/transfers?${params}`));
  }
  appendTransfer(space: string, id: string, page: MemoryTransferPage, key?: string) {
    return this.request<MemoryTransferStatus>(
      this.path(space, `/transfers/${encodeURIComponent(id)}/pages`),
      "POST",
      page,
      key,
    );
  }
  commitTransfer(space: string, id: string, sha256: string, key?: string) {
    return this.request<MemoryReceipt & { portable_ids_preserved: boolean }>(
      this.path(space, `/transfers/${encodeURIComponent(id)}/commit`),
      "POST",
      { sha256 },
      key,
    );
  }
  abortTransfer(space: string, id: string, key?: string) {
    return this.request<MemoryReceipt>(
      this.path(space, `/transfers/${encodeURIComponent(id)}/abort`),
      "POST",
      {},
      key,
    );
  }
  importBundle(space: string, bundle: MemoryBundle | Record<string, unknown>, key?: string) {
    return this.request<MemoryReceipt & { portable_ids_preserved: boolean }>(
      this.path(space, "/bundle"),
      "POST",
      bundle,
      key,
    );
  }
  federationMounts(space: string) {
    return this.request<{ mounts: string[] }>(this.path(space, "/federation_mounts"));
  }
  federatedSearch(space: string, input: MemoryFederatedSearch) {
    return this.request<MemoryFederatedResult>(
      this.path(space, "/federated_search"),
      "POST",
      input,
    );
  }
  federatedRead(space: string, input: MemoryFederatedRead) {
    return this.request<{
      origin: { mount: string; space_id: string; id: string };
      result: MemoryRecord | MemorySourceRange;
    }>(this.path(space, "/federated_read"), "POST", input);
  }
  me() {
    return this.request<{ principal_id: string; credential_id: string; scopes: string[] }>("/me");
  }
  usage() {
    return this.request<MemoryStorageUsage>("/usage");
  }
  capabilities() {
    return this.request<Record<string, unknown>>("");
  }
  spaces() {
    return this.request<{ spaces: MemorySpace[] }>("/spaces");
  }
  createSpace(name: string, key?: string) {
    return this.request<MemoryReceipt>("/spaces", "POST", { name }, key);
  }
  space(id: string) {
    return this.request<MemorySpace>(this.path(id));
  }
  remember(space: string, input: MemoryRecordInput, key?: string) {
    return this.request<MemoryReceipt>(this.path(space, "/records"), "POST", input, key);
  }
  get(space: string, id: string, version?: number) {
    return this.request<MemoryRecord>(
      this.path(
        space,
        `/records/${encodeURIComponent(id)}${version === undefined ? "" : `?version=${version}`}`,
      ),
    );
  }
  revise(
    space: string,
    id: string,
    expected_version: number,
    input: MemoryRecordInput,
    key?: string,
  ) {
    return this.request<MemoryReceipt>(
      this.path(space, `/records/${encodeURIComponent(id)}`),
      "PATCH",
      { ...input, expected_version },
      key,
    );
  }
  search(space: string, input: MemorySearchInput) {
    return this.request<MemorySearchResult>(this.path(space, "/search"), "POST", input);
  }
  join(space: string, input: import("./memory-symbolic").MemoryJoin) {
    return this.request<import("./memory-symbolic").MemoryJoinResult>(
      this.path(space, "/join"),
      "POST",
      input,
    );
  }
  saveRule(
    space: string,
    rule: import("./memory-symbolic").MemoryRule,
    options: { id?: string; expected_version?: number; source_ids?: string[] } = {},
    key?: string,
  ) {
    return this.request<MemoryReceipt>(
      this.path(space, "/rules"),
      "POST",
      { ...options, rule },
      key,
    );
  }
  runRule(space: string, id: string, expected_version: number, valid_at?: number) {
    return this.request<import("./memory-symbolic").MemoryRuleResult>(
      this.path(space, "/rules/run"),
      "POST",
      { id, expected_version, valid_at },
    );
  }
  materializeRule(
    space: string,
    id: string,
    expected_version: number,
    valid_at?: number,
    key?: string,
  ) {
    return this.request<MemoryReceipt & { records: MemoryReceipt[] }>(
      this.path(space, "/rules/materialize"),
      "POST",
      { id, expected_version, valid_at },
      key,
    );
  }
  query(space: string, input: MemoryQuery = {}) {
    return this.request<MemoryQueryResult>(this.path(space, "/query"), "POST", input);
  }
  graph(space: string, input: MemoryGraphQuery) {
    return this.request<MemoryGraphResult>(this.path(space, "/graph"), "POST", input);
  }
  reindex(
    space: string,
    expected_generation: number,
    key?: string,
    page: { cursor?: string; limit?: number } = {},
  ) {
    return this.request<
      MemoryReceipt & {
        model: string;
        job_ids: string[];
        examined: number;
        next_cursor: string | null;
        generation: number;
      }
    >(this.path(space, "/reindex"), "POST", { expected_generation, ...page }, key);
  }
  context(space: string, input: MemorySearchInput & { budget_tokens?: number }) {
    return this.request<{
      text: string;
      citations: { id: string; version: number; source_ids: string[]; truncated: boolean }[];
      estimated_tokens: number;
      generation: number;
      degraded: string[];
    }>(this.path(space, "/context"), "POST", input);
  }
  capture(space: string, content: unknown, session_id?: string, key?: string) {
    return this.request<MemoryReceipt>(
      this.path(space, "/sources"),
      "POST",
      { content, session_id },
      key,
    );
  }
  sources(space: string, after = 0, limit = 100) {
    return this.request<{ sources: MemorySource[]; next_cursor: number }>(
      this.path(space, `/sources?after=${after}&limit=${limit}`),
    );
  }
  sourceHeaders(space: string, after = 0, limit = 20) {
    return this.request<{ sources: Omit<MemorySource, "body">[]; next_cursor: number | null }>(
      this.path(space, `/source_headers?after=${after}&limit=${limit}`),
    );
  }
  captureBatch(
    space: string,
    items: { content: unknown; session_id?: string; key: string }[],
    key?: string,
  ) {
    return this.request<MemoryReceipt & { receipts: MemoryReceipt[] }>(
      this.path(space, "/sources/batch"),
      "POST",
      { items },
      key,
    );
  }
  sourceSearch(space: string, input: MemorySourceSearch) {
    return this.request<MemorySourceSearchResult>(
      this.path(space, "/source_search"),
      "POST",
      input,
    );
  }
  vocabulary(space: string, version?: number) {
    return this.request<MemoryVocabulary>(
      this.path(space, `/vocabulary${version === undefined ? "" : `?version=${version}`}`),
    );
  }
  plan(
    space: string,
    input: {
      task: string;
      use_model?: boolean;
      steps?: MemoryPlanStep[];
      max_results?: number;
      max_bytes?: number;
    },
  ) {
    return this.request<MemoryPlan>(this.path(space, "/plan"), "POST", input);
  }
  executePlan(space: string, plan: MemoryPlan) {
    return this.request<MemoryPlanResult>(this.path(space, "/execute_plan"), "POST", plan);
  }
  saveVocabulary(
    space: string,
    expected_version: number,
    definition: MemoryVocabularyDefinition,
    key?: string,
  ) {
    return this.request<MemoryReceipt>(
      this.path(space, "/vocabulary"),
      "POST",
      { expected_version, definition },
      key,
    );
  }
  sourceRange(
    space: string,
    id: string,
    input: { start?: number; end?: number; text_hash?: string } = {},
  ) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) params.set(key, String(value));
    return this.request<MemorySourceRange>(
      this.path(space, `/sources/${encodeURIComponent(id)}?${params}`),
    );
  }
  checkpoint(space: string, name: string) {
    return this.request<MemoryCheckpoint>(
      this.path(space, `/checkpoints/${encodeURIComponent(name)}`),
    );
  }
  saveCheckpoint(
    space: string,
    name: string,
    expected_version: number,
    data: Record<string, unknown>,
    source_cursor = 0,
    key?: string,
    source_ids: string[] = [],
  ) {
    return this.request<MemoryReceipt>(
      this.path(space, `/checkpoints/${encodeURIComponent(name)}`),
      "POST",
      { expected_version, data, source_cursor, source_ids },
      key,
    );
  }
  grant(space: string, principal_id: string, role: "reader" | "writer" | null, key?: string) {
    return this.request<MemoryReceipt>(
      this.path(space, "/grants"),
      "POST",
      { principal_id, role },
      key,
    );
  }
  forget(space: string, input: ForgetMemoryInput, key?: string) {
    return this.request<MemoryReceipt>(this.path(space, "/forget"), "POST", input, key);
  }
  export(space: string) {
    return this.request<Record<string, unknown>>(this.path(space, "/export"));
  }
  job(space: string, id: string) {
    return this.request<MemoryJobStatus>(this.path(space, `/jobs/${encodeURIComponent(id)}`));
  }
  async waitForIndex(space: string, receipt: MemoryReceipt, timeoutMs = 30_000): Promise<void> {
    if (!receipt.job_id) return;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const job = await this.job(space, receipt.job_id);
      if (job.state === "ready") return;
      if (job.state === "failed" || job.state === "cancelled")
        throw new MemoryClientError(409, "index_job_failed", `Index job is ${job.state}`);
      await memoryRetryDelay(200, this.signal);
    }
    throw new MemoryClientError(
      408,
      "index_timeout",
      "Index did not become ready within the requested wait",
    );
  }
}
