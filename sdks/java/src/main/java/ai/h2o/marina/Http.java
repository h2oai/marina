// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * marina.http.v1, typed: a record for each request and reply, and a class per group with a
 * method per operation. Generated from protocol/marina.http.v1.openapi.json by
 * scripts/sdk-models/java.ts ({@code bun run docs:api}); do not edit by hand.
 *
 * <p>Records have a nullable component per JSON field (camelCase; {@link Json.Name} gives the JSON
 * name where it differs). Enums are {@code String} (the server may add values) and unions are
 * {@code Object}, the raw JSON value. Build one with {@code of(required...)} and {@code withX(...)}.
 */
public final class Http {
  private Http() {}

  /** The typed {@code memory} operations, signed with a memory credential. {@link #call} stays for anything newer. */
  public static final class MemoryApi extends HttpGroup {
    public MemoryApi(String baseUrl, Supplier<String> token) {
      super(baseUrl, token, "memory");
    }

    /** What this memory service offers. GET /v1/memory. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> capabilities() {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return (Map<String, Object>) Json.bind(call("capabilities", params$, null, null), Json.mapOf(Object.class));
    }

    /** Who the presented credential is. GET /v1/memory/me. */
    public MeResponse me() {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("me", params$, null, null), MeResponse.class);
    }

