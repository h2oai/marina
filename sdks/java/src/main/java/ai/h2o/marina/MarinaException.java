// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

/** Base of every error the SDK throws. Unchecked: catch it where you can act on it. */
public class MarinaException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public MarinaException(String message) {
    super(message);
  }

  public MarinaException(String message, Throwable cause) {
    super(message, cause);
  }
}
