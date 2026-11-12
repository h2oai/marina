// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

/** A coding run did not finish in time; it was stopped. */
public class CodingTimeoutException extends MarinaException {
  private static final long serialVersionUID = 1L;

  public CodingTimeoutException(String message) {
    super(message);
  }
}
