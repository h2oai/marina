// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Check, Monitor, Palette } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTheme } from "../hooks/use-theme";
import { SYSTEM_THEME, themes } from "../lib/themes";

const THEME_LIST = Object.values(themes);

export function ThemeSwitcher() {
  const { themeId, choice, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const currentName = themes[themeId]?.name ?? themeId;
  const followingSystem = choice === SYSTEM_THEME;

  const pick = (id: string) => {
    setTheme(id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-text-dim transition-colors hover:text-primary"
        title="Switch theme"
        aria-label={`Switch theme (current: ${currentName}${followingSystem ? ", following system" : ""})`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <Palette size={11} aria-hidden="true" />
        <span className="hidden sm:inline">{currentName}</span>
      </button>

      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label="Theme"
          className="glass-panel absolute right-0 top-full z-50 mt-1 min-w-[180px] border border-border p-1 shadow-lg"
        >
          <button
            type="button"
            role="option"
            aria-selected={followingSystem}
            onClick={() => pick(SYSTEM_THEME)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors ${
              followingSystem
                ? "bg-bg-hover text-primary"
                : "text-text hover:bg-bg-hover hover:text-text-bright"
            }`}
          >
            <Monitor size={10} aria-hidden="true" />
            <span className="flex-1">System</span>
            <span className="text-text-dim text-[9px]">Follow OS light/dark</span>
            {followingSystem && <Check size={10} aria-hidden="true" />}
          </button>
          <div className="my-1 border-t border-border" role="presentation" />
          {THEME_LIST.map((t) => {
            const selected = !followingSystem && t.id === themeId;
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => pick(t.id)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors ${
                  selected
                    ? "bg-bg-hover text-primary"
                    : "text-text hover:bg-bg-hover hover:text-text-bright"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-full border border-border"
                  style={{ backgroundColor: t.colors.primary }}
                />
                <span className="flex-1">{t.name}</span>
                <span className="text-text-dim text-[9px]">{t.description}</span>
                {selected && <Check size={10} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
