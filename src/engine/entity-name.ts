// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical entity-name sanitization applied at login (`Engine.spawnEntity` and
 * `Engine.login`): alphanumeric + underscores only, truncated to 20 chars.
 *
 * Any code that compares a stored agent-config name (which may contain dashes,
 * e.g. "code-coder-code_5") against a live entity's name must normalize both
 * sides through this helper — the entity was created from the sanitized form
 * ("codecodercode_5"), so a raw string comparison silently fails.
 */
export function sanitizeEntityName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20);
}
