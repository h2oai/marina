// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Theme switcher for the unified canvas view.
 *
 * Provides a Zustand store tracking the current theme ID,
 * a cycleTheme() function to rotate through all 5 themes,
 * and a ThemeSwitcher React component (button) for the topbar.
 */

import { create } from "zustand";
import { applyTheme, DEFAULT_THEME, THEME_IDS, themes } from "../../lib/themes";

// ── Zustand store ─────────────────────────────────────────────────────────────

/** Theme store state. */
interface ThemeState {
  /** Currently active theme ID. */
  themeId: string;
  /** Set the theme to a specific ID. */
  setTheme: (id: string) => void;
}

/**
 * Zustand store tracking the current theme.
 * Persists selection in localStorage under "marina-theme".
 */
export const useTheme = create<ThemeState>((set) => ({
  themeId: localStorage.getItem("marina-theme") ?? DEFAULT_THEME,
  setTheme: (id: string) => {
    set({ themeId: id });
    localStorage.setItem("marina-theme", id);
    applyTheme(id);
  },
}));

// ── Cycle helper ──────────────────────────────────────────────────────────────

/**
 * Cycle to the next theme in the theme list.
 * Wraps around after the last theme.
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
