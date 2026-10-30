// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's one statistics module: Wilson intervals, McNemar's exact test, the
 * seeded PRNGs and every bootstrap the core and the harnesses use. Pure and
 * deterministic for a given seed.
 */

export * from "./bootstrap";
export * from "./descriptive";
export * from "./hash";
export * from "./paired";
export * from "./replicates";
