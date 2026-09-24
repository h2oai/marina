// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";
import { useChatState } from "./use-chat-state";
import { useWorldState } from "./use-world-state";

interface Favorite {
  id: string;
  command: string;
}
const KEY = "marina-command-favorites-v1";
function load(): Record<string, Favorite[]> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, list]) => Array.isArray(list))
        .map(([scope, list]) => [
          scope,
          (list as unknown[])
            .filter(
              (item): item is Favorite =>
                !!item &&
                typeof item === "object" &&
                typeof (item as Favorite).id === "string" &&
                typeof (item as Favorite).command === "string",
            )
            .slice(-30),
        ]),
    );
  } catch {
    return {};
  }
}
const useFavoritesStore = create<{
  scopes: Record<string, Favorite[]>;
  toggle: (scope: string, command: string) => void;
}>((set) => ({
  scopes: load(),
  toggle: (scope, command) =>
    set((state) => {
      const current = state.scopes[scope] ?? [];
      const existing = current.find((favorite) => favorite.command === command);
      const next = existing
        ? current.filter((favorite) => favorite.id !== existing.id)
        : [...current, { id: crypto.randomUUID(), command }].slice(-30);
      const scopes = { ...state.scopes, [scope]: next };
      try {
        localStorage.setItem(KEY, JSON.stringify(scopes));
      } catch {
        /* Continue with session favorites when browser storage is unavailable. */
      }
      return { scopes };
    }),
}));
const EMPTY: Favorite[] = [];
export function useCommandFavorites() {
  const entity = useChatState((s) => s.entityName);
  const instance = useWorldState((s) => s.instanceName);
  const scope = `${instance ?? "Marina"}:${entity ?? "guest"}`;
  const favorites = useFavoritesStore((s) => s.scopes[scope] ?? EMPTY);
  const toggle = useFavoritesStore((s) => s.toggle);
  return { favorites, toggle: (command: string) => toggle(scope, command.trim()) };
}
