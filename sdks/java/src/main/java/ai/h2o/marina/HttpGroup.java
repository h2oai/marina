// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * One group of {@code marina.http.v1} operations ({@code memory}, {@code routing}, ...). The
 * generated {@link Http} classes extend it with a typed method per operation; {@link #call} stays
 * for anything newer than this SDK.
 */
public class HttpGroup {
  private final HttpApi http;
  private final String baseUrl;
  private final Supplier<String> token;

  protected HttpGroup(String baseUrl, Supplier<String> token, String tag) {
    this.http = new HttpApi(baseUrl, token, tag);
    this.baseUrl = baseUrl.replaceAll("/+$", "");
    this.token = token;
  }

  /** The untyped calls underneath. */
  public HttpApi http() {
    return http;
  }

  /** The server's HTTP base URL. */
  protected String baseUrl() {
    return baseUrl;
  }

  /** The credential this group signs with (the newest session token, or a memory credential). */
  protected String token() {
    return token.get();
  }

  /** The operation ids this group offers. */
  public List<String> operations() {
    return http.operations();
  }

  /** Call an operation by id; see {@link HttpApi#call(String, Map, Object, String)}. */
  public Object call(String operation) {
    return http.call(operation);
  }

  /** Call an operation with path/query parameters and no body. */
  public Object call(String operation, Map<String, ?> params) {
    return http.call(operation, params);
  }

  /** Call an operation with path/query parameters and a JSON body (maps, lists or records). */
  public Object call(String operation, Map<String, ?> params, Object body) {
    return http.call(operation, params, body);
  }

  /** Call an operation; {@code idempotencyKey} replays the first result of a memory write. */
  public Object call(String operation, Map<String, ?> params, Object body, String idempotencyKey) {
    return http.call(operation, params, body, idempotencyKey);
  }
}
