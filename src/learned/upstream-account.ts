// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The account and trust label every imported record carries. They live apart
 * from `import.ts` so the lesson recall path (`src/learning/service.ts` →
 * `serve.ts`) reads them without loading the importer.
 */

/** The server account that owns every `upstream:*` space (login cannot produce the name). */
export const UPSTREAM_ACCOUNT = "marina:upstream";
/** The trust value of every imported record: below local `trusted`, never promoted by import. */
export const IMPORTED_TRUST = "imported";
/** The space prefix imported lessons live under: `upstream:lessons:<domain>`. */
export const UPSTREAM_LESSONS_PREFIX = "upstream:lessons:";
