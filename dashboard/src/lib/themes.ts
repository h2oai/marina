// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Theme definitions for the Marina dashboard.
// Each theme provides CSS custom property overrides applied via data-theme attribute.

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  /**
   * Which `color-scheme` the palette is built for. Drives native form controls
   * and scrollbars, and lets CSS branch on `[data-theme-scheme="light"]`.
   */
  scheme: "dark" | "light";
  colors: {
    bg: string;
    "bg-card": string;
    "bg-hover": string;
    border: string;
    "border-glow": string;
    primary: string;
    secondary: string;
    accent: string;
    text: string;
    "text-dim": string;
    "text-bright": string;
    success: string;
    warning: string;
    danger: string;
    coral: string;
    teal: string;
    pink: string;
  };
  /** Glass panel gradient (two rgba stops) */
  glass: [string, string];
  /** Glow color for focused panels (rgba) */
  glowRgba: string;
  /** Gradient text stops */
  gradientStops: string;
  /** District palette for world map */
  districtPalette: string[];
}

export const themes: Record<string, ThemeDefinition> = {
  h2o: {
    id: "h2o",
    scheme: "dark",
    name: "H2O",
    description: "H2O.ai brand — black & gold",
    colors: {
      bg: "#0a0a0a",
      "bg-card": "#111111",
      "bg-hover": "#1a1a1a",
      border: "#262626",
      "border-glow": "#FFDD0040",
      primary: "#FFDD00",
      secondary: "#FFB800",
      accent: "#FF9500",
      text: "#d4d4d4",
      "text-dim": "#666666",
      "text-bright": "#f0f0f0",
      success: "#22c55e",
      warning: "#FFDD00",
      danger: "#ef4444",
      coral: "#f97316",
      teal: "#eab308",
      pink: "#fbbf24",
    },
    glass: ["rgba(17, 17, 17, 0.92)", "rgba(10, 10, 10, 0.96)"],
    glowRgba: "rgba(255, 221, 0, 0.15)",
    gradientStops: "#FFDD00, #FFB800, #FF9500",
    districtPalette: [
      "#FFDD00", // gold
      "#FF9500", // amber
      "#22c55e", // green
      "#ef4444", // red
      "#3b82f6", // blue
      "#a855f7", // purple
      "#f97316", // orange
      "#06b6d4", // cyan
    ],
  },

  cyberpunk: {
    id: "cyberpunk",
    scheme: "dark",
    name: "Cyberpunk",
    description: "Neon cyan & magenta",
    colors: {
      bg: "#080c14",
      "bg-card": "#0d1420",
      "bg-hover": "#121a2a",
      border: "#1a2538",
      "border-glow": "#00ffe740",
      primary: "#00ffe7",
      secondary: "#0088ff",
      accent: "#bf00ff",
      text: "#c8d6e5",
      "text-dim": "#5a6a7a",
      "text-bright": "#e8f0f8",
      success: "#00ff88",
      warning: "#ffcc00",
      danger: "#ff4444",
      coral: "#ff6b6b",
      teal: "#4ecdc4",
      pink: "#ff00cc",
    },
    glass: ["rgba(13, 20, 32, 0.9)", "rgba(8, 12, 20, 0.95)"],
    glowRgba: "rgba(0, 255, 231, 0.15)",
    gradientStops: "#00ffe7, #00a8ff, #bf00ff",
    districtPalette: [
      "#00ffe7", // cyan
      "#ff6bff", // magenta
      "#ffcc00", // gold
      "#66ff66", // green
      "#ff6644", // coral
      "#6699ff", // blue
      "#ff9944", // orange
      "#cc66ff", // purple
    ],
  },

  synthwave: {
    id: "synthwave",
    scheme: "dark",
    name: "Synthwave",
    description: "Retro purple & hot pink",
    colors: {
      bg: "#0f0a1a",
      "bg-card": "#150e24",
      "bg-hover": "#1c1330",
      border: "#2d1f4e",
      "border-glow": "#e040fb40",
      primary: "#e040fb",
      secondary: "#7c4dff",
      accent: "#ff4081",
      text: "#d0c0e8",
      "text-dim": "#6a5a8a",
      "text-bright": "#f0e8ff",
      success: "#69f0ae",
      warning: "#ffd740",
      danger: "#ff5252",
      coral: "#ff6e40",
      teal: "#64ffda",
      pink: "#ff80ab",
    },
    glass: ["rgba(21, 14, 36, 0.92)", "rgba(15, 10, 26, 0.96)"],
    glowRgba: "rgba(224, 64, 251, 0.15)",
    gradientStops: "#e040fb, #7c4dff, #ff4081",
    districtPalette: [
      "#e040fb", // magenta
      "#7c4dff", // deep purple
      "#ff4081", // pink
      "#69f0ae", // green
      "#ffd740", // amber
      "#40c4ff", // light blue
      "#ff6e40", // deep orange
      "#b388ff", // lavender
    ],
  },

  matrix: {
    id: "matrix",
    scheme: "dark",
    name: "Matrix",
    description: "Green phosphor terminal",
    colors: {
      bg: "#050a05",
      "bg-card": "#0a120a",
      "bg-hover": "#0f1a0f",
      border: "#1a2e1a",
      "border-glow": "#00ff4140",
      primary: "#00ff41",
      secondary: "#00cc33",
      accent: "#33ff77",
      text: "#88cc88",
      "text-dim": "#446644",
      "text-bright": "#ccffcc",
      success: "#00ff41",
      warning: "#99ff00",
      danger: "#ff3333",
      coral: "#66ff44",
      teal: "#00cc88",
      pink: "#00ffaa",
    },
    glass: ["rgba(10, 18, 10, 0.92)", "rgba(5, 10, 5, 0.96)"],
    glowRgba: "rgba(0, 255, 65, 0.15)",
    gradientStops: "#00ff41, #00cc33, #33ff77",
    districtPalette: [
      "#00ff41", // bright green
      "#00cc33", // green
      "#33ff77", // light green
      "#99ff00", // lime
      "#00ffaa", // mint
      "#66ff44", // yellow-green
      "#00cc88", // teal-green
      "#44ff99", // spring green
    ],
  },

  ocean: {
    id: "ocean",
    scheme: "dark",
    name: "Ocean",
    description: "Deep sea blues & coral",
    colors: {
      bg: "#060d14",
      "bg-card": "#0a1520",
      "bg-hover": "#0f1e2e",
      border: "#163050",
      "border-glow": "#0ea5e940",
      primary: "#0ea5e9",
      secondary: "#2563eb",
      accent: "#f97316",
      text: "#94a3b8",
      "text-dim": "#475569",
      "text-bright": "#e2e8f0",
      success: "#10b981",
      warning: "#f59e0b",
      danger: "#ef4444",
      coral: "#fb7185",
      teal: "#14b8a6",
      pink: "#ec4899",
    },
    glass: ["rgba(10, 21, 32, 0.92)", "rgba(6, 13, 20, 0.96)"],
    glowRgba: "rgba(14, 165, 233, 0.15)",
    gradientStops: "#0ea5e9, #2563eb, #f97316",
    districtPalette: [
      "#0ea5e9", // sky blue
      "#f97316", // orange
      "#10b981", // emerald
      "#ec4899", // pink
      "#f59e0b", // amber
      "#8b5cf6", // violet
      "#14b8a6", // teal
      "#ef4444", // red
    ],
  },

  light: {
    id: "light",
    name: "Light",
    description: "Paper ground, ink text",
    scheme: "light",
    // A designed light palette, not an inversion: near-white ground with a
    // slight cool bias, ink text, and every accent hue re-tuned so that text
    // in that colour clears WCAG AA (>= 4.5:1) on bg, bg-card AND bg-hover.
    // Ratios are asserted in src/__tests__/theme-resolution.test.tsx.
    colors: {
      bg: "#f4f6fa",
      "bg-card": "#ffffff",
      "bg-hover": "#e6eaf2",
      border: "#d2d8e3",
      "border-glow": "#7d600040",
      primary: "#7d6000", // ochre — the gold, grounded
      secondary: "#9a4f00", // burnt amber
      accent: "#ad4209", // rust
      text: "#1f2430",
      "text-dim": "#5a6376",
      "text-bright": "#0b0f19",
      success: "#177536",
      warning: "#7d6000",
      danger: "#c62828",
      coral: "#b63a0a",
      teal: "#0f766e",
      pink: "#be185d",
    },
    glass: ["rgba(255, 255, 255, 0.92)", "rgba(244, 246, 250, 0.96)"],
    glowRgba: "rgba(125, 96, 0, 0.18)",
    gradientStops: "#7d6000, #9a4f00, #ad4209",
    districtPalette: [
      "#7d6000", // ochre
      "#ad4209", // rust
      "#177536", // green
      "#c62828", // red
      "#1d4ed8", // blue
      "#6d28d9", // purple
      "#b63a0a", // coral
      "#0e7490", // cyan
    ],
  },
};

