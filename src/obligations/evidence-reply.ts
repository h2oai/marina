// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The world's own reply to `task submit`: "Submitted work for task #N." and,
 * when the evidence audit still finds something, "<n> unmet obligation(s)".
 * Read mechanically — the world stated it, nothing is inferred.
 */
export function evidenceReply(text: string): { taskId: number; unmet: number } | undefined {
  const submitted = /Submitted work for task #(\d+)\./.exec(text);
  if (!submitted) return undefined;
  const unmet = /(\d+) unmet obligation\(s\)/.exec(text);
  return { taskId: Number(submitted[1]), unmet: unmet ? Number(unmet[1]) : 0 };
}
