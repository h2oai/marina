// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { initTheme, THEME_STORAGE_KEY, useTheme } from "../hooks/use-theme";
import {
  applyTheme,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  resolveThemeId,
  SYSTEM_THEME,
  THEME_IDS,
  themes,
} from "../lib/themes";

// ── WCAG contrast helpers (relative luminance, sRGB) ──────────────────────
function luminance(hex: string): number {
  const c = hex.replace("#", "").slice(0, 6);
  const [r, g, b] = [0, 2, 4]
    .map((i) => Number.parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Install a matchMedia stub whose `(prefers-color-scheme: light)` answer is `light`. */
function stubPrefersLight(light: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  // test-setup defines a writable (non-configurable) stub — assign over it.
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) =>
    ({
      matches: query.includes("light") ? light : !light,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) =>
        listeners.delete(cb),
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  return {
    fire(matches: boolean) {
      for (const cb of listeners) cb({ matches });
    },
  };
}

describe("theme resolution", () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
  });
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    useTheme.setState({ choice: SYSTEM_THEME, themeId: DEFAULT_DARK_THEME });
    stubPrefersLight(false);
  });

  it("registers a designed light theme alongside the dark ones", () => {
    expect(THEME_IDS).toContain("light");
    expect(themes.light?.scheme).toBe("light");
    for (const id of THEME_IDS.filter((t) => t !== "light")) {
      expect(themes[id]?.scheme).toBe("dark");
    }
  });

  it("follows the OS preference when the user never chose a theme", () => {
    expect(resolveThemeId(null, true)).toBe(DEFAULT_LIGHT_THEME);
    expect(resolveThemeId(null, false)).toBe(DEFAULT_DARK_THEME);
    expect(resolveThemeId(undefined, true)).toBe(DEFAULT_LIGHT_THEME);
    // The `system` sentinel is not a theme id and resolves like "never chosen".
    expect(resolveThemeId(SYSTEM_THEME, true)).toBe(DEFAULT_LIGHT_THEME);
    expect(resolveThemeId(SYSTEM_THEME, false)).toBe(DEFAULT_DARK_THEME);
  });

  it("honours an explicit stored choice over the OS preference", () => {
    expect(resolveThemeId("ocean", true)).toBe("ocean");
    expect(resolveThemeId("light", false)).toBe("light");
    // Unknown stored values are treated as "never chosen".
    expect(resolveThemeId("not-a-theme", true)).toBe(DEFAULT_LIGHT_THEME);
  });

  it("persists an explicit choice and applies it to the document", () => {
    stubPrefersLight(true);
    useTheme.getState().setTheme("matrix");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("matrix");
    expect(useTheme.getState().themeId).toBe("matrix");
    expect(document.documentElement.getAttribute("data-theme")).toBe("matrix");
    expect(document.documentElement.getAttribute("data-theme-scheme")).toBe("dark");

    useTheme.getState().setTheme(SYSTEM_THEME);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(SYSTEM_THEME);
    expect(useTheme.getState().themeId).toBe(DEFAULT_LIGHT_THEME);
    expect(document.documentElement.getAttribute("data-theme-scheme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("re-resolves live when the OS preference flips in system mode", () => {
    const media = stubPrefersLight(false);
    useTheme.setState({ choice: SYSTEM_THEME, themeId: DEFAULT_DARK_THEME });
    initTheme();
    media.fire(true);
    expect(useTheme.getState().themeId).toBe(DEFAULT_LIGHT_THEME);
    media.fire(false);
    expect(useTheme.getState().themeId).toBe(DEFAULT_DARK_THEME);

    // An explicit choice is immune to OS flips.
    useTheme.getState().setTheme("ocean");
    media.fire(true);
    expect(useTheme.getState().themeId).toBe("ocean");
  });

  it("applyTheme injects every colour token as a CSS custom property", () => {
    applyTheme("light");
    const css = document.getElementById("marina-theme")?.textContent ?? "";
    for (const [key, value] of Object.entries(themes.light!.colors)) {
      expect(css).toContain(`--color-${key}:${value}`);
    }
    expect(css).toContain("color-scheme:light");
  });

  it("light palette clears WCAG AA (>= 4.5:1) for text and accents on every ground", () => {
    const { colors } = themes.light!;
    const grounds = [colors.bg, colors["bg-card"], colors["bg-hover"]];
    const textish = [
      "text",
      "text-dim",
      "text-bright",
      "primary",
      "secondary",
      "accent",
      "success",
      "warning",
      "danger",
      "coral",
      "teal",
      "pink",
    ] as const;
    for (const key of textish) {
      for (const ground of grounds) {
        expect(
          contrast(colors[key], ground),
          `${key} ${colors[key]} on ${ground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the semantic status colours distinguishable on both grounds", () => {
    for (const id of ["h2o", "light"]) {
      const { colors } = themes[id]!;
      // Distinct hex values, each readable against its own ground.
      expect(new Set([colors.success, colors.danger]).size).toBe(2);
      expect(contrast(colors.success, colors.bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(colors.warning, colors.bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(colors.danger, colors.bg)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    stubPrefersLight(false);
    useTheme.setState({ choice: SYSTEM_THEME, themeId: DEFAULT_DARK_THEME });
  });

  it("offers a System option and persists explicit picks", () => {
    render(<ThemeSwitcher />);
    const trigger = screen.getByRole("button", { name: /switch theme/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Theme" });
    expect(listbox).toBeInTheDocument();
    const system = screen.getByRole("option", { name: /system/i });
    expect(system).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("option", { name: /^light/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(useTheme.getState().themeId).toBe("light");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /switch theme/i }));
    fireEvent.click(screen.getByRole("option", { name: /system/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(SYSTEM_THEME);
    expect(useTheme.getState().themeId).toBe(DEFAULT_DARK_THEME);
  });
});
