// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * {@code marina.http.v1}: memory, routing, investigations and panels over HTTP.
 *
 * <p>Every operation in protocol/marina.http.v1.openapi.json is called by its operation id, with
 * path and query parameters by name and the JSON body:
 *
 * <pre>{@code
 * marina.routing().call("discover");
 * HttpApi memory = marina.memory(credential);
 * Object space = memory.call("createSpace", Map.of(), Map.of("name", "notes"));
 * memory.call("remember", Map.of("space", id), Map.of("content", "Deploys run from main"));
 * }</pre>
 */
public final class HttpApi {
  private final String baseUrl;
  private final Supplier<String> token;
  private final String tag;
  private final Duration timeout;
  // Never follows a redirect: it would carry the bearer token somewhere else.
  private final HttpClient http =
      HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

  /** The operations of one group ({@code memory}, {@code routing}, ...), or of all when null. */
  public HttpApi(String baseUrl, Supplier<String> token, String tag) {
    this.baseUrl = baseUrl.replaceAll("/+$", "");
    this.token = token;
    this.tag = tag;
    this.timeout = Duration.ofSeconds(35);
  }

  /** The operation ids this group offers. */
  public List<String> operations() {
    List<String> ids = new ArrayList<>();
    for (Operations.Operation op : Operations.ALL.values())
      if (tag == null || tag.equals(op.tag())) ids.add(op.id());
    return ids;
  }

  /** Call an operation that takes no parameters and no body. */
  public Object call(String operation) {
    return call(operation, Map.of(), null, null);
  }

  /** Call an operation with path/query parameters and no body. */
  public Object call(String operation, Map<String, ?> params) {
    return call(operation, params, null, null);
  }

  /** Call an operation with path/query parameters and a JSON body. */
  public Object call(String operation, Map<String, ?> params, Object body) {
    return call(operation, params, body, null);
  }

  /**
   * Call an operation. {@code idempotencyKey} matters for memory writes: the same key replays the
   * first result, so pass your own to retry a write safely (a fresh one is made otherwise).
   *
   * @return the parsed JSON reply ({@code Map}, {@code List}, ...), or null when empty
   * @throws ApiException when the server refuses or fails it
   */
  public Object call(String operation, Map<String, ?> params, Object body, String idempotencyKey) {
    Operations.Operation op = Operations.ALL.get(operation);
    if (op == null || (tag != null && !tag.equals(op.tag())))
      throw new IllegalArgumentException("No operation " + operation + " here; see operations()");
    Map<String, Object> rest = new HashMap<>(params == null ? Map.of() : params);
    String path = op.path();
    for (String name : op.pathParams()) {
      Object value = rest.remove(name);
      if (value == null) throw new IllegalArgumentException(op.id() + " needs " + name);
      path = path.replace("{" + name + "}", URLEncoder.encode(String.valueOf(value), StandardCharsets.UTF_8).replace("+", "%20"));
    }
    StringBuilder query = new StringBuilder();
    for (String name : op.query()) {
      Object value = rest.remove(name);
      if (value == null) continue;
      query.append(query.length() == 0 ? '?' : '&')
          .append(URLEncoder.encode(name, StandardCharsets.UTF_8))
          .append('=')
          .append(URLEncoder.encode(String.valueOf(value), StandardCharsets.UTF_8));
    }
    if (!rest.isEmpty())
      throw new IllegalArgumentException(op.id() + " takes no " + String.join(", ", new java.util.TreeSet<>(rest.keySet())));
    if (op.body() && body == null) throw new IllegalArgumentException(op.id() + " needs a body");
    if (!op.body() && body != null) throw new IllegalArgumentException(op.id() + " takes no body");
    HttpRequest.Builder request =
        HttpRequest.newBuilder(URI.create(baseUrl + path + query))
            .timeout(timeout)
            .header("Authorization", "Bearer " + token.get())
            .header("Accept", "application/json");
    if (op.idempotencyKey())
      request.header("Idempotency-Key", idempotencyKey != null ? idempotencyKey : UUID.randomUUID().toString());
    if (body != null) {
      request.header("Content-Type", "application/json");
      request.method(op.method(), HttpRequest.BodyPublishers.ofString(Json.write(body)));
    } else {
      request.method(op.method(), HttpRequest.BodyPublishers.noBody());
    }
    HttpResponse<String> response;
    try {
      response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    } catch (java.io.IOException e) {
      throw new MarinaException("Could not reach " + baseUrl + ": " + e.getMessage(), e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new MarinaException("Interrupted", e);
    }
    String text = response.body();
    Object parsed = null;
    if (text != null && !text.isBlank()) {
      try {
        parsed = Json.parse(text);
      } catch (IllegalArgumentException notJson) {
        parsed = text;
      }
    }
    if (response.statusCode() >= 300) throw error(response.statusCode(), parsed, response.headers().firstValue("Retry-After").orElse(null));
    return parsed;
  }

  static ApiException error(int status, Object body, String retryAfter) {
    Long retryMs = null;
    if (retryAfter != null) {
      try {
        retryMs = (long) (Double.parseDouble(retryAfter) * 1000);
      } catch (NumberFormatException notSeconds) {
        // an HTTP date: leave it to the caller
      }
    }
    Map<String, Object> map = Json.object(body);
    if (map != null) {
      Object err = map.get("error");
      Map<String, Object> memory = Json.object(err);
      if (memory != null) { // memory: {"error": {"code", "message", "retry_after_ms"?}}
        Object after = memory.get("retry_after_ms");
        return new ApiException(
            status,
            String.valueOf(memory.getOrDefault("code", "error")),
            String.valueOf(memory.getOrDefault("message", "")),
            after instanceof Number n ? n.longValue() : retryMs);
      }
      if (err instanceof String s) { // routing, investigations, panels: {"error", "code"?}
        Object code = map.get("code");
        return new ApiException(status, code != null ? String.valueOf(code) : "http_" + status, s, retryMs);
      }
    }
    return new ApiException(status, "http_" + status, body == null ? "" : String.valueOf(body), retryMs);
  }

  /** Groups an {@link HttpApi} may be limited to. */
  public static final Set<String> TAGS = Set.of("memory", "routing", "investigations", "panels");
}
