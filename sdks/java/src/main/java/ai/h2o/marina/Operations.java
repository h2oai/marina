// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Every marina.http.v1 operation, by operation id. Generated from src/protocol/http-api.ts by
 * scripts/generate-openapi.ts ({@code bun run docs:api}); do not edit by hand.
 */
public final class Operations {
  private Operations() {}

  /** One HTTP operation. */
  public record Operation(
      String id,
      String method,
      String path,
      String tag,
      List<String> pathParams,
      List<String> query,
      boolean body,
      boolean idempotencyKey) {}

  public static final String HTTP_API_VERSION = "marina.http.v1";

  private static final Map<String, Operation> BY_ID = new LinkedHashMap<>();

  private static void add(Operation op) {
    BY_ID.put(op.id(), op);
  }

  static {
    add(new Operation("capabilities", "GET", "/v1/memory", "memory", List.of(), List.of(), false, false));
    add(new Operation("me", "GET", "/v1/memory/me", "memory", List.of(), List.of(), false, false));
    add(new Operation("usage", "GET", "/v1/memory/usage", "memory", List.of(), List.of(), false, false));
    add(new Operation("spaces", "GET", "/v1/memory/spaces", "memory", List.of(), List.of(), false, false));
    add(new Operation("createSpace", "POST", "/v1/memory/spaces", "memory", List.of(), List.of(), true, true));
    add(new Operation("space", "GET", "/v1/memory/spaces/{space}", "memory", List.of("space"), List.of(), false, false));
    add(new Operation("remember", "POST", "/v1/memory/spaces/{space}/records", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("get", "GET", "/v1/memory/spaces/{space}/records/{id}", "memory", List.of("space", "id"), List.of("version"), false, false));
    add(new Operation("revise", "PATCH", "/v1/memory/spaces/{space}/records/{id}", "memory", List.of("space", "id"), List.of(), true, true));
    add(new Operation("search", "POST", "/v1/memory/spaces/{space}/search", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("context", "POST", "/v1/memory/spaces/{space}/context", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("query", "POST", "/v1/memory/spaces/{space}/query", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("graph", "POST", "/v1/memory/spaces/{space}/graph", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("join", "POST", "/v1/memory/spaces/{space}/join", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("saveRule", "POST", "/v1/memory/spaces/{space}/rules", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("runRule", "POST", "/v1/memory/spaces/{space}/rules/run", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("materializeRule", "POST", "/v1/memory/spaces/{space}/rules/materialize", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("knowledgeGraph", "POST", "/v1/memory/spaces/{space}/knowledge_graph", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("review", "POST", "/v1/memory/spaces/{space}/review", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("reaffirm", "POST", "/v1/memory/spaces/{space}/reaffirm", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("resolve", "POST", "/v1/memory/spaces/{space}/resolve", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("adopt", "POST", "/v1/memory/spaces/{space}/adopt", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("acknowledge", "POST", "/v1/memory/spaces/{space}/acknowledge", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("forget", "POST", "/v1/memory/spaces/{space}/forget", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("grant", "POST", "/v1/memory/spaces/{space}/grants", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("reindex", "POST", "/v1/memory/spaces/{space}/reindex", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("cacheGet", "POST", "/v1/memory/spaces/{space}/cache/get", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("cachePut", "POST", "/v1/memory/spaces/{space}/cache/put", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("cacheDelete", "POST", "/v1/memory/spaces/{space}/cache/delete", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("plan", "POST", "/v1/memory/spaces/{space}/plan", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("executePlan", "POST", "/v1/memory/spaces/{space}/execute_plan", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("retrieve", "POST", "/v1/memory/spaces/{space}/retrieve", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("retrieveCached", "POST", "/v1/memory/spaces/{space}/retrieve_cached", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("federatedRetrieve", "POST", "/v1/memory/spaces/{space}/federated_retrieve", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("federationMounts", "GET", "/v1/memory/spaces/{space}/federation_mounts", "memory", List.of("space"), List.of(), false, false));
    add(new Operation("federatedSearch", "POST", "/v1/memory/spaces/{space}/federated_search", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("federatedRead", "POST", "/v1/memory/spaces/{space}/federated_read", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("vocabulary", "GET", "/v1/memory/spaces/{space}/vocabulary", "memory", List.of("space"), List.of("version"), false, false));
    add(new Operation("saveVocabulary", "POST", "/v1/memory/spaces/{space}/vocabulary", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("capture", "POST", "/v1/memory/spaces/{space}/sources", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("captureBatch", "POST", "/v1/memory/spaces/{space}/sources/batch", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("sources", "GET", "/v1/memory/spaces/{space}/sources", "memory", List.of("space"), List.of("after", "limit"), false, false));
    add(new Operation("sourceHeaders", "GET", "/v1/memory/spaces/{space}/source_headers", "memory", List.of("space"), List.of("after", "limit"), false, false));
    add(new Operation("sourceRange", "GET", "/v1/memory/spaces/{space}/sources/{id}", "memory", List.of("space", "id"), List.of("start", "end", "text_hash"), false, false));
    add(new Operation("sourceSearch", "POST", "/v1/memory/spaces/{space}/source_search", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("checkpoint", "GET", "/v1/memory/spaces/{space}/checkpoints/{name}", "memory", List.of("space", "name"), List.of(), false, false));
    add(new Operation("saveCheckpoint", "POST", "/v1/memory/spaces/{space}/checkpoints/{name}", "memory", List.of("space", "name"), List.of(), true, true));
    add(new Operation("captureCheckpoint", "POST", "/v1/memory/spaces/{space}/checkpoints/{name}/capture", "memory", List.of("space", "name"), List.of(), true, true));
    add(new Operation("exportBundle", "GET", "/v1/memory/spaces/{space}/bundle", "memory", List.of("space"), List.of(), false, false));
    add(new Operation("importBundle", "POST", "/v1/memory/spaces/{space}/bundle", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("exportTransferPage", "GET", "/v1/memory/spaces/{space}/transfer", "memory", List.of("space"), List.of("cursor"), false, false));
    add(new Operation("beginTransfer", "POST", "/v1/memory/spaces/{space}/transfers", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("transfers", "GET", "/v1/memory/spaces/{space}/transfers", "memory", List.of("space"), List.of("state", "limit", "cursor"), false, false));
    add(new Operation("transferStatus", "GET", "/v1/memory/spaces/{space}/transfers/{id}", "memory", List.of("space", "id"), List.of(), false, false));
    add(new Operation("appendTransfer", "POST", "/v1/memory/spaces/{space}/transfers/{id}/pages", "memory", List.of("space", "id"), List.of(), true, true));
    add(new Operation("commitTransfer", "POST", "/v1/memory/spaces/{space}/transfers/{id}/commit", "memory", List.of("space", "id"), List.of(), true, true));
    add(new Operation("abortTransfer", "POST", "/v1/memory/spaces/{space}/transfers/{id}/abort", "memory", List.of("space", "id"), List.of(), true, true));
    add(new Operation("export", "GET", "/v1/memory/spaces/{space}/export", "memory", List.of("space"), List.of(), false, false));
    add(new Operation("job", "GET", "/v1/memory/spaces/{space}/jobs/{id}", "memory", List.of("space", "id"), List.of(), false, false));
    add(new Operation("jsonStore", "POST", "/v1/memory/spaces/{space}/json_store", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("workflow", "POST", "/v1/memory/spaces/{space}/workflow", "memory", List.of("space"), List.of(), true, false));
    add(new Operation("assistCreate", "POST", "/v1/memory/spaces/{space}/assistance", "memory", List.of("space"), List.of(), true, true));
    add(new Operation("assistJobs", "GET", "/v1/memory/assistance", "memory", List.of(), List.of("open", "limit", "cursor"), false, false));
    add(new Operation("assistGet", "GET", "/v1/memory/assistance/{job}", "memory", List.of("job"), List.of(), false, false));
    add(new Operation("assistClaim", "POST", "/v1/memory/assistance/{job}/claim", "memory", List.of("job"), List.of(), true, true));
    add(new Operation("assistHeartbeat", "POST", "/v1/memory/assistance/{job}/heartbeat", "memory", List.of("job"), List.of(), true, true));
    add(new Operation("assistRead", "POST", "/v1/memory/assistance/{job}/read", "memory", List.of("job"), List.of(), true, true));
    add(new Operation("assistFinish", "POST", "/v1/memory/assistance/{job}/finish", "memory", List.of("job"), List.of(), true, true));
    add(new Operation("assistCancel", "POST", "/v1/memory/assistance/{job}/cancel", "memory", List.of("job"), List.of(), true, true));
    add(new Operation("assistDelegate", "POST", "/v1/memory/assistance/{job}/delegate", "memory", List.of("job"), List.of(), true, true));
    add(new Operation("assistAdopt", "POST", "/v1/memory/assistance/{job}/adopt", "memory", List.of("job"), List.of(), true, true));
    add(new Operation("joinSession", "POST", "/api/routing/sessions", "routing", List.of(), List.of(), true, false));
    add(new Operation("discover", "GET", "/api/routing/sessions", "routing", List.of(), List.of("after", "limit"), false, false));
    add(new Operation("overview", "GET", "/api/routing/overview", "routing", List.of(), List.of("after", "limit", "attention"), false, false));
    add(new Operation("session", "GET", "/api/routing/sessions/{session}", "routing", List.of("session"), List.of(), false, false));
    add(new Operation("heartbeat", "POST", "/api/routing/sessions/{session}/heartbeat", "routing", List.of("session"), List.of(), true, false));
    add(new Operation("leave", "POST", "/api/routing/sessions/{session}/leave", "routing", List.of("session"), List.of(), true, false));
    add(new Operation("publish", "POST", "/api/routing/sessions/{session}/events", "routing", List.of("session"), List.of(), true, false));
    add(new Operation("events", "GET", "/api/routing/sessions/{session}/events", "routing", List.of("session"), List.of("after", "limit"), false, false));
    add(new Operation("send", "POST", "/api/routing/sessions/{session}/messages", "routing", List.of("session"), List.of(), true, false));
    add(new Operation("inbox", "GET", "/api/routing/sessions/{session}/inbox", "routing", List.of("session"), List.of("limit"), false, false));
    add(new Operation("deliveries", "GET", "/api/routing/sessions/{session}/deliveries", "routing", List.of("session"), List.of("limit"), false, false));
    add(new Operation("receipt", "GET", "/api/routing/sessions/{session}/messages/{message}", "routing", List.of("session", "message"), List.of(), false, false));
    add(new Operation("acknowledgeMessage", "POST", "/api/routing/sessions/{session}/messages/{message}/ack", "routing", List.of("session", "message"), List.of(), true, false));
    add(new Operation("channels", "GET", "/api/routing/sessions/{session}/channels", "routing", List.of("session"), List.of(), false, false));
    add(new Operation("channelMessages", "GET", "/api/routing/sessions/{session}/channels/{channel}/messages", "routing", List.of("session", "channel"), List.of("after", "limit"), false, false));
    add(new Operation("sendChannel", "POST", "/api/routing/sessions/{session}/channels/{channel}/messages", "routing", List.of("session", "channel"), List.of(), true, false));
    add(new Operation("sync", "POST", "/api/routing/sync", "routing", List.of(), List.of(), true, false));
    add(new Operation("runtime", "GET", "/api/routing/sessions/{session}/runtime", "routing", List.of("session"), List.of(), false, false));
    add(new Operation("control", "POST", "/api/routing/sessions/{session}/control", "routing", List.of("session"), List.of(), true, false));
    add(new Operation("enrolResident", "POST", "/api/routing/residents", "routing", List.of(), List.of(), true, false));
    add(new Operation("renewResident", "POST", "/api/routing/residents/{name}/renew", "routing", List.of("name"), List.of(), true, false));
    add(new Operation("revokeResident", "POST", "/api/routing/residents/{name}/revoke", "routing", List.of("name"), List.of(), true, false));
    add(new Operation("reportResidentAttention", "POST", "/api/routing/residents/{name}/attention", "routing", List.of("name"), List.of(), true, false));
    add(new Operation("issueSupervision", "POST", "/api/routing/supervision", "routing", List.of(), List.of(), true, false));
    add(new Operation("renewSupervision", "POST", "/api/routing/supervision/renew", "routing", List.of(), List.of(), true, false));
    add(new Operation("revokeSupervision", "POST", "/api/routing/supervision/revoke", "routing", List.of(), List.of(), true, false));
    add(new Operation("startInvestigation", "POST", "/api/investigations", "investigations", List.of(), List.of(), true, false));
    add(new Operation("listInvestigations", "GET", "/api/investigations", "investigations", List.of(), List.of("before"), false, false));
    add(new Operation("getInvestigation", "GET", "/api/investigations/{case}", "investigations", List.of("case"), List.of("attempt"), false, false));
    add(new Operation("eraseInvestigation", "DELETE", "/api/investigations/{case}", "investigations", List.of("case"), List.of(), false, false));
    add(new Operation("grantInvestigation", "POST", "/api/investigations/{case}/grants", "investigations", List.of("case"), List.of(), true, false));
    add(new Operation("attempt", "GET", "/api/investigations/attempts/{attempt}", "investigations", List.of("attempt"), List.of(), false, false));
    add(new Operation("attemptEvents", "GET", "/api/investigations/attempts/{attempt}/events", "investigations", List.of("attempt"), List.of("after", "limit"), false, false));
    add(new Operation("cancelAttempt", "POST", "/api/investigations/attempts/{attempt}/cancel", "investigations", List.of("attempt"), List.of(), true, false));
    add(new Operation("selectAttempt", "POST", "/api/investigations/attempts/{attempt}/select", "investigations", List.of("attempt"), List.of(), true, false));
    add(new Operation("reviewAttempt", "POST", "/api/investigations/attempts/{attempt}/review", "investigations", List.of("attempt"), List.of(), true, false));
    add(new Operation("resolveAttempt", "POST", "/api/investigations/attempts/{attempt}/resolve", "investigations", List.of("attempt"), List.of(), true, false));
    add(new Operation("investigationContent", "GET", "/api/investigations/content/{content}", "investigations", List.of("content"), List.of(), false, false));
    add(new Operation("createCanvas", "POST", "/api/canvases", "panels", List.of(), List.of(), true, false));
    add(new Operation("canvases", "GET", "/api/canvases", "panels", List.of(), List.of("limit"), false, false));
    add(new Operation("panelResources", "GET", "/api/panel-resources", "panels", List.of(), List.of(), false, false));
    add(new Operation("canvas", "GET", "/api/canvases/{canvas}", "panels", List.of("canvas"), List.of(), false, false));
    add(new Operation("publishPanel", "POST", "/api/canvases/{canvas}/nodes", "panels", List.of("canvas"), List.of(), true, false));
    add(new Operation("panel", "GET", "/api/canvases/{canvas}/nodes/{node}", "panels", List.of("canvas", "node"), List.of(), false, false));
    add(new Operation("revisePanel", "PATCH", "/api/canvases/{canvas}/nodes/{node}", "panels", List.of("canvas", "node"), List.of(), true, false));
    add(new Operation("interactPanel", "POST", "/api/canvases/{canvas}/nodes/{node}/interaction", "panels", List.of("canvas", "node"), List.of(), true, false));
  }

  /** Every operation, by id, in the order of the OpenAPI document. */
  public static final Map<String, Operation> ALL = Collections.unmodifiableMap(BY_ID);
}
