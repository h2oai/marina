// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

/** The connection closed, or could not be opened. */
public class ConnectionLostException extends MarinaException {
  private static final long serialVersionUID = 1L;

  public ConnectionLostException(String message) {
    super(message);
  }

  public ConnectionLostException(String message, Throwable cause) {
    super(message, cause);
  }
}
