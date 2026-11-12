// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

/** The server refused a login or a session token. */
public class LoginRefusedException extends MarinaException {
  private static final long serialVersionUID = 1L;

  public LoginRefusedException(String message) {
    super(message);
  }
}
