import { Palette } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../hooks/use-theme";
import { themes } from "../lib/themes";

const THEME_LIST = Object.values(themes);

export function ThemeSwitcher() {
  const { themeId, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-text-dim transition-colors hover:text-primary"
        title="Switch theme"
      >
        <Palette size={11} />
        <span className="hidden sm:inline">{themes[themeId]?.name}</span>
      </button>

      {open && (
        <div className="glass-panel absolute right-0 top-full z-50 mt-1 min-w-[160px] border border-border p-1 shadow-lg">
          {THEME_LIST.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTheme(t.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors ${
                t.id === themeId
                  ? "bg-bg-hover text-primary"
                  : "text-text hover:bg-bg-hover hover:text-text-bright"
              }`}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full border border-border"
                style={{ backgroundColor: t.colors.primary }}
              />
              <span className="flex-1">{t.name}</span>
              <span className="text-text-dim text-[9px]">{t.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
