// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Pin, X } from "lucide-react";
import { useCommandFavorites } from "../hooks/use-command-favorites";
import { draftCommand } from "../lib/command-discovery";

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
export function CommandFavorites() {
  const { favorites, toggle } = useCommandFavorites();
  if (!favorites.length) return null;
  return (
    <nav
      aria-label="Favorite commands"
      className="flex shrink-0 flex-wrap gap-1 border-t border-border p-2"
    >
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