export const DEFAULT_THEME = "h2o";
/** Theme picked for a dark OS preference when the user has never chosen one. */
export const DEFAULT_DARK_THEME = DEFAULT_THEME;
/** Theme picked for a light OS preference when the user has never chosen one. */
export const DEFAULT_LIGHT_THEME = "light";
/** Sentinel stored choice meaning "follow the OS `prefers-color-scheme`". */
export const SYSTEM_THEME = "system";
export const THEME_IDS = Object.keys(themes);

/** True when `id` names a real theme (not the `system` sentinel). */
export function isThemeId(id: string | null | undefined): id is string {
  return typeof id === "string" && id in themes;
}

/**
 * Read the OS colour-scheme preference. Safe everywhere: returns `false`
 * (dark-first, the historical default) when `matchMedia` is unavailable.
 */
export function prefersLightScheme(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-color-scheme: light)")?.matches
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the theme to render from the stored choice and the OS preference.
 *
 * - a stored, valid theme id wins (explicit choice);
 * - `null` (never chosen) or `"system"` follows the OS: light OS → `light`,
 *   dark OS (or unknown) → the historical dark default;
 * - an unknown stored value is treated as "never chosen".
 */
export function resolveThemeId(stored: string | null | undefined, prefersLight: boolean): string {
  if (isThemeId(stored)) return stored;
  return prefersLight ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME;
}

/** Apply a theme's CSS variables to the document.
 *  Injects/updates a <style> element so theme overrides are unlayered
 *  and beat Tailwind v4's @layer theme declarations in the cascade. */
export function applyTheme(themeId: string): void {
  const theme = themes[themeId] ?? themes[DEFAULT_THEME]!;
  const root = document.documentElement;

  root.setAttribute("data-theme", theme.id);
  root.setAttribute("data-theme-scheme", theme.scheme);
  root.style.colorScheme = theme.scheme;

  const colorVars = Object.entries(theme.colors)
    .map(([key, value]) => `--color-${key}:${value}`)
    .join(";");

  const css = `:root{${colorVars};--glass-stop-1:${theme.glass[0]};--glass-stop-2:${theme.glass[1]};--glow-rgba:${theme.glowRgba};--gradient-stops:${theme.gradientStops};color-scheme:${theme.scheme}}`;

  let el = document.getElementById("marina-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "marina-theme";
    document.head.appendChild(el);
  }
  el.textContent = css;
}