    /** Storage used and its limits. GET /v1/memory/usage. */
    public MemoryStorageUsage usage() {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("usage", params$, null, null), MemoryStorageUsage.class);
    }

    /** Spaces this credential can read. GET /v1/memory/spaces. */
    public SpacesResponse spaces() {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("spaces", params$, null, null), SpacesResponse.class);
    }

    /** Create a space. POST /v1/memory/spaces. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt createSpace(CreateSpaceRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("createSpace", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt createSpace(CreateSpaceRequest body) {
      return createSpace(body, null);
    }

    /** One space. GET /v1/memory/spaces/&#123;space&#125;. */
    public MemorySpace space(String space) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("space", params$, null, null), MemorySpace.class);
    }

    /** Write a record. POST /v1/memory/spaces/&#123;space&#125;/records. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt remember(String space, MemoryRecordInput body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("remember", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt remember(String space, MemoryRecordInput body) {
      return remember(space, body, null);
    }

    /** Read a record, or one of its earlier versions. GET /v1/memory/spaces/&#123;space&#125;/records/&#123;id&#125;. */
    public MemoryRecord get(String space, String id, Long version) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("id", id);
      params$.put("version", version);
      return Json.bind(call("get", params$, null, null), MemoryRecord.class);
    }

    public MemoryRecord get(String space, String id) {
      return get(space, id, null);
    }

    /** Revise a record (compare-and-set on its version). PATCH /v1/memory/spaces/&#123;space&#125;/records/&#123;id&#125;. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt revise(String space, String id, ReviseRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("id", id);
      return Json.bind(call("revise", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt revise(String space, String id, ReviseRequest body) {
      return revise(space, id, body, null);
    }

    /** Search records. POST /v1/memory/spaces/&#123;space&#125;/search. */
    public MemorySearchResult search(String space, MemorySearchInput body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("search", params$, body, null), MemorySearchResult.class);
    }

    /** A prompt-ready context block with citations, within a token budget. POST /v1/memory/spaces/&#123;space&#125;/context. */
    public ContextResponse context(String space, ContextRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("context", params$, body, null), ContextResponse.class);
    }

    /** Structured query over claims. POST /v1/memory/spaces/&#123;space&#125;/query. */
    public MemoryQueryResult query(String space, MemoryQuery body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("query", params$, body, null), MemoryQueryResult.class);
    }

    /** Walk the claim graph from a subject. POST /v1/memory/spaces/&#123;space&#125;/graph. */
    public MemoryGraphResult graph(String space, MemoryGraphQuery body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("graph", params$, body, null), MemoryGraphResult.class);
    }

    /** Join claim patterns. POST /v1/memory/spaces/&#123;space&#125;/join. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryJoinResult join(String space, MemoryJoin body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("join", params$, body, idempotencyKey), MemoryJoinResult.class);
    }

    public MemoryJoinResult join(String space, MemoryJoin body) {
      return join(space, body, null);
    }

    /** Save an inference rule. POST /v1/memory/spaces/&#123;space&#125;/rules. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt saveRule(String space, SaveRuleRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("saveRule", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt saveRule(String space, SaveRuleRequest body) {
      return saveRule(space, body, null);
    }

    /** Run a rule without writing. POST /v1/memory/spaces/&#123;space&#125;/rules/run. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryRuleResult runRule(String space, RunRuleRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("runRule", params$, body, idempotencyKey), MemoryRuleResult.class);
    }

    public MemoryRuleResult runRule(String space, RunRuleRequest body) {
      return runRule(space, body, null);
    }

    /** Run a rule and write what it infers. POST /v1/memory/spaces/&#123;space&#125;/rules/materialize. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MaterializeRuleResponse materializeRule(String space, MaterializeRuleRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("materializeRule", params$, body, idempotencyKey), MaterializeRuleResponse.class);
    }

    public MaterializeRuleResponse materializeRule(String space, MaterializeRuleRequest body) {
      return materializeRule(space, body, null);
    }

    /** Entity/relation/observation graph operations. POST /v1/memory/spaces/&#123;space&#125;/knowledge_graph. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> knowledgeGraph(String space, KnowledgeGraphRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return (Map<String, Object>) Json.bind(call("knowledgeGraph", params$, body, null), Json.mapOf(Object.class));
    }

    /** Records that need a decision: stale, competing or pending. POST /v1/memory/spaces/&#123;space&#125;/review. */
    public MemoryReviewResult review(String space, ReviewRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("review", params$, body, null), MemoryReviewResult.class);
    }

    /** Confirm a stale record still holds against its dependencies. POST /v1/memory/spaces/&#123;space&#125;/reaffirm. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt reaffirm(String space, ReaffirmRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("reaffirm", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt reaffirm(String space, ReaffirmRequest body) {
      return reaffirm(space, body, null);
    }

    /** Settle a contradiction: keep the head, close its rivals. POST /v1/memory/spaces/&#123;space&#125;/resolve. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryResolveResult resolve(String space, ResolveRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("resolve", params$, body, idempotencyKey), MemoryResolveResult.class);
    }

    public MemoryResolveResult resolve(String space, ResolveRequest body) {
      return resolve(space, body, null);
    }

    /** Adopt an answered assistance proposal into this space. POST /v1/memory/spaces/&#123;space&#125;/adopt. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryAdoptResult adopt(String space, MemoryAdoptInput body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("adopt", params$, body, idempotencyKey), MemoryAdoptResult.class);
    }

    public MemoryAdoptResult adopt(String space, MemoryAdoptInput body) {
      return adopt(space, body, null);
    }

    /** Acknowledge change notifications by key. POST /v1/memory/spaces/&#123;space&#125;/acknowledge. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public AcknowledgeResponse acknowledge(String space, AcknowledgeRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("acknowledge", params$, body, idempotencyKey), AcknowledgeResponse.class);
    }

    public AcknowledgeResponse acknowledge(String space, AcknowledgeRequest body) {
      return acknowledge(space, body, null);
    }

    /** Erase records or sources. POST /v1/memory/spaces/&#123;space&#125;/forget. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt forget(String space, ForgetMemoryInput body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("forget", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt forget(String space, ForgetMemoryInput body) {
      return forget(space, body, null);
    }

    /** Give a principal read or write access (null removes it). POST /v1/memory/spaces/&#123;space&#125;/grants. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt grant(String space, GrantRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("grant", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt grant(String space, GrantRequest body) {
      return grant(space, body, null);
    }

    /** Re-embed records, one page at a time. POST /v1/memory/spaces/&#123;space&#125;/reindex. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public ReindexResponse reindex(String space, ReindexRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("reindex", params$, body, idempotencyKey), ReindexResponse.class);
    }

    public ReindexResponse reindex(String space, ReindexRequest body) {
      return reindex(space, body, null);
    }

    /** Read a cached derived value, if still valid. POST /v1/memory/spaces/&#123;space&#125;/cache/get. */
    public Object cacheGet(String space, MemoryCacheInput body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return call("cacheGet", params$, body, null);
    }

    /** Cache a derived value pinned to the records and sources it used. POST /v1/memory/spaces/&#123;space&#125;/cache/put. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt cachePut(String space, MemoryCacheWrite body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("cachePut", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt cachePut(String space, MemoryCacheWrite body) {
      return cachePut(space, body, null);
    }

    /** Drop a cached value. POST /v1/memory/spaces/&#123;space&#125;/cache/delete. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public CacheDeleteResponse cacheDelete(String space, MemoryCacheInput body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("cacheDelete", params$, body, idempotencyKey), CacheDeleteResponse.class);
    }

    public CacheDeleteResponse cacheDelete(String space, MemoryCacheInput body) {
      return cacheDelete(space, body, null);
    }

    /** Plan the retrieval steps for a task. POST /v1/memory/spaces/&#123;space&#125;/plan. */
    public MemoryPlan plan(String space, PlanRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("plan", params$, body, null), MemoryPlan.class);
    }

    /** Run a retrieval plan. POST /v1/memory/spaces/&#123;space&#125;/execute_plan. */
    public MemoryPlanResult executePlan(String space, MemoryPlan body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("executePlan", params$, body, null), MemoryPlanResult.class);
    }

    /** Find and read citable evidence in one bounded request. POST /v1/memory/spaces/&#123;space&#125;/retrieve. */
    public MemoryRetrievalResult retrieve(String space, MemoryRetrievalInput body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("retrieve", params$, body, null), MemoryRetrievalResult.class);
    }

    /** Retrieve, reusing a cached result while its evidence is unchanged. POST /v1/memory/spaces/&#123;space&#125;/retrieve_cached. */
    public MemoryCachedRetrievalResult retrieveCached(String space, MemoryCachedRetrievalInput body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("retrieveCached", params$, body, null), MemoryCachedRetrievalResult.class);
    }

    /** Retrieve across mounted peer spaces. POST /v1/memory/spaces/&#123;space&#125;/federated_retrieve. */
    public MemoryFederatedRetrievalResult federatedRetrieve(String space, FederatedRetrieveRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("federatedRetrieve", params$, body, null), MemoryFederatedRetrievalResult.class);
    }

    /** Peer spaces this principal can search. GET /v1/memory/spaces/&#123;space&#125;/federation_mounts. */
    public FederationMountsResponse federationMounts(String space) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("federationMounts", params$, null, null), FederationMountsResponse.class);
    }

    /** Search mounted peer spaces. POST /v1/memory/spaces/&#123;space&#125;/federated_search. */
    public MemoryFederatedResult federatedSearch(String space, MemoryFederatedSearch body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("federatedSearch", params$, body, null), MemoryFederatedResult.class);
    }

    /** Read one item from a mounted peer space. POST /v1/memory/spaces/&#123;space&#125;/federated_read. */
    public FederatedReadResponse federatedRead(String space, MemoryFederatedRead body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("federatedRead", params$, body, null), FederatedReadResponse.class);
    }

    /** The space's vocabulary (current, or a version). GET /v1/memory/spaces/&#123;space&#125;/vocabulary. */
    public MemoryVocabulary vocabulary(String space, Long version) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("version", version);
      return Json.bind(call("vocabulary", params$, null, null), MemoryVocabulary.class);
    }

    public MemoryVocabulary vocabulary(String space) {
      return vocabulary(space, null);
    }

    /** Replace the vocabulary (compare-and-set on its version). POST /v1/memory/spaces/&#123;space&#125;/vocabulary. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt saveVocabulary(String space, SaveVocabularyRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("saveVocabulary", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt saveVocabulary(String space, SaveVocabularyRequest body) {
      return saveVocabulary(space, body, null);
    }

    /** Capture a source (raw evidence). POST /v1/memory/spaces/&#123;space&#125;/sources. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt capture(String space, CaptureRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("capture", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt capture(String space, CaptureRequest body) {
      return capture(space, body, null);
    }

    /** Sources after a cursor, oldest first. GET /v1/memory/spaces/&#123;space&#125;/sources. */
    public SourcesResponse sources(String space, Long after, Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("after", after);
      params$.put("limit", limit);
      return Json.bind(call("sources", params$, null, null), SourcesResponse.class);
    }

    public SourcesResponse sources(String space) {
      return sources(space, null, null);
    }

    /** Capture several sources, each with its own key. POST /v1/memory/spaces/&#123;space&#125;/sources/batch. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public CaptureBatchResponse captureBatch(String space, CaptureBatchRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("captureBatch", params$, body, idempotencyKey), CaptureBatchResponse.class);
    }

    public CaptureBatchResponse captureBatch(String space, CaptureBatchRequest body) {
      return captureBatch(space, body, null);
    }

    /** Source headers (no bodies) after a cursor. GET /v1/memory/spaces/&#123;space&#125;/source_headers. */
    public SourceHeadersResponse sourceHeaders(String space, Long after, Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("after", after);
      params$.put("limit", limit);
      return Json.bind(call("sourceHeaders", params$, null, null), SourceHeadersResponse.class);
    }

    public SourceHeadersResponse sourceHeaders(String space) {
      return sourceHeaders(space, null, null);
    }

    /** Read a range of a source. GET /v1/memory/spaces/&#123;space&#125;/sources/&#123;id&#125;. */
    public MemorySourceRange sourceRange(String space, String id, Long start, Long end, String textHash) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("id", id);
      params$.put("start", start);
      params$.put("end", end);
      params$.put("text_hash", textHash);
      return Json.bind(call("sourceRange", params$, null, null), MemorySourceRange.class);
    }

    public MemorySourceRange sourceRange(String space, String id) {
      return sourceRange(space, id, null, null, null);
    }

    /** Search source text. POST /v1/memory/spaces/&#123;space&#125;/source_search. */
    public MemorySourceSearchResult sourceSearch(String space, MemorySourceSearch body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("sourceSearch", params$, body, null), MemorySourceSearchResult.class);
    }

    /** Read a named checkpoint. GET /v1/memory/spaces/&#123;space&#125;/checkpoints/&#123;name&#125;. */
    public MemoryCheckpoint checkpoint(String space, String name) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("name", name);
      return Json.bind(call("checkpoint", params$, null, null), MemoryCheckpoint.class);
    }

    /** Save a named checkpoint (compare-and-set on its version). POST /v1/memory/spaces/&#123;space&#125;/checkpoints/&#123;name&#125;. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt saveCheckpoint(String space, String name, SaveCheckpointRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("name", name);
      return Json.bind(call("saveCheckpoint", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt saveCheckpoint(String space, String name, SaveCheckpointRequest body) {
      return saveCheckpoint(space, name, body, null);
    }

    /** Capture sources and the checkpoint naming them in one transaction. POST /v1/memory/spaces/&#123;space&#125;/checkpoints/&#123;name&#125;/capture. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryCheckpointCaptureReceipt captureCheckpoint(String space, String name, MemoryCheckpointCapture body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("name", name);
      return Json.bind(call("captureCheckpoint", params$, body, idempotencyKey), MemoryCheckpointCaptureReceipt.class);
    }

    public MemoryCheckpointCaptureReceipt captureCheckpoint(String space, String name, MemoryCheckpointCapture body) {
      return captureCheckpoint(space, name, body, null);
    }

    /** Export the space as one bundle. GET /v1/memory/spaces/&#123;space&#125;/bundle. */
    public MemoryBundle exportBundle(String space) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("exportBundle", params$, null, null), MemoryBundle.class);
    }

    /** Import a bundle into the space. POST /v1/memory/spaces/&#123;space&#125;/bundle. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public ImportBundleResponse importBundle(String space, MemoryBundle body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("importBundle", params$, body, idempotencyKey), ImportBundleResponse.class);
    }

    public ImportBundleResponse importBundle(String space, MemoryBundle body) {
      return importBundle(space, body, null);
    }

    /** Export the space page by page. GET /v1/memory/spaces/&#123;space&#125;/transfer. */
    public MemoryTransferPage exportTransferPage(String space, String cursor) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("cursor", cursor);
      return Json.bind(call("exportTransferPage", params$, null, null), MemoryTransferPage.class);
    }

    public MemoryTransferPage exportTransferPage(String space) {
      return exportTransferPage(space, null);
    }

    /** Begin a paged import. POST /v1/memory/spaces/&#123;space&#125;/transfers. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryTransferStatus beginTransfer(String space, MemoryTransferHeader body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("beginTransfer", params$, body, idempotencyKey), MemoryTransferStatus.class);
    }

    public MemoryTransferStatus beginTransfer(String space, MemoryTransferHeader body) {
      return beginTransfer(space, body, null);
    }

    /** Paged imports into this space. GET /v1/memory/spaces/&#123;space&#125;/transfers. */
    public MemoryTransferList transfers(String space, String state, Long limit, String cursor) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("state", state);
      params$.put("limit", limit);
      params$.put("cursor", cursor);
      return Json.bind(call("transfers", params$, null, null), MemoryTransferList.class);
    }

    public MemoryTransferList transfers(String space) {
      return transfers(space, null, null, null);
    }

    /** One paged import. GET /v1/memory/spaces/&#123;space&#125;/transfers/&#123;id&#125;. */
    public MemoryTransferStatus transferStatus(String space, String id) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("id", id);
      return Json.bind(call("transferStatus", params$, null, null), MemoryTransferStatus.class);
    }

    /** Add a page to a paged import. POST /v1/memory/spaces/&#123;space&#125;/transfers/&#123;id&#125;/pages. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryTransferStatus appendTransfer(String space, String id, MemoryTransferPage body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("id", id);
      return Json.bind(call("appendTransfer", params$, body, idempotencyKey), MemoryTransferStatus.class);
    }

    public MemoryTransferStatus appendTransfer(String space, String id, MemoryTransferPage body) {
      return appendTransfer(space, id, body, null);
    }

    /** Commit a paged import, checked against its hash. POST /v1/memory/spaces/&#123;space&#125;/transfers/&#123;id&#125;/commit. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public CommitTransferResponse commitTransfer(String space, String id, CommitTransferRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("id", id);
      return Json.bind(call("commitTransfer", params$, body, idempotencyKey), CommitTransferResponse.class);
    }

    public CommitTransferResponse commitTransfer(String space, String id, CommitTransferRequest body) {
      return commitTransfer(space, id, body, null);
    }

    /** Abandon a paged import. POST /v1/memory/spaces/&#123;space&#125;/transfers/&#123;id&#125;/abort. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryReceipt abortTransfer(String space, String id, Map<String, Object> body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("id", id);
      return Json.bind(call("abortTransfer", params$, body, idempotencyKey), MemoryReceipt.class);
    }

    public MemoryReceipt abortTransfer(String space, String id, Map<String, Object> body) {
      return abortTransfer(space, id, body, null);
    }

    public MemoryReceipt abortTransfer(String space, String id) {
      return abortTransfer(space, id, Map.of(), null);
    }

    /** Everything in the space as JSON. GET /v1/memory/spaces/&#123;space&#125;/export. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> export(String space) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return (Map<String, Object>) Json.bind(call("export", params$, null, null), Json.mapOf(Object.class));
    }

    /** An index job (a receipt's job_id). GET /v1/memory/spaces/&#123;space&#125;/jobs/&#123;id&#125;. */
    public MemoryJobStatus job(String space, String id) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      params$.put("id", id);
      return Json.bind(call("job", params$, null, null), MemoryJobStatus.class);
    }

    /** Key-value JSON documents in namespaces, as one atomic batch (1-64 operations). POST /v1/memory/spaces/&#123;space&#125;/json_store. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public JsonStoreResponse jsonStore(String space, JsonStoreRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("jsonStore", params$, body, idempotencyKey), JsonStoreResponse.class);
    }

    public JsonStoreResponse jsonStore(String space, JsonStoreRequest body) {
      return jsonStore(space, body, null);
    }

    /** Task workflows over memory: start, run, finish, resume, recipes, watches. POST /v1/memory/spaces/&#123;space&#125;/workflow. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> workflow(String space, WorkflowRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return (Map<String, Object>) Json.bind(call("workflow", params$, body, null), Json.mapOf(Object.class));
    }

    /** Ask a helper for memory work. POST /v1/memory/spaces/&#123;space&#125;/assistance. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public AssistCreateResponse assistCreate(String space, MemoryAssistanceInput body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("space", space);
      return Json.bind(call("assistCreate", params$, body, idempotencyKey), AssistCreateResponse.class);
    }

    public AssistCreateResponse assistCreate(String space, MemoryAssistanceInput body) {
      return assistCreate(space, body, null);
    }

    /** Assistance jobs for this principal. GET /v1/memory/assistance. */
    public MemoryAssistancePage assistJobs(Boolean open, Long limit, String cursor) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("open", open);
      params$.put("limit", limit);
      params$.put("cursor", cursor);
      return Json.bind(call("assistJobs", params$, null, null), MemoryAssistancePage.class);
    }

    public MemoryAssistancePage assistJobs() {
      return assistJobs(null, null, null);
    }

    /** One assistance job. GET /v1/memory/assistance/&#123;job&#125;. */
    public MemoryAssistanceJob assistGet(String job) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("job", job);
      return Json.bind(call("assistGet", params$, null, null), MemoryAssistanceJob.class);
    }

    /** Claim a job (as its worker); returns a lease. POST /v1/memory/assistance/&#123;job&#125;/claim. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public AssistClaimResponse assistClaim(String job, Map<String, Object> body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("job", job);
      return Json.bind(call("assistClaim", params$, body, idempotencyKey), AssistClaimResponse.class);
    }

    public AssistClaimResponse assistClaim(String job, Map<String, Object> body) {
      return assistClaim(job, body, null);
    }

    public AssistClaimResponse assistClaim(String job) {
      return assistClaim(job, Map.of(), null);
    }

    /** Extend the lease. POST /v1/memory/assistance/&#123;job&#125;/heartbeat. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public AssistHeartbeatResponse assistHeartbeat(String job, AssistHeartbeatRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("job", job);
      return Json.bind(call("assistHeartbeat", params$, body, idempotencyKey), AssistHeartbeatResponse.class);
    }

    public AssistHeartbeatResponse assistHeartbeat(String job, AssistHeartbeatRequest body) {
      return assistHeartbeat(job, body, null);
    }

    /** Run one read operation inside the job's scope. POST /v1/memory/assistance/&#123;job&#125;/read. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public Object assistRead(String job, AssistReadRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("job", job);
      return call("assistRead", params$, body, idempotencyKey);
    }

    public Object assistRead(String job, AssistReadRequest body) {
      return assistRead(job, body, null);
    }

    /** Finish with an answer (cited) or an abstention. POST /v1/memory/assistance/&#123;job&#125;/finish. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public AssistFinishResponse assistFinish(String job, AssistFinishRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("job", job);
      return Json.bind(call("assistFinish", params$, body, idempotencyKey), AssistFinishResponse.class);
    }

    public AssistFinishResponse assistFinish(String job, AssistFinishRequest body) {
      return assistFinish(job, body, null);
    }

    /** Cancel a job. POST /v1/memory/assistance/&#123;job&#125;/cancel. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public AssistCancelResponse assistCancel(String job, Map<String, Object> body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("job", job);
      return Json.bind(call("assistCancel", params$, body, idempotencyKey), AssistCancelResponse.class);
    }

    public AssistCancelResponse assistCancel(String job, Map<String, Object> body) {
      return assistCancel(job, body, null);
    }

    public AssistCancelResponse assistCancel(String job) {
      return assistCancel(job, Map.of(), null);
    }

    /** Hand part of the job to another helper. POST /v1/memory/assistance/&#123;job&#125;/delegate. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public AssistDelegateResponse assistDelegate(String job, AssistDelegateRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("job", job);
      return Json.bind(call("assistDelegate", params$, body, idempotencyKey), AssistDelegateResponse.class);
    }

    public AssistDelegateResponse assistDelegate(String job, AssistDelegateRequest body) {
      return assistDelegate(job, body, null);
    }

    /** Adopt the job's answer into its own space. POST /v1/memory/assistance/&#123;job&#125;/adopt. The same {@code idempotencyKey} replays the first result; null makes a fresh one. */
    public MemoryAdoptResult assistAdopt(String job, AssistAdoptRequest body, String idempotencyKey) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("job", job);
      return Json.bind(call("assistAdopt", params$, body, idempotencyKey), MemoryAdoptResult.class);
    }

    public MemoryAdoptResult assistAdopt(String job, AssistAdoptRequest body) {
      return assistAdopt(job, body, null);
    }
  }

  /** The typed {@code routing} operations, signed with the session token. {@link #call} stays for anything newer. */
  public static final class RoutingApi extends HttpGroup {
    public RoutingApi(String baseUrl, Supplier<String> token) {
      super(baseUrl, token, "routing");
    }

    /** Join as a routed participant session. POST /api/routing/sessions. */
    public RoutingSession joinSession(RoutingJoin body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("joinSession", params$, body, null), RoutingSession.class);
    }

    /** Sessions you can see. GET /api/routing/sessions. */
    public RoutingSessionPage discover(String after, Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("after", after);
      params$.put("limit", limit);
      return Json.bind(call("discover", params$, null, null), RoutingSessionPage.class);
    }

    public RoutingSessionPage discover() {
      return discover(null, null);
    }

    /** Sessions with their latest activity. GET /api/routing/overview. */
    public RoutingOverview overview(String after, Long limit, Boolean attention) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("after", after);
      params$.put("limit", limit);
      params$.put("attention", attention);
      return Json.bind(call("overview", params$, null, null), RoutingOverview.class);
    }

    public RoutingOverview overview() {
      return overview(null, null, null);
    }

    /** One session. GET /api/routing/sessions/&#123;session&#125;. */
    public RoutingSession session(String session) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      return Json.bind(call("session", params$, null, null), RoutingSession.class);
    }

    /** Keep the session live. POST /api/routing/sessions/&#123;session&#125;/heartbeat. */
    public RoutingSession heartbeat(String session, Map<String, Object> body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      return Json.bind(call("heartbeat", params$, body, null), RoutingSession.class);
    }

    public RoutingSession heartbeat(String session) {
      return heartbeat(session, Map.of());
    }

    /** End the session. POST /api/routing/sessions/&#123;session&#125;/leave. */
    public RoutingSession leave(String session, Map<String, Object> body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      return Json.bind(call("leave", params$, body, null), RoutingSession.class);
    }

    public RoutingSession leave(String session) {
      return leave(session, Map.of());
    }

    /** Publish output events. POST /api/routing/sessions/&#123;session&#125;/events. */
    public PublishResponse publish(String session, PublishRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      return Json.bind(call("publish", params$, body, null), PublishResponse.class);
    }

    /** Events after a cursor (poll this to watch). GET /api/routing/sessions/&#123;session&#125;/events. */
    public RoutingEventPage events(String session, Long after, Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      params$.put("after", after);
      params$.put("limit", limit);
      return Json.bind(call("events", params$, null, null), RoutingEventPage.class);
    }

    public RoutingEventPage events(String session) {
      return events(session, null, null);
    }

    /** Send a message to another session. POST /api/routing/sessions/&#123;session&#125;/messages. */
    public RoutingMessage send(String session, RoutingSend body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      return Json.bind(call("send", params$, body, null), RoutingMessage.class);
    }

    /** Messages waiting for this session. GET /api/routing/sessions/&#123;session&#125;/inbox. */
    public InboxResponse inbox(String session, Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      params$.put("limit", limit);
      return Json.bind(call("inbox", params$, null, null), InboxResponse.class);
    }

    public InboxResponse inbox(String session) {
      return inbox(session, null);
    }

    /** Messages this session sent, with delivery state. GET /api/routing/sessions/&#123;session&#125;/deliveries. */
    public DeliveriesResponse deliveries(String session, Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      params$.put("limit", limit);
      return Json.bind(call("deliveries", params$, null, null), DeliveriesResponse.class);
    }

    public DeliveriesResponse deliveries(String session) {
      return deliveries(session, null);
    }

    /** One message's delivery state. GET /api/routing/sessions/&#123;session&#125;/messages/&#123;message&#125;. */
    public RoutingMessage receipt(String session, String message) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      params$.put("message", message);
      return Json.bind(call("receipt", params$, null, null), RoutingMessage.class);
    }

    /** Acknowledge a received message. POST /api/routing/sessions/&#123;session&#125;/messages/&#123;message&#125;/ack. */
    public RoutingMessage acknowledgeMessage(String session, String message, Map<String, Object> body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      params$.put("message", message);
      return Json.bind(call("acknowledgeMessage", params$, body, null), RoutingMessage.class);
    }

    public RoutingMessage acknowledgeMessage(String session, String message) {
      return acknowledgeMessage(session, message, Map.of());
    }

    /** World channels this session can use. GET /api/routing/sessions/&#123;session&#125;/channels. */
    public ChannelsResponse channels(String session) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      return Json.bind(call("channels", params$, null, null), ChannelsResponse.class);
    }

    /** Channel history after a cursor. GET /api/routing/sessions/&#123;session&#125;/channels/&#123;channel&#125;/messages. */
    public RoutingChannelPage channelMessages(String session, String channel, Long after, Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      params$.put("channel", channel);
      params$.put("after", after);
      params$.put("limit", limit);
      return Json.bind(call("channelMessages", params$, null, null), RoutingChannelPage.class);
    }

    public RoutingChannelPage channelMessages(String session, String channel) {
      return channelMessages(session, channel, null, null);
    }

    /** Post to a channel. POST /api/routing/sessions/&#123;session&#125;/channels/&#123;channel&#125;/messages. */
    public RoutingChannelReceipt sendChannel(String session, String channel, SendChannelRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      params$.put("channel", channel);
      return Json.bind(call("sendChannel", params$, body, null), RoutingChannelReceipt.class);
    }

    /** Report a supervisor's runtimes and collect their controls. POST /api/routing/sync. */
    public RoutingSyncResult sync(RoutingSyncInput body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("sync", params$, body, null), RoutingSyncResult.class);
    }

    /** The session's supervised runtime state. GET /api/routing/sessions/&#123;session&#125;/runtime. */
    public RuntimeResponse runtime(String session) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      return Json.bind(call("runtime", params$, null, null), RuntimeResponse.class);
    }

    /** Send a runtime control (steer, interrupt, stop…) to another session. POST /api/routing/sessions/&#123;session&#125;/control. */
    public RoutingMessage control(String session, ControlRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("session", session);
      return Json.bind(call("control", params$, body, null), RoutingMessage.class);
    }

    /** Enrol a run's agent as its own world account. POST /api/routing/residents. */
    public ResidentEnrolment enrolResident(ResidentEnrolInput body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("enrolResident", params$, body, null), ResidentEnrolment.class);
    }

    /** A fresh credential for a live owned run. POST /api/routing/residents/&#123;name&#125;/renew. */
    public RenewResidentResponse renewResident(String name, RenewResidentRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("name", name);
      return Json.bind(call("renewResident", params$, body, null), RenewResidentResponse.class);
    }

    /** End this run's hold on the resident. POST /api/routing/residents/&#123;name&#125;/revoke. */
    public RevokeResidentResponse revokeResident(String name, RevokeResidentRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("name", name);
      return Json.bind(call("revokeResident", params$, body, null), RevokeResidentResponse.class);
    }

    /** Report attention-bridge decisions and presence. POST /api/routing/residents/&#123;name&#125;/attention. */
    public ReportResidentAttentionResponse reportResidentAttention(String name, ResidentAttentionReport body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("name", name);
      return Json.bind(call("reportResidentAttention", params$, body, null), ReportResidentAttentionResponse.class);
    }

    /** Exchange a world session for a routing-only supervision credential. POST /api/routing/supervision. */
    public SupervisionCredentialGrant issueSupervision(Map<String, Object> body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("issueSupervision", params$, body, null), SupervisionCredentialGrant.class);
    }

    public SupervisionCredentialGrant issueSupervision() {
      return issueSupervision(Map.of());
    }

    /** Replace the presented supervision credential. POST /api/routing/supervision/renew. */
    public SupervisionCredentialGrant renewSupervision(Map<String, Object> body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("renewSupervision", params$, body, null), SupervisionCredentialGrant.class);
    }

    public SupervisionCredentialGrant renewSupervision() {
      return renewSupervision(Map.of());
    }

    /** Revoke the presented supervision credential. POST /api/routing/supervision/revoke. */
    public RevokeSupervisionResponse revokeSupervision(Map<String, Object> body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("revokeSupervision", params$, body, null), RevokeSupervisionResponse.class);
    }

    public RevokeSupervisionResponse revokeSupervision() {
      return revokeSupervision(Map.of());
    }
  }

  /** The typed {@code investigations} operations, signed with the session token. {@link #call} stays for anything newer. */
  public static final class InvestigationsApi extends HttpGroup {
    public InvestigationsApi(String baseUrl, Supplier<String> token) {
      super(baseUrl, token, "investigations");
    }

    /** Start an investigation (or replay the one this key started). POST /api/investigations. */
    public StartInvestigationResponse startInvestigation(StartInvestigationRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("startInvestigation", params$, body, null), StartInvestigationResponse.class);
    }

    /** Your cases, newest first. GET /api/investigations. */
    public ListInvestigationsResponse listInvestigations(Long before) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("before", before);
      return Json.bind(call("listInvestigations", params$, null, null), ListInvestigationsResponse.class);
    }

    public ListInvestigationsResponse listInvestigations() {
      return listInvestigations(null);
    }

    /** A case with its attempts (or one attempt of it). GET /api/investigations/&#123;case&#125;. */
    public InvestigationSnapshot getInvestigation(String case_, String attempt) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("case", case_);
      params$.put("attempt", attempt);
      return Json.bind(call("getInvestigation", params$, null, null), InvestigationSnapshot.class);
    }

    public InvestigationSnapshot getInvestigation(String case_) {
      return getInvestigation(case_, null);
    }

    /** Erase a case. DELETE /api/investigations/&#123;case&#125;. */
    public EraseInvestigationResponse eraseInvestigation(String case_) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("case", case_);
      return Json.bind(call("eraseInvestigation", params$, null, null), EraseInvestigationResponse.class);
    }

    /** Share a case (null access removes it). POST /api/investigations/&#123;case&#125;/grants. */
    public GrantInvestigationResponse grantInvestigation(String case_, GrantInvestigationRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("case", case_);
      return Json.bind(call("grantInvestigation", params$, body, null), GrantInvestigationResponse.class);
    }

    /** One attempt. GET /api/investigations/attempts/&#123;attempt&#125;. */
    public InvestigationAttempt attempt(String attempt) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("attempt", attempt);
      return Json.bind(call("attempt", params$, null, null), InvestigationAttempt.class);
    }

    /** An attempt's events after a cursor. GET /api/investigations/attempts/&#123;attempt&#125;/events. */
    public InvestigationEventPage attemptEvents(String attempt, Long after, Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("attempt", attempt);
      params$.put("after", after);
      params$.put("limit", limit);
      return Json.bind(call("attemptEvents", params$, null, null), InvestigationEventPage.class);
    }

    public InvestigationEventPage attemptEvents(String attempt) {
      return attemptEvents(attempt, null, null);
    }

    /** Cancel an attempt. POST /api/investigations/attempts/&#123;attempt&#125;/cancel. */
    public CancelAttemptResponse cancelAttempt(String attempt, Map<String, Object> body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("attempt", attempt);
      return Json.bind(call("cancelAttempt", params$, body, null), CancelAttemptResponse.class);
    }

    public CancelAttemptResponse cancelAttempt(String attempt) {
      return cancelAttempt(attempt, Map.of());
    }

    /** Make this attempt the case's answer. POST /api/investigations/attempts/&#123;attempt&#125;/select. */
    public InvestigationSnapshot selectAttempt(String attempt, Map<String, Object> body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("attempt", attempt);
      return Json.bind(call("selectAttempt", params$, body, null), InvestigationSnapshot.class);
    }

    public InvestigationSnapshot selectAttempt(String attempt) {
      return selectAttempt(attempt, Map.of());
    }

    /** Add a review note. POST /api/investigations/attempts/&#123;attempt&#125;/review. */
    public InvestigationEvent reviewAttempt(String attempt, ReviewAttemptRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("attempt", attempt);
      return Json.bind(call("reviewAttempt", params$, body, null), InvestigationEvent.class);
    }

    /** Record the real outcome; scores a prediction. POST /api/investigations/attempts/&#123;attempt&#125;/resolve. */
    public ResolveAttemptResponse resolveAttempt(String attempt, ResolveAttemptRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("attempt", attempt);
      return Json.bind(call("resolveAttempt", params$, body, null), ResolveAttemptResponse.class);
    }

    /** Stored content an event refers to. GET /api/investigations/content/&#123;content&#125;. */
    public InvestigationContent investigationContent(String content) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("content", content);
      return Json.bind(call("investigationContent", params$, null, null), InvestigationContent.class);
    }
  }

  /** The typed {@code panels} operations, signed with the session token. {@link #call} stays for anything newer. */
  public static final class PanelsApi extends PanelsGroup {
    public PanelsApi(String baseUrl, Supplier<String> token) {
      super(baseUrl, token);
    }

    /** Create a canvas to publish panels on. POST /api/canvases. */
    public CreateCanvasResponse createCanvas(CreateCanvasRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("createCanvas", params$, body, null), CreateCanvasResponse.class);
    }

    /** Canvases you can see. GET /api/canvases. */
    @SuppressWarnings("unchecked")
    public List<CanvasesResponseItem> canvases(Long limit) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("limit", limit);
      return (List<CanvasesResponseItem>) Json.bind(call("canvases", params$, null, null), Json.listOf(CanvasesResponseItem.class));
    }

    public List<CanvasesResponseItem> canvases() {
      return canvases(null);
    }

    /** Live data a panel can bind to. GET /api/panel-resources. */
    public PanelResourcesResponse panelResources() {
      Map<String, Object> params$ = new LinkedHashMap<>();
      return Json.bind(call("panelResources", params$, null, null), PanelResourcesResponse.class);
    }

    /** A canvas with its nodes (panels are type `a2ui`). GET /api/canvases/&#123;canvas&#125;. */
    public CanvasResponse canvas(String canvas) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("canvas", canvas);
      return Json.bind(call("canvas", params$, null, null), CanvasResponse.class);
    }

    /** Publish a panel. POST /api/canvases/&#123;canvas&#125;/nodes. */
    public PublishedPanelNode publishPanel(String canvas, PublishPanelRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("canvas", canvas);
      return Json.bind(call("publishPanel", params$, body, null), PublishedPanelNode.class);
    }

    /** One panel. GET /api/canvases/&#123;canvas&#125;/nodes/&#123;node&#125;. */
    public PublishedPanelNode panel(String canvas, String node) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("canvas", canvas);
      params$.put("node", node);
      return Json.bind(call("panel", params$, null, null), PublishedPanelNode.class);
    }

    /** Replace a panel's document (409 if `revision` is stale). PATCH /api/canvases/&#123;canvas&#125;/nodes/&#123;node&#125;. */
    public PublishedPanelNode revisePanel(String canvas, String node, RevisePanelRequest body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("canvas", canvas);
      params$.put("node", node);
      return Json.bind(call("revisePanel", params$, body, null), PublishedPanelNode.class);
    }

    /** Press a panel's button or submit its form. POST /api/canvases/&#123;canvas&#125;/nodes/&#123;node&#125;/interaction. */
    public InteractPanelResponse interactPanel(String canvas, String node, PanelInteractionInput body) {
      Map<String, Object> params$ = new LinkedHashMap<>();
      params$.put("canvas", canvas);
      params$.put("node", node);
      return Json.bind(call("interactPanel", params$, body, null), InteractPanelResponse.class);
    }
  }

  /**
   * @param component A known type, or (read tolerantly) a newer Marina's type, drawn as a placeholder.
   */
  public record A2UIComponent(
      String id,
      Object component,
      String child,
      List<String> children) {

    /** With its required fields; the rest are null. */
    public static A2UIComponent of(String id, Object component) {
      return new A2UIComponent(id, component, null, null);
    }

    public A2UIComponent withId(String value) {
      return new A2UIComponent(value, component, child, children);
    }

    public A2UIComponent withComponent(Object value) {
      return new A2UIComponent(id, value, child, children);
    }

    public A2UIComponent withChild(String value) {
      return new A2UIComponent(id, component, value, children);
    }

    public A2UIComponent withChildren(List<String> value) {
      return new A2UIComponent(id, component, child, value);
    }
  }

  public record A2UINodeData(
      String schema,
      List<A2UIComponent> components,
      String rootId,
      Map<String, Object> dataModel,
      Map<String, Object> sources,
      String title,
      LastAction lastAction) {

    /** With its required fields; the rest are null. */
    public static A2UINodeData of(List<A2UIComponent> components) {
      return new A2UINodeData(null, components, null, null, null, null, null);
    }

    public A2UINodeData withSchema(String value) {
      return new A2UINodeData(value, components, rootId, dataModel, sources, title, lastAction);
    }

    public A2UINodeData withComponents(List<A2UIComponent> value) {
      return new A2UINodeData(schema, value, rootId, dataModel, sources, title, lastAction);
    }

    public A2UINodeData withRootId(String value) {
      return new A2UINodeData(schema, components, value, dataModel, sources, title, lastAction);
    }

    public A2UINodeData withDataModel(Map<String, Object> value) {
      return new A2UINodeData(schema, components, rootId, value, sources, title, lastAction);
    }

    public A2UINodeData withSources(Map<String, Object> value) {
      return new A2UINodeData(schema, components, rootId, dataModel, value, title, lastAction);
    }

    public A2UINodeData withTitle(String value) {
      return new A2UINodeData(schema, components, rootId, dataModel, sources, value, lastAction);
    }

    public A2UINodeData withLastAction(LastAction value) {
      return new A2UINodeData(schema, components, rootId, dataModel, sources, title, value);
    }

    public record LastAction(
        String name,
        Map<String, Object> payload,
        Double timestamp) {

      /** With its required fields; the rest are null. */
      public static LastAction of(String name, Double timestamp) {
        return new LastAction(name, null, timestamp);
      }

      public LastAction withName(String value) {
        return new LastAction(value, payload, timestamp);
      }

      public LastAction withPayload(Map<String, Object> value) {
        return new LastAction(name, value, timestamp);
      }

      public LastAction withTimestamp(Double value) {
        return new LastAction(name, payload, value);
      }
    }
  }

  public record AcknowledgeRequest(
      List<String> keys) {

    /** With its required fields; the rest are null. */
    public static AcknowledgeRequest of(List<String> keys) {
      return new AcknowledgeRequest(keys);
    }

    public AcknowledgeRequest withKeys(List<String> value) {
      return new AcknowledgeRequest(value);
    }
  }

  public record AcknowledgeResponse(
      List<String> acknowledged,
      List<String> missing) {

    /** With its required fields; the rest are null. */
    public static AcknowledgeResponse of(List<String> acknowledged, List<String> missing) {
      return new AcknowledgeResponse(acknowledged, missing);
    }

    public AcknowledgeResponse withAcknowledged(List<String> value) {
      return new AcknowledgeResponse(value, missing);
    }

    public AcknowledgeResponse withMissing(List<String> value) {
      return new AcknowledgeResponse(acknowledged, value);
    }
  }

  /**
   * A routing or investigations failure.
   *
   * @param error For people; wording may change.
   * @param code Stable, machine-readable: branch on this.
   */
  public record ApiError(
      String error,
      String code) {

    /** With its required fields; the rest are null. */
    public static ApiError of(String error) {
      return new ApiError(error, null);
    }

    public ApiError withError(String value) {
      return new ApiError(value, code);
    }

    public ApiError withCode(String value) {
      return new ApiError(error, value);
    }
  }

  public record MemoryValidity(
      Double from,
      Double until) {

    /** With its required fields; the rest are null. */
    public static MemoryValidity of(Double from, Double until) {
      return new MemoryValidity(from, until);
    }

    public MemoryValidity withFrom(Double value) {
      return new MemoryValidity(value, until);
    }

    public MemoryValidity withUntil(Double value) {
      return new MemoryValidity(from, value);
    }
  }

  /**
   * @param targetSpaceId Defaults to the job's own space.
   * @param confirmAbstention Explicit `assistance_abstained_confirmed` credit for an abstained job; writes no record.
   */
  public record AssistAdoptRequest(
      @Json.Name("target_space_id") String targetSpaceId,
      String rationale,
      @Json.Name("valid_time") MemoryValidity validTime,
      @Json.Name("confirm_abstention") Boolean confirmAbstention) {

    /** With its required fields; the rest are null. */
    public static AssistAdoptRequest of() {
      return new AssistAdoptRequest(null, null, null, null);
    }

    public AssistAdoptRequest withTargetSpaceId(String value) {
      return new AssistAdoptRequest(value, rationale, validTime, confirmAbstention);
    }

    public AssistAdoptRequest withRationale(String value) {
      return new AssistAdoptRequest(targetSpaceId, value, validTime, confirmAbstention);
    }

    public AssistAdoptRequest withValidTime(MemoryValidity value) {
      return new AssistAdoptRequest(targetSpaceId, rationale, value, confirmAbstention);
    }

    public AssistAdoptRequest withConfirmAbstention(Boolean value) {
      return new AssistAdoptRequest(targetSpaceId, rationale, validTime, value);
    }
  }

  public record AssistCancelResponse(
      String id,
      String state) {

    /** With its required fields; the rest are null. */
    public static AssistCancelResponse of(String id, String state) {
      return new AssistCancelResponse(id, state);
    }

    public AssistCancelResponse withId(String value) {
      return new AssistCancelResponse(value, state);
    }

    public AssistCancelResponse withState(String value) {
      return new AssistCancelResponse(id, value);
    }
  }

  public record AssistClaimResponse(
      String id,
      @Json.Name("lease_token") String leaseToken,
      @Json.Name("lease_until") Double leaseUntil) {

    /** With its required fields; the rest are null. */
    public static AssistClaimResponse of(String id, String leaseToken, Double leaseUntil) {
      return new AssistClaimResponse(id, leaseToken, leaseUntil);
    }

    public AssistClaimResponse withId(String value) {
      return new AssistClaimResponse(value, leaseToken, leaseUntil);
    }

    public AssistClaimResponse withLeaseToken(String value) {
      return new AssistClaimResponse(id, value, leaseUntil);
    }

    public AssistClaimResponse withLeaseUntil(Double value) {
      return new AssistClaimResponse(id, leaseToken, value);
    }
  }

  public record AssistCreateResponse(
      String id) {

    /** With its required fields; the rest are null. */
    public static AssistCreateResponse of(String id) {
      return new AssistCreateResponse(id);
    }

    public AssistCreateResponse withId(String value) {
      return new AssistCreateResponse(value);
    }
  }

  public record AssistDelegateRequest(
      @Json.Name("worker_id") String workerId,
      String role,
      String task,
      @Json.Name("lease_token") String leaseToken) {

    /** With its required fields; the rest are null. */
    public static AssistDelegateRequest of(String workerId, String role, String task, String leaseToken) {
      return new AssistDelegateRequest(workerId, role, task, leaseToken);
    }

    public AssistDelegateRequest withWorkerId(String value) {
      return new AssistDelegateRequest(value, role, task, leaseToken);
    }

    public AssistDelegateRequest withRole(String value) {
      return new AssistDelegateRequest(workerId, value, task, leaseToken);
    }

    public AssistDelegateRequest withTask(String value) {
      return new AssistDelegateRequest(workerId, role, value, leaseToken);
    }

    public AssistDelegateRequest withLeaseToken(String value) {
      return new AssistDelegateRequest(workerId, role, task, value);
    }
  }

  public record AssistDelegateResponse(
      String id) {

    /** With its required fields; the rest are null. */
    public static AssistDelegateResponse of(String id) {
      return new AssistDelegateResponse(id);
    }

    public AssistDelegateResponse withId(String value) {
      return new AssistDelegateResponse(value);
    }
  }

  public record AssistFinishRequest(
      @Json.Name("lease_token") String leaseToken,
      Object completion) {

    /** With its required fields; the rest are null. */
    public static AssistFinishRequest of(String leaseToken, Object completion) {
      return new AssistFinishRequest(leaseToken, completion);
    }

    public AssistFinishRequest withLeaseToken(String value) {
      return new AssistFinishRequest(value, completion);
    }

    public AssistFinishRequest withCompletion(Object value) {
      return new AssistFinishRequest(leaseToken, value);
    }
  }

  public record AssistFinishResponse(
      String id,
      String state,
      @Json.Name("result_record_id") String resultRecordId) {

    /** With its required fields; the rest are null. */
    public static AssistFinishResponse of(String id, String state, String resultRecordId) {
      return new AssistFinishResponse(id, state, resultRecordId);
    }

    public AssistFinishResponse withId(String value) {
      return new AssistFinishResponse(value, state, resultRecordId);
    }

    public AssistFinishResponse withState(String value) {
      return new AssistFinishResponse(id, value, resultRecordId);
    }

    public AssistFinishResponse withResultRecordId(String value) {
      return new AssistFinishResponse(id, state, value);
    }
  }

  public record AssistHeartbeatRequest(
      @Json.Name("lease_token") String leaseToken) {

    /** With its required fields; the rest are null. */
    public static AssistHeartbeatRequest of(String leaseToken) {
      return new AssistHeartbeatRequest(leaseToken);
    }

    public AssistHeartbeatRequest withLeaseToken(String value) {
      return new AssistHeartbeatRequest(value);
    }
  }

  public record AssistHeartbeatResponse(
      String id,
      @Json.Name("lease_until") Double leaseUntil) {

    /** With its required fields; the rest are null. */
    public static AssistHeartbeatResponse of(String id, Double leaseUntil) {
      return new AssistHeartbeatResponse(id, leaseUntil);
    }

    public AssistHeartbeatResponse withId(String value) {
      return new AssistHeartbeatResponse(value, leaseUntil);
    }

    public AssistHeartbeatResponse withLeaseUntil(Double value) {
      return new AssistHeartbeatResponse(id, value);
    }
  }

  public record AssistReadRequest(
      @Json.Name("lease_token") String leaseToken,
      Request request) {

    /** With its required fields; the rest are null. */
    public static AssistReadRequest of(String leaseToken, Request request) {
      return new AssistReadRequest(leaseToken, request);
    }

    public AssistReadRequest withLeaseToken(String value) {
      return new AssistReadRequest(value, request);
    }

    public AssistReadRequest withRequest(Request value) {
      return new AssistReadRequest(leaseToken, value);
    }

    public record Request(
        String operation,
        String id,
        Map<String, Object> input) {

      /** With its required fields; the rest are null. */
      public static Request of(String operation) {
        return new Request(operation, null, null);
      }

      public Request withOperation(String value) {
        return new Request(value, id, input);
      }

      public Request withId(String value) {
        return new Request(operation, value, input);
      }

      public Request withInput(Map<String, Object> value) {
        return new Request(operation, id, value);
      }
    }
  }

  public record CacheDeleteResponse(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      Boolean removed) {

    /** With its required fields; the rest are null. */
    public static CacheDeleteResponse of(String id, Boolean removed) {
      return new CacheDeleteResponse(id, null, null, null, null, removed);
    }

    public CacheDeleteResponse withId(String value) {
      return new CacheDeleteResponse(value, version, jobId, seq, generation, removed);
    }

    public CacheDeleteResponse withVersion(Double value) {
      return new CacheDeleteResponse(id, value, jobId, seq, generation, removed);
    }

    public CacheDeleteResponse withJobId(String value) {
      return new CacheDeleteResponse(id, version, value, seq, generation, removed);
    }

    public CacheDeleteResponse withSeq(Double value) {
      return new CacheDeleteResponse(id, version, jobId, value, generation, removed);
    }

    public CacheDeleteResponse withGeneration(Double value) {
      return new CacheDeleteResponse(id, version, jobId, seq, value, removed);
    }

    public CacheDeleteResponse withRemoved(Boolean value) {
      return new CacheDeleteResponse(id, version, jobId, seq, generation, value);
    }
  }

  public record CancelAttemptResponse(
      List<String> cancelled) {

    /** With its required fields; the rest are null. */
    public static CancelAttemptResponse of(List<String> cancelled) {
      return new CancelAttemptResponse(cancelled);
    }

    public CancelAttemptResponse withCancelled(List<String> value) {
      return new CancelAttemptResponse(value);
    }
  }

  public record CanvasesResponseItem(
      String id,
      String name) {

    /** With its required fields; the rest are null. */
    public static CanvasesResponseItem of(String id, String name) {
      return new CanvasesResponseItem(id, name);
    }

    public CanvasesResponseItem withId(String value) {
      return new CanvasesResponseItem(value, name);
    }

    public CanvasesResponseItem withName(String value) {
      return new CanvasesResponseItem(id, value);
    }
  }

  public record PublishedPanelNode(
      String id,
      @Json.Name("canvas_id") String canvasId,
      String type,
      @Json.Name("creator_name") String creatorName,
      @Json.Name("updated_at") Double updatedAt,
      Data data) {

    /** With its required fields; the rest are null. */
    public static PublishedPanelNode of(String id, String canvasId, String type, String creatorName, Double updatedAt, Data data) {
      return new PublishedPanelNode(id, canvasId, type, creatorName, updatedAt, data);
    }

    public PublishedPanelNode withId(String value) {
      return new PublishedPanelNode(value, canvasId, type, creatorName, updatedAt, data);
    }

    public PublishedPanelNode withCanvasId(String value) {
      return new PublishedPanelNode(id, value, type, creatorName, updatedAt, data);
    }

    public PublishedPanelNode withType(String value) {
      return new PublishedPanelNode(id, canvasId, value, creatorName, updatedAt, data);
    }

    public PublishedPanelNode withCreatorName(String value) {
      return new PublishedPanelNode(id, canvasId, type, value, updatedAt, data);
    }

    public PublishedPanelNode withUpdatedAt(Double value) {
      return new PublishedPanelNode(id, canvasId, type, creatorName, value, data);
    }

    public PublishedPanelNode withData(Data value) {
      return new PublishedPanelNode(id, canvasId, type, creatorName, updatedAt, value);
    }

    public record Data(
        String panelRevision) {

      /** With its required fields; the rest are null. */
      public static Data of() {
        return new Data(null);
      }

      public Data withPanelRevision(String value) {
        return new Data(value);
      }
    }
  }

  public record CanvasResponse(
      List<PublishedPanelNode> nodes) {

    /** With its required fields; the rest are null. */
    public static CanvasResponse of(List<PublishedPanelNode> nodes) {
      return new CanvasResponse(nodes);
    }

    public CanvasResponse withNodes(List<PublishedPanelNode> value) {
      return new CanvasResponse(value);
    }
  }

  public record CaptureBatchRequest(
      List<ItemsItem> items) {

    /** With its required fields; the rest are null. */
    public static CaptureBatchRequest of(List<ItemsItem> items) {
      return new CaptureBatchRequest(items);
    }

    public CaptureBatchRequest withItems(List<ItemsItem> value) {
      return new CaptureBatchRequest(value);
    }

    public record ItemsItem(
        Object content,
        @Json.Name("session_id") String sessionId,
        String key) {

      /** With its required fields; the rest are null. */
      public static ItemsItem of(Object content, String key) {
        return new ItemsItem(content, null, key);
      }

      public ItemsItem withContent(Object value) {
        return new ItemsItem(value, sessionId, key);
      }

      public ItemsItem withSessionId(String value) {
        return new ItemsItem(content, value, key);
      }

      public ItemsItem withKey(String value) {
        return new ItemsItem(content, sessionId, value);
      }
    }
  }

  public record MemoryReceipt(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation) {

    /** With its required fields; the rest are null. */
    public static MemoryReceipt of(String id) {
      return new MemoryReceipt(id, null, null, null, null);
    }

    public MemoryReceipt withId(String value) {
      return new MemoryReceipt(value, version, jobId, seq, generation);
    }

    public MemoryReceipt withVersion(Double value) {
      return new MemoryReceipt(id, value, jobId, seq, generation);
    }

    public MemoryReceipt withJobId(String value) {
      return new MemoryReceipt(id, version, value, seq, generation);
    }

    public MemoryReceipt withSeq(Double value) {
      return new MemoryReceipt(id, version, jobId, value, generation);
    }

    public MemoryReceipt withGeneration(Double value) {
      return new MemoryReceipt(id, version, jobId, seq, value);
    }
  }

  public record CaptureBatchResponse(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      List<MemoryReceipt> receipts) {

    /** With its required fields; the rest are null. */
    public static CaptureBatchResponse of(String id, List<MemoryReceipt> receipts) {
      return new CaptureBatchResponse(id, null, null, null, null, receipts);
    }

    public CaptureBatchResponse withId(String value) {
      return new CaptureBatchResponse(value, version, jobId, seq, generation, receipts);
    }

    public CaptureBatchResponse withVersion(Double value) {
      return new CaptureBatchResponse(id, value, jobId, seq, generation, receipts);
    }

    public CaptureBatchResponse withJobId(String value) {
      return new CaptureBatchResponse(id, version, value, seq, generation, receipts);
    }

    public CaptureBatchResponse withSeq(Double value) {
      return new CaptureBatchResponse(id, version, jobId, value, generation, receipts);
    }

    public CaptureBatchResponse withGeneration(Double value) {
      return new CaptureBatchResponse(id, version, jobId, seq, value, receipts);
    }

    public CaptureBatchResponse withReceipts(List<MemoryReceipt> value) {
      return new CaptureBatchResponse(id, version, jobId, seq, generation, value);
    }
  }

  public record CaptureRequest(
      Object content,
      @Json.Name("session_id") String sessionId) {

    /** With its required fields; the rest are null. */
    public static CaptureRequest of(Object content) {
      return new CaptureRequest(content, null);
    }

    public CaptureRequest withContent(Object value) {
      return new CaptureRequest(value, sessionId);
    }

    public CaptureRequest withSessionId(String value) {
      return new CaptureRequest(content, value);
    }
  }

  public record CatalogPanelSource(
      String kind,
      String resource,
      Map<String, String> params,
      Map<String, Object> query) {

    /** With its required fields; the rest are null. */
    public static CatalogPanelSource of(String kind, String resource) {
      return new CatalogPanelSource(kind, resource, null, null);
    }

    public CatalogPanelSource withKind(String value) {
      return new CatalogPanelSource(value, resource, params, query);
    }

    public CatalogPanelSource withResource(String value) {
      return new CatalogPanelSource(kind, value, params, query);
    }

    public CatalogPanelSource withParams(Map<String, String> value) {
      return new CatalogPanelSource(kind, resource, value, query);
    }

    public CatalogPanelSource withQuery(Map<String, Object> value) {
      return new CatalogPanelSource(kind, resource, params, value);
    }
  }

  public record ChannelsResponse(
      List<ChannelsItem> channels) {

    /** With its required fields; the rest are null. */
    public static ChannelsResponse of(List<ChannelsItem> channels) {
      return new ChannelsResponse(channels);
    }

    public ChannelsResponse withChannels(List<ChannelsItem> value) {
      return new ChannelsResponse(value);
    }

    public record ChannelsItem(
        String id,
        String name) {

      /** With its required fields; the rest are null. */
      public static ChannelsItem of(String id, String name) {
        return new ChannelsItem(id, name);
      }

      public ChannelsItem withId(String value) {
        return new ChannelsItem(value, name);
      }

      public ChannelsItem withName(String value) {
        return new ChannelsItem(id, value);
      }
    }
  }

  public record CommitTransferRequest(
      String sha256) {

    /** With its required fields; the rest are null. */
    public static CommitTransferRequest of(String sha256) {
      return new CommitTransferRequest(sha256);
    }

    public CommitTransferRequest withSha256(String value) {
      return new CommitTransferRequest(value);
    }
  }

  public record CommitTransferResponse(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      @Json.Name("portable_ids_preserved") Boolean portableIdsPreserved) {

    /** With its required fields; the rest are null. */
    public static CommitTransferResponse of(String id, Boolean portableIdsPreserved) {
      return new CommitTransferResponse(id, null, null, null, null, portableIdsPreserved);
    }

    public CommitTransferResponse withId(String value) {
      return new CommitTransferResponse(value, version, jobId, seq, generation, portableIdsPreserved);
    }

    public CommitTransferResponse withVersion(Double value) {
      return new CommitTransferResponse(id, value, jobId, seq, generation, portableIdsPreserved);
    }

    public CommitTransferResponse withJobId(String value) {
      return new CommitTransferResponse(id, version, value, seq, generation, portableIdsPreserved);
    }

    public CommitTransferResponse withSeq(Double value) {
      return new CommitTransferResponse(id, version, jobId, value, generation, portableIdsPreserved);
    }

    public CommitTransferResponse withGeneration(Double value) {
      return new CommitTransferResponse(id, version, jobId, seq, value, portableIdsPreserved);
    }

    public CommitTransferResponse withPortableIdsPreserved(Boolean value) {
      return new CommitTransferResponse(id, version, jobId, seq, generation, value);
    }
  }

  /**
   * Caller-selected alternatives are retrieval hints, never new assertions.
   */
  public record MemoryQueryExpansion(
      String policy,
      List<String> queries) {

    /** With its required fields; the rest are null. */
    public static MemoryQueryExpansion of(String policy, List<String> queries) {
      return new MemoryQueryExpansion(policy, queries);
    }

    public MemoryQueryExpansion withPolicy(String value) {
      return new MemoryQueryExpansion(value, queries);
    }

    public MemoryQueryExpansion withQueries(List<String> value) {
      return new MemoryQueryExpansion(policy, value);
    }
  }

  /**
   * @param validAt Validity of ranked records. Default: a record whose `valid_time.until` has passed (retired by a tombstone `revise`, a `resolve` loser) is excluded before ranking, so it never takes a result slot. `valid_at` (UTC ms) serves the records valid at that instant instead (`from &lt;= t &lt; until`, as `query` and `graph`). `include_ended: true` is the explicit history/audit read and returns every active record regardless of validity; it cannot be combined with `valid_at`. Exact `get`/`history` reads are never filtered.
   */
  public record ContextRequest(
      @Json.Name("include_stale") Boolean includeStale,
      String subject,
      String type,
      String tier,
      String query,
      MemoryQueryExpansion expansion,
      Double limit,
      String mode,
      @Json.Name("allow_degraded") Boolean allowDegraded,
      @Json.Name("valid_at") Double validAt,
      @Json.Name("include_ended") Boolean includeEnded,
      @Json.Name("budget_tokens") Double budgetTokens) {

    /** With its required fields; the rest are null. */
    public static ContextRequest of(String query) {
      return new ContextRequest(null, null, null, null, query, null, null, null, null, null, null, null);
    }

    public ContextRequest withIncludeStale(Boolean value) {
      return new ContextRequest(value, subject, type, tier, query, expansion, limit, mode, allowDegraded, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withSubject(String value) {
      return new ContextRequest(includeStale, value, type, tier, query, expansion, limit, mode, allowDegraded, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withType(String value) {
      return new ContextRequest(includeStale, subject, value, tier, query, expansion, limit, mode, allowDegraded, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withTier(String value) {
      return new ContextRequest(includeStale, subject, type, value, query, expansion, limit, mode, allowDegraded, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withQuery(String value) {
      return new ContextRequest(includeStale, subject, type, tier, value, expansion, limit, mode, allowDegraded, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withExpansion(MemoryQueryExpansion value) {
      return new ContextRequest(includeStale, subject, type, tier, query, value, limit, mode, allowDegraded, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withLimit(Double value) {
      return new ContextRequest(includeStale, subject, type, tier, query, expansion, value, mode, allowDegraded, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withMode(String value) {
      return new ContextRequest(includeStale, subject, type, tier, query, expansion, limit, value, allowDegraded, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withAllowDegraded(Boolean value) {
      return new ContextRequest(includeStale, subject, type, tier, query, expansion, limit, mode, value, validAt, includeEnded, budgetTokens);
    }

    public ContextRequest withValidAt(Double value) {
      return new ContextRequest(includeStale, subject, type, tier, query, expansion, limit, mode, allowDegraded, value, includeEnded, budgetTokens);
    }

    public ContextRequest withIncludeEnded(Boolean value) {
      return new ContextRequest(includeStale, subject, type, tier, query, expansion, limit, mode, allowDegraded, validAt, value, budgetTokens);
    }

    public ContextRequest withBudgetTokens(Double value) {
      return new ContextRequest(includeStale, subject, type, tier, query, expansion, limit, mode, allowDegraded, validAt, includeEnded, value);
    }
  }

  public record ContextResponse(
      String text,
      List<CitationsItem> citations,
      @Json.Name("estimated_tokens") Double estimatedTokens,
      Double generation,
      List<String> degraded) {

    /** With its required fields; the rest are null. */
    public static ContextResponse of(String text, List<CitationsItem> citations, Double estimatedTokens, Double generation, List<String> degraded) {
      return new ContextResponse(text, citations, estimatedTokens, generation, degraded);
    }

    public ContextResponse withText(String value) {
      return new ContextResponse(value, citations, estimatedTokens, generation, degraded);
    }

    public ContextResponse withCitations(List<CitationsItem> value) {
      return new ContextResponse(text, value, estimatedTokens, generation, degraded);
    }

    public ContextResponse withEstimatedTokens(Double value) {
      return new ContextResponse(text, citations, value, generation, degraded);
    }

    public ContextResponse withGeneration(Double value) {
      return new ContextResponse(text, citations, estimatedTokens, value, degraded);
    }

    public ContextResponse withDegraded(List<String> value) {
      return new ContextResponse(text, citations, estimatedTokens, generation, value);
    }

    public record CitationsItem(
        String id,
        Double version,
        @Json.Name("source_ids") List<String> sourceIds,
        Boolean truncated) {

      /** With its required fields; the rest are null. */
      public static CitationsItem of(String id, Double version, List<String> sourceIds, Boolean truncated) {
        return new CitationsItem(id, version, sourceIds, truncated);
      }

      public CitationsItem withId(String value) {
        return new CitationsItem(value, version, sourceIds, truncated);
      }

      public CitationsItem withVersion(Double value) {
        return new CitationsItem(id, value, sourceIds, truncated);
      }

      public CitationsItem withSourceIds(List<String> value) {
        return new CitationsItem(id, version, value, truncated);
      }

      public CitationsItem withTruncated(Boolean value) {
        return new CitationsItem(id, version, sourceIds, value);
      }
    }
  }

  public record ControlRequest(
      String targetId,
      String clientMessageId,
      Object control) {

    /** With its required fields; the rest are null. */
    public static ControlRequest of(String targetId, String clientMessageId, Object control) {
      return new ControlRequest(targetId, clientMessageId, control);
    }

    public ControlRequest withTargetId(String value) {
      return new ControlRequest(value, clientMessageId, control);
    }

    public ControlRequest withClientMessageId(String value) {
      return new ControlRequest(targetId, value, control);
    }

    public ControlRequest withControl(Object value) {
      return new ControlRequest(targetId, clientMessageId, value);
    }
  }

  public record CreateCanvasRequest(
      String name,
      String description) {

    /** With its required fields; the rest are null. */
    public static CreateCanvasRequest of(String name) {
      return new CreateCanvasRequest(name, null);
    }

    public CreateCanvasRequest withName(String value) {
      return new CreateCanvasRequest(value, description);
    }

    public CreateCanvasRequest withDescription(String value) {
      return new CreateCanvasRequest(name, value);
    }
  }

  public record CreateCanvasResponse(
      String id,
      String name) {

    /** With its required fields; the rest are null. */
    public static CreateCanvasResponse of(String id, String name) {
      return new CreateCanvasResponse(id, name);
    }

    public CreateCanvasResponse withId(String value) {
      return new CreateCanvasResponse(value, name);
    }

    public CreateCanvasResponse withName(String value) {
      return new CreateCanvasResponse(id, value);
    }
  }

  public record CreateSpaceRequest(
      String name) {

    /** With its required fields; the rest are null. */
    public static CreateSpaceRequest of(String name) {
      return new CreateSpaceRequest(name);
    }

    public CreateSpaceRequest withName(String value) {
      return new CreateSpaceRequest(value);
    }
  }

  public record RoutingMessage(
      String clientMessageId,
      String targetId,
      String kind,
      Object payload,
      String id,
      String sourceId,
      String status,
      Double createdAt,
      Double acknowledgedAt) {

    /** With its required fields; the rest are null. */
    public static RoutingMessage of(String clientMessageId, String targetId, String kind, Object payload, String id, String sourceId, String status, Double createdAt, Double acknowledgedAt) {
      return new RoutingMessage(clientMessageId, targetId, kind, payload, id, sourceId, status, createdAt, acknowledgedAt);
    }

    public RoutingMessage withClientMessageId(String value) {
      return new RoutingMessage(value, targetId, kind, payload, id, sourceId, status, createdAt, acknowledgedAt);
    }

    public RoutingMessage withTargetId(String value) {
      return new RoutingMessage(clientMessageId, value, kind, payload, id, sourceId, status, createdAt, acknowledgedAt);
    }

    public RoutingMessage withKind(String value) {
      return new RoutingMessage(clientMessageId, targetId, value, payload, id, sourceId, status, createdAt, acknowledgedAt);
    }

    public RoutingMessage withPayload(Object value) {
      return new RoutingMessage(clientMessageId, targetId, kind, value, id, sourceId, status, createdAt, acknowledgedAt);
    }

    public RoutingMessage withId(String value) {
      return new RoutingMessage(clientMessageId, targetId, kind, payload, value, sourceId, status, createdAt, acknowledgedAt);
    }

    public RoutingMessage withSourceId(String value) {
      return new RoutingMessage(clientMessageId, targetId, kind, payload, id, value, status, createdAt, acknowledgedAt);
    }

    public RoutingMessage withStatus(String value) {
      return new RoutingMessage(clientMessageId, targetId, kind, payload, id, sourceId, value, createdAt, acknowledgedAt);
    }

    public RoutingMessage withCreatedAt(Double value) {
      return new RoutingMessage(clientMessageId, targetId, kind, payload, id, sourceId, status, value, acknowledgedAt);
    }

    public RoutingMessage withAcknowledgedAt(Double value) {
      return new RoutingMessage(clientMessageId, targetId, kind, payload, id, sourceId, status, createdAt, value);
    }
  }

  public record DeliveriesResponse(
      List<RoutingMessage> messages) {

    /** With its required fields; the rest are null. */
    public static DeliveriesResponse of(List<RoutingMessage> messages) {
      return new DeliveriesResponse(messages);
    }

    public DeliveriesResponse withMessages(List<RoutingMessage> value) {
      return new DeliveriesResponse(value);
    }
  }

  public record EraseInvestigationResponse(
      Boolean erased) {

    /** With its required fields; the rest are null. */
    public static EraseInvestigationResponse of(Boolean erased) {
      return new EraseInvestigationResponse(erased);
    }

    public EraseInvestigationResponse withErased(Boolean value) {
      return new EraseInvestigationResponse(value);
    }
  }

  public record FederatedReadResponse(
      Origin origin,
      Object result) {

    /** With its required fields; the rest are null. */
    public static FederatedReadResponse of(Origin origin, Object result) {
      return new FederatedReadResponse(origin, result);
    }

    public FederatedReadResponse withOrigin(Origin value) {
      return new FederatedReadResponse(value, result);
    }

    public FederatedReadResponse withResult(Object value) {
      return new FederatedReadResponse(origin, value);
    }

    public record Origin(
        String mount,
        @Json.Name("space_id") String spaceId,
        String id) {

      /** With its required fields; the rest are null. */
      public static Origin of(String mount, String spaceId, String id) {
        return new Origin(mount, spaceId, id);
      }

      public Origin withMount(String value) {
        return new Origin(value, spaceId, id);
      }

      public Origin withSpaceId(String value) {
        return new Origin(mount, value, id);
      }

      public Origin withId(String value) {
        return new Origin(mount, spaceId, value);
      }
    }
  }

  public record MemoryPlanStep(
      String operation,
      Map<String, Object> input) {

    /** With its required fields; the rest are null. */
    public static MemoryPlanStep of(String operation, Map<String, Object> input) {
      return new MemoryPlanStep(operation, input);
    }

    public MemoryPlanStep withOperation(String value) {
      return new MemoryPlanStep(value, input);
    }

    public MemoryPlanStep withInput(Map<String, Object> value) {
      return new MemoryPlanStep(operation, value);
    }
  }

  /**
   * One bounded retrieval, including witnessed original-source reads.
   *
   * @param observe Include a bounded candidate pool for explicit episode capture and offline comparison.
   * @param maxBytes Serialized evidence-array budget; plan and diagnostic metadata are separate.
   * @param sourceBytes Maximum UTF-8 text bytes read per original source.
   */
  public record MemoryRetrievalInput(
      String task,
      String selection,
      MemoryQueryExpansion expansion,
      List<Object> requirements,
      Boolean observe,
      List<MemoryPlanStep> steps,
      @Json.Name("use_model") Boolean useModel,
      Boolean broaden,
      @Json.Name("valid_at") Double validAt,
      @Json.Name("max_results") Double maxResults,
      @Json.Name("max_bytes") Double maxBytes,
      @Json.Name("source_bytes") Double sourceBytes) {

    /** With its required fields; the rest are null. */
    public static MemoryRetrievalInput of(String task) {
      return new MemoryRetrievalInput(task, null, null, null, null, null, null, null, null, null, null, null);
    }

    public MemoryRetrievalInput withTask(String value) {
      return new MemoryRetrievalInput(value, selection, expansion, requirements, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withSelection(String value) {
      return new MemoryRetrievalInput(task, value, expansion, requirements, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withExpansion(MemoryQueryExpansion value) {
      return new MemoryRetrievalInput(task, selection, value, requirements, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withRequirements(List<Object> value) {
      return new MemoryRetrievalInput(task, selection, expansion, value, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withObserve(Boolean value) {
      return new MemoryRetrievalInput(task, selection, expansion, requirements, value, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withSteps(List<MemoryPlanStep> value) {
      return new MemoryRetrievalInput(task, selection, expansion, requirements, observe, value, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withUseModel(Boolean value) {
      return new MemoryRetrievalInput(task, selection, expansion, requirements, observe, steps, value, broaden, validAt, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withBroaden(Boolean value) {
      return new MemoryRetrievalInput(task, selection, expansion, requirements, observe, steps, useModel, value, validAt, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withValidAt(Double value) {
      return new MemoryRetrievalInput(task, selection, expansion, requirements, observe, steps, useModel, broaden, value, maxResults, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withMaxResults(Double value) {
      return new MemoryRetrievalInput(task, selection, expansion, requirements, observe, steps, useModel, broaden, validAt, value, maxBytes, sourceBytes);
    }

    public MemoryRetrievalInput withMaxBytes(Double value) {
      return new MemoryRetrievalInput(task, selection, expansion, requirements, observe, steps, useModel, broaden, validAt, maxResults, value, sourceBytes);
    }

    public MemoryRetrievalInput withSourceBytes(Double value) {
      return new MemoryRetrievalInput(task, selection, expansion, requirements, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, value);
    }
  }

  public record FederatedRetrieveRequest(
      List<String> mounts,
      MemoryRetrievalInput retrieval,
      @Json.Name("allow_partial") Boolean allowPartial) {

    /** With its required fields; the rest are null. */
    public static FederatedRetrieveRequest of(List<String> mounts, MemoryRetrievalInput retrieval) {
      return new FederatedRetrieveRequest(mounts, retrieval, null);
    }

    public FederatedRetrieveRequest withMounts(List<String> value) {
      return new FederatedRetrieveRequest(value, retrieval, allowPartial);
    }

    public FederatedRetrieveRequest withRetrieval(MemoryRetrievalInput value) {
      return new FederatedRetrieveRequest(mounts, value, allowPartial);
    }

    public FederatedRetrieveRequest withAllowPartial(Boolean value) {
      return new FederatedRetrieveRequest(mounts, retrieval, value);
    }
  }

  public record FederationMountsResponse(
      List<String> mounts) {

    /** With its required fields; the rest are null. */
    public static FederationMountsResponse of(List<String> mounts) {
      return new FederationMountsResponse(mounts);
    }

    public FederationMountsResponse withMounts(List<String> value) {
      return new FederationMountsResponse(value);
    }
  }

  public record ForgetMemoryInput(
      @Json.Name("record_ids") List<String> recordIds,
      @Json.Name("source_ids") List<String> sourceIds,
      Boolean all,
      @Json.Name("expected_generation") Double expectedGeneration) {

    /** With its required fields; the rest are null. */
    public static ForgetMemoryInput of() {
      return new ForgetMemoryInput(null, null, null, null);
    }

    public ForgetMemoryInput withRecordIds(List<String> value) {
      return new ForgetMemoryInput(value, sourceIds, all, expectedGeneration);
    }

    public ForgetMemoryInput withSourceIds(List<String> value) {
      return new ForgetMemoryInput(recordIds, value, all, expectedGeneration);
    }

    public ForgetMemoryInput withAll(Boolean value) {
      return new ForgetMemoryInput(recordIds, sourceIds, value, expectedGeneration);
    }

    public ForgetMemoryInput withExpectedGeneration(Double value) {
      return new ForgetMemoryInput(recordIds, sourceIds, all, value);
    }
  }

  public record GrantInvestigationRequest(
      String name,
      String access) {

    /** With its required fields; the rest are null. */
    public static GrantInvestigationRequest of(String name, String access) {
      return new GrantInvestigationRequest(name, access);
    }

    public GrantInvestigationRequest withName(String value) {
      return new GrantInvestigationRequest(value, access);
    }

    public GrantInvestigationRequest withAccess(String value) {
      return new GrantInvestigationRequest(name, value);
    }
  }

  public record GrantInvestigationResponse(
      String name,
      String access) {

    /** With its required fields; the rest are null. */
    public static GrantInvestigationResponse of(String name, String access) {
      return new GrantInvestigationResponse(name, access);
    }

    public GrantInvestigationResponse withName(String value) {
      return new GrantInvestigationResponse(value, access);
    }

    public GrantInvestigationResponse withAccess(String value) {
      return new GrantInvestigationResponse(name, value);
    }
  }

  public record GrantRequest(
      @Json.Name("principal_id") String principalId,
      String role) {

    /** With its required fields; the rest are null. */
    public static GrantRequest of(String principalId, String role) {
      return new GrantRequest(principalId, role);
    }

    public GrantRequest withPrincipalId(String value) {
      return new GrantRequest(value, role);
    }

    public GrantRequest withRole(String value) {
      return new GrantRequest(principalId, value);
    }
  }

  public record ImportBundleResponse(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      @Json.Name("portable_ids_preserved") Boolean portableIdsPreserved) {

    /** With its required fields; the rest are null. */
    public static ImportBundleResponse of(String id, Boolean portableIdsPreserved) {
      return new ImportBundleResponse(id, null, null, null, null, portableIdsPreserved);
    }

    public ImportBundleResponse withId(String value) {
      return new ImportBundleResponse(value, version, jobId, seq, generation, portableIdsPreserved);
    }

    public ImportBundleResponse withVersion(Double value) {
      return new ImportBundleResponse(id, value, jobId, seq, generation, portableIdsPreserved);
    }

    public ImportBundleResponse withJobId(String value) {
      return new ImportBundleResponse(id, version, value, seq, generation, portableIdsPreserved);
    }

    public ImportBundleResponse withSeq(Double value) {
      return new ImportBundleResponse(id, version, jobId, value, generation, portableIdsPreserved);
    }

    public ImportBundleResponse withGeneration(Double value) {
      return new ImportBundleResponse(id, version, jobId, seq, value, portableIdsPreserved);
    }

    public ImportBundleResponse withPortableIdsPreserved(Boolean value) {
      return new ImportBundleResponse(id, version, jobId, seq, generation, value);
    }
  }

  public record InboxResponse(
      List<RoutingMessage> messages) {

    /** With its required fields; the rest are null. */
    public static InboxResponse of(List<RoutingMessage> messages) {
      return new InboxResponse(messages);
    }

    public InboxResponse withMessages(List<RoutingMessage> value) {
      return new InboxResponse(value);
    }
  }

  public record InteractPanelResponse(
      String status,
      String message,
      Receipt receipt) {

    /** With its required fields; the rest are null. */
    public static InteractPanelResponse of(String status) {
      return new InteractPanelResponse(status, null, null);
    }

    public InteractPanelResponse withStatus(String value) {
      return new InteractPanelResponse(value, message, receipt);
    }

    public InteractPanelResponse withMessage(String value) {
      return new InteractPanelResponse(status, value, receipt);
    }

    public InteractPanelResponse withReceipt(Receipt value) {
      return new InteractPanelResponse(status, message, value);
    }

    public record Receipt(
        String id,
        String status) {

      /** With its required fields; the rest are null. */
      public static Receipt of(String id, String status) {
        return new Receipt(id, status);
      }

      public Receipt withId(String value) {
        return new Receipt(value, status);
      }

      public Receipt withStatus(String value) {
        return new Receipt(id, value);
      }
    }
  }

  /**
   * @param key Authenticated durable account, never a caller-supplied display name.
   */
  public record InvestigationActor(
      String key,
      String name) {

    /** With its required fields; the rest are null. */
    public static InvestigationActor of(String key, String name) {
      return new InvestigationActor(key, name);
    }

    public InvestigationActor withKey(String value) {
      return new InvestigationActor(value, name);
    }

    public InvestigationActor withName(String value) {
      return new InvestigationActor(key, value);
    }
  }

  /**
   * @param caseId Existing case for a new attempt; prior results remain immutable.
   * @param parentAttemptId An owned child while its parent runs; otherwise a new episode referencing prior work.
   */
  public record InvestigationRequest(
      String kind,
      String question,
      Object answer,
      String context,
      String horizon,
      String asOf,
      String caseId,
      String parentAttemptId,
      Double runs,
      Limits limits) {

    /** With its required fields; the rest are null. */
    public static InvestigationRequest of(String kind, String question) {
      return new InvestigationRequest(kind, question, null, null, null, null, null, null, null, null);
    }

    public InvestigationRequest withKind(String value) {
      return new InvestigationRequest(value, question, answer, context, horizon, asOf, caseId, parentAttemptId, runs, limits);
    }

    public InvestigationRequest withQuestion(String value) {
      return new InvestigationRequest(kind, value, answer, context, horizon, asOf, caseId, parentAttemptId, runs, limits);
    }

    public InvestigationRequest withAnswer(Object value) {
      return new InvestigationRequest(kind, question, value, context, horizon, asOf, caseId, parentAttemptId, runs, limits);
    }

    public InvestigationRequest withContext(String value) {
      return new InvestigationRequest(kind, question, answer, value, horizon, asOf, caseId, parentAttemptId, runs, limits);
    }

    public InvestigationRequest withHorizon(String value) {
      return new InvestigationRequest(kind, question, answer, context, value, asOf, caseId, parentAttemptId, runs, limits);
    }

    public InvestigationRequest withAsOf(String value) {
      return new InvestigationRequest(kind, question, answer, context, horizon, value, caseId, parentAttemptId, runs, limits);
    }

    public InvestigationRequest withCaseId(String value) {
      return new InvestigationRequest(kind, question, answer, context, horizon, asOf, value, parentAttemptId, runs, limits);
    }

    public InvestigationRequest withParentAttemptId(String value) {
      return new InvestigationRequest(kind, question, answer, context, horizon, asOf, caseId, value, runs, limits);
    }

    public InvestigationRequest withRuns(Double value) {
      return new InvestigationRequest(kind, question, answer, context, horizon, asOf, caseId, parentAttemptId, value, limits);
    }

    public InvestigationRequest withLimits(Limits value) {
      return new InvestigationRequest(kind, question, answer, context, horizon, asOf, caseId, parentAttemptId, runs, value);
    }

    public record Limits(
        Double calls,
        Double concurrency,
        Double timeoutMs) {

      /** With its required fields; the rest are null. */
      public static Limits of() {
        return new Limits(null, null, null);
      }

      public Limits withCalls(Double value) {
        return new Limits(value, concurrency, timeoutMs);
      }

      public Limits withConcurrency(Double value) {
        return new Limits(calls, value, timeoutMs);
      }

      public Limits withTimeoutMs(Double value) {
        return new Limits(calls, concurrency, value);
      }
    }
  }

  /**
   * @param sourceIds Only declared citations; proximity to a source is not entailment.
   */
  public record InvestigationReason(
      String actor,
      String text,
      List<String> sourceIds) {

    /** With its required fields; the rest are null. */
    public static InvestigationReason of(String actor, String text, List<String> sourceIds) {
      return new InvestigationReason(actor, text, sourceIds);
    }

    public InvestigationReason withActor(String value) {
      return new InvestigationReason(value, text, sourceIds);
    }

    public InvestigationReason withText(String value) {
      return new InvestigationReason(actor, value, sourceIds);
    }

    public InvestigationReason withSourceIds(List<String> value) {
      return new InvestigationReason(actor, text, value);
    }
  }

  public record InvestigationSource(
      String id,
      String url,
      String title) {

    /** With its required fields; the rest are null. */
    public static InvestigationSource of(String id, String url) {
      return new InvestigationSource(id, url, null);
    }

    public InvestigationSource withId(String value) {
      return new InvestigationSource(value, url, title);
    }

    public InvestigationSource withUrl(String value) {
      return new InvestigationSource(id, value, title);
    }

    public InvestigationSource withTitle(String value) {
      return new InvestigationSource(id, url, value);
    }
  }

  /**
   * @param outputId Raw executor output is private content, loaded separately from a compact result.
   */
  public record InvestigationResult(
      String schema,
      String kind,
      String summary,
      String availability,
      Object estimate,
      String report,
      List<InvestigationReason> reasons,
      List<InvestigationSource> sources,
      List<String> limitations,
      String horizon,
      String cutoff,
      Double answerId,
      String outputId,
      Capture capture,
      InvestigationResultAccounting accounting) {

    /** With its required fields; the rest are null. */
    public static InvestigationResult of(String schema, String kind, String summary, String availability, List<InvestigationReason> reasons, List<InvestigationSource> sources, List<String> limitations, Capture capture, InvestigationResultAccounting accounting) {
      return new InvestigationResult(schema, kind, summary, availability, null, null, reasons, sources, limitations, null, null, null, null, capture, accounting);
    }

    public InvestigationResult withSchema(String value) {
      return new InvestigationResult(value, kind, summary, availability, estimate, report, reasons, sources, limitations, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withKind(String value) {
      return new InvestigationResult(schema, value, summary, availability, estimate, report, reasons, sources, limitations, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withSummary(String value) {
      return new InvestigationResult(schema, kind, value, availability, estimate, report, reasons, sources, limitations, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withAvailability(String value) {
      return new InvestigationResult(schema, kind, summary, value, estimate, report, reasons, sources, limitations, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withEstimate(Object value) {
      return new InvestigationResult(schema, kind, summary, availability, value, report, reasons, sources, limitations, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withReport(String value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, value, reasons, sources, limitations, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withReasons(List<InvestigationReason> value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, value, sources, limitations, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withSources(List<InvestigationSource> value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, reasons, value, limitations, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withLimitations(List<String> value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, reasons, sources, value, horizon, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withHorizon(String value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, reasons, sources, limitations, value, cutoff, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withCutoff(String value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, reasons, sources, limitations, horizon, value, answerId, outputId, capture, accounting);
    }

    public InvestigationResult withAnswerId(Double value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, reasons, sources, limitations, horizon, cutoff, value, outputId, capture, accounting);
    }

    public InvestigationResult withOutputId(String value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, reasons, sources, limitations, horizon, cutoff, answerId, value, capture, accounting);
    }

    public InvestigationResult withCapture(Capture value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, reasons, sources, limitations, horizon, cutoff, answerId, outputId, value, accounting);
    }

    public InvestigationResult withAccounting(InvestigationResultAccounting value) {
      return new InvestigationResult(schema, kind, summary, availability, estimate, report, reasons, sources, limitations, horizon, cutoff, answerId, outputId, capture, value);
    }

    public record Capture(
        String status,
        List<String> gaps) {

      /** With its required fields; the rest are null. */
      public static Capture of(String status, List<String> gaps) {
        return new Capture(status, gaps);
      }

      public Capture withStatus(String value) {
        return new Capture(value, gaps);
      }

      public Capture withGaps(List<String> value) {
        return new Capture(status, value);
      }
    }

    /**
     * @param reasons Coverage gaps are independent of outstanding calls and answer availability.
     * @param reportedUsd Adapter totals can overlap; retained for diagnosis, never added to receipts.
     */
    public record InvestigationResultAccounting(
        Double knownUsd,
        Boolean complete,
        Double outstanding,
        List<String> reasons,
        Double pricedCalls,
        Double unknownCalls,
        Double reportedUsd) {

      /** With its required fields; the rest are null. */
      public static InvestigationResultAccounting of(Double knownUsd, Boolean complete, Double outstanding) {
        return new InvestigationResultAccounting(knownUsd, complete, outstanding, null, null, null, null);
      }

      public InvestigationResultAccounting withKnownUsd(Double value) {
        return new InvestigationResultAccounting(value, complete, outstanding, reasons, pricedCalls, unknownCalls, reportedUsd);
      }

      public InvestigationResultAccounting withComplete(Boolean value) {
        return new InvestigationResultAccounting(knownUsd, value, outstanding, reasons, pricedCalls, unknownCalls, reportedUsd);
      }

      public InvestigationResultAccounting withOutstanding(Double value) {
        return new InvestigationResultAccounting(knownUsd, complete, value, reasons, pricedCalls, unknownCalls, reportedUsd);
      }

      public InvestigationResultAccounting withReasons(List<String> value) {
        return new InvestigationResultAccounting(knownUsd, complete, outstanding, value, pricedCalls, unknownCalls, reportedUsd);
      }

      public InvestigationResultAccounting withPricedCalls(Double value) {
        return new InvestigationResultAccounting(knownUsd, complete, outstanding, reasons, value, unknownCalls, reportedUsd);
      }

      public InvestigationResultAccounting withUnknownCalls(Double value) {
        return new InvestigationResultAccounting(knownUsd, complete, outstanding, reasons, pricedCalls, value, reportedUsd);
      }

      public InvestigationResultAccounting withReportedUsd(Double value) {
        return new InvestigationResultAccounting(knownUsd, complete, outstanding, reasons, pricedCalls, unknownCalls, value);
      }
    }
  }

  /**
   * @param accounting Mutable settlement, separate from the immutable answer (including after cancellation).
   */
  public record InvestigationAttempt(
      String id,
      String caseId,
      InvestigationActor actor,
      String parentAttemptId,
      String rootAttemptId,
      InvestigationRequest request,
      String state,
      String generation,
      Double sequence,
      Double createdAt,
      Double updatedAt,
      Accounting accounting,
      InvestigationResult result,
      String error) {

    /** With its required fields; the rest are null. */
    public static InvestigationAttempt of(String id, String caseId, InvestigationActor actor, String rootAttemptId, InvestigationRequest request, String state, Double sequence, Double createdAt, Double updatedAt, Accounting accounting) {
      return new InvestigationAttempt(id, caseId, actor, null, rootAttemptId, request, state, null, sequence, createdAt, updatedAt, accounting, null, null);
    }

    public InvestigationAttempt withId(String value) {
      return new InvestigationAttempt(value, caseId, actor, parentAttemptId, rootAttemptId, request, state, generation, sequence, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withCaseId(String value) {
      return new InvestigationAttempt(id, value, actor, parentAttemptId, rootAttemptId, request, state, generation, sequence, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withActor(InvestigationActor value) {
      return new InvestigationAttempt(id, caseId, value, parentAttemptId, rootAttemptId, request, state, generation, sequence, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withParentAttemptId(String value) {
      return new InvestigationAttempt(id, caseId, actor, value, rootAttemptId, request, state, generation, sequence, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withRootAttemptId(String value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, value, request, state, generation, sequence, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withRequest(InvestigationRequest value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, value, state, generation, sequence, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withState(String value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, request, value, generation, sequence, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withGeneration(String value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, request, state, value, sequence, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withSequence(Double value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, request, state, generation, value, createdAt, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withCreatedAt(Double value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, request, state, generation, sequence, value, updatedAt, accounting, result, error);
    }

    public InvestigationAttempt withUpdatedAt(Double value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, request, state, generation, sequence, createdAt, value, accounting, result, error);
    }

    public InvestigationAttempt withAccounting(Accounting value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, request, state, generation, sequence, createdAt, updatedAt, value, result, error);
    }

    public InvestigationAttempt withResult(InvestigationResult value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, request, state, generation, sequence, createdAt, updatedAt, accounting, value, error);
    }

    public InvestigationAttempt withError(String value) {
      return new InvestigationAttempt(id, caseId, actor, parentAttemptId, rootAttemptId, request, state, generation, sequence, createdAt, updatedAt, accounting, result, value);
    }

    /**
     * Mutable settlement, separate from the immutable answer (including after cancellation).
     *
     * @param reasons Coverage gaps are independent of outstanding calls and answer availability.
     * @param reportedUsd Adapter totals can overlap; retained for diagnosis, never added to receipts.
     */
    public record Accounting(
        Double knownUsd,
        Boolean complete,
        Double outstanding,
        List<String> reasons,
        Double pricedCalls,
        Double unknownCalls,
        Double reportedUsd) {

      /** With its required fields; the rest are null. */
      public static Accounting of(Double knownUsd, Boolean complete, Double outstanding) {
        return new Accounting(knownUsd, complete, outstanding, null, null, null, null);
      }

      public Accounting withKnownUsd(Double value) {
        return new Accounting(value, complete, outstanding, reasons, pricedCalls, unknownCalls, reportedUsd);
      }

      public Accounting withComplete(Boolean value) {
        return new Accounting(knownUsd, value, outstanding, reasons, pricedCalls, unknownCalls, reportedUsd);
      }

      public Accounting withOutstanding(Double value) {
        return new Accounting(knownUsd, complete, value, reasons, pricedCalls, unknownCalls, reportedUsd);
      }

      public Accounting withReasons(List<String> value) {
        return new Accounting(knownUsd, complete, outstanding, value, pricedCalls, unknownCalls, reportedUsd);
      }

      public Accounting withPricedCalls(Double value) {
        return new Accounting(knownUsd, complete, outstanding, reasons, value, unknownCalls, reportedUsd);
      }

      public Accounting withUnknownCalls(Double value) {
        return new Accounting(knownUsd, complete, outstanding, reasons, pricedCalls, value, reportedUsd);
      }

      public Accounting withReportedUsd(Double value) {
        return new Accounting(knownUsd, complete, outstanding, reasons, pricedCalls, unknownCalls, value);
      }
    }
  }

  public record InvestigationCase(
      String schema,
      String id,
      String instanceId,
      InvestigationActor owner,
      String kind,
      String question,
      String selectedAttemptId,
      String currentAttemptId,
      Double createdAt,
      Double updatedAt,
      Object access) {

    /** With its required fields; the rest are null. */
    public static InvestigationCase of(String schema, String id, String instanceId, InvestigationActor owner, String kind, String question, String selectedAttemptId, Double createdAt, Double updatedAt, Object access) {
      return new InvestigationCase(schema, id, instanceId, owner, kind, question, selectedAttemptId, null, createdAt, updatedAt, access);
    }

    public InvestigationCase withSchema(String value) {
      return new InvestigationCase(value, id, instanceId, owner, kind, question, selectedAttemptId, currentAttemptId, createdAt, updatedAt, access);
    }

    public InvestigationCase withId(String value) {
      return new InvestigationCase(schema, value, instanceId, owner, kind, question, selectedAttemptId, currentAttemptId, createdAt, updatedAt, access);
    }

    public InvestigationCase withInstanceId(String value) {
      return new InvestigationCase(schema, id, value, owner, kind, question, selectedAttemptId, currentAttemptId, createdAt, updatedAt, access);
    }

    public InvestigationCase withOwner(InvestigationActor value) {
      return new InvestigationCase(schema, id, instanceId, value, kind, question, selectedAttemptId, currentAttemptId, createdAt, updatedAt, access);
    }

    public InvestigationCase withKind(String value) {
      return new InvestigationCase(schema, id, instanceId, owner, value, question, selectedAttemptId, currentAttemptId, createdAt, updatedAt, access);
    }

    public InvestigationCase withQuestion(String value) {
      return new InvestigationCase(schema, id, instanceId, owner, kind, value, selectedAttemptId, currentAttemptId, createdAt, updatedAt, access);
    }

    public InvestigationCase withSelectedAttemptId(String value) {
      return new InvestigationCase(schema, id, instanceId, owner, kind, question, value, currentAttemptId, createdAt, updatedAt, access);
    }

    public InvestigationCase withCurrentAttemptId(String value) {
      return new InvestigationCase(schema, id, instanceId, owner, kind, question, selectedAttemptId, value, createdAt, updatedAt, access);
    }

    public InvestigationCase withCreatedAt(Double value) {
      return new InvestigationCase(schema, id, instanceId, owner, kind, question, selectedAttemptId, currentAttemptId, value, updatedAt, access);
    }

    public InvestigationCase withUpdatedAt(Double value) {
      return new InvestigationCase(schema, id, instanceId, owner, kind, question, selectedAttemptId, currentAttemptId, createdAt, value, access);
    }

    public InvestigationCase withAccess(Object value) {
      return new InvestigationCase(schema, id, instanceId, owner, kind, question, selectedAttemptId, currentAttemptId, createdAt, updatedAt, value);
    }
  }

  public record InvestigationContent(
      String id,
      String attemptId,
      String label,
      Object value,
      Double bytes,
      String hash,
      Double createdAt) {

    /** With its required fields; the rest are null. */
    public static InvestigationContent of(String id, String attemptId, String label, Object value, Double bytes, String hash, Double createdAt) {
      return new InvestigationContent(id, attemptId, label, value, bytes, hash, createdAt);
    }

    public InvestigationContent withId(String value) {
      return new InvestigationContent(value, attemptId, label, value, bytes, hash, createdAt);
    }

    public InvestigationContent withAttemptId(String value) {
      return new InvestigationContent(id, value, label, value, bytes, hash, createdAt);
    }

    public InvestigationContent withLabel(String value) {
      return new InvestigationContent(id, attemptId, value, value, bytes, hash, createdAt);
    }

    public InvestigationContent withValue(Object value) {
      return new InvestigationContent(id, attemptId, label, value, bytes, hash, createdAt);
    }

    public InvestigationContent withBytes(Double value) {
      return new InvestigationContent(id, attemptId, label, value, value, hash, createdAt);
    }

    public InvestigationContent withHash(String value) {
      return new InvestigationContent(id, attemptId, label, value, bytes, value, createdAt);
    }

    public InvestigationContent withCreatedAt(Double value) {
      return new InvestigationContent(id, attemptId, label, value, bytes, hash, value);
    }
  }

  public record InvestigationEvent(
      String attemptId,
      Double sequence,
      Double at,
      String kind,
      String actor,
      String stageId,
      String inputId,
      String outputId,
      String message) {

    /** With its required fields; the rest are null. */
    public static InvestigationEvent of(String attemptId, Double sequence, Double at, String kind, String actor) {
      return new InvestigationEvent(attemptId, sequence, at, kind, actor, null, null, null, null);
    }

    public InvestigationEvent withAttemptId(String value) {
      return new InvestigationEvent(value, sequence, at, kind, actor, stageId, inputId, outputId, message);
    }

    public InvestigationEvent withSequence(Double value) {
      return new InvestigationEvent(attemptId, value, at, kind, actor, stageId, inputId, outputId, message);
    }

    public InvestigationEvent withAt(Double value) {
      return new InvestigationEvent(attemptId, sequence, value, kind, actor, stageId, inputId, outputId, message);
    }

    public InvestigationEvent withKind(String value) {
      return new InvestigationEvent(attemptId, sequence, at, value, actor, stageId, inputId, outputId, message);
    }

    public InvestigationEvent withActor(String value) {
      return new InvestigationEvent(attemptId, sequence, at, kind, value, stageId, inputId, outputId, message);
    }

    public InvestigationEvent withStageId(String value) {
      return new InvestigationEvent(attemptId, sequence, at, kind, actor, value, inputId, outputId, message);
    }

    public InvestigationEvent withInputId(String value) {
      return new InvestigationEvent(attemptId, sequence, at, kind, actor, stageId, value, outputId, message);
    }

    public InvestigationEvent withOutputId(String value) {
      return new InvestigationEvent(attemptId, sequence, at, kind, actor, stageId, inputId, value, message);
    }

    public InvestigationEvent withMessage(String value) {
      return new InvestigationEvent(attemptId, sequence, at, kind, actor, stageId, inputId, outputId, value);
    }
  }

  public record InvestigationEventPage(
      List<InvestigationEvent> events,
      Double cursor,
      Boolean more,
      Boolean reset) {

    /** With its required fields; the rest are null. */
    public static InvestigationEventPage of(List<InvestigationEvent> events, Double cursor, Boolean more, Boolean reset) {
      return new InvestigationEventPage(events, cursor, more, reset);
    }

    public InvestigationEventPage withEvents(List<InvestigationEvent> value) {
      return new InvestigationEventPage(value, cursor, more, reset);
    }

    public InvestigationEventPage withCursor(Double value) {
      return new InvestigationEventPage(events, value, more, reset);
    }

    public InvestigationEventPage withMore(Boolean value) {
      return new InvestigationEventPage(events, cursor, value, reset);
    }

    public InvestigationEventPage withReset(Boolean value) {
      return new InvestigationEventPage(events, cursor, more, value);
    }
  }

  /**
   * @param cursor Cursor and state are read in one transaction.
   */
  public record InvestigationSnapshot(
      @Json.Name("case") InvestigationCase case_,
      InvestigationAttempt attempt,
      List<AttemptsItem> attempts,
      Double cursor,
      List<ChildrenItem> children,
      Resolution resolution,
      List<GrantsItem> grants) {

    /** With its required fields; the rest are null. */
    public static InvestigationSnapshot of(InvestigationCase case_, InvestigationAttempt attempt, List<AttemptsItem> attempts, Double cursor, List<ChildrenItem> children) {
      return new InvestigationSnapshot(case_, attempt, attempts, cursor, children, null, null);
    }

    public InvestigationSnapshot withCase(InvestigationCase value) {
      return new InvestigationSnapshot(value, attempt, attempts, cursor, children, resolution, grants);
    }

    public InvestigationSnapshot withAttempt(InvestigationAttempt value) {
      return new InvestigationSnapshot(case_, value, attempts, cursor, children, resolution, grants);
    }

    public InvestigationSnapshot withAttempts(List<AttemptsItem> value) {
      return new InvestigationSnapshot(case_, attempt, value, cursor, children, resolution, grants);
    }

    public InvestigationSnapshot withCursor(Double value) {
      return new InvestigationSnapshot(case_, attempt, attempts, value, children, resolution, grants);
    }

    public InvestigationSnapshot withChildren(List<ChildrenItem> value) {
      return new InvestigationSnapshot(case_, attempt, attempts, cursor, value, resolution, grants);
    }

    public InvestigationSnapshot withResolution(Resolution value) {
      return new InvestigationSnapshot(case_, attempt, attempts, cursor, children, value, grants);
    }

    public InvestigationSnapshot withGrants(List<GrantsItem> value) {
      return new InvestigationSnapshot(case_, attempt, attempts, cursor, children, resolution, value);
    }

    public record AttemptsItem(
        String id,
        InvestigationActor actor,
        String state,
        Double createdAt) {

      /** With its required fields; the rest are null. */
      public static AttemptsItem of(String id, InvestigationActor actor, String state, Double createdAt) {
        return new AttemptsItem(id, actor, state, createdAt);
      }

      public AttemptsItem withId(String value) {
        return new AttemptsItem(value, actor, state, createdAt);
      }

      public AttemptsItem withActor(InvestigationActor value) {
        return new AttemptsItem(id, value, state, createdAt);
      }

      public AttemptsItem withState(String value) {
        return new AttemptsItem(id, actor, value, createdAt);
      }

      public AttemptsItem withCreatedAt(Double value) {
        return new AttemptsItem(id, actor, state, value);
      }
    }

    public record ChildrenItem(
        String caseId,
        String attemptId,
        String question,
        String state) {

      /** With its required fields; the rest are null. */
      public static ChildrenItem of(String caseId, String attemptId, String question, String state) {
        return new ChildrenItem(caseId, attemptId, question, state);
      }

      public ChildrenItem withCaseId(String value) {
        return new ChildrenItem(value, attemptId, question, state);
      }

      public ChildrenItem withAttemptId(String value) {
        return new ChildrenItem(caseId, value, question, state);
      }

      public ChildrenItem withQuestion(String value) {
        return new ChildrenItem(caseId, attemptId, value, state);
      }

      public ChildrenItem withState(String value) {
        return new ChildrenItem(caseId, attemptId, question, value);
      }
    }

    public record Resolution(
        Double at,
        Object value,
        Double loss) {

      /** With its required fields; the rest are null. */
      public static Resolution of(Double at, Object value, Double loss) {
        return new Resolution(at, value, loss);
      }

      public Resolution withAt(Double value) {
        return new Resolution(value, value, loss);
      }

      public Resolution withValue(Object value) {
        return new Resolution(at, value, loss);
      }

      public Resolution withLoss(Double value) {
        return new Resolution(at, value, value);
      }
    }

    public record GrantsItem(
        String name,
        String access) {

      /** With its required fields; the rest are null. */
      public static GrantsItem of(String name, String access) {
        return new GrantsItem(name, access);
      }

      public GrantsItem withName(String value) {
        return new GrantsItem(value, access);
      }

      public GrantsItem withAccess(String value) {
        return new GrantsItem(name, value);
      }
    }
  }

  public record JsonStoreRequest(
      List<Object> operations) {

    /** With its required fields; the rest are null. */
    public static JsonStoreRequest of(List<Object> operations) {
      return new JsonStoreRequest(operations);
    }

    public JsonStoreRequest withOperations(List<Object> value) {
      return new JsonStoreRequest(value);
    }
  }

  public record JsonStoreResponse(
      List<Object> results) {

    /** With its required fields; the rest are null. */
    public static JsonStoreResponse of(List<Object> results) {
      return new JsonStoreResponse(results);
    }

    public JsonStoreResponse withResults(List<Object> value) {
      return new JsonStoreResponse(value);
    }
  }

  public record KnowledgeGraphRequest(
      String action) {

    /** With its required fields; the rest are null. */
    public static KnowledgeGraphRequest of(String action) {
      return new KnowledgeGraphRequest(action);
    }

    public KnowledgeGraphRequest withAction(String value) {
      return new KnowledgeGraphRequest(value);
    }
  }

  public record ListInvestigationsResponse(
      List<InvestigationCase> cases) {

    /** With its required fields; the rest are null. */
    public static ListInvestigationsResponse of(List<InvestigationCase> cases) {
      return new ListInvestigationsResponse(cases);
    }

    public ListInvestigationsResponse withCases(List<InvestigationCase> value) {
      return new ListInvestigationsResponse(value);
    }
  }

  public record MaterializeRuleRequest(
      String id,
      @Json.Name("expected_version") Double expectedVersion,
      @Json.Name("valid_at") Double validAt) {

    /** With its required fields; the rest are null. */
    public static MaterializeRuleRequest of(String id, Double expectedVersion) {
      return new MaterializeRuleRequest(id, expectedVersion, null);
    }

    public MaterializeRuleRequest withId(String value) {
      return new MaterializeRuleRequest(value, expectedVersion, validAt);
    }

    public MaterializeRuleRequest withExpectedVersion(Double value) {
      return new MaterializeRuleRequest(id, value, validAt);
    }

    public MaterializeRuleRequest withValidAt(Double value) {
      return new MaterializeRuleRequest(id, expectedVersion, value);
    }
  }

  public record MaterializeRuleResponse(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      List<MemoryReceipt> records) {

    /** With its required fields; the rest are null. */
    public static MaterializeRuleResponse of(String id, List<MemoryReceipt> records) {
      return new MaterializeRuleResponse(id, null, null, null, null, records);
    }

    public MaterializeRuleResponse withId(String value) {
      return new MaterializeRuleResponse(value, version, jobId, seq, generation, records);
    }

    public MaterializeRuleResponse withVersion(Double value) {
      return new MaterializeRuleResponse(id, value, jobId, seq, generation, records);
    }

    public MaterializeRuleResponse withJobId(String value) {
      return new MaterializeRuleResponse(id, version, value, seq, generation, records);
    }

    public MaterializeRuleResponse withSeq(Double value) {
      return new MaterializeRuleResponse(id, version, jobId, value, generation, records);
    }

    public MaterializeRuleResponse withGeneration(Double value) {
      return new MaterializeRuleResponse(id, version, jobId, seq, value, records);
    }

    public MaterializeRuleResponse withRecords(List<MemoryReceipt> value) {
      return new MaterializeRuleResponse(id, version, jobId, seq, generation, value);
    }
  }

  /**
   * @param targetSpaceId Defaults to the job's own space.
   * @param confirmAbstention Explicit `assistance_abstained_confirmed` credit for an abstained job; writes no record.
   */
  public record MemoryAdoptInput(
      @Json.Name("job_id") String jobId,
      @Json.Name("target_space_id") String targetSpaceId,
      String rationale,
      @Json.Name("valid_time") MemoryValidity validTime,
      @Json.Name("confirm_abstention") Boolean confirmAbstention) {

    /** With its required fields; the rest are null. */
    public static MemoryAdoptInput of(String jobId) {
      return new MemoryAdoptInput(jobId, null, null, null, null);
    }

    public MemoryAdoptInput withJobId(String value) {
      return new MemoryAdoptInput(value, targetSpaceId, rationale, validTime, confirmAbstention);
    }

    public MemoryAdoptInput withTargetSpaceId(String value) {
      return new MemoryAdoptInput(jobId, value, rationale, validTime, confirmAbstention);
    }

    public MemoryAdoptInput withRationale(String value) {
      return new MemoryAdoptInput(jobId, targetSpaceId, value, validTime, confirmAbstention);
    }

    public MemoryAdoptInput withValidTime(MemoryValidity value) {
      return new MemoryAdoptInput(jobId, targetSpaceId, rationale, value, confirmAbstention);
    }

    public MemoryAdoptInput withConfirmAbstention(Boolean value) {
      return new MemoryAdoptInput(jobId, targetSpaceId, rationale, validTime, value);
    }
  }

  /**
   * Why a record lives in a shared (institutional) space. Stamped by `adopt` and `pool &lt;name&gt; ratify`; every institutional record answers "why is this shared?" from its own metadata.
   *
   * @param basis Which rule admitted the ratifier.
   */
  public record MemoryRatifiedBy(
      @Json.Name("principal_id") String principalId,
      String name,
      Double standing,
      Double at,
      String rationale,
      String basis) {

    /** With its required fields; the rest are null. */
    public static MemoryRatifiedBy of(String principalId, String name, Double standing, Double at, String rationale, String basis) {
      return new MemoryRatifiedBy(principalId, name, standing, at, rationale, basis);
    }

    public MemoryRatifiedBy withPrincipalId(String value) {
      return new MemoryRatifiedBy(value, name, standing, at, rationale, basis);
    }

    public MemoryRatifiedBy withName(String value) {
      return new MemoryRatifiedBy(principalId, value, standing, at, rationale, basis);
    }

    public MemoryRatifiedBy withStanding(Double value) {
      return new MemoryRatifiedBy(principalId, name, value, at, rationale, basis);
    }

    public MemoryRatifiedBy withAt(Double value) {
      return new MemoryRatifiedBy(principalId, name, standing, value, rationale, basis);
    }

    public MemoryRatifiedBy withRationale(String value) {
      return new MemoryRatifiedBy(principalId, name, standing, at, value, basis);
    }

    public MemoryRatifiedBy withBasis(String value) {
      return new MemoryRatifiedBy(principalId, name, standing, at, rationale, value);
    }
  }

  public record MemoryStandingCredit(
      @Json.Name("principal_id") String principalId,
      String kind,
      String ref,
      Double amount) {

    /** With its required fields; the rest are null. */
    public static MemoryStandingCredit of(String principalId, String kind, String ref, Double amount) {
      return new MemoryStandingCredit(principalId, kind, ref, amount);
    }

    public MemoryStandingCredit withPrincipalId(String value) {
      return new MemoryStandingCredit(value, kind, ref, amount);
    }

    public MemoryStandingCredit withKind(String value) {
      return new MemoryStandingCredit(principalId, value, ref, amount);
    }

    public MemoryStandingCredit withRef(String value) {
      return new MemoryStandingCredit(principalId, kind, value, amount);
    }

    public MemoryStandingCredit withAmount(Double value) {
      return new MemoryStandingCredit(principalId, kind, ref, value);
    }
  }

  /**
   * @param existing True when this call returned an adoption that already existed.
   */
  public record MemoryAdoptResult(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      @Json.Name("space_id") String spaceId,
      String state,
      Boolean existing,
      @Json.Name("ratified_by") MemoryRatifiedBy ratifiedBy,
      List<MemoryStandingCredit> credited) {

    /** With its required fields; the rest are null. */
    public static MemoryAdoptResult of(String id, String jobId, String spaceId, String state, Boolean existing, MemoryRatifiedBy ratifiedBy, List<MemoryStandingCredit> credited) {
      return new MemoryAdoptResult(id, null, jobId, null, null, spaceId, state, existing, ratifiedBy, credited);
    }

    public MemoryAdoptResult withId(String value) {
      return new MemoryAdoptResult(value, version, jobId, seq, generation, spaceId, state, existing, ratifiedBy, credited);
    }

    public MemoryAdoptResult withVersion(Double value) {
      return new MemoryAdoptResult(id, value, jobId, seq, generation, spaceId, state, existing, ratifiedBy, credited);
    }

    public MemoryAdoptResult withJobId(String value) {
      return new MemoryAdoptResult(id, version, value, seq, generation, spaceId, state, existing, ratifiedBy, credited);
    }

    public MemoryAdoptResult withSeq(Double value) {
      return new MemoryAdoptResult(id, version, jobId, value, generation, spaceId, state, existing, ratifiedBy, credited);
    }

    public MemoryAdoptResult withGeneration(Double value) {
      return new MemoryAdoptResult(id, version, jobId, seq, value, spaceId, state, existing, ratifiedBy, credited);
    }

    public MemoryAdoptResult withSpaceId(String value) {
      return new MemoryAdoptResult(id, version, jobId, seq, generation, value, state, existing, ratifiedBy, credited);
    }

    public MemoryAdoptResult withState(String value) {
      return new MemoryAdoptResult(id, version, jobId, seq, generation, spaceId, value, existing, ratifiedBy, credited);
    }

    public MemoryAdoptResult withExisting(Boolean value) {
      return new MemoryAdoptResult(id, version, jobId, seq, generation, spaceId, state, value, ratifiedBy, credited);
    }

    public MemoryAdoptResult withRatifiedBy(MemoryRatifiedBy value) {
      return new MemoryAdoptResult(id, version, jobId, seq, generation, spaceId, state, existing, value, credited);
    }

    public MemoryAdoptResult withCredited(List<MemoryStandingCredit> value) {
      return new MemoryAdoptResult(id, version, jobId, seq, generation, spaceId, state, existing, ratifiedBy, value);
    }
  }

  /**
   * Assistance is explicitly delegated reading and a cited proposal, never a grant to edit the requester's memories or to certify a claim as true.
   */
  public record MemoryAssistanceInput(
      @Json.Name("worker_id") String workerId,
      String role,
      String task,
      @Json.Name("max_operations") Double maxOperations,
      @Json.Name("timeout_ms") Double timeoutMs) {

    /** With its required fields; the rest are null. */
    public static MemoryAssistanceInput of(String workerId, String role, String task) {
      return new MemoryAssistanceInput(workerId, role, task, null, null);
    }

    public MemoryAssistanceInput withWorkerId(String value) {
      return new MemoryAssistanceInput(value, role, task, maxOperations, timeoutMs);
    }

    public MemoryAssistanceInput withRole(String value) {
      return new MemoryAssistanceInput(workerId, value, task, maxOperations, timeoutMs);
    }

    public MemoryAssistanceInput withTask(String value) {
      return new MemoryAssistanceInput(workerId, role, value, maxOperations, timeoutMs);
    }

    public MemoryAssistanceInput withMaxOperations(Double value) {
      return new MemoryAssistanceInput(workerId, role, task, value, timeoutMs);
    }

    public MemoryAssistanceInput withTimeoutMs(Double value) {
      return new MemoryAssistanceInput(workerId, role, task, maxOperations, value);
    }
  }

  /**
   * @param workOpen Live deadline/ancestor projection; state retains the last recorded transition.
   */
  public record MemoryAssistanceJob(
      String id,
      @Json.Name("space_id") String spaceId,
      @Json.Name("requester_id") String requesterId,
      @Json.Name("worker_id") String workerId,
      String role,
      @Json.Name("parent_id") String parentId,
      @Json.Name("root_id") String rootId,
      Double depth,
      String state,
      @Json.Name("work_open") Boolean workOpen,
      Double version,
      @Json.Name("lease_until") Double leaseUntil,
      Double deadline,
      @Json.Name("remaining_operations") Double remainingOperations,
      @Json.Name("input_source_id") String inputSourceId,
      @Json.Name("result_record_id") String resultRecordId,
      @Json.Name("created_at") Double createdAt,
      String task,
      Object result) {

    /** With its required fields; the rest are null. */
    public static MemoryAssistanceJob of(String id, String spaceId, String requesterId, String workerId, String role, String parentId, String rootId, Double depth, String state, Boolean workOpen, Double version, Double leaseUntil, Double deadline, Double remainingOperations, String inputSourceId, String resultRecordId, Double createdAt) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, null, null);
    }

    public MemoryAssistanceJob withId(String value) {
      return new MemoryAssistanceJob(value, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withSpaceId(String value) {
      return new MemoryAssistanceJob(id, value, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withRequesterId(String value) {
      return new MemoryAssistanceJob(id, spaceId, value, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withWorkerId(String value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, value, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withRole(String value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, value, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withParentId(String value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, value, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withRootId(String value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, value, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withDepth(Double value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, value, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withState(String value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, value, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withWorkOpen(Boolean value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, value, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withVersion(Double value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, value, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withLeaseUntil(Double value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, value, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withDeadline(Double value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, value, remainingOperations, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withRemainingOperations(Double value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, value, inputSourceId, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withInputSourceId(String value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, value, resultRecordId, createdAt, task, result);
    }

    public MemoryAssistanceJob withResultRecordId(String value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, value, createdAt, task, result);
    }

    public MemoryAssistanceJob withCreatedAt(Double value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, value, task, result);
    }

    public MemoryAssistanceJob withTask(String value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, value, result);
    }

    public MemoryAssistanceJob withResult(Object value) {
      return new MemoryAssistanceJob(id, spaceId, requesterId, workerId, role, parentId, rootId, depth, state, workOpen, version, leaseUntil, deadline, remainingOperations, inputSourceId, resultRecordId, createdAt, task, value);
    }
  }

  public record MemoryAssistancePage(
      List<MemoryAssistanceJob> jobs,
      @Json.Name("next_cursor") String nextCursor) {

    /** With its required fields; the rest are null. */
    public static MemoryAssistancePage of(List<MemoryAssistanceJob> jobs, String nextCursor) {
      return new MemoryAssistancePage(jobs, nextCursor);
    }

    public MemoryAssistancePage withJobs(List<MemoryAssistanceJob> value) {
      return new MemoryAssistancePage(value, nextCursor);
    }

    public MemoryAssistancePage withNextCursor(String value) {
      return new MemoryAssistancePage(jobs, value);
    }
  }

  public record MemoryClaim(
      String subject,
      String predicate,
      Object object) {

    /** With its required fields; the rest are null. */
    public static MemoryClaim of(String subject, String predicate, Object object) {
      return new MemoryClaim(subject, predicate, object);
    }

    public MemoryClaim withSubject(String value) {
      return new MemoryClaim(value, predicate, object);
    }

    public MemoryClaim withPredicate(String value) {
      return new MemoryClaim(subject, value, object);
    }

    public MemoryClaim withObject(Object value) {
      return new MemoryClaim(subject, predicate, value);
    }
  }

  public record MemoryRecord(
      String freshness,
      @Json.Name("stale_reason") StaleReason staleReason,
      @Json.Name("dependency_versions") Map<String, Double> dependencyVersions,
      @Json.Name("valid_time") MemoryValidity validTime,
      @Json.Name("vocabulary_version") Double vocabularyVersion,
      String id,
      @Json.Name("space_id") String spaceId,
      Double version,
      String content,
      String type,
      String tier,
      Double importance,
      String subject,
      Map<String, Object> metadata,
      @Json.Name("source_ids") List<String> sourceIds,
      @Json.Name("depends_on") List<String> dependsOn,
      @Json.Name("created_at") Double createdAt,
      MemoryClaim claim) {

    /** With its required fields; the rest are null. */
    public static MemoryRecord of(String id, String spaceId, Double version, String content, String type, String tier, Double importance, String subject, Map<String, Object> metadata, List<String> sourceIds, List<String> dependsOn, Double createdAt) {
      return new MemoryRecord(null, null, null, null, null, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, null);
    }

    public MemoryRecord withFreshness(String value) {
      return new MemoryRecord(value, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withStaleReason(StaleReason value) {
      return new MemoryRecord(freshness, value, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withDependencyVersions(Map<String, Double> value) {
      return new MemoryRecord(freshness, staleReason, value, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withValidTime(MemoryValidity value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, value, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withVocabularyVersion(Double value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, value, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withId(String value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, value, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withSpaceId(String value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, value, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withVersion(Double value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, value, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withContent(String value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, value, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withType(String value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, value, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withTier(String value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, value, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withImportance(Double value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, value, subject, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withSubject(String value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, value, metadata, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withMetadata(Map<String, Object> value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, value, sourceIds, dependsOn, createdAt, claim);
    }

    public MemoryRecord withSourceIds(List<String> value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, value, dependsOn, createdAt, claim);
    }

    public MemoryRecord withDependsOn(List<String> value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, value, createdAt, claim);
    }

    public MemoryRecord withCreatedAt(Double value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, value, claim);
    }

    public MemoryRecord withClaim(MemoryClaim value) {
      return new MemoryRecord(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, value);
    }

    public record StaleReason(
        String kind,
        @Json.Name("record_id") String recordId,
        @Json.Name("observed_version") Double observedVersion) {

      /** With its required fields; the rest are null. */
      public static StaleReason of(String kind) {
        return new StaleReason(kind, null, null);
      }

      public StaleReason withKind(String value) {
        return new StaleReason(value, recordId, observedVersion);
      }

      public StaleReason withRecordId(String value) {
        return new StaleReason(kind, value, observedVersion);
      }

      public StaleReason withObservedVersion(Double value) {
        return new StaleReason(kind, recordId, value);
      }
    }
  }

  /**
   * Portable history envelope. Authorization and indexes are deliberately excluded.
   */
  public record MemoryBundle(
      String schema,
      String sha256,
      Payload payload,
      List<String> excluded) {

    /** With its required fields; the rest are null. */
    public static MemoryBundle of(String schema, String sha256, Payload payload, List<String> excluded) {
      return new MemoryBundle(schema, sha256, payload, excluded);
    }

    public MemoryBundle withSchema(String value) {
      return new MemoryBundle(value, sha256, payload, excluded);
    }

    public MemoryBundle withSha256(String value) {
      return new MemoryBundle(schema, value, payload, excluded);
    }

    public MemoryBundle withPayload(Payload value) {
      return new MemoryBundle(schema, sha256, value, excluded);
    }

    public MemoryBundle withExcluded(List<String> value) {
      return new MemoryBundle(schema, sha256, payload, value);
    }

    public record Payload(
        @Json.Name("origin_space") String originSpace,
        List<SourcesItem> sources,
        List<RecordsItem> records,
        List<VocabulariesItem> vocabularies,
        List<CheckpointsItem> checkpoints) {

      /** With its required fields; the rest are null. */
      public static Payload of(String originSpace, List<SourcesItem> sources, List<RecordsItem> records, List<VocabulariesItem> vocabularies, List<CheckpointsItem> checkpoints) {
        return new Payload(originSpace, sources, records, vocabularies, checkpoints);
      }

      public Payload withOriginSpace(String value) {
        return new Payload(value, sources, records, vocabularies, checkpoints);
      }

      public Payload withSources(List<SourcesItem> value) {
        return new Payload(originSpace, value, records, vocabularies, checkpoints);
      }

      public Payload withRecords(List<RecordsItem> value) {
        return new Payload(originSpace, sources, value, vocabularies, checkpoints);
      }

      public Payload withVocabularies(List<VocabulariesItem> value) {
        return new Payload(originSpace, sources, records, value, checkpoints);
      }

      public Payload withCheckpoints(List<CheckpointsItem> value) {
        return new Payload(originSpace, sources, records, vocabularies, value);
      }

      public record SourcesItem(
          String id,
          @Json.Name("space_id") String spaceId,
          Double seq,
          @Json.Name("session_id") String sessionId,
          Object body,
          @Json.Name("content_hash") String contentHash,
          @Json.Name("created_at") Double createdAt,
          @Json.Name("body_sha256") String bodySha256) {

        /** With its required fields; the rest are null. */
        public static SourcesItem of(String id, String spaceId, Double seq, String sessionId, Object body, String contentHash, Double createdAt, String bodySha256) {
          return new SourcesItem(id, spaceId, seq, sessionId, body, contentHash, createdAt, bodySha256);
        }

        public SourcesItem withId(String value) {
          return new SourcesItem(value, spaceId, seq, sessionId, body, contentHash, createdAt, bodySha256);
        }

        public SourcesItem withSpaceId(String value) {
          return new SourcesItem(id, value, seq, sessionId, body, contentHash, createdAt, bodySha256);
        }

        public SourcesItem withSeq(Double value) {
          return new SourcesItem(id, spaceId, value, sessionId, body, contentHash, createdAt, bodySha256);
        }

        public SourcesItem withSessionId(String value) {
          return new SourcesItem(id, spaceId, seq, value, body, contentHash, createdAt, bodySha256);
        }

        public SourcesItem withBody(Object value) {
          return new SourcesItem(id, spaceId, seq, sessionId, value, contentHash, createdAt, bodySha256);
        }

        public SourcesItem withContentHash(String value) {
          return new SourcesItem(id, spaceId, seq, sessionId, body, value, createdAt, bodySha256);
        }

        public SourcesItem withCreatedAt(Double value) {
          return new SourcesItem(id, spaceId, seq, sessionId, body, contentHash, value, bodySha256);
        }

        public SourcesItem withBodySha256(String value) {
          return new SourcesItem(id, spaceId, seq, sessionId, body, contentHash, createdAt, value);
        }
      }

      public record RecordsItem(
          String id,
          Double version,
          @Json.Name("created_at") Double createdAt,
          Double stale,
          @Json.Name("stale_reason") String staleReason,
          List<VersionsItem> versions) {

        /** With its required fields; the rest are null. */
        public static RecordsItem of(String id, Double version, Double createdAt, Double stale, String staleReason, List<VersionsItem> versions) {
          return new RecordsItem(id, version, createdAt, stale, staleReason, versions);
        }

        public RecordsItem withId(String value) {
          return new RecordsItem(value, version, createdAt, stale, staleReason, versions);
        }

        public RecordsItem withVersion(Double value) {
          return new RecordsItem(id, value, createdAt, stale, staleReason, versions);
        }

        public RecordsItem withCreatedAt(Double value) {
          return new RecordsItem(id, version, value, stale, staleReason, versions);
        }

        public RecordsItem withStale(Double value) {
          return new RecordsItem(id, version, createdAt, value, staleReason, versions);
        }

        public RecordsItem withStaleReason(String value) {
          return new RecordsItem(id, version, createdAt, stale, value, versions);
        }

        public RecordsItem withVersions(List<VersionsItem> value) {
          return new RecordsItem(id, version, createdAt, stale, staleReason, value);
        }

        public record VersionsItem(
            @Json.Name("record") MemoryRecord record_,
            Map<String, Object> attributes) {

          /** With its required fields; the rest are null. */
          public static VersionsItem of(MemoryRecord record_, Map<String, Object> attributes) {
            return new VersionsItem(record_, attributes);
          }

          public VersionsItem withRecord(MemoryRecord value) {
            return new VersionsItem(value, attributes);
          }

          public VersionsItem withAttributes(Map<String, Object> value) {
            return new VersionsItem(record_, value);
          }
        }
      }

      public record VocabulariesItem(
          Double version,
          String definition,
          @Json.Name("created_at") Double createdAt) {

        /** With its required fields; the rest are null. */
        public static VocabulariesItem of(Double version, String definition, Double createdAt) {
          return new VocabulariesItem(version, definition, createdAt);
        }

        public VocabulariesItem withVersion(Double value) {
          return new VocabulariesItem(value, definition, createdAt);
        }

        public VocabulariesItem withDefinition(String value) {
          return new VocabulariesItem(version, value, createdAt);
        }

        public VocabulariesItem withCreatedAt(Double value) {
          return new VocabulariesItem(version, definition, value);
        }
      }

      public record CheckpointsItem(
          String name,
          Double version,
          @Json.Name("source_cursor") Double sourceCursor,
          String data,
          @Json.Name("updated_at") Double updatedAt) {

        /** With its required fields; the rest are null. */
        public static CheckpointsItem of(String name, Double version, Double sourceCursor, String data, Double updatedAt) {
          return new CheckpointsItem(name, version, sourceCursor, data, updatedAt);
        }

        public CheckpointsItem withName(String value) {
          return new CheckpointsItem(value, version, sourceCursor, data, updatedAt);
        }

        public CheckpointsItem withVersion(Double value) {
          return new CheckpointsItem(name, value, sourceCursor, data, updatedAt);
        }

        public CheckpointsItem withSourceCursor(Double value) {
          return new CheckpointsItem(name, version, value, data, updatedAt);
        }

        public CheckpointsItem withData(String value) {
          return new CheckpointsItem(name, version, sourceCursor, value, updatedAt);
        }

        public CheckpointsItem withUpdatedAt(Double value) {
          return new CheckpointsItem(name, version, sourceCursor, data, value);
        }
      }
    }
  }

  public record MemoryCachedRetrievalInput(
      Retrieval retrieval,
      List<String> mounts,
      @Json.Name("allow_partial") Boolean allowPartial,
      String cache,
      @Json.Name("ttl_ms") Double ttlMs) {

    /** With its required fields; the rest are null. */
    public static MemoryCachedRetrievalInput of(Retrieval retrieval) {
      return new MemoryCachedRetrievalInput(retrieval, null, null, null, null);
    }

    public MemoryCachedRetrievalInput withRetrieval(Retrieval value) {
      return new MemoryCachedRetrievalInput(value, mounts, allowPartial, cache, ttlMs);
    }

    public MemoryCachedRetrievalInput withMounts(List<String> value) {
      return new MemoryCachedRetrievalInput(retrieval, value, allowPartial, cache, ttlMs);
    }

    public MemoryCachedRetrievalInput withAllowPartial(Boolean value) {
      return new MemoryCachedRetrievalInput(retrieval, mounts, value, cache, ttlMs);
    }

    public MemoryCachedRetrievalInput withCache(String value) {
      return new MemoryCachedRetrievalInput(retrieval, mounts, allowPartial, value, ttlMs);
    }

    public MemoryCachedRetrievalInput withTtlMs(Double value) {
      return new MemoryCachedRetrievalInput(retrieval, mounts, allowPartial, cache, value);
    }

    /**
     * @param observe Include a bounded candidate pool for explicit episode capture and offline comparison.
     * @param maxBytes Serialized evidence-array budget; plan and diagnostic metadata are separate.
     * @param sourceBytes Maximum UTF-8 text bytes read per original source.
     */
    public record Retrieval(
        String task,
        String selection,
        MemoryQueryExpansion expansion,
        List<Object> requirements,
        Boolean observe,
        List<MemoryPlanStep> steps,
        @Json.Name("use_model") Boolean useModel,
        Boolean broaden,
        @Json.Name("valid_at") Double validAt,
        @Json.Name("max_results") Double maxResults,
        @Json.Name("max_bytes") Double maxBytes,
        @Json.Name("source_bytes") Double sourceBytes) {

      /** With its required fields; the rest are null. */
      public static Retrieval of(String task, Double validAt) {
        return new Retrieval(task, null, null, null, null, null, null, null, validAt, null, null, null);
      }

      public Retrieval withTask(String value) {
        return new Retrieval(value, selection, expansion, requirements, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withSelection(String value) {
        return new Retrieval(task, value, expansion, requirements, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withExpansion(MemoryQueryExpansion value) {
        return new Retrieval(task, selection, value, requirements, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withRequirements(List<Object> value) {
        return new Retrieval(task, selection, expansion, value, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withObserve(Boolean value) {
        return new Retrieval(task, selection, expansion, requirements, value, steps, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withSteps(List<MemoryPlanStep> value) {
        return new Retrieval(task, selection, expansion, requirements, observe, value, useModel, broaden, validAt, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withUseModel(Boolean value) {
        return new Retrieval(task, selection, expansion, requirements, observe, steps, value, broaden, validAt, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withBroaden(Boolean value) {
        return new Retrieval(task, selection, expansion, requirements, observe, steps, useModel, value, validAt, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withValidAt(Double value) {
        return new Retrieval(task, selection, expansion, requirements, observe, steps, useModel, broaden, value, maxResults, maxBytes, sourceBytes);
      }

      public Retrieval withMaxResults(Double value) {
        return new Retrieval(task, selection, expansion, requirements, observe, steps, useModel, broaden, validAt, value, maxBytes, sourceBytes);
      }

      public Retrieval withMaxBytes(Double value) {
        return new Retrieval(task, selection, expansion, requirements, observe, steps, useModel, broaden, validAt, maxResults, value, sourceBytes);
      }

      public Retrieval withSourceBytes(Double value) {
        return new Retrieval(task, selection, expansion, requirements, observe, steps, useModel, broaden, validAt, maxResults, maxBytes, value);
      }
    }
  }

  public record MemoryCachedRetrievalResult(
      Object retrieval,
      Cache cache) {

    /** With its required fields; the rest are null. */
    public static MemoryCachedRetrievalResult of(Object retrieval, Cache cache) {
      return new MemoryCachedRetrievalResult(retrieval, cache);
    }

    public MemoryCachedRetrievalResult withRetrieval(Object value) {
      return new MemoryCachedRetrievalResult(value, cache);
    }

    public MemoryCachedRetrievalResult withCache(Cache value) {
      return new MemoryCachedRetrievalResult(retrieval, value);
    }

    public record Cache(
        Boolean hit,
        String reason,
        Boolean stored) {

      /** With its required fields; the rest are null. */
      public static Cache of(Boolean hit, String reason) {
        return new Cache(hit, reason, null);
      }

      public Cache withHit(Boolean value) {
        return new Cache(value, reason, stored);
      }

      public Cache withReason(String value) {
        return new Cache(hit, value, stored);
      }

      public Cache withStored(Boolean value) {
        return new Cache(hit, reason, value);
      }
    }
  }

  public record MemoryCacheInput(
      Object inputs,
      String model,
      String policy) {

    /** With its required fields; the rest are null. */
    public static MemoryCacheInput of(Object inputs, String model, String policy) {
      return new MemoryCacheInput(inputs, model, policy);
    }

    public MemoryCacheInput withInputs(Object value) {
      return new MemoryCacheInput(value, model, policy);
    }

    public MemoryCacheInput withModel(String value) {
      return new MemoryCacheInput(inputs, value, policy);
    }

    public MemoryCacheInput withPolicy(String value) {
      return new MemoryCacheInput(inputs, model, value);
    }
  }

  public record MemoryCacheWrite(
      Object inputs,
      String model,
      String policy,
      Object value,
      List<MemoryCacheWriteRecordsItem> records,
      List<MemoryCacheWriteSourcesItem> sources,
      List<Object> federated,
      @Json.Name("expires_at") Double expiresAt) {

    /** With its required fields; the rest are null. */
    public static MemoryCacheWrite of(Object inputs, String model, String policy, Object value, Double expiresAt) {
      return new MemoryCacheWrite(inputs, model, policy, value, null, null, null, expiresAt);
    }

    public MemoryCacheWrite withInputs(Object value) {
      return new MemoryCacheWrite(value, model, policy, value, records, sources, federated, expiresAt);
    }

    public MemoryCacheWrite withModel(String value) {
      return new MemoryCacheWrite(inputs, value, policy, value, records, sources, federated, expiresAt);
    }

    public MemoryCacheWrite withPolicy(String value) {
      return new MemoryCacheWrite(inputs, model, value, value, records, sources, federated, expiresAt);
    }

    public MemoryCacheWrite withValue(Object value) {
      return new MemoryCacheWrite(inputs, model, policy, value, records, sources, federated, expiresAt);
    }

    public MemoryCacheWrite withRecords(List<MemoryCacheWriteRecordsItem> value) {
      return new MemoryCacheWrite(inputs, model, policy, value, value, sources, federated, expiresAt);
    }

    public MemoryCacheWrite withSources(List<MemoryCacheWriteSourcesItem> value) {
      return new MemoryCacheWrite(inputs, model, policy, value, records, value, federated, expiresAt);
    }

    public MemoryCacheWrite withFederated(List<Object> value) {
      return new MemoryCacheWrite(inputs, model, policy, value, records, sources, value, expiresAt);
    }

    public MemoryCacheWrite withExpiresAt(Double value) {
      return new MemoryCacheWrite(inputs, model, policy, value, records, sources, federated, value);
    }

    public record MemoryCacheWriteRecordsItem(
        String id,
        Double version) {

      /** With its required fields; the rest are null. */
      public static MemoryCacheWriteRecordsItem of(String id, Double version) {
        return new MemoryCacheWriteRecordsItem(id, version);
      }

      public MemoryCacheWriteRecordsItem withId(String value) {
        return new MemoryCacheWriteRecordsItem(value, version);
      }

      public MemoryCacheWriteRecordsItem withVersion(Double value) {
        return new MemoryCacheWriteRecordsItem(id, value);
      }
    }

    public record MemoryCacheWriteSourcesItem(
        String id,
        @Json.Name("content_hash") String contentHash) {

      /** With its required fields; the rest are null. */
      public static MemoryCacheWriteSourcesItem of(String id, String contentHash) {
        return new MemoryCacheWriteSourcesItem(id, contentHash);
      }

      public MemoryCacheWriteSourcesItem withId(String value) {
        return new MemoryCacheWriteSourcesItem(value, contentHash);
      }

      public MemoryCacheWriteSourcesItem withContentHash(String value) {
        return new MemoryCacheWriteSourcesItem(id, value);
      }
    }
  }

  public record MemoryCheckpoint(
      String name,
      Double version,
      @Json.Name("source_cursor") Double sourceCursor,
      Map<String, Object> data,
      @Json.Name("updated_at") Double updatedAt) {

    /** With its required fields; the rest are null. */
    public static MemoryCheckpoint of(String name, Double version, Double sourceCursor, Map<String, Object> data, Double updatedAt) {
      return new MemoryCheckpoint(name, version, sourceCursor, data, updatedAt);
    }

    public MemoryCheckpoint withName(String value) {
      return new MemoryCheckpoint(value, version, sourceCursor, data, updatedAt);
    }

    public MemoryCheckpoint withVersion(Double value) {
      return new MemoryCheckpoint(name, value, sourceCursor, data, updatedAt);
    }

    public MemoryCheckpoint withSourceCursor(Double value) {
      return new MemoryCheckpoint(name, version, value, data, updatedAt);
    }

    public MemoryCheckpoint withData(Map<String, Object> value) {
      return new MemoryCheckpoint(name, version, sourceCursor, value, updatedAt);
    }

    public MemoryCheckpoint withUpdatedAt(Double value) {
      return new MemoryCheckpoint(name, version, sourceCursor, data, value);
    }
  }

  /**
   * Input of an atomic checkpoint capture (`capture_checkpoint`).
   *
   * @param items New sources; `order` refers to them by index. At most 64, 1 MiB.
   * @param order The manifest's sources in order: an existing source id or a new item's index.
   * @param manifest The server adds `source_ids` (resolved `order`) to this content.
   * @param field Checkpoint data field set to `entry` plus `source_ids` and `manifest_source_id`.
   * @param data The rest of the checkpoint data.
   * @param sourceIds Other sources the checkpoint keeps referring to.
   * @param cursor `"manifest"` = the manifest's sequence number, else an explicit cursor.
   */
  public record MemoryCheckpointCapture(
      @Json.Name("expected_version") Double expectedVersion,
      @Json.Name("session_id") String sessionId,
      List<MemoryCheckpointCaptureItemsItem> items,
      List<Object> order,
      Manifest manifest,
      String field,
      Map<String, Object> entry,
      Map<String, Object> data,
      @Json.Name("source_ids") List<String> sourceIds,
      Object cursor,
      @Json.Name("checkpoint_key") String checkpointKey) {

    /** With its required fields; the rest are null. */
    public static MemoryCheckpointCapture of(Double expectedVersion, List<Object> order, Manifest manifest, String field, Map<String, Object> entry, Map<String, Object> data, String checkpointKey) {
      return new MemoryCheckpointCapture(expectedVersion, null, null, order, manifest, field, entry, data, null, null, checkpointKey);
    }

    public MemoryCheckpointCapture withExpectedVersion(Double value) {
      return new MemoryCheckpointCapture(value, sessionId, items, order, manifest, field, entry, data, sourceIds, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withSessionId(String value) {
      return new MemoryCheckpointCapture(expectedVersion, value, items, order, manifest, field, entry, data, sourceIds, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withItems(List<MemoryCheckpointCaptureItemsItem> value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, value, order, manifest, field, entry, data, sourceIds, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withOrder(List<Object> value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, items, value, manifest, field, entry, data, sourceIds, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withManifest(Manifest value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, items, order, value, field, entry, data, sourceIds, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withField(String value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, items, order, manifest, value, entry, data, sourceIds, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withEntry(Map<String, Object> value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, items, order, manifest, field, value, data, sourceIds, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withData(Map<String, Object> value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, items, order, manifest, field, entry, value, sourceIds, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withSourceIds(List<String> value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, items, order, manifest, field, entry, data, value, cursor, checkpointKey);
    }

    public MemoryCheckpointCapture withCursor(Object value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, items, order, manifest, field, entry, data, sourceIds, value, checkpointKey);
    }

    public MemoryCheckpointCapture withCheckpointKey(String value) {
      return new MemoryCheckpointCapture(expectedVersion, sessionId, items, order, manifest, field, entry, data, sourceIds, cursor, value);
    }

    public record MemoryCheckpointCaptureItemsItem(
        Object content,
        String key) {

      /** With its required fields; the rest are null. */
      public static MemoryCheckpointCaptureItemsItem of(Object content, String key) {
        return new MemoryCheckpointCaptureItemsItem(content, key);
      }

      public MemoryCheckpointCaptureItemsItem withContent(Object value) {
        return new MemoryCheckpointCaptureItemsItem(value, key);
      }

      public MemoryCheckpointCaptureItemsItem withKey(String value) {
        return new MemoryCheckpointCaptureItemsItem(content, value);
      }
    }

    /**
     * The server adds `source_ids` (resolved `order`) to this content.
     */
    public record Manifest(
        String key,
        Map<String, Object> content) {

      /** With its required fields; the rest are null. */
      public static Manifest of(String key, Map<String, Object> content) {
        return new Manifest(key, content);
      }

      public Manifest withKey(String value) {
        return new Manifest(value, content);
      }

      public Manifest withContent(Map<String, Object> value) {
        return new Manifest(key, value);
      }
    }
  }

  public record MemoryCheckpointCaptureReceipt(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      MemoryCheckpointCaptureReceiptManifest manifest,
      @Json.Name("source_ids") List<String> sourceIds) {

    /** With its required fields; the rest are null. */
    public static MemoryCheckpointCaptureReceipt of(String id, MemoryCheckpointCaptureReceiptManifest manifest, List<String> sourceIds) {
      return new MemoryCheckpointCaptureReceipt(id, null, null, null, null, manifest, sourceIds);
    }

    public MemoryCheckpointCaptureReceipt withId(String value) {
      return new MemoryCheckpointCaptureReceipt(value, version, jobId, seq, generation, manifest, sourceIds);
    }

    public MemoryCheckpointCaptureReceipt withVersion(Double value) {
      return new MemoryCheckpointCaptureReceipt(id, value, jobId, seq, generation, manifest, sourceIds);
    }

    public MemoryCheckpointCaptureReceipt withJobId(String value) {
      return new MemoryCheckpointCaptureReceipt(id, version, value, seq, generation, manifest, sourceIds);
    }

    public MemoryCheckpointCaptureReceipt withSeq(Double value) {
      return new MemoryCheckpointCaptureReceipt(id, version, jobId, value, generation, manifest, sourceIds);
    }

    public MemoryCheckpointCaptureReceipt withGeneration(Double value) {
      return new MemoryCheckpointCaptureReceipt(id, version, jobId, seq, value, manifest, sourceIds);
    }

    public MemoryCheckpointCaptureReceipt withManifest(MemoryCheckpointCaptureReceiptManifest value) {
      return new MemoryCheckpointCaptureReceipt(id, version, jobId, seq, generation, value, sourceIds);
    }

    public MemoryCheckpointCaptureReceipt withSourceIds(List<String> value) {
      return new MemoryCheckpointCaptureReceipt(id, version, jobId, seq, generation, manifest, value);
    }

    public record MemoryCheckpointCaptureReceiptManifest(
        String id,
        Double seq) {

      /** With its required fields; the rest are null. */
      public static MemoryCheckpointCaptureReceiptManifest of(String id, Double seq) {
        return new MemoryCheckpointCaptureReceiptManifest(id, seq);
      }

      public MemoryCheckpointCaptureReceiptManifest withId(String value) {
        return new MemoryCheckpointCaptureReceiptManifest(value, seq);
      }

      public MemoryCheckpointCaptureReceiptManifest withSeq(Double value) {
        return new MemoryCheckpointCaptureReceiptManifest(id, value);
      }
    }
  }

  /**
   * Every memory API failure.
   */
  public record MemoryError(
      MemoryErrorError error) {

    /** With its required fields; the rest are null. */
    public static MemoryError of(MemoryErrorError error) {
      return new MemoryError(error);
    }

    public MemoryError withError(MemoryErrorError value) {
      return new MemoryError(value);
    }

    /**
     * @param code Stable, machine-readable: branch on this.
     * @param message For people; wording may change.
     * @param retryAfterMs When present, wait this long before retrying (exact; `Retry-After` is whole seconds).
     */
    public record MemoryErrorError(
        String code,
        String message,
        @Json.Name("retry_after_ms") Double retryAfterMs) {

      /** With its required fields; the rest are null. */
      public static MemoryErrorError of(String code, String message) {
        return new MemoryErrorError(code, message, null);
      }

      public MemoryErrorError withCode(String value) {
        return new MemoryErrorError(value, message, retryAfterMs);
      }

      public MemoryErrorError withMessage(String value) {
        return new MemoryErrorError(code, value, retryAfterMs);
      }

      public MemoryErrorError withRetryAfterMs(Double value) {
        return new MemoryErrorError(code, message, value);
      }
    }
  }

  public record MemoryExpansionCoverage(
      String policy,
      List<String> queries,
      List<Double> candidates,
      @Json.Name("candidate_limit") Double candidateLimit,
      String fusion) {

    /** With its required fields; the rest are null. */
    public static MemoryExpansionCoverage of(String policy, List<String> queries, List<Double> candidates, Double candidateLimit, String fusion) {
      return new MemoryExpansionCoverage(policy, queries, candidates, candidateLimit, fusion);
    }

    public MemoryExpansionCoverage withPolicy(String value) {
      return new MemoryExpansionCoverage(value, queries, candidates, candidateLimit, fusion);
    }

    public MemoryExpansionCoverage withQueries(List<String> value) {
      return new MemoryExpansionCoverage(policy, value, candidates, candidateLimit, fusion);
    }

    public MemoryExpansionCoverage withCandidates(List<Double> value) {
      return new MemoryExpansionCoverage(policy, queries, value, candidateLimit, fusion);
    }

    public MemoryExpansionCoverage withCandidateLimit(Double value) {
      return new MemoryExpansionCoverage(policy, queries, candidates, value, fusion);
    }

    public MemoryExpansionCoverage withFusion(String value) {
      return new MemoryExpansionCoverage(policy, queries, candidates, candidateLimit, value);
    }
  }

  public record MemoryFederatedRead(
      String mount,
      String id,
      String kind,
      Double version,
      Double start,
      Double end) {

    /** With its required fields; the rest are null. */
    public static MemoryFederatedRead of(String mount, String id, String kind) {
      return new MemoryFederatedRead(mount, id, kind, null, null, null);
    }

    public MemoryFederatedRead withMount(String value) {
      return new MemoryFederatedRead(value, id, kind, version, start, end);
    }

    public MemoryFederatedRead withId(String value) {
      return new MemoryFederatedRead(mount, value, kind, version, start, end);
    }

    public MemoryFederatedRead withKind(String value) {
      return new MemoryFederatedRead(mount, id, value, version, start, end);
    }

    public MemoryFederatedRead withVersion(Double value) {
      return new MemoryFederatedRead(mount, id, kind, value, start, end);
    }

    public MemoryFederatedRead withStart(Double value) {
      return new MemoryFederatedRead(mount, id, kind, version, value, end);
    }

    public MemoryFederatedRead withEnd(Double value) {
      return new MemoryFederatedRead(mount, id, kind, version, start, value);
    }
  }

  public record MemoryFederatedResult(
      List<Object> results,
      List<FailuresItem> failures,
      Boolean incomplete,
      Double bytes,
      Boolean truncated,
      String consistency,
      Boolean replicated) {

    /** With its required fields; the rest are null. */
    public static MemoryFederatedResult of(List<Object> results, List<FailuresItem> failures, Boolean incomplete, Double bytes, Boolean truncated, String consistency, Boolean replicated) {
      return new MemoryFederatedResult(results, failures, incomplete, bytes, truncated, consistency, replicated);
    }

    public MemoryFederatedResult withResults(List<Object> value) {
      return new MemoryFederatedResult(value, failures, incomplete, bytes, truncated, consistency, replicated);
    }

    public MemoryFederatedResult withFailures(List<FailuresItem> value) {
      return new MemoryFederatedResult(results, value, incomplete, bytes, truncated, consistency, replicated);
    }

    public MemoryFederatedResult withIncomplete(Boolean value) {
      return new MemoryFederatedResult(results, failures, value, bytes, truncated, consistency, replicated);
    }

    public MemoryFederatedResult withBytes(Double value) {
      return new MemoryFederatedResult(results, failures, incomplete, value, truncated, consistency, replicated);
    }

    public MemoryFederatedResult withTruncated(Boolean value) {
      return new MemoryFederatedResult(results, failures, incomplete, bytes, value, consistency, replicated);
    }

    public MemoryFederatedResult withConsistency(String value) {
      return new MemoryFederatedResult(results, failures, incomplete, bytes, truncated, value, replicated);
    }

    public MemoryFederatedResult withReplicated(Boolean value) {
      return new MemoryFederatedResult(results, failures, incomplete, bytes, truncated, consistency, value);
    }

    public record FailuresItem(
        String mount,
        String code) {

      /** With its required fields; the rest are null. */
      public static FailuresItem of(String mount, String code) {
        return new FailuresItem(mount, code);
      }

      public FailuresItem withMount(String value) {
        return new FailuresItem(value, code);
      }

      public FailuresItem withCode(String value) {
        return new FailuresItem(mount, value);
      }
    }
  }

  public record MemoryFederatedRetrievalResult(
      String schema,
      List<Object> evidence,
      List<PeersItem> peers,
      Double bytes,
      String consistency,
      @Json.Name("answer_sufficiency") String answerSufficiency,
      Boolean truncated) {

    /** With its required fields; the rest are null. */
    public static MemoryFederatedRetrievalResult of(String schema, List<Object> evidence, List<PeersItem> peers, Double bytes, String consistency, String answerSufficiency, Boolean truncated) {
      return new MemoryFederatedRetrievalResult(schema, evidence, peers, bytes, consistency, answerSufficiency, truncated);
    }

    public MemoryFederatedRetrievalResult withSchema(String value) {
      return new MemoryFederatedRetrievalResult(value, evidence, peers, bytes, consistency, answerSufficiency, truncated);
    }

    public MemoryFederatedRetrievalResult withEvidence(List<Object> value) {
      return new MemoryFederatedRetrievalResult(schema, value, peers, bytes, consistency, answerSufficiency, truncated);
    }

    public MemoryFederatedRetrievalResult withPeers(List<PeersItem> value) {
      return new MemoryFederatedRetrievalResult(schema, evidence, value, bytes, consistency, answerSufficiency, truncated);
    }

    public MemoryFederatedRetrievalResult withBytes(Double value) {
      return new MemoryFederatedRetrievalResult(schema, evidence, peers, value, consistency, answerSufficiency, truncated);
    }

    public MemoryFederatedRetrievalResult withConsistency(String value) {
      return new MemoryFederatedRetrievalResult(schema, evidence, peers, bytes, value, answerSufficiency, truncated);
    }

    public MemoryFederatedRetrievalResult withAnswerSufficiency(String value) {
      return new MemoryFederatedRetrievalResult(schema, evidence, peers, bytes, consistency, value, truncated);
    }

    public MemoryFederatedRetrievalResult withTruncated(Boolean value) {
      return new MemoryFederatedRetrievalResult(schema, evidence, peers, bytes, consistency, answerSufficiency, value);
    }

    public record PeersItem(
        String mount,
        @Json.Name("space_id") String spaceId,
        String status,
        @Json.Name("retrieval_generation") Double retrievalGeneration,
        @Json.Name("vocabulary_version") Double vocabularyVersion,
        @Json.Name("valid_at") Double validAt,
        String code) {

      /** With its required fields; the rest are null. */
      public static PeersItem of(String mount, String status) {
        return new PeersItem(mount, null, status, null, null, null, null);
      }

      public PeersItem withMount(String value) {
        return new PeersItem(value, spaceId, status, retrievalGeneration, vocabularyVersion, validAt, code);
      }

      public PeersItem withSpaceId(String value) {
        return new PeersItem(mount, value, status, retrievalGeneration, vocabularyVersion, validAt, code);
      }

      public PeersItem withStatus(String value) {
        return new PeersItem(mount, spaceId, value, retrievalGeneration, vocabularyVersion, validAt, code);
      }

      public PeersItem withRetrievalGeneration(Double value) {
        return new PeersItem(mount, spaceId, status, value, vocabularyVersion, validAt, code);
      }

      public PeersItem withVocabularyVersion(Double value) {
        return new PeersItem(mount, spaceId, status, retrievalGeneration, value, validAt, code);
      }

      public PeersItem withValidAt(Double value) {
        return new PeersItem(mount, spaceId, status, retrievalGeneration, vocabularyVersion, value, code);
      }

      public PeersItem withCode(String value) {
        return new PeersItem(mount, spaceId, status, retrievalGeneration, vocabularyVersion, validAt, value);
      }
    }
  }

  public record MemoryFederatedSearch(
      List<String> mounts,
      String query,
      String kind,
      String mode,
      Double limit,
      @Json.Name("max_bytes") Double maxBytes,
      @Json.Name("allow_partial") Boolean allowPartial) {

    /** With its required fields; the rest are null. */
    public static MemoryFederatedSearch of(List<String> mounts, String query) {
      return new MemoryFederatedSearch(mounts, query, null, null, null, null, null);
    }

    public MemoryFederatedSearch withMounts(List<String> value) {
      return new MemoryFederatedSearch(value, query, kind, mode, limit, maxBytes, allowPartial);
    }

    public MemoryFederatedSearch withQuery(String value) {
      return new MemoryFederatedSearch(mounts, value, kind, mode, limit, maxBytes, allowPartial);
    }

    public MemoryFederatedSearch withKind(String value) {
      return new MemoryFederatedSearch(mounts, query, value, mode, limit, maxBytes, allowPartial);
    }

    public MemoryFederatedSearch withMode(String value) {
      return new MemoryFederatedSearch(mounts, query, kind, value, limit, maxBytes, allowPartial);
    }

    public MemoryFederatedSearch withLimit(Double value) {
      return new MemoryFederatedSearch(mounts, query, kind, mode, value, maxBytes, allowPartial);
    }

    public MemoryFederatedSearch withMaxBytes(Double value) {
      return new MemoryFederatedSearch(mounts, query, kind, mode, limit, value, allowPartial);
    }

    public MemoryFederatedSearch withAllowPartial(Boolean value) {
      return new MemoryFederatedSearch(mounts, query, kind, mode, limit, maxBytes, value);
    }
  }

  public record MemoryGraphQuery(
      @Json.Name("include_stale") Boolean includeStale,
      @Json.Name("valid_at") Double validAt,
      String subject,
      List<String> predicates,
      String direction,
      @Json.Name("max_depth") Double maxDepth,
      Double limit) {

    /** With its required fields; the rest are null. */
    public static MemoryGraphQuery of(String subject) {
      return new MemoryGraphQuery(null, null, subject, null, null, null, null);
    }

    public MemoryGraphQuery withIncludeStale(Boolean value) {
      return new MemoryGraphQuery(value, validAt, subject, predicates, direction, maxDepth, limit);
    }

    public MemoryGraphQuery withValidAt(Double value) {
      return new MemoryGraphQuery(includeStale, value, subject, predicates, direction, maxDepth, limit);
    }

    public MemoryGraphQuery withSubject(String value) {
      return new MemoryGraphQuery(includeStale, validAt, value, predicates, direction, maxDepth, limit);
    }

    public MemoryGraphQuery withPredicates(List<String> value) {
      return new MemoryGraphQuery(includeStale, validAt, subject, value, direction, maxDepth, limit);
    }

    public MemoryGraphQuery withDirection(String value) {
      return new MemoryGraphQuery(includeStale, validAt, subject, predicates, value, maxDepth, limit);
    }

    public MemoryGraphQuery withMaxDepth(Double value) {
      return new MemoryGraphQuery(includeStale, validAt, subject, predicates, direction, value, limit);
    }

    public MemoryGraphQuery withLimit(Double value) {
      return new MemoryGraphQuery(includeStale, validAt, subject, predicates, direction, maxDepth, value);
    }
  }

  public record MemoryGraphResult(
      @Json.Name("space_id") String spaceId,
      Double generation,
      String root,
      List<EdgesItem> edges,
      Boolean truncated) {

    /** With its required fields; the rest are null. */
    public static MemoryGraphResult of(String spaceId, Double generation, String root, List<EdgesItem> edges, Boolean truncated) {
      return new MemoryGraphResult(spaceId, generation, root, edges, truncated);
    }

    public MemoryGraphResult withSpaceId(String value) {
      return new MemoryGraphResult(value, generation, root, edges, truncated);
    }

    public MemoryGraphResult withGeneration(Double value) {
      return new MemoryGraphResult(spaceId, value, root, edges, truncated);
    }

    public MemoryGraphResult withRoot(String value) {
      return new MemoryGraphResult(spaceId, generation, value, edges, truncated);
    }

    public MemoryGraphResult withEdges(List<EdgesItem> value) {
      return new MemoryGraphResult(spaceId, generation, root, value, truncated);
    }

    public MemoryGraphResult withTruncated(Boolean value) {
      return new MemoryGraphResult(spaceId, generation, root, edges, value);
    }

    public record EdgesItem(
        @Json.Name("record") MemoryRecord record_,
        List<String> path) {

      /** With its required fields; the rest are null. */
      public static EdgesItem of(MemoryRecord record_, List<String> path) {
        return new EdgesItem(record_, path);
      }

      public EdgesItem withRecord(MemoryRecord value) {
        return new EdgesItem(value, path);
      }

      public EdgesItem withPath(List<String> value) {
        return new EdgesItem(record_, value);
      }
    }
  }

  public record MemoryJobStatus(
      String id,
      @Json.Name("space_id") String spaceId,
      @Json.Name("record_id") String recordId,
      @Json.Name("note_id") Double noteId,
      String model,
      String state,
      Double attempts,
      @Json.Name("lease_until") Double leaseUntil,
      String error,
      @Json.Name("created_at") Double createdAt) {

    /** With its required fields; the rest are null. */
    public static MemoryJobStatus of(String id, String spaceId, String recordId, Double noteId, String model, String state, Double attempts, Double leaseUntil, String error, Double createdAt) {
      return new MemoryJobStatus(id, spaceId, recordId, noteId, model, state, attempts, leaseUntil, error, createdAt);
    }

    public MemoryJobStatus withId(String value) {
      return new MemoryJobStatus(value, spaceId, recordId, noteId, model, state, attempts, leaseUntil, error, createdAt);
    }

    public MemoryJobStatus withSpaceId(String value) {
      return new MemoryJobStatus(id, value, recordId, noteId, model, state, attempts, leaseUntil, error, createdAt);
    }

    public MemoryJobStatus withRecordId(String value) {
      return new MemoryJobStatus(id, spaceId, value, noteId, model, state, attempts, leaseUntil, error, createdAt);
    }

    public MemoryJobStatus withNoteId(Double value) {
      return new MemoryJobStatus(id, spaceId, recordId, value, model, state, attempts, leaseUntil, error, createdAt);
    }

    public MemoryJobStatus withModel(String value) {
      return new MemoryJobStatus(id, spaceId, recordId, noteId, value, state, attempts, leaseUntil, error, createdAt);
    }

    public MemoryJobStatus withState(String value) {
      return new MemoryJobStatus(id, spaceId, recordId, noteId, model, value, attempts, leaseUntil, error, createdAt);
    }

    public MemoryJobStatus withAttempts(Double value) {
      return new MemoryJobStatus(id, spaceId, recordId, noteId, model, state, value, leaseUntil, error, createdAt);
    }

    public MemoryJobStatus withLeaseUntil(Double value) {
      return new MemoryJobStatus(id, spaceId, recordId, noteId, model, state, attempts, value, error, createdAt);
    }

    public MemoryJobStatus withError(String value) {
      return new MemoryJobStatus(id, spaceId, recordId, noteId, model, state, attempts, leaseUntil, value, createdAt);
    }

    public MemoryJobStatus withCreatedAt(Double value) {
      return new MemoryJobStatus(id, spaceId, recordId, noteId, model, state, attempts, leaseUntil, error, value);
    }
  }

  public record MemoryPattern(
      Object subject,
      Object predicate,
      Object object) {

    /** With its required fields; the rest are null. */
    public static MemoryPattern of(Object subject, Object predicate, Object object) {
      return new MemoryPattern(subject, predicate, object);
    }

    public MemoryPattern withSubject(Object value) {
      return new MemoryPattern(value, predicate, object);
    }

    public MemoryPattern withPredicate(Object value) {
      return new MemoryPattern(subject, value, object);
    }

    public MemoryPattern withObject(Object value) {
      return new MemoryPattern(subject, predicate, value);
    }
  }

  public record MemoryJoin(
      List<MemoryPattern> patterns,
      List<String> select,
      @Json.Name("valid_at") Double validAt,
      Double limit) {

    /** With its required fields; the rest are null. */
    public static MemoryJoin of(List<MemoryPattern> patterns) {
      return new MemoryJoin(patterns, null, null, null);
    }

    public MemoryJoin withPatterns(List<MemoryPattern> value) {
      return new MemoryJoin(value, select, validAt, limit);
    }

    public MemoryJoin withSelect(List<String> value) {
      return new MemoryJoin(patterns, value, validAt, limit);
    }

    public MemoryJoin withValidAt(Double value) {
      return new MemoryJoin(patterns, select, value, limit);
    }

    public MemoryJoin withLimit(Double value) {
      return new MemoryJoin(patterns, select, validAt, value);
    }
  }

  public record MemoryMatch(
      Map<String, Object> bindings,
      List<WitnessesItem> witnesses,
      @Json.Name("valid_time") MemoryValidity validTime) {

    /** With its required fields; the rest are null. */
    public static MemoryMatch of(Map<String, Object> bindings, List<WitnessesItem> witnesses, MemoryValidity validTime) {
      return new MemoryMatch(bindings, witnesses, validTime);
    }

    public MemoryMatch withBindings(Map<String, Object> value) {
      return new MemoryMatch(value, witnesses, validTime);
    }

    public MemoryMatch withWitnesses(List<WitnessesItem> value) {
      return new MemoryMatch(bindings, value, validTime);
    }

    public MemoryMatch withValidTime(MemoryValidity value) {
      return new MemoryMatch(bindings, witnesses, value);
    }

    public record WitnessesItem(
        String id,
        Double version) {

      /** With its required fields; the rest are null. */
      public static WitnessesItem of(String id, Double version) {
        return new WitnessesItem(id, version);
      }

      public WitnessesItem withId(String value) {
        return new WitnessesItem(value, version);
      }

      public WitnessesItem withVersion(Double value) {
        return new WitnessesItem(id, value);
      }
    }
  }

  public record MemoryJoinResult(
      @Json.Name("space_id") String spaceId,
      Double generation,
      List<MemoryMatch> results,
      Boolean truncated,
      List<TraceItem> trace,
      String semantics) {

    /** With its required fields; the rest are null. */
    public static MemoryJoinResult of(String spaceId, Double generation, List<MemoryMatch> results, Boolean truncated, List<TraceItem> trace, String semantics) {
      return new MemoryJoinResult(spaceId, generation, results, truncated, trace, semantics);
    }

    public MemoryJoinResult withSpaceId(String value) {
      return new MemoryJoinResult(value, generation, results, truncated, trace, semantics);
    }

    public MemoryJoinResult withGeneration(Double value) {
      return new MemoryJoinResult(spaceId, value, results, truncated, trace, semantics);
    }

    public MemoryJoinResult withResults(List<MemoryMatch> value) {
      return new MemoryJoinResult(spaceId, generation, value, truncated, trace, semantics);
    }

    public MemoryJoinResult withTruncated(Boolean value) {
      return new MemoryJoinResult(spaceId, generation, results, value, trace, semantics);
    }

    public MemoryJoinResult withTrace(List<TraceItem> value) {
      return new MemoryJoinResult(spaceId, generation, results, truncated, value, semantics);
    }

    public MemoryJoinResult withSemantics(String value) {
      return new MemoryJoinResult(spaceId, generation, results, truncated, trace, value);
    }

    public record TraceItem(
        Double pattern,
        Double candidates,
        Double matches) {

      /** With its required fields; the rest are null. */
      public static TraceItem of(Double pattern, Double candidates, Double matches) {
        return new TraceItem(pattern, candidates, matches);
      }

      public TraceItem withPattern(Double value) {
        return new TraceItem(value, candidates, matches);
      }

      public TraceItem withCandidates(Double value) {
        return new TraceItem(pattern, value, matches);
      }

      public TraceItem withMatches(Double value) {
        return new TraceItem(pattern, candidates, value);
      }
    }
  }

  public record MemoryPlan(
      @Json.Name("retrieval_generation") Double retrievalGeneration,
      String schema,
      @Json.Name("space_id") String spaceId,
      Double generation,
      @Json.Name("vocabulary_version") Double vocabularyVersion,
      String task,
      String planner,
      List<String> assumptions,
      List<MemoryPlanStep> steps,
      Budget budget) {

    /** With its required fields; the rest are null. */
    public static MemoryPlan of(String schema, String spaceId, Double generation, Double vocabularyVersion, String task, String planner, List<String> assumptions, List<MemoryPlanStep> steps, Budget budget) {
      return new MemoryPlan(null, schema, spaceId, generation, vocabularyVersion, task, planner, assumptions, steps, budget);
    }

    public MemoryPlan withRetrievalGeneration(Double value) {
      return new MemoryPlan(value, schema, spaceId, generation, vocabularyVersion, task, planner, assumptions, steps, budget);
    }

    public MemoryPlan withSchema(String value) {
      return new MemoryPlan(retrievalGeneration, value, spaceId, generation, vocabularyVersion, task, planner, assumptions, steps, budget);
    }

    public MemoryPlan withSpaceId(String value) {
      return new MemoryPlan(retrievalGeneration, schema, value, generation, vocabularyVersion, task, planner, assumptions, steps, budget);
    }

    public MemoryPlan withGeneration(Double value) {
      return new MemoryPlan(retrievalGeneration, schema, spaceId, value, vocabularyVersion, task, planner, assumptions, steps, budget);
    }

    public MemoryPlan withVocabularyVersion(Double value) {
      return new MemoryPlan(retrievalGeneration, schema, spaceId, generation, value, task, planner, assumptions, steps, budget);
    }

    public MemoryPlan withTask(String value) {
      return new MemoryPlan(retrievalGeneration, schema, spaceId, generation, vocabularyVersion, value, planner, assumptions, steps, budget);
    }

    public MemoryPlan withPlanner(String value) {
      return new MemoryPlan(retrievalGeneration, schema, spaceId, generation, vocabularyVersion, task, value, assumptions, steps, budget);
    }

    public MemoryPlan withAssumptions(List<String> value) {
      return new MemoryPlan(retrievalGeneration, schema, spaceId, generation, vocabularyVersion, task, planner, value, steps, budget);
    }

    public MemoryPlan withSteps(List<MemoryPlanStep> value) {
      return new MemoryPlan(retrievalGeneration, schema, spaceId, generation, vocabularyVersion, task, planner, assumptions, value, budget);
    }

    public MemoryPlan withBudget(Budget value) {
      return new MemoryPlan(retrievalGeneration, schema, spaceId, generation, vocabularyVersion, task, planner, assumptions, steps, value);
    }

    public record Budget(
        @Json.Name("max_results") Double maxResults,
        @Json.Name("max_bytes") Double maxBytes) {

      /** With its required fields; the rest are null. */
      public static Budget of(Double maxResults, Double maxBytes) {
        return new Budget(maxResults, maxBytes);
      }

      public Budget withMaxResults(Double value) {
        return new Budget(value, maxBytes);
      }

      public Budget withMaxBytes(Double value) {
        return new Budget(maxResults, value);
      }
    }
  }

  public record MemoryPlanResult(
      @Json.Name("space_id") String spaceId,
      Double generation,
      List<MemoryPlanResultTraceItem> trace,
      Double bytes,
      Boolean truncated,
      @Json.Name("answer_sufficiency") String answerSufficiency) {

    /** With its required fields; the rest are null. */
    public static MemoryPlanResult of(String spaceId, Double generation, List<MemoryPlanResultTraceItem> trace, Double bytes, Boolean truncated, String answerSufficiency) {
      return new MemoryPlanResult(spaceId, generation, trace, bytes, truncated, answerSufficiency);
    }

    public MemoryPlanResult withSpaceId(String value) {
      return new MemoryPlanResult(value, generation, trace, bytes, truncated, answerSufficiency);
    }

    public MemoryPlanResult withGeneration(Double value) {
      return new MemoryPlanResult(spaceId, value, trace, bytes, truncated, answerSufficiency);
    }

    public MemoryPlanResult withTrace(List<MemoryPlanResultTraceItem> value) {
      return new MemoryPlanResult(spaceId, generation, value, bytes, truncated, answerSufficiency);
    }

    public MemoryPlanResult withBytes(Double value) {
      return new MemoryPlanResult(spaceId, generation, trace, value, truncated, answerSufficiency);
    }

    public MemoryPlanResult withTruncated(Boolean value) {
      return new MemoryPlanResult(spaceId, generation, trace, bytes, value, answerSufficiency);
    }

    public MemoryPlanResult withAnswerSufficiency(String value) {
      return new MemoryPlanResult(spaceId, generation, trace, bytes, truncated, value);
    }

    public record MemoryPlanResultTraceItem(
        String operation,
        Map<String, Object> input,
        List<Object> evidence,
        Boolean truncated) {

      /** With its required fields; the rest are null. */
      public static MemoryPlanResultTraceItem of(String operation, Map<String, Object> input, List<Object> evidence, Boolean truncated) {
        return new MemoryPlanResultTraceItem(operation, input, evidence, truncated);
      }

      public MemoryPlanResultTraceItem withOperation(String value) {
        return new MemoryPlanResultTraceItem(value, input, evidence, truncated);
      }

      public MemoryPlanResultTraceItem withInput(Map<String, Object> value) {
        return new MemoryPlanResultTraceItem(operation, value, evidence, truncated);
      }

      public MemoryPlanResultTraceItem withEvidence(List<Object> value) {
        return new MemoryPlanResultTraceItem(operation, input, value, truncated);
      }

      public MemoryPlanResultTraceItem withTruncated(Boolean value) {
        return new MemoryPlanResultTraceItem(operation, input, evidence, value);
      }
    }
  }

  public record MemoryQuery(
      @Json.Name("include_stale") Boolean includeStale,
      @Json.Name("valid_at") Double validAt,
      String subject,
      String predicate,
      Object object,
      String type,
      String tier,
      Double limit,
      String cursor) {

    /** With its required fields; the rest are null. */
    public static MemoryQuery of() {
      return new MemoryQuery(null, null, null, null, null, null, null, null, null);
    }

    public MemoryQuery withIncludeStale(Boolean value) {
      return new MemoryQuery(value, validAt, subject, predicate, object, type, tier, limit, cursor);
    }

    public MemoryQuery withValidAt(Double value) {
      return new MemoryQuery(includeStale, value, subject, predicate, object, type, tier, limit, cursor);
    }

    public MemoryQuery withSubject(String value) {
      return new MemoryQuery(includeStale, validAt, value, predicate, object, type, tier, limit, cursor);
    }

    public MemoryQuery withPredicate(String value) {
      return new MemoryQuery(includeStale, validAt, subject, value, object, type, tier, limit, cursor);
    }

    public MemoryQuery withObject(Object value) {
      return new MemoryQuery(includeStale, validAt, subject, predicate, value, type, tier, limit, cursor);
    }

    public MemoryQuery withType(String value) {
      return new MemoryQuery(includeStale, validAt, subject, predicate, object, value, tier, limit, cursor);
    }

    public MemoryQuery withTier(String value) {
      return new MemoryQuery(includeStale, validAt, subject, predicate, object, type, value, limit, cursor);
    }

    public MemoryQuery withLimit(Double value) {
      return new MemoryQuery(includeStale, validAt, subject, predicate, object, type, tier, value, cursor);
    }

    public MemoryQuery withCursor(String value) {
      return new MemoryQuery(includeStale, validAt, subject, predicate, object, type, tier, limit, value);
    }
  }

  public record MemoryQueryResult(
      @Json.Name("space_id") String spaceId,
      Double generation,
      String mode,
      List<MemoryRecord> results,
      @Json.Name("next_cursor") String nextCursor) {

    /** With its required fields; the rest are null. */
    public static MemoryQueryResult of(String spaceId, Double generation, String mode, List<MemoryRecord> results, String nextCursor) {
      return new MemoryQueryResult(spaceId, generation, mode, results, nextCursor);
    }

    public MemoryQueryResult withSpaceId(String value) {
      return new MemoryQueryResult(value, generation, mode, results, nextCursor);
    }

    public MemoryQueryResult withGeneration(Double value) {
      return new MemoryQueryResult(spaceId, value, mode, results, nextCursor);
    }

    public MemoryQueryResult withMode(String value) {
      return new MemoryQueryResult(spaceId, generation, value, results, nextCursor);
    }

    public MemoryQueryResult withResults(List<MemoryRecord> value) {
      return new MemoryQueryResult(spaceId, generation, mode, value, nextCursor);
    }

    public MemoryQueryResult withNextCursor(String value) {
      return new MemoryQueryResult(spaceId, generation, mode, results, value);
    }
  }

  public record MemoryRecordInput(
      @Json.Name("dependency_versions") Map<String, Double> dependencyVersions,
      @Json.Name("valid_time") MemoryValidity validTime,
      @Json.Name("expected_vocabulary_version") Double expectedVocabularyVersion,
      String content,
      String type,
      String tier,
      Double importance,
      String subject,
      Map<String, Object> metadata,
      @Json.Name("source_ids") List<String> sourceIds,
      @Json.Name("depends_on") List<String> dependsOn,
      MemoryClaim claim) {

    /** With its required fields; the rest are null. */
    public static MemoryRecordInput of(String content) {
      return new MemoryRecordInput(null, null, null, content, null, null, null, null, null, null, null, null);
    }

    public MemoryRecordInput withDependencyVersions(Map<String, Double> value) {
      return new MemoryRecordInput(value, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withValidTime(MemoryValidity value) {
      return new MemoryRecordInput(dependencyVersions, value, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withExpectedVocabularyVersion(Double value) {
      return new MemoryRecordInput(dependencyVersions, validTime, value, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withContent(String value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, value, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withType(String value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, content, value, tier, importance, subject, metadata, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withTier(String value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, content, type, value, importance, subject, metadata, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withImportance(Double value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, value, subject, metadata, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withSubject(String value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, value, metadata, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withMetadata(Map<String, Object> value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, value, sourceIds, dependsOn, claim);
    }

    public MemoryRecordInput withSourceIds(List<String> value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, value, dependsOn, claim);
    }

    public MemoryRecordInput withDependsOn(List<String> value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, value, claim);
    }

    public MemoryRecordInput withClaim(MemoryClaim value) {
      return new MemoryRecordInput(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, value);
    }
  }

  /**
   * Reputation-weighted re-rank applied to SHARED-space search results (records the actor does not own). Bounded, inspectable, deterministic — see db-memory-ranking.ts.
   *
   * @param usefulness Usefulness factor from others' evidence (`MARINA_MEMORY_USEFULNESS_RANKING`); absent when off.
   */
  public record MemoryReputationRanking(
      Double weight,
      @Json.Name("standing_ceiling") Double standingCeiling,
      Double applied,
      Double considered,
      Map<String, AuthorsValue> authors,
      Usefulness usefulness) {

    /** With its required fields; the rest are null. */
    public static MemoryReputationRanking of(Double weight, Double standingCeiling, Double applied, Double considered, Map<String, AuthorsValue> authors) {
      return new MemoryReputationRanking(weight, standingCeiling, applied, considered, authors, null);
    }

    public MemoryReputationRanking withWeight(Double value) {
      return new MemoryReputationRanking(value, standingCeiling, applied, considered, authors, usefulness);
    }

    public MemoryReputationRanking withStandingCeiling(Double value) {
      return new MemoryReputationRanking(weight, value, applied, considered, authors, usefulness);
    }

    public MemoryReputationRanking withApplied(Double value) {
      return new MemoryReputationRanking(weight, standingCeiling, value, considered, authors, usefulness);
    }

    public MemoryReputationRanking withConsidered(Double value) {
      return new MemoryReputationRanking(weight, standingCeiling, applied, value, authors, usefulness);
    }

    public MemoryReputationRanking withAuthors(Map<String, AuthorsValue> value) {
      return new MemoryReputationRanking(weight, standingCeiling, applied, considered, value, usefulness);
    }

    public MemoryReputationRanking withUsefulness(Usefulness value) {
      return new MemoryReputationRanking(weight, standingCeiling, applied, considered, authors, value);
    }

    public record AuthorsValue(
        String author,
        Double standing,
        Double term) {

      /** With its required fields; the rest are null. */
      public static AuthorsValue of(String author, Double standing, Double term) {
        return new AuthorsValue(author, standing, term);
      }

      public AuthorsValue withAuthor(String value) {
        return new AuthorsValue(value, standing, term);
      }

      public AuthorsValue withStanding(Double value) {
        return new AuthorsValue(author, value, term);
      }

      public AuthorsValue withTerm(Double value) {
        return new AuthorsValue(author, standing, value);
      }
    }

    /**
     * Usefulness factor from others' evidence (`MARINA_MEMORY_USEFULNESS_RANKING`); absent when off.
     */
    public record Usefulness(
        String mode,
        Double weight,
        Boolean applied,
        Map<String, ItemsValue> items) {

      /** With its required fields; the rest are null. */
      public static Usefulness of(String mode, Double weight, Boolean applied, Map<String, ItemsValue> items) {
        return new Usefulness(mode, weight, applied, items);
      }

      public Usefulness withMode(String value) {
        return new Usefulness(value, weight, applied, items);
      }

      public Usefulness withWeight(Double value) {
        return new Usefulness(mode, value, applied, items);
      }

      public Usefulness withApplied(Boolean value) {
        return new Usefulness(mode, weight, value, items);
      }

      public Usefulness withItems(Map<String, ItemsValue> value) {
        return new Usefulness(mode, weight, applied, value);
      }

      public record ItemsValue(
          Double alpha,
          Double beta,
          Double n,
          Double mean,
          Double term) {

        /** With its required fields; the rest are null. */
        public static ItemsValue of(Double alpha, Double beta, Double n, Double mean, Double term) {
          return new ItemsValue(alpha, beta, n, mean, term);
        }

        public ItemsValue withAlpha(Double value) {
          return new ItemsValue(value, beta, n, mean, term);
        }

        public ItemsValue withBeta(Double value) {
          return new ItemsValue(alpha, value, n, mean, term);
        }

        public ItemsValue withN(Double value) {
          return new ItemsValue(alpha, beta, value, mean, term);
        }

        public ItemsValue withMean(Double value) {
          return new ItemsValue(alpha, beta, n, value, term);
        }

        public ItemsValue withTerm(Double value) {
          return new ItemsValue(alpha, beta, n, mean, value);
        }
      }
    }
  }

  public record MemoryResolutionMembership(
      String id,
      String policy,
      String status,
      String role,
      String rationale,
      Double deadline,
      @Json.Name("created_at") Double createdAt) {

    /** With its required fields; the rest are null. */
    public static MemoryResolutionMembership of(String id, String policy, String status, String role, String rationale, Double deadline, Double createdAt) {
      return new MemoryResolutionMembership(id, policy, status, role, rationale, deadline, createdAt);
    }

    public MemoryResolutionMembership withId(String value) {
      return new MemoryResolutionMembership(value, policy, status, role, rationale, deadline, createdAt);
    }

    public MemoryResolutionMembership withPolicy(String value) {
      return new MemoryResolutionMembership(id, value, status, role, rationale, deadline, createdAt);
    }

    public MemoryResolutionMembership withStatus(String value) {
      return new MemoryResolutionMembership(id, policy, value, role, rationale, deadline, createdAt);
    }

    public MemoryResolutionMembership withRole(String value) {
      return new MemoryResolutionMembership(id, policy, status, value, rationale, deadline, createdAt);
    }

    public MemoryResolutionMembership withRationale(String value) {
      return new MemoryResolutionMembership(id, policy, status, role, value, deadline, createdAt);
    }

    public MemoryResolutionMembership withDeadline(Double value) {
      return new MemoryResolutionMembership(id, policy, status, role, rationale, value, createdAt);
    }

    public MemoryResolutionMembership withCreatedAt(Double value) {
      return new MemoryResolutionMembership(id, policy, status, role, rationale, deadline, value);
    }
  }

  /**
   * @param id Resolution (audit row) ID.
   */
  public record MemoryResolveResult(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      @Json.Name("record_id") String recordId,
      String policy,
      String status,
      String winner,
      List<SupersededItem> superseded,
      List<String> peers,
      List<String> pending,
      @Json.Name("evidence_counts") Map<String, Double> evidenceCounts,
      Double deadline) {

    /** With its required fields; the rest are null. */
    public static MemoryResolveResult of(String id, String recordId, String policy, String status, String winner, List<SupersededItem> superseded, List<String> peers, List<String> pending, Map<String, Double> evidenceCounts, Double deadline) {
      return new MemoryResolveResult(id, null, null, null, null, recordId, policy, status, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withId(String value) {
      return new MemoryResolveResult(value, version, jobId, seq, generation, recordId, policy, status, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withVersion(Double value) {
      return new MemoryResolveResult(id, value, jobId, seq, generation, recordId, policy, status, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withJobId(String value) {
      return new MemoryResolveResult(id, version, value, seq, generation, recordId, policy, status, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withSeq(Double value) {
      return new MemoryResolveResult(id, version, jobId, value, generation, recordId, policy, status, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withGeneration(Double value) {
      return new MemoryResolveResult(id, version, jobId, seq, value, recordId, policy, status, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withRecordId(String value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, value, policy, status, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withPolicy(String value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, recordId, value, status, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withStatus(String value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, recordId, policy, value, winner, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withWinner(String value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, recordId, policy, status, value, superseded, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withSuperseded(List<SupersededItem> value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, recordId, policy, status, winner, value, peers, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withPeers(List<String> value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, recordId, policy, status, winner, superseded, value, pending, evidenceCounts, deadline);
    }

    public MemoryResolveResult withPending(List<String> value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, recordId, policy, status, winner, superseded, peers, value, evidenceCounts, deadline);
    }

    public MemoryResolveResult withEvidenceCounts(Map<String, Double> value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, recordId, policy, status, winner, superseded, peers, pending, value, deadline);
    }

    public MemoryResolveResult withDeadline(Double value) {
      return new MemoryResolveResult(id, version, jobId, seq, generation, recordId, policy, status, winner, superseded, peers, pending, evidenceCounts, value);
    }

    public record SupersededItem(
        String id,
        Double version,
        @Json.Name("valid_time") MemoryValidity validTime) {

      /** With its required fields; the rest are null. */
      public static SupersededItem of(String id, Double version, MemoryValidity validTime) {
        return new SupersededItem(id, version, validTime);
      }

      public SupersededItem withId(String value) {
        return new SupersededItem(value, version, validTime);
      }

      public SupersededItem withVersion(Double value) {
        return new SupersededItem(id, value, validTime);
      }

      public SupersededItem withValidTime(MemoryValidity value) {
        return new SupersededItem(id, version, value);
      }
    }
  }

  public record MemoryRetrievalResult(
      String schema,
      @Json.Name("space_id") String spaceId,
      Double generation,
      @Json.Name("retrieval_generation") Double retrievalGeneration,
      @Json.Name("vocabulary_version") Double vocabularyVersion,
      @Json.Name("valid_at") Double validAt,
      String status,
      MemoryPlan plan,
      List<Object> evidence,
      List<MemoryRetrievalResultTraceItem> trace,
      MemoryRetrievalResultBudget budget,
      Double bytes,
      Boolean truncated,
      @Json.Name("answer_sufficiency") String answerSufficiency,
      String selection,
      @Json.Name("selection_contract") String selectionContract,
      @Json.Name("selected_recipe") SelectedRecipe selectedRecipe,
      @Json.Name("observed_candidates") List<Object> observedCandidates,
      List<CoverageItem> coverage,
      @Json.Name("known_conflicts") List<KnownConflictsItem> knownConflicts,
      Diagnostics diagnostics,
      List<String> limitations) {

    /** With its required fields; the rest are null. */
    public static MemoryRetrievalResult of(String schema, String spaceId, Double generation, Double retrievalGeneration, Double vocabularyVersion, Double validAt, String status, MemoryPlan plan, List<Object> evidence, List<MemoryRetrievalResultTraceItem> trace, MemoryRetrievalResultBudget budget, Double bytes, Boolean truncated, String answerSufficiency, Diagnostics diagnostics, List<String> limitations) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, null, null, null, null, null, null, diagnostics, limitations);
    }

    public MemoryRetrievalResult withSchema(String value) {
      return new MemoryRetrievalResult(value, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withSpaceId(String value) {
      return new MemoryRetrievalResult(schema, value, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withGeneration(Double value) {
      return new MemoryRetrievalResult(schema, spaceId, value, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withRetrievalGeneration(Double value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, value, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withVocabularyVersion(Double value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, value, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withValidAt(Double value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, value, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withStatus(String value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, value, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withPlan(MemoryPlan value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, value, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withEvidence(List<Object> value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, value, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withTrace(List<MemoryRetrievalResultTraceItem> value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, value, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withBudget(MemoryRetrievalResultBudget value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, value, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withBytes(Double value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, value, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withTruncated(Boolean value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, value, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withAnswerSufficiency(String value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, value, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withSelection(String value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, value, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withSelectionContract(String value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, value, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withSelectedRecipe(SelectedRecipe value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, value, observedCandidates, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withObservedCandidates(List<Object> value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, value, coverage, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withCoverage(List<CoverageItem> value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, value, knownConflicts, diagnostics, limitations);
    }

    public MemoryRetrievalResult withKnownConflicts(List<KnownConflictsItem> value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, value, diagnostics, limitations);
    }

    public MemoryRetrievalResult withDiagnostics(Diagnostics value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, value, limitations);
    }

    public MemoryRetrievalResult withLimitations(List<String> value) {
      return new MemoryRetrievalResult(schema, spaceId, generation, retrievalGeneration, vocabularyVersion, validAt, status, plan, evidence, trace, budget, bytes, truncated, answerSufficiency, selection, selectionContract, selectedRecipe, observedCandidates, coverage, knownConflicts, diagnostics, value);
    }

    public record MemoryRetrievalResultTraceItem(
        Object operation,
        Map<String, Object> input,
        Double returned,
        Boolean truncated,
        String reason) {

      /** With its required fields; the rest are null. */
      public static MemoryRetrievalResultTraceItem of(Object operation, Map<String, Object> input, Double returned, Boolean truncated, String reason) {
        return new MemoryRetrievalResultTraceItem(operation, input, returned, truncated, reason);
      }

      public MemoryRetrievalResultTraceItem withOperation(Object value) {
        return new MemoryRetrievalResultTraceItem(value, input, returned, truncated, reason);
      }

      public MemoryRetrievalResultTraceItem withInput(Map<String, Object> value) {
        return new MemoryRetrievalResultTraceItem(operation, value, returned, truncated, reason);
      }

      public MemoryRetrievalResultTraceItem withReturned(Double value) {
        return new MemoryRetrievalResultTraceItem(operation, input, value, truncated, reason);
      }

      public MemoryRetrievalResultTraceItem withTruncated(Boolean value) {
        return new MemoryRetrievalResultTraceItem(operation, input, returned, value, reason);
      }

      public MemoryRetrievalResultTraceItem withReason(String value) {
        return new MemoryRetrievalResultTraceItem(operation, input, returned, truncated, value);
      }
    }

    public record MemoryRetrievalResultBudget(
        @Json.Name("max_results") Double maxResults,
        @Json.Name("max_bytes") Double maxBytes,
        @Json.Name("source_bytes") Double sourceBytes) {

      /** With its required fields; the rest are null. */
      public static MemoryRetrievalResultBudget of(Double maxResults, Double maxBytes, Double sourceBytes) {
        return new MemoryRetrievalResultBudget(maxResults, maxBytes, sourceBytes);
      }

      public MemoryRetrievalResultBudget withMaxResults(Double value) {
        return new MemoryRetrievalResultBudget(value, maxBytes, sourceBytes);
      }

      public MemoryRetrievalResultBudget withMaxBytes(Double value) {
        return new MemoryRetrievalResultBudget(maxResults, value, sourceBytes);
      }

      public MemoryRetrievalResultBudget withSourceBytes(Double value) {
        return new MemoryRetrievalResultBudget(maxResults, maxBytes, value);
      }
    }

    public record SelectedRecipe(
        @Json.Name("space_id") String spaceId,
        String id,
        Double version) {

      /** With its required fields; the rest are null. */
      public static SelectedRecipe of(String spaceId, String id, Double version) {
        return new SelectedRecipe(spaceId, id, version);
      }

      public SelectedRecipe withSpaceId(String value) {
        return new SelectedRecipe(value, id, version);
      }

      public SelectedRecipe withId(String value) {
        return new SelectedRecipe(spaceId, value, version);
      }

      public SelectedRecipe withVersion(Double value) {
        return new SelectedRecipe(spaceId, id, value);
      }
    }

    public record CoverageItem(
        Object requirement,
        Boolean covered) {

      /** With its required fields; the rest are null. */
      public static CoverageItem of(Object requirement, Boolean covered) {
        return new CoverageItem(requirement, covered);
      }

      public CoverageItem withRequirement(Object value) {
        return new CoverageItem(value, covered);
      }

      public CoverageItem withCovered(Boolean value) {
        return new CoverageItem(requirement, value);
      }
    }

    public record KnownConflictsItem(
        String subject,
        String predicate,
        List<String> records) {

      /** With its required fields; the rest are null. */
      public static KnownConflictsItem of(String subject, String predicate, List<String> records) {
        return new KnownConflictsItem(subject, predicate, records);
      }

      public KnownConflictsItem withSubject(String value) {
        return new KnownConflictsItem(value, predicate, records);
      }

      public KnownConflictsItem withPredicate(String value) {
        return new KnownConflictsItem(subject, value, records);
      }

      public KnownConflictsItem withRecords(List<String> value) {
        return new KnownConflictsItem(subject, predicate, value);
      }
    }

    public record Diagnostics(
        Boolean broadened,
        @Json.Name("discovery_truncated") Boolean discoveryTruncated,
        @Json.Name("budget_limited") Boolean budgetLimited,
        @Json.Name("filtered_records") Double filteredRecords,
        @Json.Name("partial_sources") Double partialSources,
        @Json.Name("next_actions") List<String> nextActions) {

      /** With its required fields; the rest are null. */
      public static Diagnostics of(Boolean broadened, Boolean discoveryTruncated, Boolean budgetLimited, Double filteredRecords, Double partialSources, List<String> nextActions) {
        return new Diagnostics(broadened, discoveryTruncated, budgetLimited, filteredRecords, partialSources, nextActions);
      }

      public Diagnostics withBroadened(Boolean value) {
        return new Diagnostics(value, discoveryTruncated, budgetLimited, filteredRecords, partialSources, nextActions);
      }

      public Diagnostics withDiscoveryTruncated(Boolean value) {
        return new Diagnostics(broadened, value, budgetLimited, filteredRecords, partialSources, nextActions);
      }

      public Diagnostics withBudgetLimited(Boolean value) {
        return new Diagnostics(broadened, discoveryTruncated, value, filteredRecords, partialSources, nextActions);
      }

      public Diagnostics withFilteredRecords(Double value) {
        return new Diagnostics(broadened, discoveryTruncated, budgetLimited, value, partialSources, nextActions);
      }

      public Diagnostics withPartialSources(Double value) {
        return new Diagnostics(broadened, discoveryTruncated, budgetLimited, filteredRecords, value, nextActions);
      }

      public Diagnostics withNextActions(List<String> value) {
        return new Diagnostics(broadened, discoveryTruncated, budgetLimited, filteredRecords, partialSources, value);
      }
    }
  }

  public record MemoryReviewResult(
      @Json.Name("space_id") String spaceId,
      @Json.Name("retrieval_generation") Double retrievalGeneration,
      List<MemoryReviewResultItemsItem> items,
      @Json.Name("next_cursor") String nextCursor) {

    /** With its required fields; the rest are null. */
    public static MemoryReviewResult of(String spaceId, Double retrievalGeneration, List<MemoryReviewResultItemsItem> items, String nextCursor) {
      return new MemoryReviewResult(spaceId, retrievalGeneration, items, nextCursor);
    }

    public MemoryReviewResult withSpaceId(String value) {
      return new MemoryReviewResult(value, retrievalGeneration, items, nextCursor);
    }

    public MemoryReviewResult withRetrievalGeneration(Double value) {
      return new MemoryReviewResult(spaceId, value, items, nextCursor);
    }

    public MemoryReviewResult withItems(List<MemoryReviewResultItemsItem> value) {
      return new MemoryReviewResult(spaceId, retrievalGeneration, value, nextCursor);
    }

    public MemoryReviewResult withNextCursor(String value) {
      return new MemoryReviewResult(spaceId, retrievalGeneration, items, value);
    }

    /**
     * @param resolution The record's live resolution membership, when one exists.
     */
    public record MemoryReviewResultItemsItem(
        @Json.Name("record") MemoryRecord record_,
        List<PremisesItem> premises,
        @Json.Name("competing_records") List<MemoryRecord> competingRecords,
        @Json.Name("competing_truncated") Boolean competingTruncated,
        MemoryResolutionMembership resolution) {

      /** With its required fields; the rest are null. */
      public static MemoryReviewResultItemsItem of(MemoryRecord record_, List<PremisesItem> premises, List<MemoryRecord> competingRecords, Boolean competingTruncated) {
        return new MemoryReviewResultItemsItem(record_, premises, competingRecords, competingTruncated, null);
      }

      public MemoryReviewResultItemsItem withRecord(MemoryRecord value) {
        return new MemoryReviewResultItemsItem(value, premises, competingRecords, competingTruncated, resolution);
      }

      public MemoryReviewResultItemsItem withPremises(List<PremisesItem> value) {
        return new MemoryReviewResultItemsItem(record_, value, competingRecords, competingTruncated, resolution);
      }

      public MemoryReviewResultItemsItem withCompetingRecords(List<MemoryRecord> value) {
        return new MemoryReviewResultItemsItem(record_, premises, value, competingTruncated, resolution);
      }

      public MemoryReviewResultItemsItem withCompetingTruncated(Boolean value) {
        return new MemoryReviewResultItemsItem(record_, premises, competingRecords, value, resolution);
      }

      public MemoryReviewResultItemsItem withResolution(MemoryResolutionMembership value) {
        return new MemoryReviewResultItemsItem(record_, premises, competingRecords, competingTruncated, value);
      }

      public record PremisesItem(
          String id,
          @Json.Name("pinned_version") Double pinnedVersion,
          @Json.Name("current_version") Double currentVersion,
          String state) {

        /** With its required fields; the rest are null. */
        public static PremisesItem of(String id, Double pinnedVersion, Double currentVersion, String state) {
          return new PremisesItem(id, pinnedVersion, currentVersion, state);
        }

        public PremisesItem withId(String value) {
          return new PremisesItem(value, pinnedVersion, currentVersion, state);
        }

        public PremisesItem withPinnedVersion(Double value) {
          return new PremisesItem(id, value, currentVersion, state);
        }

        public PremisesItem withCurrentVersion(Double value) {
          return new PremisesItem(id, pinnedVersion, value, state);
        }

        public PremisesItem withState(String value) {
          return new PremisesItem(id, pinnedVersion, currentVersion, value);
        }
      }
    }
  }

  public record MemoryRule(
      String schema,
      String name,
      MemoryJoin query,
      MemoryPattern conclusion) {

    /** With its required fields; the rest are null. */
    public static MemoryRule of(String schema, String name, MemoryJoin query, MemoryPattern conclusion) {
      return new MemoryRule(schema, name, query, conclusion);
    }

    public MemoryRule withSchema(String value) {
      return new MemoryRule(value, name, query, conclusion);
    }

    public MemoryRule withName(String value) {
      return new MemoryRule(schema, value, query, conclusion);
    }

    public MemoryRule withQuery(MemoryJoin value) {
      return new MemoryRule(schema, name, value, conclusion);
    }

    public MemoryRule withConclusion(MemoryPattern value) {
      return new MemoryRule(schema, name, query, value);
    }
  }

  public record MemoryRuleResult(
      @Json.Name("space_id") String spaceId,
      Double generation,
      List<ResultsItem> results,
      Boolean truncated,
      List<MemoryRuleResultTraceItem> trace,
      String semantics,
      Rule rule) {

    /** With its required fields; the rest are null. */
    public static MemoryRuleResult of(String spaceId, Double generation, List<ResultsItem> results, Boolean truncated, List<MemoryRuleResultTraceItem> trace, String semantics, Rule rule) {
      return new MemoryRuleResult(spaceId, generation, results, truncated, trace, semantics, rule);
    }

    public MemoryRuleResult withSpaceId(String value) {
      return new MemoryRuleResult(value, generation, results, truncated, trace, semantics, rule);
    }

    public MemoryRuleResult withGeneration(Double value) {
      return new MemoryRuleResult(spaceId, value, results, truncated, trace, semantics, rule);
    }

    public MemoryRuleResult withResults(List<ResultsItem> value) {
      return new MemoryRuleResult(spaceId, generation, value, truncated, trace, semantics, rule);
    }

    public MemoryRuleResult withTruncated(Boolean value) {
      return new MemoryRuleResult(spaceId, generation, results, value, trace, semantics, rule);
    }

    public MemoryRuleResult withTrace(List<MemoryRuleResultTraceItem> value) {
      return new MemoryRuleResult(spaceId, generation, results, truncated, value, semantics, rule);
    }

    public MemoryRuleResult withSemantics(String value) {
      return new MemoryRuleResult(spaceId, generation, results, truncated, trace, value, rule);
    }

    public MemoryRuleResult withRule(Rule value) {
      return new MemoryRuleResult(spaceId, generation, results, truncated, trace, semantics, value);
    }

    public record ResultsItem(
        Map<String, Object> bindings,
        List<ResultsItemWitnessesItem> witnesses,
        @Json.Name("valid_time") MemoryValidity validTime,
        MemoryClaim claim) {

      /** With its required fields; the rest are null. */
      public static ResultsItem of(Map<String, Object> bindings, List<ResultsItemWitnessesItem> witnesses, MemoryValidity validTime, MemoryClaim claim) {
        return new ResultsItem(bindings, witnesses, validTime, claim);
      }

      public ResultsItem withBindings(Map<String, Object> value) {
        return new ResultsItem(value, witnesses, validTime, claim);
      }

      public ResultsItem withWitnesses(List<ResultsItemWitnessesItem> value) {
        return new ResultsItem(bindings, value, validTime, claim);
      }

      public ResultsItem withValidTime(MemoryValidity value) {
        return new ResultsItem(bindings, witnesses, value, claim);
      }

      public ResultsItem withClaim(MemoryClaim value) {
        return new ResultsItem(bindings, witnesses, validTime, value);
      }

      public record ResultsItemWitnessesItem(
          String id,
          Double version) {

        /** With its required fields; the rest are null. */
        public static ResultsItemWitnessesItem of(String id, Double version) {
          return new ResultsItemWitnessesItem(id, version);
        }

        public ResultsItemWitnessesItem withId(String value) {
          return new ResultsItemWitnessesItem(value, version);
        }

        public ResultsItemWitnessesItem withVersion(Double value) {
          return new ResultsItemWitnessesItem(id, value);
        }
      }
    }

    public record MemoryRuleResultTraceItem(
        Double pattern,
        Double candidates,
        Double matches) {

      /** With its required fields; the rest are null. */
      public static MemoryRuleResultTraceItem of(Double pattern, Double candidates, Double matches) {
        return new MemoryRuleResultTraceItem(pattern, candidates, matches);
      }

      public MemoryRuleResultTraceItem withPattern(Double value) {
        return new MemoryRuleResultTraceItem(value, candidates, matches);
      }

      public MemoryRuleResultTraceItem withCandidates(Double value) {
        return new MemoryRuleResultTraceItem(pattern, value, matches);
      }

      public MemoryRuleResultTraceItem withMatches(Double value) {
        return new MemoryRuleResultTraceItem(pattern, candidates, value);
      }
    }

    public record Rule(
        String id,
        Double version) {

      /** With its required fields; the rest are null. */
      public static Rule of(String id, Double version) {
        return new Rule(id, version);
      }

      public Rule withId(String value) {
        return new Rule(value, version);
      }

      public Rule withVersion(Double value) {
        return new Rule(id, value);
      }
    }
  }

  /**
   * @param validAt Validity of ranked records. Default: a record whose `valid_time.until` has passed (retired by a tombstone `revise`, a `resolve` loser) is excluded before ranking, so it never takes a result slot. `valid_at` (UTC ms) serves the records valid at that instant instead (`from &lt;= t &lt; until`, as `query` and `graph`). `include_ended: true` is the explicit history/audit read and returns every active record regardless of validity; it cannot be combined with `valid_at`. Exact `get`/`history` reads are never filtered.
   */
  public record MemorySearchInput(
      @Json.Name("include_stale") Boolean includeStale,
      String subject,
      String type,
      String tier,
      String query,
      MemoryQueryExpansion expansion,
      Double limit,
      String mode,
      @Json.Name("allow_degraded") Boolean allowDegraded,
      @Json.Name("valid_at") Double validAt,
      @Json.Name("include_ended") Boolean includeEnded) {

    /** With its required fields; the rest are null. */
    public static MemorySearchInput of(String query) {
      return new MemorySearchInput(null, null, null, null, query, null, null, null, null, null, null);
    }

    public MemorySearchInput withIncludeStale(Boolean value) {
      return new MemorySearchInput(value, subject, type, tier, query, expansion, limit, mode, allowDegraded, validAt, includeEnded);
    }

    public MemorySearchInput withSubject(String value) {
      return new MemorySearchInput(includeStale, value, type, tier, query, expansion, limit, mode, allowDegraded, validAt, includeEnded);
    }

    public MemorySearchInput withType(String value) {
      return new MemorySearchInput(includeStale, subject, value, tier, query, expansion, limit, mode, allowDegraded, validAt, includeEnded);
    }

    public MemorySearchInput withTier(String value) {
      return new MemorySearchInput(includeStale, subject, type, value, query, expansion, limit, mode, allowDegraded, validAt, includeEnded);
    }

    public MemorySearchInput withQuery(String value) {
      return new MemorySearchInput(includeStale, subject, type, tier, value, expansion, limit, mode, allowDegraded, validAt, includeEnded);
    }

    public MemorySearchInput withExpansion(MemoryQueryExpansion value) {
      return new MemorySearchInput(includeStale, subject, type, tier, query, value, limit, mode, allowDegraded, validAt, includeEnded);
    }

    public MemorySearchInput withLimit(Double value) {
      return new MemorySearchInput(includeStale, subject, type, tier, query, expansion, value, mode, allowDegraded, validAt, includeEnded);
    }

    public MemorySearchInput withMode(String value) {
      return new MemorySearchInput(includeStale, subject, type, tier, query, expansion, limit, value, allowDegraded, validAt, includeEnded);
    }

    public MemorySearchInput withAllowDegraded(Boolean value) {
      return new MemorySearchInput(includeStale, subject, type, tier, query, expansion, limit, mode, value, validAt, includeEnded);
    }

    public MemorySearchInput withValidAt(Double value) {
      return new MemorySearchInput(includeStale, subject, type, tier, query, expansion, limit, mode, allowDegraded, value, includeEnded);
    }

    public MemorySearchInput withIncludeEnded(Boolean value) {
      return new MemorySearchInput(includeStale, subject, type, tier, query, expansion, limit, mode, allowDegraded, validAt, value);
    }
  }

  /**
   * @param ranking Present only when the actor is not the space owner and ≥1 record was considered.
   */
  public record MemorySearchResult(
      MemoryReputationRanking ranking,
      MemoryExpansionCoverage expansion,
      Coverage coverage,
      @Json.Name("space_id") String spaceId,
      Double generation,
      String mode,
      String model,
      List<String> degraded,
      List<MemorySearchResultResultsItem> results) {

    /** With its required fields; the rest are null. */
    public static MemorySearchResult of(String spaceId, Double generation, String mode, String model, List<String> degraded, List<MemorySearchResultResultsItem> results) {
      return new MemorySearchResult(null, null, null, spaceId, generation, mode, model, degraded, results);
    }

    public MemorySearchResult withRanking(MemoryReputationRanking value) {
      return new MemorySearchResult(value, expansion, coverage, spaceId, generation, mode, model, degraded, results);
    }

    public MemorySearchResult withExpansion(MemoryExpansionCoverage value) {
      return new MemorySearchResult(ranking, value, coverage, spaceId, generation, mode, model, degraded, results);
    }

    public MemorySearchResult withCoverage(Coverage value) {
      return new MemorySearchResult(ranking, expansion, value, spaceId, generation, mode, model, degraded, results);
    }

    public MemorySearchResult withSpaceId(String value) {
      return new MemorySearchResult(ranking, expansion, coverage, value, generation, mode, model, degraded, results);
    }

    public MemorySearchResult withGeneration(Double value) {
      return new MemorySearchResult(ranking, expansion, coverage, spaceId, value, mode, model, degraded, results);
    }

    public MemorySearchResult withMode(String value) {
      return new MemorySearchResult(ranking, expansion, coverage, spaceId, generation, value, model, degraded, results);
    }

    public MemorySearchResult withModel(String value) {
      return new MemorySearchResult(ranking, expansion, coverage, spaceId, generation, mode, value, degraded, results);
    }

    public MemorySearchResult withDegraded(List<String> value) {
      return new MemorySearchResult(ranking, expansion, coverage, spaceId, generation, mode, model, value, results);
    }

    public MemorySearchResult withResults(List<MemorySearchResultResultsItem> value) {
      return new MemorySearchResult(ranking, expansion, coverage, spaceId, generation, mode, model, degraded, value);
    }

    public record Coverage(
        @Json.Name("candidate_limit") Double candidateLimit,
        @Json.Name("lexical_candidates") Double lexicalCandidates,
        Semantic semantic) {

      /** With its required fields; the rest are null. */
      public static Coverage of(Double candidateLimit, Double lexicalCandidates, Semantic semantic) {
        return new Coverage(candidateLimit, lexicalCandidates, semantic);
      }

      public Coverage withCandidateLimit(Double value) {
        return new Coverage(value, lexicalCandidates, semantic);
      }

      public Coverage withLexicalCandidates(Double value) {
        return new Coverage(candidateLimit, value, semantic);
      }

      public Coverage withSemantic(Semantic value) {
        return new Coverage(candidateLimit, lexicalCandidates, value);
      }

      public record Semantic(
          Double scored,
          Double missing,
          Double invalid) {

        /** With its required fields; the rest are null. */
        public static Semantic of(Double scored, Double missing, Double invalid) {
          return new Semantic(scored, missing, invalid);
        }

        public Semantic withScored(Double value) {
          return new Semantic(value, missing, invalid);
        }

        public Semantic withMissing(Double value) {
          return new Semantic(scored, value, invalid);
        }

        public Semantic withInvalid(Double value) {
          return new Semantic(scored, missing, value);
        }
      }
    }

    public record MemorySearchResultResultsItem(
        String freshness,
        @Json.Name("stale_reason") MemorySearchResultResultsItemStaleReason staleReason,
        @Json.Name("dependency_versions") Map<String, Double> dependencyVersions,
        @Json.Name("valid_time") MemoryValidity validTime,
        @Json.Name("vocabulary_version") Double vocabularyVersion,
        String id,
        @Json.Name("space_id") String spaceId,
        Double version,
        String content,
        String type,
        String tier,
        Double importance,
        String subject,
        Map<String, Object> metadata,
        @Json.Name("source_ids") List<String> sourceIds,
        @Json.Name("depends_on") List<String> dependsOn,
        @Json.Name("created_at") Double createdAt,
        MemoryClaim claim,
        Double score,
        Ranks ranks) {

      /** With its required fields; the rest are null. */
      public static MemorySearchResultResultsItem of(String id, String spaceId, Double version, String content, String type, String tier, Double importance, String subject, Map<String, Object> metadata, List<String> sourceIds, List<String> dependsOn, Double createdAt, Double score, Ranks ranks) {
        return new MemorySearchResultResultsItem(null, null, null, null, null, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, null, score, ranks);
      }

      public MemorySearchResultResultsItem withFreshness(String value) {
        return new MemorySearchResultResultsItem(value, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withStaleReason(MemorySearchResultResultsItemStaleReason value) {
        return new MemorySearchResultResultsItem(freshness, value, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withDependencyVersions(Map<String, Double> value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, value, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withValidTime(MemoryValidity value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, value, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withVocabularyVersion(Double value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, value, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withId(String value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, value, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withSpaceId(String value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, value, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withVersion(Double value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, value, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withContent(String value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, value, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withType(String value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, value, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withTier(String value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, value, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withImportance(Double value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, value, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withSubject(String value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, value, metadata, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withMetadata(Map<String, Object> value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, value, sourceIds, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withSourceIds(List<String> value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, value, dependsOn, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withDependsOn(List<String> value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, value, createdAt, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withCreatedAt(Double value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, value, claim, score, ranks);
      }

      public MemorySearchResultResultsItem withClaim(MemoryClaim value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, value, score, ranks);
      }

      public MemorySearchResultResultsItem withScore(Double value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, value, ranks);
      }

      public MemorySearchResultResultsItem withRanks(Ranks value) {
        return new MemorySearchResultResultsItem(freshness, staleReason, dependencyVersions, validTime, vocabularyVersion, id, spaceId, version, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, createdAt, claim, score, value);
      }

      public record MemorySearchResultResultsItemStaleReason(
          String kind,
          @Json.Name("record_id") String recordId,
          @Json.Name("observed_version") Double observedVersion) {

        /** With its required fields; the rest are null. */
        public static MemorySearchResultResultsItemStaleReason of(String kind) {
          return new MemorySearchResultResultsItemStaleReason(kind, null, null);
        }

        public MemorySearchResultResultsItemStaleReason withKind(String value) {
          return new MemorySearchResultResultsItemStaleReason(value, recordId, observedVersion);
        }

        public MemorySearchResultResultsItemStaleReason withRecordId(String value) {
          return new MemorySearchResultResultsItemStaleReason(kind, value, observedVersion);
        }

        public MemorySearchResultResultsItemStaleReason withObservedVersion(Double value) {
          return new MemorySearchResultResultsItemStaleReason(kind, recordId, value);
        }
      }

      public record Ranks(
          Double lexical,
          Double semantic,
          List<Double> expansion) {

        /** With its required fields; the rest are null. */
        public static Ranks of() {
          return new Ranks(null, null, null);
        }

        public Ranks withLexical(Double value) {
          return new Ranks(value, semantic, expansion);
        }

        public Ranks withSemantic(Double value) {
          return new Ranks(lexical, value, expansion);
        }

        public Ranks withExpansion(List<Double> value) {
          return new Ranks(lexical, semantic, value);
        }
      }
    }
  }

  public record MemorySource(
      String id,
      @Json.Name("space_id") String spaceId,
      Double seq,
      @Json.Name("session_id") String sessionId,
      Object body,
      @Json.Name("content_hash") String contentHash,
      @Json.Name("created_at") Double createdAt) {

    /** With its required fields; the rest are null. */
    public static MemorySource of(String id, String spaceId, Double seq, String sessionId, Object body, String contentHash, Double createdAt) {
      return new MemorySource(id, spaceId, seq, sessionId, body, contentHash, createdAt);
    }

    public MemorySource withId(String value) {
      return new MemorySource(value, spaceId, seq, sessionId, body, contentHash, createdAt);
    }

    public MemorySource withSpaceId(String value) {
      return new MemorySource(id, value, seq, sessionId, body, contentHash, createdAt);
    }

    public MemorySource withSeq(Double value) {
      return new MemorySource(id, spaceId, value, sessionId, body, contentHash, createdAt);
    }

    public MemorySource withSessionId(String value) {
      return new MemorySource(id, spaceId, seq, value, body, contentHash, createdAt);
    }

    public MemorySource withBody(Object value) {
      return new MemorySource(id, spaceId, seq, sessionId, value, contentHash, createdAt);
    }

    public MemorySource withContentHash(String value) {
      return new MemorySource(id, spaceId, seq, sessionId, body, value, createdAt);
    }

    public MemorySource withCreatedAt(Double value) {
      return new MemorySource(id, spaceId, seq, sessionId, body, contentHash, value);
    }
  }

  public record MemorySourceRange(
      String id,
      @Json.Name("session_id") String sessionId,
      @Json.Name("content_hash") String contentHash,
      @Json.Name("text_hash") String textHash,
      String representation,
      Double start,
      Double end,
      @Json.Name("total_bytes") Double totalBytes,
      @Json.Name("next_start") Double nextStart,
      String text) {

    /** With its required fields; the rest are null. */
    public static MemorySourceRange of(String id, String sessionId, String contentHash, String textHash, String representation, Double start, Double end, Double totalBytes, Double nextStart, String text) {
      return new MemorySourceRange(id, sessionId, contentHash, textHash, representation, start, end, totalBytes, nextStart, text);
    }

    public MemorySourceRange withId(String value) {
      return new MemorySourceRange(value, sessionId, contentHash, textHash, representation, start, end, totalBytes, nextStart, text);
    }

    public MemorySourceRange withSessionId(String value) {
      return new MemorySourceRange(id, value, contentHash, textHash, representation, start, end, totalBytes, nextStart, text);
    }

    public MemorySourceRange withContentHash(String value) {
      return new MemorySourceRange(id, sessionId, value, textHash, representation, start, end, totalBytes, nextStart, text);
    }

    public MemorySourceRange withTextHash(String value) {
      return new MemorySourceRange(id, sessionId, contentHash, value, representation, start, end, totalBytes, nextStart, text);
    }

    public MemorySourceRange withRepresentation(String value) {
      return new MemorySourceRange(id, sessionId, contentHash, textHash, value, start, end, totalBytes, nextStart, text);
    }

    public MemorySourceRange withStart(Double value) {
      return new MemorySourceRange(id, sessionId, contentHash, textHash, representation, value, end, totalBytes, nextStart, text);
    }

    public MemorySourceRange withEnd(Double value) {
      return new MemorySourceRange(id, sessionId, contentHash, textHash, representation, start, value, totalBytes, nextStart, text);
    }

    public MemorySourceRange withTotalBytes(Double value) {
      return new MemorySourceRange(id, sessionId, contentHash, textHash, representation, start, end, value, nextStart, text);
    }

    public MemorySourceRange withNextStart(Double value) {
      return new MemorySourceRange(id, sessionId, contentHash, textHash, representation, start, end, totalBytes, value, text);
    }

    public MemorySourceRange withText(String value) {
      return new MemorySourceRange(id, sessionId, contentHash, textHash, representation, start, end, totalBytes, nextStart, value);
    }
  }

  public record MemorySourceSearch(
      String query,
      MemoryQueryExpansion expansion,
      String match,
      @Json.Name("session_id") String sessionId,
      Double limit) {

    /** With its required fields; the rest are null. */
    public static MemorySourceSearch of(String query) {
      return new MemorySourceSearch(query, null, null, null, null);
    }

    public MemorySourceSearch withQuery(String value) {
      return new MemorySourceSearch(value, expansion, match, sessionId, limit);
    }

    public MemorySourceSearch withExpansion(MemoryQueryExpansion value) {
      return new MemorySourceSearch(query, value, match, sessionId, limit);
    }

    public MemorySourceSearch withMatch(String value) {
      return new MemorySourceSearch(query, expansion, value, sessionId, limit);
    }

    public MemorySourceSearch withSessionId(String value) {
      return new MemorySourceSearch(query, expansion, match, value, limit);
    }

    public MemorySourceSearch withLimit(Double value) {
      return new MemorySourceSearch(query, expansion, match, sessionId, value);
    }
  }

  public record MemorySourceSearchResult(
      MemoryExpansionCoverage expansion,
      @Json.Name("space_id") String spaceId,
      Double generation,
      List<MemorySourceSearchResultResultsItem> results,
      Boolean truncated) {

    /** With its required fields; the rest are null. */
    public static MemorySourceSearchResult of(String spaceId, Double generation, List<MemorySourceSearchResultResultsItem> results, Boolean truncated) {
      return new MemorySourceSearchResult(null, spaceId, generation, results, truncated);
    }

    public MemorySourceSearchResult withExpansion(MemoryExpansionCoverage value) {
      return new MemorySourceSearchResult(value, spaceId, generation, results, truncated);
    }

    public MemorySourceSearchResult withSpaceId(String value) {
      return new MemorySourceSearchResult(expansion, value, generation, results, truncated);
    }

    public MemorySourceSearchResult withGeneration(Double value) {
      return new MemorySourceSearchResult(expansion, spaceId, value, results, truncated);
    }

    public MemorySourceSearchResult withResults(List<MemorySourceSearchResultResultsItem> value) {
      return new MemorySourceSearchResult(expansion, spaceId, generation, value, truncated);
    }

    public MemorySourceSearchResult withTruncated(Boolean value) {
      return new MemorySourceSearchResult(expansion, spaceId, generation, results, value);
    }

    public record MemorySourceSearchResultResultsItem(
        String id,
        Double seq,
        @Json.Name("session_id") String sessionId,
        @Json.Name("content_hash") String contentHash,
        String excerpt,
        Double score,
        MemorySourceSearchResultResultsItemRanks ranks) {

      /** With its required fields; the rest are null. */
      public static MemorySourceSearchResultResultsItem of(String id, Double seq, String sessionId, String contentHash, String excerpt) {
        return new MemorySourceSearchResultResultsItem(id, seq, sessionId, contentHash, excerpt, null, null);
      }

      public MemorySourceSearchResultResultsItem withId(String value) {
        return new MemorySourceSearchResultResultsItem(value, seq, sessionId, contentHash, excerpt, score, ranks);
      }

      public MemorySourceSearchResultResultsItem withSeq(Double value) {
        return new MemorySourceSearchResultResultsItem(id, value, sessionId, contentHash, excerpt, score, ranks);
      }

      public MemorySourceSearchResultResultsItem withSessionId(String value) {
        return new MemorySourceSearchResultResultsItem(id, seq, value, contentHash, excerpt, score, ranks);
      }

      public MemorySourceSearchResultResultsItem withContentHash(String value) {
        return new MemorySourceSearchResultResultsItem(id, seq, sessionId, value, excerpt, score, ranks);
      }

      public MemorySourceSearchResultResultsItem withExcerpt(String value) {
        return new MemorySourceSearchResultResultsItem(id, seq, sessionId, contentHash, value, score, ranks);
      }

      public MemorySourceSearchResultResultsItem withScore(Double value) {
        return new MemorySourceSearchResultResultsItem(id, seq, sessionId, contentHash, excerpt, value, ranks);
      }

      public MemorySourceSearchResultResultsItem withRanks(MemorySourceSearchResultResultsItemRanks value) {
        return new MemorySourceSearchResultResultsItem(id, seq, sessionId, contentHash, excerpt, score, value);
      }

      public record MemorySourceSearchResultResultsItemRanks(
          Double lexical,
          List<Double> expansion) {

        /** With its required fields; the rest are null. */
        public static MemorySourceSearchResultResultsItemRanks of() {
          return new MemorySourceSearchResultResultsItemRanks(null, null);
        }

        public MemorySourceSearchResultResultsItemRanks withLexical(Double value) {
          return new MemorySourceSearchResultResultsItemRanks(value, expansion);
        }

        public MemorySourceSearchResultResultsItemRanks withExpansion(List<Double> value) {
          return new MemorySourceSearchResultResultsItemRanks(lexical, value);
        }
      }
    }
  }

  /**
   * @param metadata Operator-set flags (migration 114). `institutional: true` makes `adopt` a standing-gated ratification; `read_public: true` grants every active credential read access. Never settable over HTTP.
   */
  public record MemorySpace(
      @Json.Name("retrieval_generation") Double retrievalGeneration,
      String id,
      @Json.Name("owner_id") String ownerId,
      String name,
      Double generation,
      String status,
      @Json.Name("created_at") Double createdAt,
      Map<String, Object> metadata) {

    /** With its required fields; the rest are null. */
    public static MemorySpace of(Double retrievalGeneration, String id, String ownerId, String name, Double generation, String status, Double createdAt, Map<String, Object> metadata) {
      return new MemorySpace(retrievalGeneration, id, ownerId, name, generation, status, createdAt, metadata);
    }

    public MemorySpace withRetrievalGeneration(Double value) {
      return new MemorySpace(value, id, ownerId, name, generation, status, createdAt, metadata);
    }

    public MemorySpace withId(String value) {
      return new MemorySpace(retrievalGeneration, value, ownerId, name, generation, status, createdAt, metadata);
    }

    public MemorySpace withOwnerId(String value) {
      return new MemorySpace(retrievalGeneration, id, value, name, generation, status, createdAt, metadata);
    }

    public MemorySpace withName(String value) {
      return new MemorySpace(retrievalGeneration, id, ownerId, value, generation, status, createdAt, metadata);
    }

    public MemorySpace withGeneration(Double value) {
      return new MemorySpace(retrievalGeneration, id, ownerId, name, value, status, createdAt, metadata);
    }

    public MemorySpace withStatus(String value) {
      return new MemorySpace(retrievalGeneration, id, ownerId, name, generation, value, createdAt, metadata);
    }

    public MemorySpace withCreatedAt(Double value) {
      return new MemorySpace(retrievalGeneration, id, ownerId, name, generation, status, value, metadata);
    }

    public MemorySpace withMetadata(Map<String, Object> value) {
      return new MemorySpace(retrievalGeneration, id, ownerId, name, generation, status, createdAt, value);
    }
  }

  public record MemoryStorageAmounts(
      @Json.Name("logical_bytes") Double logicalBytes,
      Double sources,
      Double revisions,
      Double spaces) {

    /** With its required fields; the rest are null. */
    public static MemoryStorageAmounts of(Double logicalBytes, Double sources, Double revisions, Double spaces) {
      return new MemoryStorageAmounts(logicalBytes, sources, revisions, spaces);
    }

    public MemoryStorageAmounts withLogicalBytes(Double value) {
      return new MemoryStorageAmounts(value, sources, revisions, spaces);
    }

    public MemoryStorageAmounts withSources(Double value) {
      return new MemoryStorageAmounts(logicalBytes, value, revisions, spaces);
    }

    public MemoryStorageAmounts withRevisions(Double value) {
      return new MemoryStorageAmounts(logicalBytes, sources, value, spaces);
    }

    public MemoryStorageAmounts withSpaces(Double value) {
      return new MemoryStorageAmounts(logicalBytes, sources, revisions, value);
    }
  }

  public record MemoryStorageUsage(
      @Json.Name("owner_id") String ownerId,
      MemoryStorageAmounts usage,
      MemoryStorageAmounts limits,
      @Json.Name("over_limit") List<String> overLimit) {

    /** With its required fields; the rest are null. */
    public static MemoryStorageUsage of(String ownerId, MemoryStorageAmounts usage, MemoryStorageAmounts limits, List<String> overLimit) {
      return new MemoryStorageUsage(ownerId, usage, limits, overLimit);
    }

    public MemoryStorageUsage withOwnerId(String value) {
      return new MemoryStorageUsage(value, usage, limits, overLimit);
    }

    public MemoryStorageUsage withUsage(MemoryStorageAmounts value) {
      return new MemoryStorageUsage(ownerId, value, limits, overLimit);
    }

    public MemoryStorageUsage withLimits(MemoryStorageAmounts value) {
      return new MemoryStorageUsage(ownerId, usage, value, overLimit);
    }

    public MemoryStorageUsage withOverLimit(List<String> value) {
      return new MemoryStorageUsage(ownerId, usage, limits, value);
    }
  }

  public record MemoryTransferFragment(
      String kind,
      String id,
      Double version,
      Double offset,
      Double size,
      String sha256,
      String base64) {

    /** With its required fields; the rest are null. */
    public static MemoryTransferFragment of(String kind, String id, Double version, Double offset, Double size, String sha256, String base64) {
      return new MemoryTransferFragment(kind, id, version, offset, size, sha256, base64);
    }

    public MemoryTransferFragment withKind(String value) {
      return new MemoryTransferFragment(value, id, version, offset, size, sha256, base64);
    }

    public MemoryTransferFragment withId(String value) {
      return new MemoryTransferFragment(kind, value, version, offset, size, sha256, base64);
    }

    public MemoryTransferFragment withVersion(Double value) {
      return new MemoryTransferFragment(kind, id, value, offset, size, sha256, base64);
    }

    public MemoryTransferFragment withOffset(Double value) {
      return new MemoryTransferFragment(kind, id, version, value, size, sha256, base64);
    }

    public MemoryTransferFragment withSize(Double value) {
      return new MemoryTransferFragment(kind, id, version, offset, value, sha256, base64);
    }

    public MemoryTransferFragment withSha256(String value) {
      return new MemoryTransferFragment(kind, id, version, offset, size, value, base64);
    }

    public MemoryTransferFragment withBase64(String value) {
      return new MemoryTransferFragment(kind, id, version, offset, size, sha256, value);
    }
  }

  public record MemoryTransferHeader(
      String schema,
      @Json.Name("origin_space") String originSpace,
      Double generation,
      Counts counts) {

    /** With its required fields; the rest are null. */
    public static MemoryTransferHeader of(String schema, String originSpace, Double generation, Counts counts) {
      return new MemoryTransferHeader(schema, originSpace, generation, counts);
    }

    public MemoryTransferHeader withSchema(String value) {
      return new MemoryTransferHeader(value, originSpace, generation, counts);
    }

    public MemoryTransferHeader withOriginSpace(String value) {
      return new MemoryTransferHeader(schema, value, generation, counts);
    }

    public MemoryTransferHeader withGeneration(Double value) {
      return new MemoryTransferHeader(schema, originSpace, value, counts);
    }

    public MemoryTransferHeader withCounts(Counts value) {
      return new MemoryTransferHeader(schema, originSpace, generation, value);
    }

    public record Counts(
        Double source,
        @Json.Name("record") Double record_,
        Double revision,
        Double vocabulary,
        Double checkpoint) {

      /** With its required fields; the rest are null. */
      public static Counts of(Double source, Double record_, Double revision, Double vocabulary, Double checkpoint) {
        return new Counts(source, record_, revision, vocabulary, checkpoint);
      }

      public Counts withSource(Double value) {
        return new Counts(value, record_, revision, vocabulary, checkpoint);
      }

      public Counts withRecord(Double value) {
        return new Counts(source, value, revision, vocabulary, checkpoint);
      }

      public Counts withRevision(Double value) {
        return new Counts(source, record_, value, vocabulary, checkpoint);
      }

      public Counts withVocabulary(Double value) {
        return new Counts(source, record_, revision, value, checkpoint);
      }

      public Counts withCheckpoint(Double value) {
        return new Counts(source, record_, revision, vocabulary, value);
      }
    }
  }

  public record MemoryTransferList(
      List<TransfersItem> transfers,
      @Json.Name("next_cursor") String nextCursor) {

    /** With its required fields; the rest are null. */
    public static MemoryTransferList of(List<TransfersItem> transfers, String nextCursor) {
      return new MemoryTransferList(transfers, nextCursor);
    }

    public MemoryTransferList withTransfers(List<TransfersItem> value) {
      return new MemoryTransferList(value, nextCursor);
    }

    public MemoryTransferList withNextCursor(String value) {
      return new MemoryTransferList(transfers, value);
    }

    public record TransfersItem(
        String id,
        MemoryTransferHeader header,
        String state,
        Double position,
        String sha256,
        Double bytes,
        @Json.Name("next_cursor") String nextCursor,
        @Json.Name("expires_at") Double expiresAt,
        Boolean expired) {

      /** With its required fields; the rest are null. */
      public static TransfersItem of(String id, MemoryTransferHeader header, String state, Double position, String sha256, Double bytes, String nextCursor, Double expiresAt, Boolean expired) {
        return new TransfersItem(id, header, state, position, sha256, bytes, nextCursor, expiresAt, expired);
      }

      public TransfersItem withId(String value) {
        return new TransfersItem(value, header, state, position, sha256, bytes, nextCursor, expiresAt, expired);
      }

      public TransfersItem withHeader(MemoryTransferHeader value) {
        return new TransfersItem(id, value, state, position, sha256, bytes, nextCursor, expiresAt, expired);
      }

      public TransfersItem withState(String value) {
        return new TransfersItem(id, header, value, position, sha256, bytes, nextCursor, expiresAt, expired);
      }

      public TransfersItem withPosition(Double value) {
        return new TransfersItem(id, header, state, value, sha256, bytes, nextCursor, expiresAt, expired);
      }

      public TransfersItem withSha256(String value) {
        return new TransfersItem(id, header, state, position, value, bytes, nextCursor, expiresAt, expired);
      }

      public TransfersItem withBytes(Double value) {
        return new TransfersItem(id, header, state, position, sha256, value, nextCursor, expiresAt, expired);
      }

      public TransfersItem withNextCursor(String value) {
        return new TransfersItem(id, header, state, position, sha256, bytes, value, expiresAt, expired);
      }

      public TransfersItem withExpiresAt(Double value) {
        return new TransfersItem(id, header, state, position, sha256, bytes, nextCursor, value, expired);
      }

      public TransfersItem withExpired(Boolean value) {
        return new TransfersItem(id, header, state, position, sha256, bytes, nextCursor, expiresAt, value);
      }
    }
  }

  public record MemoryTransferPage(
      MemoryTransferHeader header,
      Double position,
      String previous,
      List<MemoryTransferFragment> fragments,
      Boolean done,
      String sha256,
      @Json.Name("next_cursor") String nextCursor) {

    /** With its required fields; the rest are null. */
    public static MemoryTransferPage of(MemoryTransferHeader header, Double position, String previous, List<MemoryTransferFragment> fragments, Boolean done, String sha256, String nextCursor) {
      return new MemoryTransferPage(header, position, previous, fragments, done, sha256, nextCursor);
    }

    public MemoryTransferPage withHeader(MemoryTransferHeader value) {
      return new MemoryTransferPage(value, position, previous, fragments, done, sha256, nextCursor);
    }

    public MemoryTransferPage withPosition(Double value) {
      return new MemoryTransferPage(header, value, previous, fragments, done, sha256, nextCursor);
    }

    public MemoryTransferPage withPrevious(String value) {
      return new MemoryTransferPage(header, position, value, fragments, done, sha256, nextCursor);
    }

    public MemoryTransferPage withFragments(List<MemoryTransferFragment> value) {
      return new MemoryTransferPage(header, position, previous, value, done, sha256, nextCursor);
    }

    public MemoryTransferPage withDone(Boolean value) {
      return new MemoryTransferPage(header, position, previous, fragments, value, sha256, nextCursor);
    }

    public MemoryTransferPage withSha256(String value) {
      return new MemoryTransferPage(header, position, previous, fragments, done, value, nextCursor);
    }

    public MemoryTransferPage withNextCursor(String value) {
      return new MemoryTransferPage(header, position, previous, fragments, done, sha256, value);
    }
  }

  public record MemoryTransferStatus(
      String id,
      MemoryTransferHeader header,
      String state,
      Double position,
      String sha256,
      Double bytes,
      @Json.Name("next_cursor") String nextCursor,
      @Json.Name("expires_at") Double expiresAt) {

    /** With its required fields; the rest are null. */
    public static MemoryTransferStatus of(String id, MemoryTransferHeader header, String state, Double position, String sha256, Double bytes, String nextCursor, Double expiresAt) {
      return new MemoryTransferStatus(id, header, state, position, sha256, bytes, nextCursor, expiresAt);
    }

    public MemoryTransferStatus withId(String value) {
      return new MemoryTransferStatus(value, header, state, position, sha256, bytes, nextCursor, expiresAt);
    }

    public MemoryTransferStatus withHeader(MemoryTransferHeader value) {
      return new MemoryTransferStatus(id, value, state, position, sha256, bytes, nextCursor, expiresAt);
    }

    public MemoryTransferStatus withState(String value) {
      return new MemoryTransferStatus(id, header, value, position, sha256, bytes, nextCursor, expiresAt);
    }

    public MemoryTransferStatus withPosition(Double value) {
      return new MemoryTransferStatus(id, header, state, value, sha256, bytes, nextCursor, expiresAt);
    }

    public MemoryTransferStatus withSha256(String value) {
      return new MemoryTransferStatus(id, header, state, position, value, bytes, nextCursor, expiresAt);
    }

    public MemoryTransferStatus withBytes(Double value) {
      return new MemoryTransferStatus(id, header, state, position, sha256, value, nextCursor, expiresAt);
    }

    public MemoryTransferStatus withNextCursor(String value) {
      return new MemoryTransferStatus(id, header, state, position, sha256, bytes, value, expiresAt);
    }

    public MemoryTransferStatus withExpiresAt(Double value) {
      return new MemoryTransferStatus(id, header, state, position, sha256, bytes, nextCursor, value);
    }
  }

  public record MemoryVariable(
      String variable,
      String type) {

    /** With its required fields; the rest are null. */
    public static MemoryVariable of(String variable, String type) {
      return new MemoryVariable(variable, type);
    }

    public MemoryVariable withVariable(String value) {
      return new MemoryVariable(value, type);
    }

    public MemoryVariable withType(String value) {
      return new MemoryVariable(variable, value);
    }
  }

  public record MemoryVocabularyDefinition(
      Boolean closed,
      Map<String, PredicatesValue> predicates) {

    /** With its required fields; the rest are null. */
    public static MemoryVocabularyDefinition of(Boolean closed, Map<String, PredicatesValue> predicates) {
      return new MemoryVocabularyDefinition(closed, predicates);
    }

    public MemoryVocabularyDefinition withClosed(Boolean value) {
      return new MemoryVocabularyDefinition(value, predicates);
    }

    public MemoryVocabularyDefinition withPredicates(Map<String, PredicatesValue> value) {
      return new MemoryVocabularyDefinition(closed, value);
    }

    public record PredicatesValue(
        String object,
        String cardinality,
        String description) {

      /** With its required fields; the rest are null. */
      public static PredicatesValue of(String object, String cardinality) {
        return new PredicatesValue(object, cardinality, null);
      }

      public PredicatesValue withObject(String value) {
        return new PredicatesValue(value, cardinality, description);
      }

      public PredicatesValue withCardinality(String value) {
        return new PredicatesValue(object, value, description);
      }

      public PredicatesValue withDescription(String value) {
        return new PredicatesValue(object, cardinality, value);
      }
    }
  }

  public record MemoryVocabulary(
      Double version,
      MemoryVocabularyDefinition definition) {

    /** With its required fields; the rest are null. */
    public static MemoryVocabulary of(Double version, MemoryVocabularyDefinition definition) {
      return new MemoryVocabulary(version, definition);
    }

    public MemoryVocabulary withVersion(Double value) {
      return new MemoryVocabulary(value, definition);
    }

    public MemoryVocabulary withDefinition(MemoryVocabularyDefinition value) {
      return new MemoryVocabulary(version, value);
    }
  }

  public record MeResponse(
      @Json.Name("principal_id") String principalId,
      @Json.Name("credential_id") String credentialId,
      List<String> scopes) {

    /** With its required fields; the rest are null. */
    public static MeResponse of(String principalId, String credentialId, List<String> scopes) {
      return new MeResponse(principalId, credentialId, scopes);
    }

    public MeResponse withPrincipalId(String value) {
      return new MeResponse(value, credentialId, scopes);
    }

    public MeResponse withCredentialId(String value) {
      return new MeResponse(principalId, value, scopes);
    }

    public MeResponse withScopes(List<String> value) {
      return new MeResponse(principalId, credentialId, value);
    }
  }

  /**
   * A canvas or panel failure. `code` is present on some failures only.
   */
  public record PanelError(
      String error,
      String code) {

    /** With its required fields; the rest are null. */
    public static PanelError of(String error) {
      return new PanelError(error, null);
    }

    public PanelError withError(String value) {
      return new PanelError(value, code);
    }

    public PanelError withCode(String value) {
      return new PanelError(error, value);
    }
  }

  public record PanelInteractionInput(
      String revision,
      String componentId,
      Map<String, Object> fields,
      Object value,
      String requestId,
      String sourceId,
      Double capabilityRevision) {

    /** With its required fields; the rest are null. */
    public static PanelInteractionInput of(String revision, String componentId) {
      return new PanelInteractionInput(revision, componentId, null, null, null, null, null);
    }

    public PanelInteractionInput withRevision(String value) {
      return new PanelInteractionInput(value, componentId, fields, value, requestId, sourceId, capabilityRevision);
    }

    public PanelInteractionInput withComponentId(String value) {
      return new PanelInteractionInput(revision, value, fields, value, requestId, sourceId, capabilityRevision);
    }

    public PanelInteractionInput withFields(Map<String, Object> value) {
      return new PanelInteractionInput(revision, componentId, value, value, requestId, sourceId, capabilityRevision);
    }

    public PanelInteractionInput withValue(Object value) {
      return new PanelInteractionInput(revision, componentId, fields, value, requestId, sourceId, capabilityRevision);
    }

    public PanelInteractionInput withRequestId(String value) {
      return new PanelInteractionInput(revision, componentId, fields, value, value, sourceId, capabilityRevision);
    }

    public PanelInteractionInput withSourceId(String value) {
      return new PanelInteractionInput(revision, componentId, fields, value, requestId, value, capabilityRevision);
    }

    public PanelInteractionInput withCapabilityRevision(Double value) {
      return new PanelInteractionInput(revision, componentId, fields, value, requestId, sourceId, value);
    }
  }

  /**
   * Read adapters, not grants. Every fetch still passes through the resource's own authorization. Keep side-effecting GETs (notably entities/:name/canvas), credentials and arbitrary URLs out. Parameters are encoded as individual path segments; query keys are declared per adapter.
   */
  public record PanelResourceDefinition(
      String id,
      String path,
      List<String> parameters,
      List<String> query) {

    /** With its required fields; the rest are null. */
    public static PanelResourceDefinition of(String id, String path, List<String> parameters, List<String> query) {
      return new PanelResourceDefinition(id, path, parameters, query);
    }

    public PanelResourceDefinition withId(String value) {
      return new PanelResourceDefinition(value, path, parameters, query);
    }

    public PanelResourceDefinition withPath(String value) {
      return new PanelResourceDefinition(id, value, parameters, query);
    }

    public PanelResourceDefinition withParameters(List<String> value) {
      return new PanelResourceDefinition(id, path, value, query);
    }

    public PanelResourceDefinition withQuery(List<String> value) {
      return new PanelResourceDefinition(id, path, parameters, value);
    }
  }

  public record PanelResourcesResponse(
      String schema,
      List<PanelResourceDefinition> resources) {

    /** With its required fields; the rest are null. */
    public static PanelResourcesResponse of(String schema, List<PanelResourceDefinition> resources) {
      return new PanelResourcesResponse(schema, resources);
    }

    public PanelResourcesResponse withSchema(String value) {
      return new PanelResourcesResponse(value, resources);
    }

    public PanelResourcesResponse withResources(List<PanelResourceDefinition> value) {
      return new PanelResourcesResponse(schema, value);
    }
  }

  public record PlanRequest(
      String task,
      @Json.Name("use_model") Boolean useModel,
      List<MemoryPlanStep> steps,
      @Json.Name("max_results") Double maxResults,
      @Json.Name("max_bytes") Double maxBytes) {

    /** With its required fields; the rest are null. */
    public static PlanRequest of(String task) {
      return new PlanRequest(task, null, null, null, null);
    }

    public PlanRequest withTask(String value) {
      return new PlanRequest(value, useModel, steps, maxResults, maxBytes);
    }

    public PlanRequest withUseModel(Boolean value) {
      return new PlanRequest(task, value, steps, maxResults, maxBytes);
    }

    public PlanRequest withSteps(List<MemoryPlanStep> value) {
      return new PlanRequest(task, useModel, value, maxResults, maxBytes);
    }

    public PlanRequest withMaxResults(Double value) {
      return new PlanRequest(task, useModel, steps, value, maxBytes);
    }

    public PlanRequest withMaxBytes(Double value) {
      return new PlanRequest(task, useModel, steps, maxResults, value);
    }
  }

  public record PublishPanelRequest(
      String type,
      A2UINodeData data) {

    /** With its required fields; the rest are null. */
    public static PublishPanelRequest of(String type, A2UINodeData data) {
      return new PublishPanelRequest(type, data);
    }

    public PublishPanelRequest withType(String value) {
      return new PublishPanelRequest(value, data);
    }

    public PublishPanelRequest withData(A2UINodeData value) {
      return new PublishPanelRequest(type, value);
    }
  }

  /**
   * @param id Stable producer id; reuse unchanged when retrying a batch.
   */
  public record RoutingEventInput(
      String id,
      String kind,
      Object payload) {

    /** With its required fields; the rest are null. */
    public static RoutingEventInput of(String id, String kind, Object payload) {
      return new RoutingEventInput(id, kind, payload);
    }

    public RoutingEventInput withId(String value) {
      return new RoutingEventInput(value, kind, payload);
    }

    public RoutingEventInput withKind(String value) {
      return new RoutingEventInput(id, value, payload);
    }

    public RoutingEventInput withPayload(Object value) {
      return new RoutingEventInput(id, kind, value);
    }
  }

  public record PublishRequest(
      List<RoutingEventInput> events) {

    /** With its required fields; the rest are null. */
    public static PublishRequest of(List<RoutingEventInput> events) {
      return new PublishRequest(events);
    }

    public PublishRequest withEvents(List<RoutingEventInput> value) {
      return new PublishRequest(value);
    }
  }

  /**
   * @param id Stable producer id; reuse unchanged when retrying a batch.
   */
  public record RoutingEvent(
      String id,
      String kind,
      Object payload,
      String sessionId,
      Double sequence,
      Double createdAt) {

    /** With its required fields; the rest are null. */
    public static RoutingEvent of(String id, String kind, Object payload, String sessionId, Double sequence, Double createdAt) {
      return new RoutingEvent(id, kind, payload, sessionId, sequence, createdAt);
    }

    public RoutingEvent withId(String value) {
      return new RoutingEvent(value, kind, payload, sessionId, sequence, createdAt);
    }

    public RoutingEvent withKind(String value) {
      return new RoutingEvent(id, value, payload, sessionId, sequence, createdAt);
    }

    public RoutingEvent withPayload(Object value) {
      return new RoutingEvent(id, kind, value, sessionId, sequence, createdAt);
    }

    public RoutingEvent withSessionId(String value) {
      return new RoutingEvent(id, kind, payload, value, sequence, createdAt);
    }

    public RoutingEvent withSequence(Double value) {
      return new RoutingEvent(id, kind, payload, sessionId, value, createdAt);
    }

    public RoutingEvent withCreatedAt(Double value) {
      return new RoutingEvent(id, kind, payload, sessionId, sequence, value);
    }
  }

  public record PublishResponse(
      List<RoutingEvent> events) {

    /** With its required fields; the rest are null. */
    public static PublishResponse of(List<RoutingEvent> events) {
      return new PublishResponse(events);
    }

    public PublishResponse withEvents(List<RoutingEvent> value) {
      return new PublishResponse(value);
    }
  }

  public record ReaffirmRequest(
      String id,
      @Json.Name("expected_version") Double expectedVersion,
      @Json.Name("dependency_versions") Map<String, Double> dependencyVersions,
      String content) {

    /** With its required fields; the rest are null. */
    public static ReaffirmRequest of(String id, Double expectedVersion, Map<String, Double> dependencyVersions) {
      return new ReaffirmRequest(id, expectedVersion, dependencyVersions, null);
    }

    public ReaffirmRequest withId(String value) {
      return new ReaffirmRequest(value, expectedVersion, dependencyVersions, content);
    }

    public ReaffirmRequest withExpectedVersion(Double value) {
      return new ReaffirmRequest(id, value, dependencyVersions, content);
    }

    public ReaffirmRequest withDependencyVersions(Map<String, Double> value) {
      return new ReaffirmRequest(id, expectedVersion, value, content);
    }

    public ReaffirmRequest withContent(String value) {
      return new ReaffirmRequest(id, expectedVersion, dependencyVersions, value);
    }
  }

  public record ReindexRequest(
      @Json.Name("expected_generation") Double expectedGeneration,
      String cursor,
      Double limit) {

    /** With its required fields; the rest are null. */
    public static ReindexRequest of(Double expectedGeneration) {
      return new ReindexRequest(expectedGeneration, null, null);
    }

    public ReindexRequest withExpectedGeneration(Double value) {
      return new ReindexRequest(value, cursor, limit);
    }

    public ReindexRequest withCursor(String value) {
      return new ReindexRequest(expectedGeneration, value, limit);
    }

    public ReindexRequest withLimit(Double value) {
      return new ReindexRequest(expectedGeneration, cursor, value);
    }
  }

  public record ReindexResponse(
      String id,
      Double version,
      @Json.Name("job_id") String jobId,
      Double seq,
      Double generation,
      String model,
      @Json.Name("job_ids") List<String> jobIds,
      Double examined,
      @Json.Name("next_cursor") String nextCursor) {

    /** With its required fields; the rest are null. */
    public static ReindexResponse of(String id, Double generation, String model, List<String> jobIds, Double examined, String nextCursor) {
      return new ReindexResponse(id, null, null, null, generation, model, jobIds, examined, nextCursor);
    }

    public ReindexResponse withId(String value) {
      return new ReindexResponse(value, version, jobId, seq, generation, model, jobIds, examined, nextCursor);
    }

    public ReindexResponse withVersion(Double value) {
      return new ReindexResponse(id, value, jobId, seq, generation, model, jobIds, examined, nextCursor);
    }

    public ReindexResponse withJobId(String value) {
      return new ReindexResponse(id, version, value, seq, generation, model, jobIds, examined, nextCursor);
    }

    public ReindexResponse withSeq(Double value) {
      return new ReindexResponse(id, version, jobId, value, generation, model, jobIds, examined, nextCursor);
    }

    public ReindexResponse withGeneration(Double value) {
      return new ReindexResponse(id, version, jobId, seq, value, model, jobIds, examined, nextCursor);
    }

    public ReindexResponse withModel(String value) {
      return new ReindexResponse(id, version, jobId, seq, generation, value, jobIds, examined, nextCursor);
    }

    public ReindexResponse withJobIds(List<String> value) {
      return new ReindexResponse(id, version, jobId, seq, generation, model, value, examined, nextCursor);
    }

    public ReindexResponse withExamined(Double value) {
      return new ReindexResponse(id, version, jobId, seq, generation, model, jobIds, value, nextCursor);
    }

    public ReindexResponse withNextCursor(String value) {
      return new ReindexResponse(id, version, jobId, seq, generation, model, jobIds, examined, value);
    }
  }

  public record RenewResidentRequest(
      String sessionId) {

    /** With its required fields; the rest are null. */
    public static RenewResidentRequest of(String sessionId) {
      return new RenewResidentRequest(sessionId);
    }

    public RenewResidentRequest withSessionId(String value) {
      return new RenewResidentRequest(value);
    }
  }

  /**
   * A resident's world credential, returned once and never stored by the server.
   */
  public record ResidentCredential(
      String token,
      Double expiresAt) {

    /** With its required fields; the rest are null. */
    public static ResidentCredential of(String token, Double expiresAt) {
      return new ResidentCredential(token, expiresAt);
    }

    public ResidentCredential withToken(String value) {
      return new ResidentCredential(value, expiresAt);
    }

    public ResidentCredential withExpiresAt(Double value) {
      return new ResidentCredential(token, value);
    }
  }

  public record RenewResidentResponse(
      String name,
      ResidentCredential credential) {

    /** With its required fields; the rest are null. */
    public static RenewResidentResponse of(String name, ResidentCredential credential) {
      return new RenewResidentResponse(name, credential);
    }

    public RenewResidentResponse withName(String value) {
      return new RenewResidentResponse(value, credential);
    }

    public RenewResidentResponse withCredential(ResidentCredential value) {
      return new RenewResidentResponse(name, value);
    }
  }

  public record ReportResidentAttentionResponse(
      String name,
      Double recorded) {

    /** With its required fields; the rest are null. */
    public static ReportResidentAttentionResponse of(String name, Double recorded) {
      return new ReportResidentAttentionResponse(name, recorded);
    }

    public ReportResidentAttentionResponse withName(String value) {
      return new ReportResidentAttentionResponse(value, recorded);
    }

    public ReportResidentAttentionResponse withRecorded(Double value) {
      return new ReportResidentAttentionResponse(name, value);
    }
  }

  /**
   * How a supervised resident's attention bridge decides and relays.
   */
  public record ResidentAttentionPolicy(
      String mode,
      Double threshold,
      String relay) {

    /** With its required fields; the rest are null. */
    public static ResidentAttentionPolicy of(String mode, Double threshold, String relay) {
      return new ResidentAttentionPolicy(mode, threshold, relay);
    }

    public ResidentAttentionPolicy withMode(String value) {
      return new ResidentAttentionPolicy(value, threshold, relay);
    }

    public ResidentAttentionPolicy withThreshold(Double value) {
      return new ResidentAttentionPolicy(mode, value, relay);
    }

    public ResidentAttentionPolicy withRelay(String value) {
      return new ResidentAttentionPolicy(mode, threshold, value);
    }
  }

  /**
   * `POST /api/routing/residents/:name/attention`: bridge decisions and presence.
   *
   * @param wakes Wake decisions (refs and reasons only, never content), at most 100.
   * @param outcomes What woken turns did, at most 100: whether the agent ran a tool or a world command of its own after the wake (the attention judges' truth). Refs only.
   * @param status The resident's current presence, when it changed.
   */
  public record ResidentAttentionReport(
      String sessionId,
      List<WakesItem> wakes,
      List<OutcomesItem> outcomes,
      Status status) {

    /** With its required fields; the rest are null. */
    public static ResidentAttentionReport of(String sessionId) {
      return new ResidentAttentionReport(sessionId, null, null, null);
    }

    public ResidentAttentionReport withSessionId(String value) {
      return new ResidentAttentionReport(value, wakes, outcomes, status);
    }

    public ResidentAttentionReport withWakes(List<WakesItem> value) {
      return new ResidentAttentionReport(sessionId, value, outcomes, status);
    }

    public ResidentAttentionReport withOutcomes(List<OutcomesItem> value) {
      return new ResidentAttentionReport(sessionId, wakes, value, status);
    }

    public ResidentAttentionReport withStatus(Status value) {
      return new ResidentAttentionReport(sessionId, wakes, outcomes, value);
    }

    public record WakesItem(
        String ref,
        String source,
        String decision,
        String reason,
        Double hop,
        Boolean steered,
        Double at) {

      /** With its required fields; the rest are null. */
      public static WakesItem of(String source, String decision, String reason, Double hop, Boolean steered, Double at) {
        return new WakesItem(null, source, decision, reason, hop, steered, at);
      }

      public WakesItem withRef(String value) {
        return new WakesItem(value, source, decision, reason, hop, steered, at);
      }

      public WakesItem withSource(String value) {
        return new WakesItem(ref, value, decision, reason, hop, steered, at);
      }

      public WakesItem withDecision(String value) {
        return new WakesItem(ref, source, value, reason, hop, steered, at);
      }

      public WakesItem withReason(String value) {
        return new WakesItem(ref, source, decision, value, hop, steered, at);
      }

      public WakesItem withHop(Double value) {
        return new WakesItem(ref, source, decision, reason, value, steered, at);
      }

      public WakesItem withSteered(Boolean value) {
        return new WakesItem(ref, source, decision, reason, hop, value, at);
      }

      public WakesItem withAt(Double value) {
        return new WakesItem(ref, source, decision, reason, hop, steered, value);
      }
    }

    public record OutcomesItem(
        String ref,
        Boolean worked) {

      /** With its required fields; the rest are null. */
      public static OutcomesItem of(String ref, Boolean worked) {
        return new OutcomesItem(ref, worked);
      }

      public OutcomesItem withRef(String value) {
        return new OutcomesItem(value, worked);
      }

      public OutcomesItem withWorked(Boolean value) {
        return new OutcomesItem(ref, value);
      }
    }

    /**
     * The resident's current presence, when it changed.
     */
    public record Status(
        String status,
        String steer) {

      /** With its required fields; the rest are null. */
      public static Status of(String status, String steer) {
        return new Status(status, steer);
      }

      public Status withStatus(String value) {
        return new Status(value, steer);
      }

      public Status withSteer(String value) {
        return new Status(status, value);
      }
    }
  }

  /**
   * `POST /api/routing/residents` input: enrol the agent of one owned run session.
   *
   * @param sessionId The run's routing session; its `kind` (the adapter id) is the vendor.
   * @param name Requested world name. Omitted: the agent's proposal, else a fresh word-list name.
   * @param proposedName The agent's own proposal (used only without `name`). The server sanitizes and dedupes it and never takes a vendor or model word; an unusable proposal falls back to the word list instead of failing.
   * @param room Room to arrive in. Omitted: the launching person's current room.
   */
  public record ResidentEnrolInput(
      String sessionId,
      String name,
      String proposedName,
      String room) {

    /** With its required fields; the rest are null. */
    public static ResidentEnrolInput of(String sessionId) {
      return new ResidentEnrolInput(sessionId, null, null, null);
    }

    public ResidentEnrolInput withSessionId(String value) {
      return new ResidentEnrolInput(value, name, proposedName, room);
    }

    public ResidentEnrolInput withName(String value) {
      return new ResidentEnrolInput(sessionId, value, proposedName, room);
    }

    public ResidentEnrolInput withProposedName(String value) {
      return new ResidentEnrolInput(sessionId, name, value, room);
    }

    public ResidentEnrolInput withRoom(String value) {
      return new ResidentEnrolInput(sessionId, name, proposedName, value);
    }
  }

  /**
   * @param owner The person who owns the resident (the enrolling account's world name).
   * @param room Room the resident should arrive in, when one is known.
   * @param reused True when an existing resident account of the same owner was reused.
   * @param nameSource Where the name came from: the launch request, the agent's proposal, or the word list.
   * @param attention The resident's stored attention policy (supervised residents' attention bridge).
   */
  public record ResidentEnrolment(
      String name,
      String vendor,
      String owner,
      String room,
      Boolean reused,
      String nameSource,
      ResidentCredential credential,
      ResidentAttentionPolicy attention) {

    /** With its required fields; the rest are null. */
    public static ResidentEnrolment of(String name, String vendor, Boolean reused, ResidentCredential credential) {
      return new ResidentEnrolment(name, vendor, null, null, reused, null, credential, null);
    }

    public ResidentEnrolment withName(String value) {
      return new ResidentEnrolment(value, vendor, owner, room, reused, nameSource, credential, attention);
    }

    public ResidentEnrolment withVendor(String value) {
      return new ResidentEnrolment(name, value, owner, room, reused, nameSource, credential, attention);
    }

    public ResidentEnrolment withOwner(String value) {
      return new ResidentEnrolment(name, vendor, value, room, reused, nameSource, credential, attention);
    }

    public ResidentEnrolment withRoom(String value) {
      return new ResidentEnrolment(name, vendor, owner, value, reused, nameSource, credential, attention);
    }

    public ResidentEnrolment withReused(Boolean value) {
      return new ResidentEnrolment(name, vendor, owner, room, value, nameSource, credential, attention);
    }

    public ResidentEnrolment withNameSource(String value) {
      return new ResidentEnrolment(name, vendor, owner, room, reused, value, credential, attention);
    }

    public ResidentEnrolment withCredential(ResidentCredential value) {
      return new ResidentEnrolment(name, vendor, owner, room, reused, nameSource, value, attention);
    }

    public ResidentEnrolment withAttention(ResidentAttentionPolicy value) {
      return new ResidentEnrolment(name, vendor, owner, room, reused, nameSource, credential, value);
    }
  }

  public record ResolveAttemptRequest(
      Object value) {

    /** With its required fields; the rest are null. */
    public static ResolveAttemptRequest of(Object value) {
      return new ResolveAttemptRequest(value);
    }

    public ResolveAttemptRequest withValue(Object value) {
      return new ResolveAttemptRequest(value);
    }
  }

  public record ResolveAttemptResponse(
      Double answerId,
      Double loss) {

    /** With its required fields; the rest are null. */
    public static ResolveAttemptResponse of(Double answerId, Double loss) {
      return new ResolveAttemptResponse(answerId, loss);
    }

    public ResolveAttemptResponse withAnswerId(Double value) {
      return new ResolveAttemptResponse(value, loss);
    }

    public ResolveAttemptResponse withLoss(Double value) {
      return new ResolveAttemptResponse(answerId, value);
    }
  }

  /**
   * @param competing Competing record IDs (1–32); the head record is the operation target.
   * @param validTime Explicit cutoff for closing losers; `from` overrides the winner's `valid_from`.
   * @param deadlineMs await_confirmation only: relative deadline in milliseconds.
   */
  public record ResolveRequest(
      String policy,
      List<String> competing,
      String rationale,
      @Json.Name("valid_time") MemoryValidity validTime,
      @Json.Name("deadline_ms") Double deadlineMs,
      String id) {

    /** With its required fields; the rest are null. */
    public static ResolveRequest of(String policy, List<String> competing, String rationale, String id) {
      return new ResolveRequest(policy, competing, rationale, null, null, id);
    }

    public ResolveRequest withPolicy(String value) {
      return new ResolveRequest(value, competing, rationale, validTime, deadlineMs, id);
    }

    public ResolveRequest withCompeting(List<String> value) {
      return new ResolveRequest(policy, value, rationale, validTime, deadlineMs, id);
    }

    public ResolveRequest withRationale(String value) {
      return new ResolveRequest(policy, competing, value, validTime, deadlineMs, id);
    }

    public ResolveRequest withValidTime(MemoryValidity value) {
      return new ResolveRequest(policy, competing, rationale, value, deadlineMs, id);
    }

    public ResolveRequest withDeadlineMs(Double value) {
      return new ResolveRequest(policy, competing, rationale, validTime, value, id);
    }

    public ResolveRequest withId(String value) {
      return new ResolveRequest(policy, competing, rationale, validTime, deadlineMs, value);
    }
  }

  public record ReviewAttemptRequest(
      String text) {

    /** With its required fields; the rest are null. */
    public static ReviewAttemptRequest of(String text) {
      return new ReviewAttemptRequest(text);
    }

    public ReviewAttemptRequest withText(String value) {
      return new ReviewAttemptRequest(value);
    }
  }

  public record ReviewRequest(
      String kind,
      Double limit,
      String cursor) {

    /** With its required fields; the rest are null. */
    public static ReviewRequest of() {
      return new ReviewRequest(null, null, null);
    }

    public ReviewRequest withKind(String value) {
      return new ReviewRequest(value, limit, cursor);
    }

    public ReviewRequest withLimit(Double value) {
      return new ReviewRequest(kind, value, cursor);
    }

    public ReviewRequest withCursor(String value) {
      return new ReviewRequest(kind, limit, value);
    }
  }

  public record RevisePanelRequest(
      String revision,
      A2UINodeData data) {

    /** With its required fields; the rest are null. */
    public static RevisePanelRequest of(String revision, A2UINodeData data) {
      return new RevisePanelRequest(revision, data);
    }

    public RevisePanelRequest withRevision(String value) {
      return new RevisePanelRequest(value, data);
    }

    public RevisePanelRequest withData(A2UINodeData value) {
      return new RevisePanelRequest(revision, value);
    }
  }

  public record ReviseRequest(
      @Json.Name("dependency_versions") Map<String, Double> dependencyVersions,
      @Json.Name("valid_time") MemoryValidity validTime,
      @Json.Name("expected_vocabulary_version") Double expectedVocabularyVersion,
      String content,
      String type,
      String tier,
      Double importance,
      String subject,
      Map<String, Object> metadata,
      @Json.Name("source_ids") List<String> sourceIds,
      @Json.Name("depends_on") List<String> dependsOn,
      MemoryClaim claim,
      @Json.Name("expected_version") Double expectedVersion) {

    /** With its required fields; the rest are null. */
    public static ReviseRequest of(String content, Double expectedVersion) {
      return new ReviseRequest(null, null, null, content, null, null, null, null, null, null, null, null, expectedVersion);
    }

    public ReviseRequest withDependencyVersions(Map<String, Double> value) {
      return new ReviseRequest(value, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withValidTime(MemoryValidity value) {
      return new ReviseRequest(dependencyVersions, value, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withExpectedVocabularyVersion(Double value) {
      return new ReviseRequest(dependencyVersions, validTime, value, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withContent(String value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, value, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withType(String value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, value, tier, importance, subject, metadata, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withTier(String value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, type, value, importance, subject, metadata, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withImportance(Double value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, value, subject, metadata, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withSubject(String value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, value, metadata, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withMetadata(Map<String, Object> value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, value, sourceIds, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withSourceIds(List<String> value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, value, dependsOn, claim, expectedVersion);
    }

    public ReviseRequest withDependsOn(List<String> value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, value, claim, expectedVersion);
    }

    public ReviseRequest withClaim(MemoryClaim value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, value, expectedVersion);
    }

    public ReviseRequest withExpectedVersion(Double value) {
      return new ReviseRequest(dependencyVersions, validTime, expectedVocabularyVersion, content, type, tier, importance, subject, metadata, sourceIds, dependsOn, claim, value);
    }
  }

  public record RevokeResidentRequest(
      String sessionId) {

    /** With its required fields; the rest are null. */
    public static RevokeResidentRequest of(String sessionId) {
      return new RevokeResidentRequest(sessionId);
    }

    public RevokeResidentRequest withSessionId(String value) {
      return new RevokeResidentRequest(value);
    }
  }

  public record RevokeResidentResponse(
      String name,
      Double revoked) {

    /** With its required fields; the rest are null. */
    public static RevokeResidentResponse of(String name, Double revoked) {
      return new RevokeResidentResponse(name, revoked);
    }

    public RevokeResidentResponse withName(String value) {
      return new RevokeResidentResponse(value, revoked);
    }

    public RevokeResidentResponse withRevoked(Double value) {
      return new RevokeResidentResponse(name, value);
    }
  }

  public record RevokeSupervisionResponse(
      Boolean revoked) {

    /** With its required fields; the rest are null. */
    public static RevokeSupervisionResponse of(Boolean revoked) {
      return new RevokeSupervisionResponse(revoked);
    }

    public RevokeSupervisionResponse withRevoked(Boolean value) {
      return new RevokeSupervisionResponse(value);
    }
  }

  /**
   * References to Marina's existing channel_messages; this is not a second conversation log.
   */
  public record RoutingChannelMessage(
      Double id,
      String channelId,
      String senderId,
      String senderName,
      String content,
      Double createdAt) {

    /** With its required fields; the rest are null. */
    public static RoutingChannelMessage of(Double id, String channelId, String senderId, String senderName, String content, Double createdAt) {
      return new RoutingChannelMessage(id, channelId, senderId, senderName, content, createdAt);
    }

    public RoutingChannelMessage withId(Double value) {
      return new RoutingChannelMessage(value, channelId, senderId, senderName, content, createdAt);
    }

    public RoutingChannelMessage withChannelId(String value) {
      return new RoutingChannelMessage(id, value, senderId, senderName, content, createdAt);
    }

    public RoutingChannelMessage withSenderId(String value) {
      return new RoutingChannelMessage(id, channelId, value, senderName, content, createdAt);
    }

    public RoutingChannelMessage withSenderName(String value) {
      return new RoutingChannelMessage(id, channelId, senderId, value, content, createdAt);
    }

    public RoutingChannelMessage withContent(String value) {
      return new RoutingChannelMessage(id, channelId, senderId, senderName, value, createdAt);
    }

    public RoutingChannelMessage withCreatedAt(Double value) {
      return new RoutingChannelMessage(id, channelId, senderId, senderName, content, value);
    }
  }

  public record RoutingChannelPage(
      List<RoutingChannelMessage> messages,
      Double nextCursor,
      Boolean hasMore) {

    /** With its required fields; the rest are null. */
    public static RoutingChannelPage of(List<RoutingChannelMessage> messages, Double nextCursor, Boolean hasMore) {
      return new RoutingChannelPage(messages, nextCursor, hasMore);
    }

    public RoutingChannelPage withMessages(List<RoutingChannelMessage> value) {
      return new RoutingChannelPage(value, nextCursor, hasMore);
    }

    public RoutingChannelPage withNextCursor(Double value) {
      return new RoutingChannelPage(messages, value, hasMore);
    }

    public RoutingChannelPage withHasMore(Boolean value) {
      return new RoutingChannelPage(messages, nextCursor, value);
    }
  }

  public record RoutingChannelReceipt(
      RoutingChannelMessage message,
      Boolean duplicate) {

    /** With its required fields; the rest are null. */
    public static RoutingChannelReceipt of(RoutingChannelMessage message, Boolean duplicate) {
      return new RoutingChannelReceipt(message, duplicate);
    }

    public RoutingChannelReceipt withMessage(RoutingChannelMessage value) {
      return new RoutingChannelReceipt(value, duplicate);
    }

    public RoutingChannelReceipt withDuplicate(Boolean value) {
      return new RoutingChannelReceipt(message, value);
    }
  }

  /**
   * @param gap Requested history was pruned. Consumers must show this instead of implying completeness.
   */
  public record RoutingEventPage(
      List<RoutingEvent> events,
      Double nextCursor,
      Double lastSequence,
      Boolean hasMore,
      Boolean gap) {

    /** With its required fields; the rest are null. */
    public static RoutingEventPage of(List<RoutingEvent> events, Double nextCursor, Double lastSequence, Boolean hasMore, Boolean gap) {
      return new RoutingEventPage(events, nextCursor, lastSequence, hasMore, gap);
    }

    public RoutingEventPage withEvents(List<RoutingEvent> value) {
      return new RoutingEventPage(value, nextCursor, lastSequence, hasMore, gap);
    }

    public RoutingEventPage withNextCursor(Double value) {
      return new RoutingEventPage(events, value, lastSequence, hasMore, gap);
    }

    public RoutingEventPage withLastSequence(Double value) {
      return new RoutingEventPage(events, nextCursor, value, hasMore, gap);
    }

    public RoutingEventPage withHasMore(Boolean value) {
      return new RoutingEventPage(events, nextCursor, lastSequence, value, gap);
    }

    public RoutingEventPage withGap(Boolean value) {
      return new RoutingEventPage(events, nextCursor, lastSequence, hasMore, value);
    }
  }

  /**
   * Version 1: transport-neutral participants. Capabilities describe clients, not permissions.
   */
  public record RoutingJoin(
      String clientKey,
      String label,
      String kind,
      String groupId,
      List<String> capabilities) {

    /** With its required fields; the rest are null. */
    public static RoutingJoin of(String clientKey, String label, String kind) {
      return new RoutingJoin(clientKey, label, kind, null, null);
    }

    public RoutingJoin withClientKey(String value) {
      return new RoutingJoin(value, label, kind, groupId, capabilities);
    }

    public RoutingJoin withLabel(String value) {
      return new RoutingJoin(clientKey, value, kind, groupId, capabilities);
    }

    public RoutingJoin withKind(String value) {
      return new RoutingJoin(clientKey, label, value, groupId, capabilities);
    }

    public RoutingJoin withGroupId(String value) {
      return new RoutingJoin(clientKey, label, kind, value, capabilities);
    }

    public RoutingJoin withCapabilities(List<String> value) {
      return new RoutingJoin(clientKey, label, kind, groupId, value);
    }
  }

  public record RoutingSession(
      String id,
      String ownerId,
      String clientKey,
      String label,
      String kind,
      String groupId,
      List<String> capabilities,
      String state,
      Double createdAt,
      Double lastSeenAt,
      Double lastSequence) {

    /** With its required fields; the rest are null. */
    public static RoutingSession of(String id, String ownerId, String clientKey, String label, String kind, String groupId, List<String> capabilities, String state, Double createdAt, Double lastSeenAt, Double lastSequence) {
      return new RoutingSession(id, ownerId, clientKey, label, kind, groupId, capabilities, state, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withId(String value) {
      return new RoutingSession(value, ownerId, clientKey, label, kind, groupId, capabilities, state, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withOwnerId(String value) {
      return new RoutingSession(id, value, clientKey, label, kind, groupId, capabilities, state, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withClientKey(String value) {
      return new RoutingSession(id, ownerId, value, label, kind, groupId, capabilities, state, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withLabel(String value) {
      return new RoutingSession(id, ownerId, clientKey, value, kind, groupId, capabilities, state, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withKind(String value) {
      return new RoutingSession(id, ownerId, clientKey, label, value, groupId, capabilities, state, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withGroupId(String value) {
      return new RoutingSession(id, ownerId, clientKey, label, kind, value, capabilities, state, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withCapabilities(List<String> value) {
      return new RoutingSession(id, ownerId, clientKey, label, kind, groupId, value, state, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withState(String value) {
      return new RoutingSession(id, ownerId, clientKey, label, kind, groupId, capabilities, value, createdAt, lastSeenAt, lastSequence);
    }

    public RoutingSession withCreatedAt(Double value) {
      return new RoutingSession(id, ownerId, clientKey, label, kind, groupId, capabilities, state, value, lastSeenAt, lastSequence);
    }

    public RoutingSession withLastSeenAt(Double value) {
      return new RoutingSession(id, ownerId, clientKey, label, kind, groupId, capabilities, state, createdAt, value, lastSequence);
    }

    public RoutingSession withLastSequence(Double value) {
      return new RoutingSession(id, ownerId, clientKey, label, kind, groupId, capabilities, state, createdAt, lastSeenAt, value);
    }
  }

  /**
   * Account-scoped observer projection; runtime data is reported by the participant.
   */
  public record RoutingOverviewItem(
      RoutingSession session,
      Object runtime,
      RoutingEvent lastDelivery,
      Boolean owned) {

    /** With its required fields; the rest are null. */
    public static RoutingOverviewItem of(RoutingSession session, Object runtime, RoutingEvent lastDelivery, Boolean owned) {
      return new RoutingOverviewItem(session, runtime, lastDelivery, owned);
    }

    public RoutingOverviewItem withSession(RoutingSession value) {
      return new RoutingOverviewItem(value, runtime, lastDelivery, owned);
    }

    public RoutingOverviewItem withRuntime(Object value) {
      return new RoutingOverviewItem(session, value, lastDelivery, owned);
    }

    public RoutingOverviewItem withLastDelivery(RoutingEvent value) {
      return new RoutingOverviewItem(session, runtime, value, owned);
    }

    public RoutingOverviewItem withOwned(Boolean value) {
      return new RoutingOverviewItem(session, runtime, lastDelivery, value);
    }
  }

  public record RoutingOverview(
      List<RoutingOverviewItem> items,
      Double total,
      String nextCursor) {

    /** With its required fields; the rest are null. */
    public static RoutingOverview of(List<RoutingOverviewItem> items, Double total, String nextCursor) {
      return new RoutingOverview(items, total, nextCursor);
    }

    public RoutingOverview withItems(List<RoutingOverviewItem> value) {
      return new RoutingOverview(value, total, nextCursor);
    }

    public RoutingOverview withTotal(Double value) {
      return new RoutingOverview(items, value, nextCursor);
    }

    public RoutingOverview withNextCursor(String value) {
      return new RoutingOverview(items, total, value);
    }
  }

  public record RoutingSend(
      String clientMessageId,
      String targetId,
      String kind,
      Object payload) {

    /** With its required fields; the rest are null. */
    public static RoutingSend of(String clientMessageId, String targetId, String kind, Object payload) {
      return new RoutingSend(clientMessageId, targetId, kind, payload);
    }

    public RoutingSend withClientMessageId(String value) {
      return new RoutingSend(value, targetId, kind, payload);
    }

    public RoutingSend withTargetId(String value) {
      return new RoutingSend(clientMessageId, value, kind, payload);
    }

    public RoutingSend withKind(String value) {
      return new RoutingSend(clientMessageId, targetId, value, payload);
    }

    public RoutingSend withPayload(Object value) {
      return new RoutingSend(clientMessageId, targetId, kind, value);
    }
  }

  public record RoutingSessionPage(
      List<RoutingSession> sessions,
      String nextCursor) {

    /** With its required fields; the rest are null. */
    public static RoutingSessionPage of(List<RoutingSession> sessions, String nextCursor) {
      return new RoutingSessionPage(sessions, nextCursor);
    }

    public RoutingSessionPage withSessions(List<RoutingSession> value) {
      return new RoutingSessionPage(value, nextCursor);
    }

    public RoutingSessionPage withNextCursor(String value) {
      return new RoutingSessionPage(sessions, value);
    }
  }

  public record RoutingSyncInput(
      List<PublicationsItem> publications,
      List<AcknowledgmentsItem> acknowledgments,
      List<String> inboxes) {

    /** With its required fields; the rest are null. */
    public static RoutingSyncInput of() {
      return new RoutingSyncInput(null, null, null);
    }

    public RoutingSyncInput withPublications(List<PublicationsItem> value) {
      return new RoutingSyncInput(value, acknowledgments, inboxes);
    }

    public RoutingSyncInput withAcknowledgments(List<AcknowledgmentsItem> value) {
      return new RoutingSyncInput(publications, value, inboxes);
    }

    public RoutingSyncInput withInboxes(List<String> value) {
      return new RoutingSyncInput(publications, acknowledgments, value);
    }

    public record PublicationsItem(
        String sessionId,
        List<RoutingEventInput> events) {

      /** With its required fields; the rest are null. */
      public static PublicationsItem of(String sessionId, List<RoutingEventInput> events) {
        return new PublicationsItem(sessionId, events);
      }

      public PublicationsItem withSessionId(String value) {
        return new PublicationsItem(value, events);
      }

      public PublicationsItem withEvents(List<RoutingEventInput> value) {
        return new PublicationsItem(sessionId, value);
      }
    }

    public record AcknowledgmentsItem(
        String sessionId,
        String messageId) {

      /** With its required fields; the rest are null. */
      public static AcknowledgmentsItem of(String sessionId, String messageId) {
        return new AcknowledgmentsItem(sessionId, messageId);
      }

      public AcknowledgmentsItem withSessionId(String value) {
        return new AcknowledgmentsItem(value, messageId);
      }

      public AcknowledgmentsItem withMessageId(String value) {
        return new AcknowledgmentsItem(sessionId, value);
      }
    }
  }

  public record RoutingSyncResult(
      List<InboxesItem> inboxes) {

    /** With its required fields; the rest are null. */
    public static RoutingSyncResult of(List<InboxesItem> inboxes) {
      return new RoutingSyncResult(inboxes);
    }

    public RoutingSyncResult withInboxes(List<InboxesItem> value) {
      return new RoutingSyncResult(value);
    }

    public record InboxesItem(
        String sessionId,
        List<RoutingMessage> messages) {

      /** With its required fields; the rest are null. */
      public static InboxesItem of(String sessionId, List<RoutingMessage> messages) {
        return new InboxesItem(sessionId, messages);
      }

      public InboxesItem withSessionId(String value) {
        return new InboxesItem(value, messages);
      }

      public InboxesItem withMessages(List<RoutingMessage> value) {
        return new InboxesItem(sessionId, value);
      }
    }
  }

  public record RunRuleRequest(
      String id,
      @Json.Name("expected_version") Double expectedVersion,
      @Json.Name("valid_at") Double validAt) {

    /** With its required fields; the rest are null. */
    public static RunRuleRequest of(String id, Double expectedVersion) {
      return new RunRuleRequest(id, expectedVersion, null);
    }

    public RunRuleRequest withId(String value) {
      return new RunRuleRequest(value, expectedVersion, validAt);
    }

    public RunRuleRequest withExpectedVersion(Double value) {
      return new RunRuleRequest(id, value, validAt);
    }

    public RunRuleRequest withValidAt(Double value) {
      return new RunRuleRequest(id, expectedVersion, value);
    }
  }

  public record RuntimeRequest(
      String id,
      String kind,
      String title,
      Object input,
      List<String> choices) {

    /** With its required fields; the rest are null. */
    public static RuntimeRequest of(String id, String kind, String title, Object input) {
      return new RuntimeRequest(id, kind, title, input, null);
    }

    public RuntimeRequest withId(String value) {
      return new RuntimeRequest(value, kind, title, input, choices);
    }

    public RuntimeRequest withKind(String value) {
      return new RuntimeRequest(id, value, title, input, choices);
    }

    public RuntimeRequest withTitle(String value) {
      return new RuntimeRequest(id, kind, value, input, choices);
    }

    public RuntimeRequest withInput(Object value) {
      return new RuntimeRequest(id, kind, title, value, choices);
    }

    public RuntimeRequest withChoices(List<String> value) {
      return new RuntimeRequest(id, kind, title, input, value);
    }
  }

  /**
   * @param effort Reasoning depth the run was launched with (off, minimal, low, medium, high, xhigh).
   * @param resident World account of a supervised resident run (`MARINA_SUPERVISED_RESIDENTS=on`).
   */
  public record RuntimeState(
      Double version,
      String role,
      String status,
      String mode,
      String adapter,
      String supervisorId,
      String cwd,
      String nativeSessionId,
      String model,
      String effort,
      Boolean resumeSupported,
      RuntimeRequest request,
      String error,
      List<AdaptersItem> adapters,
      String root,
      Double activeCount,
      String resident,
      Double updatedAt) {

    /** With its required fields; the rest are null. */
    public static RuntimeState of(Double version, String role, String status, String mode, String adapter, String supervisorId, String cwd, Double updatedAt) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, null, null, null, null, null, null, null, null, null, null, updatedAt);
    }

    public RuntimeState withVersion(Double value) {
      return new RuntimeState(value, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withRole(String value) {
      return new RuntimeState(version, value, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withStatus(String value) {
      return new RuntimeState(version, role, value, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withMode(String value) {
      return new RuntimeState(version, role, status, value, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withAdapter(String value) {
      return new RuntimeState(version, role, status, mode, value, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withSupervisorId(String value) {
      return new RuntimeState(version, role, status, mode, adapter, value, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withCwd(String value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, value, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withNativeSessionId(String value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, value, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withModel(String value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, value, effort, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withEffort(String value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, value, resumeSupported, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withResumeSupported(Boolean value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, value, request, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withRequest(RuntimeRequest value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, value, error, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withError(String value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, value, adapters, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withAdapters(List<AdaptersItem> value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, value, root, activeCount, resident, updatedAt);
    }

    public RuntimeState withRoot(String value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, value, activeCount, resident, updatedAt);
    }

    public RuntimeState withActiveCount(Double value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, value, resident, updatedAt);
    }

    public RuntimeState withResident(String value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, value, updatedAt);
    }

    public RuntimeState withUpdatedAt(Double value) {
      return new RuntimeState(version, role, status, mode, adapter, supervisorId, cwd, nativeSessionId, model, effort, resumeSupported, request, error, adapters, root, activeCount, resident, value);
    }

    public record AdaptersItem(
        String id,
        String label) {

      /** With its required fields; the rest are null. */
      public static AdaptersItem of(String id, String label) {
        return new AdaptersItem(id, label);
      }

      public AdaptersItem withId(String value) {
        return new AdaptersItem(value, label);
      }

      public AdaptersItem withLabel(String value) {
        return new AdaptersItem(id, value);
      }
    }
  }

  public record RuntimeResponse(
      RuntimeState state) {

    /** With its required fields; the rest are null. */
    public static RuntimeResponse of(RuntimeState state) {
      return new RuntimeResponse(state);
    }

    public RuntimeResponse withState(RuntimeState value) {
      return new RuntimeResponse(value);
    }
  }

  public record SaveCheckpointRequest(
      @Json.Name("expected_version") Double expectedVersion,
      Map<String, Object> data,
      @Json.Name("source_cursor") Double sourceCursor,
      @Json.Name("source_ids") List<String> sourceIds) {

    /** With its required fields; the rest are null. */
    public static SaveCheckpointRequest of(Double expectedVersion, Map<String, Object> data) {
      return new SaveCheckpointRequest(expectedVersion, data, null, null);
    }

    public SaveCheckpointRequest withExpectedVersion(Double value) {
      return new SaveCheckpointRequest(value, data, sourceCursor, sourceIds);
    }

    public SaveCheckpointRequest withData(Map<String, Object> value) {
      return new SaveCheckpointRequest(expectedVersion, value, sourceCursor, sourceIds);
    }

    public SaveCheckpointRequest withSourceCursor(Double value) {
      return new SaveCheckpointRequest(expectedVersion, data, value, sourceIds);
    }

    public SaveCheckpointRequest withSourceIds(List<String> value) {
      return new SaveCheckpointRequest(expectedVersion, data, sourceCursor, value);
    }
  }

  public record SaveRuleRequest(
      MemoryRule rule,
      String id,
      @Json.Name("expected_version") Double expectedVersion,
      @Json.Name("source_ids") List<String> sourceIds) {

    /** With its required fields; the rest are null. */
    public static SaveRuleRequest of(MemoryRule rule) {
      return new SaveRuleRequest(rule, null, null, null);
    }

    public SaveRuleRequest withRule(MemoryRule value) {
      return new SaveRuleRequest(value, id, expectedVersion, sourceIds);
    }

    public SaveRuleRequest withId(String value) {
      return new SaveRuleRequest(rule, value, expectedVersion, sourceIds);
    }

    public SaveRuleRequest withExpectedVersion(Double value) {
      return new SaveRuleRequest(rule, id, value, sourceIds);
    }

    public SaveRuleRequest withSourceIds(List<String> value) {
      return new SaveRuleRequest(rule, id, expectedVersion, value);
    }
  }

  public record SaveVocabularyRequest(
      @Json.Name("expected_version") Double expectedVersion,
      MemoryVocabularyDefinition definition) {

    /** With its required fields; the rest are null. */
    public static SaveVocabularyRequest of(Double expectedVersion, MemoryVocabularyDefinition definition) {
      return new SaveVocabularyRequest(expectedVersion, definition);
    }

    public SaveVocabularyRequest withExpectedVersion(Double value) {
      return new SaveVocabularyRequest(value, definition);
    }

    public SaveVocabularyRequest withDefinition(MemoryVocabularyDefinition value) {
      return new SaveVocabularyRequest(expectedVersion, value);
    }
  }

  public record SendChannelRequest(
      String clientMessageId,
      String text) {

    /** With its required fields; the rest are null. */
    public static SendChannelRequest of(String clientMessageId, String text) {
      return new SendChannelRequest(clientMessageId, text);
    }

    public SendChannelRequest withClientMessageId(String value) {
      return new SendChannelRequest(value, text);
    }

    public SendChannelRequest withText(String value) {
      return new SendChannelRequest(clientMessageId, value);
    }
  }

  public record SourceHeadersResponse(
      List<SourceHeadersResponseSourcesItem> sources,
      @Json.Name("next_cursor") Double nextCursor) {

    /** With its required fields; the rest are null. */
    public static SourceHeadersResponse of(List<SourceHeadersResponseSourcesItem> sources, Double nextCursor) {
      return new SourceHeadersResponse(sources, nextCursor);
    }

    public SourceHeadersResponse withSources(List<SourceHeadersResponseSourcesItem> value) {
      return new SourceHeadersResponse(value, nextCursor);
    }

    public SourceHeadersResponse withNextCursor(Double value) {
      return new SourceHeadersResponse(sources, value);
    }

    public record SourceHeadersResponseSourcesItem(
        String id,
        @Json.Name("space_id") String spaceId,
        Double seq,
        @Json.Name("session_id") String sessionId,
        @Json.Name("content_hash") String contentHash,
        @Json.Name("created_at") Double createdAt) {

      /** With its required fields; the rest are null. */
      public static SourceHeadersResponseSourcesItem of(String id, String spaceId, Double seq, String sessionId, String contentHash, Double createdAt) {
        return new SourceHeadersResponseSourcesItem(id, spaceId, seq, sessionId, contentHash, createdAt);
      }

      public SourceHeadersResponseSourcesItem withId(String value) {
        return new SourceHeadersResponseSourcesItem(value, spaceId, seq, sessionId, contentHash, createdAt);
      }

      public SourceHeadersResponseSourcesItem withSpaceId(String value) {
        return new SourceHeadersResponseSourcesItem(id, value, seq, sessionId, contentHash, createdAt);
      }

      public SourceHeadersResponseSourcesItem withSeq(Double value) {
        return new SourceHeadersResponseSourcesItem(id, spaceId, value, sessionId, contentHash, createdAt);
      }

      public SourceHeadersResponseSourcesItem withSessionId(String value) {
        return new SourceHeadersResponseSourcesItem(id, spaceId, seq, value, contentHash, createdAt);
      }

      public SourceHeadersResponseSourcesItem withContentHash(String value) {
        return new SourceHeadersResponseSourcesItem(id, spaceId, seq, sessionId, value, createdAt);
      }

      public SourceHeadersResponseSourcesItem withCreatedAt(Double value) {
        return new SourceHeadersResponseSourcesItem(id, spaceId, seq, sessionId, contentHash, value);
      }
    }
  }

  public record SourcesResponse(
      List<MemorySource> sources,
      @Json.Name("next_cursor") Double nextCursor) {

    /** With its required fields; the rest are null. */
    public static SourcesResponse of(List<MemorySource> sources, Double nextCursor) {
      return new SourcesResponse(sources, nextCursor);
    }

    public SourcesResponse withSources(List<MemorySource> value) {
      return new SourcesResponse(value, nextCursor);
    }

    public SourcesResponse withNextCursor(Double value) {
      return new SourcesResponse(sources, value);
    }
  }

  public record SpacesResponse(
      List<MemorySpace> spaces) {

    /** With its required fields; the rest are null. */
    public static SpacesResponse of(List<MemorySpace> spaces) {
      return new SpacesResponse(spaces);
    }

    public SpacesResponse withSpaces(List<MemorySpace> value) {
      return new SpacesResponse(value);
    }
  }

  /**
   * @param caseId Existing case for a new attempt; prior results remain immutable.
   * @param parentAttemptId An owned child while its parent runs; otherwise a new episode referencing prior work.
   */
  public record StartInvestigationRequest(
      String kind,
      String question,
      Object answer,
      String context,
      String horizon,
      String asOf,
      String caseId,
      String parentAttemptId,
      Double runs,
      StartInvestigationRequestLimits limits,
      String idempotencyKey) {

    /** With its required fields; the rest are null. */
    public static StartInvestigationRequest of(String kind, String question, String idempotencyKey) {
      return new StartInvestigationRequest(kind, question, null, null, null, null, null, null, null, null, idempotencyKey);
    }

    public StartInvestigationRequest withKind(String value) {
      return new StartInvestigationRequest(value, question, answer, context, horizon, asOf, caseId, parentAttemptId, runs, limits, idempotencyKey);
    }

    public StartInvestigationRequest withQuestion(String value) {
      return new StartInvestigationRequest(kind, value, answer, context, horizon, asOf, caseId, parentAttemptId, runs, limits, idempotencyKey);
    }

    public StartInvestigationRequest withAnswer(Object value) {
      return new StartInvestigationRequest(kind, question, value, context, horizon, asOf, caseId, parentAttemptId, runs, limits, idempotencyKey);
    }

    public StartInvestigationRequest withContext(String value) {
      return new StartInvestigationRequest(kind, question, answer, value, horizon, asOf, caseId, parentAttemptId, runs, limits, idempotencyKey);
    }

    public StartInvestigationRequest withHorizon(String value) {
      return new StartInvestigationRequest(kind, question, answer, context, value, asOf, caseId, parentAttemptId, runs, limits, idempotencyKey);
    }

    public StartInvestigationRequest withAsOf(String value) {
      return new StartInvestigationRequest(kind, question, answer, context, horizon, value, caseId, parentAttemptId, runs, limits, idempotencyKey);
    }

    public StartInvestigationRequest withCaseId(String value) {
      return new StartInvestigationRequest(kind, question, answer, context, horizon, asOf, value, parentAttemptId, runs, limits, idempotencyKey);
    }

    public StartInvestigationRequest withParentAttemptId(String value) {
      return new StartInvestigationRequest(kind, question, answer, context, horizon, asOf, caseId, value, runs, limits, idempotencyKey);
    }

    public StartInvestigationRequest withRuns(Double value) {
      return new StartInvestigationRequest(kind, question, answer, context, horizon, asOf, caseId, parentAttemptId, value, limits, idempotencyKey);
    }

    public StartInvestigationRequest withLimits(StartInvestigationRequestLimits value) {
      return new StartInvestigationRequest(kind, question, answer, context, horizon, asOf, caseId, parentAttemptId, runs, value, idempotencyKey);
    }

    public StartInvestigationRequest withIdempotencyKey(String value) {
      return new StartInvestigationRequest(kind, question, answer, context, horizon, asOf, caseId, parentAttemptId, runs, limits, value);
    }

    public record StartInvestigationRequestLimits(
        Double calls,
        Double concurrency,
        Double timeoutMs) {

      /** With its required fields; the rest are null. */
      public static StartInvestigationRequestLimits of() {
        return new StartInvestigationRequestLimits(null, null, null);
      }

      public StartInvestigationRequestLimits withCalls(Double value) {
        return new StartInvestigationRequestLimits(value, concurrency, timeoutMs);
      }

      public StartInvestigationRequestLimits withConcurrency(Double value) {
        return new StartInvestigationRequestLimits(calls, value, timeoutMs);
      }

      public StartInvestigationRequestLimits withTimeoutMs(Double value) {
        return new StartInvestigationRequestLimits(calls, concurrency, value);
      }
    }
  }

  public record StartInvestigationResponse(
      InvestigationAttempt attempt,
      Boolean created) {

    /** With its required fields; the rest are null. */
    public static StartInvestigationResponse of(InvestigationAttempt attempt, Boolean created) {
      return new StartInvestigationResponse(attempt, created);
    }

    public StartInvestigationResponse withAttempt(InvestigationAttempt value) {
      return new StartInvestigationResponse(value, created);
    }

    public StartInvestigationResponse withCreated(Boolean value) {
      return new StartInvestigationResponse(attempt, value);
    }
  }

  /**
   * A routing-only supervision credential (supervised residents).
   */
  public record SupervisionCredentialGrant(
      String credentialId,
      String token,
      Double expiresAt) {

    /** With its required fields; the rest are null. */
    public static SupervisionCredentialGrant of(String credentialId, String token, Double expiresAt) {
      return new SupervisionCredentialGrant(credentialId, token, expiresAt);
    }

    public SupervisionCredentialGrant withCredentialId(String value) {
      return new SupervisionCredentialGrant(value, token, expiresAt);
    }

    public SupervisionCredentialGrant withToken(String value) {
      return new SupervisionCredentialGrant(credentialId, value, expiresAt);
    }

    public SupervisionCredentialGrant withExpiresAt(Double value) {
      return new SupervisionCredentialGrant(credentialId, token, value);
    }
  }

  public record WorkflowRequest(
      String action) {

    /** With its required fields; the rest are null. */
    public static WorkflowRequest of(String action) {
      return new WorkflowRequest(action);
    }

    public WorkflowRequest withAction(String value) {
      return new WorkflowRequest(value);
    }
  }
}
