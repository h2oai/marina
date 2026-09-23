// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Theme switcher for the unified canvas view.
 *
 * Thin façade over the shared `useTheme` store (hooks/use-theme.ts) so the
 * unified topbar and the grid dashboard's ThemeSwitcher agree on the stored
 * choice, the OS-preference fallback and the rendered theme.
 */

import { THEME_IDS, themes } from "../../lib/themes";

export { useTheme } from "../../hooks/use-theme";

import { useTheme } from "../../hooks/use-theme";

// ── Cycle helper ──────────────────────────────────────────────────────────────

/**
 * Cycle to the next theme in the theme list (an explicit choice — leaves
 * `system` mode). Wraps around after the last theme.
 */
export function cycleTheme(): void {
  const { themeId, setTheme } = useTheme.getState();
  const idx = THEME_IDS.indexOf(themeId);
  const next = THEME_IDS[(idx + 1) % THEME_IDS.length]!;
  setTheme(next);
}

/**
 * Get the display name for the current theme.
 */
export function currentThemeName(): string {
  const { themeId } = useTheme.getState();
  return themes[themeId]?.name ?? "H2O";
}
