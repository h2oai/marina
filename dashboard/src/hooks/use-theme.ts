// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Theme store shared by every dashboard surface (grid dashboard header,
 * unified canvas topbar).
 *
 * `choice` is what the user picked — a theme id, or `system` (the default
 * when nothing was ever chosen) meaning "follow `prefers-color-scheme`".
 * `themeId` is what is actually rendered: the explicit choice, or the OS
 * default (`light` for a light OS, the dark default otherwise). Only explicit
 * choices are persisted; `system` is persisted too so a user can return to it.
 */

import { create } from "zustand";
import {
  applyTheme,
  isThemeId,
  prefersLightScheme,
  resolveThemeId,
  SYSTEM_THEME,
} from "../lib/themes";

export const THEME_STORAGE_KEY = "marina-theme";

/** Read the stored choice: a theme id, `system`, or `null` when never chosen. */
export function loadThemeChoice(): string | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === SYSTEM_THEME || isThemeId(stored)) return stored;
  } catch {
    // localStorage unavailable — fall back to the OS preference
  }
  return null;
}

interface ThemeStore {
  /** The user's stored choice (`system` when following the OS or never chosen). */
  choice: string;
  /** The theme id currently rendered. */
  themeId: string;
  /** Pick a theme id, or `system` to follow the OS preference. */
  setTheme: (id: string) => void;
}

export const useTheme = create<ThemeStore>((set) => {
  const stored = loadThemeChoice();
  return {
    choice: stored ?? SYSTEM_THEME,
    themeId: resolveThemeId(stored, prefersLightScheme()),
    setTheme: (id: string) => {
      if (id !== SYSTEM_THEME && !isThemeId(id)) return;
      try {
        localStorage.setItem(THEME_STORAGE_KEY, id);
      } catch {
        // persisting is best-effort
      }
      const themeId = resolveThemeId(id === SYSTEM_THEME ? null : id, prefersLightScheme());
      applyTheme(themeId);
      set({ choice: id, themeId });
    },
  };
});

let osListenerAttached = false;

/**
 * Call once at app startup: applies the resolved theme and, while the choice
 * is `system`, follows live OS preference changes.
 */
export function initTheme(): void {
  applyTheme(useTheme.getState().themeId);
  if (osListenerAttached) return;
  try {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media?.addEventListener) return;
    osListenerAttached = true;
    media.addEventListener("change", (event) => {
      const { choice } = useTheme.getState();
      if (choice !== SYSTEM_THEME) return;
      const themeId = resolveThemeId(null, event.matches);
      applyTheme(themeId);
      useTheme.setState({ themeId });
    });
  } catch {
    // matchMedia unavailable (tests, very old browsers) — static theme only
  }
}
