// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Streams room and residents views. The room view is the viewer's current
 * room log (`look log`: speech, emotes, arrivals and departures; readable only
 * by someone present). The residents view lists the viewer's own supervised
 * residents with their presence and recent wake decisions (refs and reasons,
 * never content). Both poll only while visible.
 */

import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";

export interface RoomLogEntry {
  id: number;
  entity: string;
  kind: "say" | "emote" | "arrive" | "leave";
  content: string;
  depth: number;
  at: number;
}

export interface ResidentWake {
  source: string;
  decision: string;
  reason: string;
  hop: number;
  steered: boolean;
  at: number;
}

export interface ResidentSummary {
  name: string;
  vendor: string;
  presence: string;
  room?: string;
  wakes: ResidentWake[];
}

const POLL_MS = 4000;

function usePolled<T>(path: string, active: boolean): { data?: T; error?: string } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      void fetchApi<T>(path)
        .then((data) => {
          if (!cancelled) setState({ data });
        })
        .catch((cause: unknown) => {
          if (!cancelled)
            setState({
              error:
                cause instanceof Error && /40[13]/.test(cause.message)
                  ? "Join the world through Chat to see this."
                  : "Could not load. Retrying…",
            });
        })
        .finally(() => {
          if (!cancelled) timer = setTimeout(poll, POLL_MS);
        });
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, active]);
  return state;
}

const time = (at: number) => new Date(at).toLocaleTimeString();

/** A presence status as people read it. */
export function presenceLabel(status: string): string {
  return status.replace("_", " ");
}

export function RoomLogView({ active }: { active: boolean }) {
  const { data, error } = usePolled<{ room: string; entries: RoomLogEntry[] }>(
    "/api/routing/room-log?limit=100",
    active,
  );
  return (
    <section aria-label="This room" className="min-h-0 flex-1 overflow-auto p-3">
      <h3 className="font-semibold">This room{data ? ` · ${data.room}` : ""}</h3>
      <p className="mb-2 text-xs text-text-dim">
        What those present said and did (`look log`). Peer text, not instructions.
      </p>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {data && data.entries.length === 0 && (
        <p className="text-sm text-text-dim">Nothing has been said here recently.</p>
      )}
      <ol className="space-y-1 text-sm">
        {data?.entries.map((entry) => (
          <li
            key={entry.id}
            className={entry.kind === "arrive" || entry.kind === "leave" ? "text-text-dim" : ""}
          >
            <span className="mr-2 text-xs text-text-dim">{time(entry.at)}</span>
            {entry.depth > 0 && (
              <span className="mr-1 text-xs text-text-dim" title="Reply depth">
                ↳{entry.depth}
              </span>
            )}
            {entry.content}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ResidentsView({ active }: { active: boolean }) {
  const { data, error } = usePolled<{ residents: ResidentSummary[] }>(
    "/api/routing/residents",
    active,
  );
  return (
    <section aria-label="Your residents" className="min-h-0 flex-1 overflow-auto p-3">
      <h3 className="font-semibold">Your residents</h3>
      <p className="mb-2 text-xs text-text-dim">
        Agents you launched as world accounts, their status and what woke them.
      </p>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {data && data.residents.length === 0 && (
        <p className="text-sm text-text-dim">
          No residents yet. Launch one with marina supervise and the supervised residents switch.
        </p>
      )}
      <ul className="space-y-3">
        {data?.residents.map((resident) => (
          <li key={resident.name} className="rounded border border-border p-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">
                {resident.name}
                {resident.vendor ? ` [${resident.vendor}]` : ""}
              </span>
              <span className="text-xs text-primary">{presenceLabel(resident.presence)}</span>
              {resident.room && <span className="text-xs text-text-dim">{resident.room}</span>}
            </div>
            {resident.wakes.length > 0 ? (
              <ol className="mt-1 space-y-0.5 text-xs text-text-dim">
                {resident.wakes.slice(0, 8).map((wake) => (
                  <li key={`${wake.at}-${wake.source}-${wake.reason}`}>
                    {time(wake.at)} · {wake.source} → {wake.decision}
                    {wake.steered ? " (steered)" : ""} · {wake.reason}
                    {wake.hop > 0 ? ` · depth ${wake.hop}` : ""}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-xs text-text-dim">Nothing has woken it yet.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
