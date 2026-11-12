// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.Map;

/**
 * One coding event, as the server sent it ({@code data.code} of a {@code code} frame).
 *
 * @param event {@code agent_output}, {@code code_lifecycle}, {@code verification_finished}, ...
 * @param type payload shape: {@code stream}, {@code lifecycle}, {@code diff}, ...
 * @param text for people (may carry ANSI colour codes)
 * @param sessionId the coding session, or null
 * @param runId the run, or null
 * @param phase the lifecycle phase, or null
 * @param kind on {@code agent_output}: {@code tool}, {@code prose}, {@code tool_error}, {@code
 *     error}; or null
 * @param activity on a step: what the coder did; or null
 * @param result on the end of a run; or null
 * @param raw the whole frame
 */
public record CodeEvent(
    String event,
    String type,
    String text,
    String sessionId,
    String runId,
    String phase,
    String kind,
    CodingActivity activity,
    RunResult result,
    Map<String, Object> raw) {}
