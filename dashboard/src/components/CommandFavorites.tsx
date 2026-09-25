// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { BookmarkPlus, Pin, Play, X } from "lucide-react";
import { useMacros } from "../hooks/use-api";
import { useCommandFavorites } from "../hooks/use-command-favorites";
import { draftCommand } from "../lib/command-discovery";

/** A macro name suggested for a pinned command: its first two words, slugged. */
export function suggestMacroName(command: string): string {
  const words = command.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 2).join("-") || "my-macro";
}

export function FavoriteCommandButton({ command }: { command: string }) {
  const { favorites, toggle } = useCommandFavorites();
  const pinned = favorites.some((favorite) => favorite.command === command.trim());
  return (
    <button
      type="button"
      disabled={!command.trim()}
      aria-pressed={pinned}
      onClick={() => toggle(command)}
      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-primary disabled:opacity-40"
    >
      <Pin size={12} />
      {pinned ? "Unpin command" : "Pin command"}
    </button>
  );
}
/**
 * Pinned commands (this browser) and macros (server-side, per entity — the same
 * ones agents use, and they follow you across devices). Both only DRAFT into
 * the input: a macro can run several steps, so Enter stays the user's call.
 */
export function CommandFavorites() {
  const { favorites, toggle } = useCommandFavorites();
  const macros = useMacros().data ?? [];
  if (!favorites.length && !macros.length) return null;
  return (
    <nav
      aria-label="Favorite commands"
      className="flex shrink-0 flex-wrap gap-1 border-t border-border p-2"
    >
      {macros.map((macro) => (
        <button
          key={`macro-${macro.id}`}
          type="button"
          title={`Macro${macro.author_id === "system" ? " (shared)" : ""}: ${macro.command}`}
          onClick={() => draftCommand(macro.name)}
          className="flex max-w-full items-center gap-1 rounded border border-primary/40 bg-primary/5 px-2 py-1 text-xs text-primary"
        >
          <Play size={10} aria-hidden="true" />
          <span className="min-w-0 truncate">{macro.name}</span>
        </button>
      ))}
      {favorites.map((favorite) => (
        <div
          key={favorite.id}
          className="flex max-w-full items-center rounded border border-border bg-bg"
        >
          <button
            type="button"
            title={`Draft ${favorite.command}`}
            onClick={() => draftCommand(favorite.command)}
            className="min-w-0 truncate px-2 py-1 text-xs text-primary"
          >
            {favorite.command}
          </button>
          <button
            type="button"
            aria-label={`Save ${favorite.command} as a macro`}
            title="Save as a macro (named, kept on the server, follows you across devices)"
            onClick={() =>
              draftCommand(`macro create ${suggestMacroName(favorite.command)} ${favorite.command}`)
            }
            className="px-1 text-text-dim hover:text-primary"
          >
            <BookmarkPlus size={12} />
          </button>
          <button
            type="button"
            aria-label={`Unpin ${favorite.command}`}
            onClick={() => toggle(favorite.command)}
            className="px-1 text-text-dim"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </nav>
  );
}
