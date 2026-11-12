// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.Map;

/**
 * How a coding run ended. Review it with {@code marina.code().review(result.runId(), "approve")}.
 *
 * @param runId the run
 * @param terminal always true
 * @param phase {@code completed} or {@code failed}
 * @param taskId the task, or null
 * @param agent the coder, or null
 * @param outcome one of {@link Wire#RUN_OUTCOMES}; {@code submitted}: handed in for review
 * @param reason {@code blocked}, {@code agent_died}, or free text; or null
 * @param detail more about the reason, or null
 * @param summary the coder's summary for the reviewer, or null
 * @param summaryId the summary's artifact, or null
 * @param verification one of {@link Wire#VERIFICATIONS}; only {@code passed} means checks ran on
 *     the change and passed
 * @param verificationReason why, or null
 * @param budgetForced present when a budget forced the answer
 * @param raw everything the server sent, including fields newer than this SDK
 */
public record RunResult(
    String runId,
    boolean terminal,
    String phase,
    Long taskId,
    String agent,
    String outcome,
    String reason,
    String detail,
    String summary,
    String summaryId,
    String verification,
    String verificationReason,
    BudgetForced budgetForced,
    Map<String, Object> raw) {

  /** The coder finished and handed the change in for review. */
  public boolean submitted() {
    return "submitted".equals(outcome);
  }

  /** Checks ran on the change and passed. */
  public boolean verified() {
    return "passed".equals(verification);
  }
}
