// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.List;

/**
 * The coder asks to run a command outside its allowlist.
 *
 * @param rendered the command as one line, for people
 */
public record ExecApprovalRequest(String token, List<String> argv, String cwd, String rendered) {}
