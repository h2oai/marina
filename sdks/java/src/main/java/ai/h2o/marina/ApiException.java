// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

/** An HTTP API refused or failed a request. Branch on {@link #code()}; the message is for people. */
public class ApiException extends MarinaException {
  private static final long serialVersionUID = 1L;

  private final int status;
  private final String code;
  private final String detail;
  private final Long retryAfterMs;

  public ApiException(int status, String code, String detail, Long retryAfterMs) {
    super(status + " " + code + ": " + detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }

  public int status() {
    return status;
  }

  /** Stable and machine-readable. */
  public String code() {
    return code;
  }

  /** For people; wording may change. */
  public String detail() {
    return detail;
  }

  /** On 429 (and some memory failures): wait this long before retrying, or null. */
  public Long retryAfterMs() {
    return retryAfterMs;
  }
}
