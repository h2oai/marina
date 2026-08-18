// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { authFetch } from "../lib/api";
import type { BoardEntry, ChannelEntry, GroupEntry, TaskEntry } from "../lib/types";

const API_BASE = window.location.origin;

export function useTasksSnapshot(enabled: boolean) {
  return useQuery({
    queryKey: ["status-cards", "tasks"],
    enabled,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/api/coordination/tasks?paged=1&limit=100`);
      if (!res.ok) throw new Error(`Failed to load tasks: ${res.status}`);
      const data = (await res.json()) as { items: TaskEntry[]; total: number };
      return data;
    },
    staleTime: 15_000,
  });
}

export function useBoardsSnapshot(enabled: boolean) {
  return useQuery({
    queryKey: ["status-cards", "boards"],
    enabled,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/api/coordination/boards`);
      if (!res.ok) throw new Error(`Failed to load boards: ${res.status}`);
      const data = (await res.json()) as BoardEntry[];
      return data;
    },
    staleTime: 30_000,
  });
}

export function useChannelsSnapshot(enabled: boolean) {
  return useQuery({
    queryKey: ["status-cards", "channels"],
    enabled,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/api/coordination/channels`);
      if (!res.ok) throw new Error(`Failed to load channels: ${res.status}`);
      const data = (await res.json()) as ChannelEntry[];
      return data;
    },
    staleTime: 30_000,
  });
}

export function useGroupsSnapshot(enabled: boolean) {
  return useQuery({
    queryKey: ["status-cards", "groups"],
    enabled,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/api/coordination/groups`);
      if (!res.ok) throw new Error(`Failed to load groups: ${res.status}`);
      const data = (await res.json()) as GroupEntry[];
      return data;
    },
    staleTime: 30_000,
  });
}
