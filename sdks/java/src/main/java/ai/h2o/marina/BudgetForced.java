// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

/** Present on a Run result when a budget forced the answer; never a free answer. */
public record BudgetForced(String reason, Double used, Double cap) {}
