import { useQuery } from "@tanstack/react-query";
import { authFetch } from "../lib/api";
import type { CodingSessionDetail, CodingSessionEntry } from "../lib/types";

const API_BASE = window.location.origin;

export function useCodingSessionsSnapshot(enabled: boolean) {
  return useQuery({
    queryKey: ["coding", "sessions"],
    enabled,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/api/coding/sessions?limit=100`);
      if (!res.ok) throw new Error(`Failed to load coding sessions: ${res.status}`);
      const data = (await res.json()) as { items: CodingSessionEntry[]; total: number };
      return data;
    },
    staleTime: 15_000,
  });
}

export function useCodingSessionDetail(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["coding", "session", id],
    enabled: enabled && !!id,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/api/coding/session/${id}`);
      if (!res.ok) throw new Error(`Failed to load coding session: ${res.status}`);
      const data = (await res.json()) as CodingSessionDetail;
      return data;
    },
    staleTime: 15_000,
  });
}
