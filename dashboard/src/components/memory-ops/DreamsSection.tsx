// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dreams — the memory consolidation pass (`src/memory/dream`) as the operator
 * sees it: the newest dreams in the caller's scope (ids, counts and hashes —
 * never note text), the mode the server runs in, the agents whose utility-
 * curve guard is tripped, and the held-out measurement the posture decision
 * reads. `GET /api/memory/dreams`, refetched every 30 s.
 */

import { useQuery } from "@tanstack/react-query";
import { describeApiError, fetchApi } from "../../lib/api";
import type { MemoryDreamsResponse, MemoryDreamView } from "../../lib/memory-observability-types";
import { formatAge } from "./format";

export const MEMORY_DREAMS_KEY = ["memory-dreams"] as const;
export const DREAMS_PATH = "/api/memory/dreams?limit=30";

export const DREAMS_EMPTY_TEXT =
  "No dreams yet. The hourly pass dreams an agent with 12 new records (or 64 KB of journal) since its last dream, quiet for 30 min, 8 h apart; `memory dream now` runs one at once.";

export const DREAM_STATE_CLASS: Record<MemoryDreamView["state"], string> = {
  observed: "bg-text-dim/15 text-text-dim",
  applied: "bg-success/15 text-success",
  rolled_back: "bg-warning/15 text-warning",
};

export const MODE_CLASS: Record<MemoryDreamsResponse["mode"], string> = {
  off: "bg-text-dim/15 text-text-dim",
  observe: "bg-primary/15 text-primary",
  on: "bg-success/15 text-success",
};

/** "3 merges · 1 link · 2 decays" from the by-kind counts, in op order. */
export function kindsLine(byKind: Record<string, number>): string {
  const order = ["merge", "supersede", "link", "decay", "propose-skill"];
  const label: Record<string, [string, string]> = {
    merge: ["merge", "merges"],
    supersede: ["restatement", "restatements"],
    link: ["link", "links"],
    decay: ["decay", "decays"],
    "propose-skill": ["skill draft", "skill drafts"],
  };
  return order
    .filter((k) => byKind[k])
    .map((k) => `${byKind[k]} ${byKind[k] === 1 ? label[k]![0] : label[k]![1]}`)
    .join(" · ");
}

/** "2/2 → 2/2" (pass over probed, before and after) or "—" when nothing was probed. */
export function probesLine(p: MemoryDreamView["probes"]): string {
  const before = p.before.pass + p.before.fail;
  if (!before) return "—";
  const head = `${p.before.pass}/${before}`;
  return p.after ? `${head} → ${p.after.pass}/${p.after.pass + p.after.fail}` : head;
}

export function entityLabel(view: Pick<MemoryDreamView, "entity" | "pool">): string {
  return view.pool ? `pool ${view.entity.slice("pool:".length)}` : view.entity;
}

function verdictTone(verdict: NonNullable<MemoryDreamsResponse["effect"]>["verdict"]): string {
  if (verdict === "wins") return "text-success";
  if (verdict === "loses") return "text-danger";
  return "text-text-dim";
}

export function DreamsSection() {
  const query = useQuery<MemoryDreamsResponse>({
    queryKey: [...MEMORY_DREAMS_KEY],
    queryFn: () => fetchApi<MemoryDreamsResponse>(DREAMS_PATH),
    refetchInterval: 30_000,
  });
  const data = query.data;
  if (query.isError)
    return <div className="text-danger text-xs">{describeApiError(query.error)}</div>;
  if (!data) return <div className="text-text-dim">Loading dreams…</div>;
  const now = Date.now();
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${MODE_CLASS[data.mode]}`}
          data-testid="dreams-mode"
        >
          {data.mode}
        </span>
        <span className="text-text-dim">
          {data.mode === "off"
            ? "dreaming is off (MARINA_DREAMING=off)"
            : data.mode === "observe"
              ? "every dream is recorded and rolled back; nothing stays applied"
              : "merges, links and decays stay applied; restatements and skill drafts wait for adoption"}
        </span>
        {data.effect && (
          <span
            className="ml-auto"
            data-testid="dreams-effect"
            title="Task success in the 10 outcomes after a dream against the 10 before, holdout half, Agresti–Caffo interval against the fishing margin"
          >
            holdout:{" "}
            <span className={`font-semibold ${verdictTone(data.effect.verdict)}`}>
              {data.effect.verdict}
            </span>
            <span className="text-text-dim">
              {" "}
              · {data.effect.measured}/{data.effect.applied} measurable · Δ [
              {data.effect.holdout.interval[0].toFixed(2)},{" "}
              {data.effect.holdout.interval[1].toFixed(2)}]
            </span>
          </span>
        )}
      </div>
      {data.guarded.length > 0 && (
        <div
          className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning"
          data-testid="dreams-guarded"
        >
          Dreaming paused by the utility-curve guard for {data.guarded.join(", ")} — an operator
          clears it with <code>memory dream guard clear &lt;entity&gt;</code>.
        </div>
      )}
      {data.dreams.length === 0 ? (
        <div className="text-text-dim">{DREAMS_EMPTY_TEXT}</div>
      ) : (
        <ul className="divide-y divide-border">
          {data.dreams.map((dream) => (
            <li
              key={dream.id}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1"
              data-testid={`dream-${dream.id}`}
            >
              <span className="font-mono text-text-dim">#{dream.id}</span>
              <span className="font-semibold">{entityLabel(dream)}</span>
              <span
                className={`rounded px-1 py-0.5 font-mono text-[10px] ${DREAM_STATE_CLASS[dream.state]}`}
                data-testid={`dream-state-${dream.id}`}
              >
                {dream.state === "rolled_back" ? "rolled back" : dream.state}
              </span>
              <span className="text-text-dim">
                {dream.trigger} · {formatAge(dream.createdAt, now)} ago
              </span>
              <span>
                {dream.ops.accepted} accepted · {dream.ops.rejected} rejected
                {dream.ops.applied ? ` · ${dream.ops.applied} applied` : ""}
                {dream.ops.pendingProposals
                  ? ` · ${dream.ops.pendingProposals} awaiting ${dream.pool ? "a ratifier" : "the owner"}`
                  : ""}
              </span>
              {Object.keys(dream.ops.byKind).length > 0 && (
                <span className="text-text-dim">{kindsLine(dream.ops.byKind)}</span>
              )}
              <span
                className="text-text-dim"
                title="Probes retrievable before → after, of those probed"
              >
                probes {probesLine(dream.probes)}
              </span>
              {Object.keys(dream.rejectedByCheck).length > 0 && (
                <span className="text-text-dim" title="Rejections by the check that refused them">
                  refused:{" "}
                  {Object.entries(dream.rejectedByCheck)
                    .map(([check, n]) => `${check} ${n}`)
                    .join(", ")}
                </span>
              )}
              <span className="text-text-dim">
                {dream.region.records} records · {dream.model ?? "—"} · ${dream.spendUsd.toFixed(4)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
