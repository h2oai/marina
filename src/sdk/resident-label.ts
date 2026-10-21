// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Display label for a supervised resident: its own name with the native
 * adapter that runs it, e.g. `Wren [claude]`. Display only: commands, `tell`,
 * `goto` and every API take the plain name. Without a vendor the label is the
 * name unchanged.
 */
export function formatResidentLabel(name: string, vendor?: string | null): string {
  const tag = vendor?.trim();
  return tag ? `${name} [${tag}]` : name;
}
