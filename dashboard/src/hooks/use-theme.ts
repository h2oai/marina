// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { applyTheme, DEFAULT_THEME, THEME_IDS } from "../lib/themes";

const STORAGE_KEY = "marina-theme";

function loadTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && THEME_IDS.includes(stored)) return stored;
  } catch {
    // ignore
  }
  return DEFAULT_THEME;
}

interface ThemeStore {
  themeId: string;
  setTheme: (id: string) => void;
}

export const useTheme = create<ThemeStore>((set) => ({
  themeId: loadTheme(),
  setTheme: (id: string) => {
    if (!THEME_IDS.includes(id)) return;
    localStorage.setItem(STORAGE_KEY, id);
    applyTheme(id);
    set({ themeId: id });
  },
}));

/** Call once at app startup to apply the stored theme */
export function initTheme(): void {
  applyTheme(loadTheme());
}
