// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * MemoryContext -- Inspector body for a selected MEMORY-layer node. Pure view
 * over the in-memory `MemoryGraph` (no fetching), so it renders from a fixture
 * in tests and never blocks on the network.
 *
 *   job         state · role · worker → requester · age · remaining ops /
 *               deadline · marker · citations · adopted record · Admin link
 *   resolution  policy · winner · losers · actor · time
 *   space       records / ratified counts · institutional flag · members
 *   record      twin note link · version · tier · space · adopted-from job
 *   proposal    adopted? · job · citations
 *   helper      role · jobs worked
 *
 * Actions are links to the Admin → Memory tab via the documented
 * `marina:open-admin` window event (see lib/memory-map-admin-link.ts); when no
 * listener claims the event the panel shows an inline hint instead.
 */

import { memo, useCallback, useMemo, useState } from "react";
import { openAdminMemory } from "../lib/memory-map-admin-link";
import { edgesTouching, indexMemoryGraph, neighborsVia, otherEnd } from "../lib/memory-map-reducer";
import {
  jobMarkerBadge,
  jobStateColor,
  type MemoryGraph,
  type MemoryGraphNode,
  parseMemoryNodeId,
  tierColor,
  UNIFIED_TIER_COLORS,
} from "../lib/memory-map-types";

export interface MemoryContextProps {
  graph: MemoryGraph | null | undefined;
  /** Prefixed memory node id, e.g. `job:12`. */
  nodeId: string;
  onNoteClick?: (noteId: number) => void;
  onEntityClick?: (name: string) => void;
  onMemoryNodeClick?: (nodeId: string) => void;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

const MARKER_NAMES: Record<string, string> = {
  H: "hygiene",
  A: "accumulation",
  S: "shared-write-review",
};

export function fmtMemoryAge(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtIn(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "expired";
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}

const Section = memo(function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="uc-cascade-section">
      <button
        type="button"
        className="uc-cascade-header"
        style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`uc-cascade-arrow${open ? "" : " collapsed"}`}>&#9662;</span>
        {title}
      </button>
      {open && <div className="uc-cascade-body">{children}</div>}
    </div>
  );
});

function Row({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="uc-context-row">
      <span className="uc-context-key">{label}</span>
      <span className="uc-context-value" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

function LinkBtn({
  onClick,
  color = "#FFDD00",
  children,
  title,
}: {
  onClick?: () => void;
  color?: string;
  children: React.ReactNode;
  title?: string;
}) {
  if (!onClick) return <span style={{ color }}>{children}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        background: "none",
        border: "none",
        color,
        cursor: "pointer",
        padding: 0,
        font: "inherit",
        textDecoration: "underline",
      }}
    >
      {children}
    </button>
  );
}

/** Short human label for a node reference — the node's label when known, else the id. */
function refLabel(graph: MemoryGraph, id: string): string {
  const n = graph.nodes.find((x) => x.id === id);
  return n?.label ?? id;
}

export const MemoryContext = memo(function MemoryContext({
  graph,
  nodeId,
  onNoteClick,
  onEntityClick,
  onMemoryNodeClick,
  now = Date.now,
}: MemoryContextProps) {
  const [adminHint, setAdminHint] = useState<string | null>(null);
  const index = useMemo(() => (graph ? indexMemoryGraph(graph) : null), [graph]);
  const node = index?.byId.get(nodeId);

  const openAdmin = useCallback((detail: Parameters<typeof openAdminMemory>[0]) => {
    const fellThrough = openAdminMemory(detail);
    setAdminHint(
      fellThrough
        ? "No admin surface is listening for marina:open-admin yet — open Admin → Memory manually."
        : null,
    );
  }, []);

  /** Navigate to any graph node: notes go to the note inspector, others to the memory inspector. */
  const go = useCallback(
    (id: string) => {
      const parsed = parseMemoryNodeId(id);
      if (parsed?.kind === "note" && onNoteClick) {
        const n = Number(parsed.ref);
        if (Number.isFinite(n)) onNoteClick(n);
        return;
      }
      onMemoryNodeClick?.(id);
    },
    [onNoteClick, onMemoryNodeClick],
  );

  if (!graph || !index) {
    return (
      <div style={{ padding: 12, color: "#888", fontSize: 13 }}>
        Memory graph not loaded yet. Enable the MEMORY layer (key 5) to fetch it.
      </div>
    );
  }
  if (!node) {
    return (
      <div style={{ padding: 12, color: "#ef4444", fontSize: 13 }}>
        {nodeId} is not in the current memory graph
        {graph.truncated ? " (the server truncated the graph — try a narrower scope)." : "."}
      </div>
    );
  }

  const nowMs = now();
  const t = nodeId;

  const banner = (color: string, tag: string, sub?: string) => (
    <div
      style={{
        padding: "10px 12px",
        borderBottom: "1px solid #222",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: 2,
          background: color,
        }}
      />
      <span style={{ color, fontFamily: "'Press Start 2P', monospace", fontSize: 9 }}>{tag}</span>
      <span style={{ color: "#ccc", fontSize: 13, wordBreak: "break-word" }}>{node.label}</span>
      {sub && <span style={{ color: "#888", fontSize: 12 }}>{sub}</span>}
    </div>
  );

  const nodeLink = (id: string, color?: string) => (
    <LinkBtn key={id} onClick={() => go(id)} color={color}>
      {refLabel(graph, id)}
    </LinkBtn>
  );

  const list = (ids: string[], empty: string, color?: string) =>
    ids.length === 0 ? (
      <div style={{ padding: "6px 12px", color: "#666", fontSize: 12 }}>{empty}</div>
    ) : (
      ids.map((id) => (
        <div key={id} className="uc-context-item" style={{ padding: "4px 12px" }}>
          {nodeLink(id, color)}
        </div>
      ))
    );

  const adminHintEl = adminHint && (
    <div style={{ padding: "4px 12px 8px", color: "#f59e0b", fontSize: 11, lineHeight: 1.35 }}>
      {adminHint}
    </div>
  );

  // ── job ───────────────────────────────────────────────────────────────────
  if (node.kind === "job") {
    const meta = node.meta ?? {};
    const color = jobStateColor(node.state);
    const worker =
      (meta.workerName as string | null) ??
      neighborsVia(index, t, "worker", "in").map((h) => refLabel(graph, h))[0] ??
      null;
    const requester =
      (meta.requesterName as string | null) ??
      node.entityName ??
      neighborsVia(index, t, "requester", "out").map((h) => refLabel(graph, h))[0] ??
      null;
    const remaining = meta.remainingOperations as number | null | undefined;
    const deadline = meta.deadline as number | null | undefined;
    const badge = jobMarkerBadge((meta.marker as string | null | undefined) ?? undefined);
    const adoptedTo = neighborsVia(index, t, "adopted_as", "out");
    const proposals = edgesTouching(index, t)
      .map((e) => otherEnd(e, t))
      .filter((id) => id.startsWith("proposal:"));
    const citations = [
      ...neighborsVia(index, t, "cites", "out"),
      ...proposals.flatMap((p) => neighborsVia(index, p, "cites", "out")),
    ].filter((v, i, a) => a.indexOf(v) === i);
    const jobRef = t.replace(/^job:/, "");

    return (
      <>
        {banner(color, "JOB", node.state ?? "pending")}
        <Section title="State">
          <Row label="State" value={node.state ?? "pending"} color={color} />
          <Row label="Role" value={node.role ?? "—"} />
          <div className="uc-context-row">
            <span className="uc-context-key">Worker → Requester</span>
            <span className="uc-context-value">
              {worker ? (
                <LinkBtn onClick={onEntityClick ? () => onEntityClick(worker) : undefined}>
                  {worker}
                </LinkBtn>
              ) : (
                "—"
              )}
              <span style={{ color: "#666" }}> → </span>
              {requester ? (
                <LinkBtn onClick={onEntityClick ? () => onEntityClick(requester) : undefined}>
                  {requester}
                </LinkBtn>
              ) : (
                "—"
              )}
            </span>
          </div>
          <Row label="Age" value={node.at ? fmtMemoryAge(nowMs - node.at) : "—"} />
          <Row
            label="Remaining ops"
            value={
              remaining == null
                ? "—"
                : `${remaining}${deadline ? ` · ${fmtIn(deadline - nowMs)}` : ""}`
            }
          />
          {deadline ? (
            <Row label="Deadline" value={new Date(deadline).toLocaleTimeString()} />
          ) : null}
          <Row
            label="Marker"
            value={
              badge
                ? `${badge} · ${MARKER_NAMES[badge]}`
                : ((meta.marker as string | null) ?? "none")
            }
            color={badge ? color : undefined}
          />
          {node.spaceId && <Row label="Space" value={node.spaceId} />}
          {typeof meta.depth === "number" && meta.depth > 0 && (
            <Row
              label="Depth"
              value={`${meta.depth}${meta.rootId ? ` · root ${meta.rootId}` : ""}`}
            />
          )}
        </Section>
        <Section title={`Citations (${citations.length})`} defaultOpen={citations.length > 0}>
          {list(citations, "No citations yet.", "#a855f7")}
        </Section>
        <Section title="Adoption" defaultOpen>
          {adoptedTo.length > 0 ? (
            <div className="uc-context-row">
              <span className="uc-context-key">Adopted record</span>
              <span className="uc-context-value">{nodeLink(adoptedTo[0]!, "#FFDD00")}</span>
            </div>
          ) : (
            <Row
              label="Adopted"
              value={meta.adopted === true ? "yes (record pending refetch)" : "not yet"}
            />
          )}
          <div style={{ padding: "6px 12px" }}>
            <button
              type="button"
              className="uc-memory-action"
              onClick={() => openAdmin({ jobId: jobRef })}
              title="Open this job in Admin → Memory"
            >
              Open in Admin → Memory
            </button>
          </div>
          {adminHintEl}
        </Section>
      </>
    );
  }

  // ── resolution ────────────────────────────────────────────────────────────
  if (node.kind === "resolution") {
    const color = "#f59e0b";
    const winners = neighborsVia(index, t, "resolves", "out");
    const losers = neighborsVia(index, t, "superseded_by", "in");
    const actor = (node.meta?.actorName as string | null) ?? node.entityName ?? null;
    return (
      <>
        {banner(color, "RESOLUTION", node.policy)}
        <Section title="Policy">
          <Row label="Policy" value={node.policy ?? "—"} color={color} />
          <Row
            label="Actor"
            value={
              actor ? (
                <LinkBtn onClick={onEntityClick ? () => onEntityClick(actor) : undefined}>
                  {actor}
                </LinkBtn>
              ) : (
                "—"
              )
            }
          />
          <Row
            label="Time"
            value={
              node.at
                ? `${new Date(node.at).toLocaleString()} · ${fmtMemoryAge(nowMs - node.at)}`
                : "—"
            }
          />
        </Section>
        <Section title={`Winner (${winners.length})`}>
          {list(winners, "No winner recorded.", "#10b981")}
        </Section>
        <Section title={`Losers (${losers.length}) — valid_time closed, still readable`}>
          {list(losers, "No losers — irreducible (keep_both) or single record.", "#f43f5e")}
        </Section>
        <div style={{ padding: "6px 12px" }}>
          <button
            type="button"
            className="uc-memory-action"
            onClick={() => openAdmin({ resolutionId: t.replace(/^resolution:/, "") })}
          >
            Open in Admin → Memory
          </button>
        </div>
        {adminHintEl}
      </>
    );
  }

  // ── space ─────────────────────────────────────────────────────────────────
  if (node.kind === "space") {
    const color = node.institutional === false ? "#9ca3af" : "#FFDD00";
    const members = neighborsVia(index, t, "in_space", "in");
    const records = members.filter((m) => index.byId.get(m)?.kind === "record");
    const ratified = records.filter((m) => {
      const r = index.byId.get(m);
      return r?.meta?.ratified === true || r?.state === "ratified" || !!r?.meta?.ratified_by;
    });
    const ratifiedCount =
      typeof node.meta?.ratified === "number"
        ? (node.meta.ratified as number)
        : ratified.length || records.length;
    const recordCount =
      typeof node.meta?.records === "number" ? (node.meta.records as number) : records.length;
    return (
      <>
        {banner(color, "SPACE", node.institutional === false ? "private" : "institutional")}
        <Section title="Counts">
          <Row label="Records" value={String(recordCount)} />
          <Row label="Ratified" value={String(ratifiedCount)} color={color} />
          <Row label="Institutional" value={node.institutional === false ? "no" : "yes"} />
          {node.entityName && <Row label="Owner" value={node.entityName} />}
        </Section>
        <Section
          title={`Members (${members.length})`}
          defaultOpen={members.length > 0 && members.length <= 12}
        >
          {list(members, "No ratified records yet.", color)}
        </Section>
        <div style={{ padding: "6px 12px" }}>
          <button
            type="button"
            className="uc-memory-action"
            onClick={() => openAdmin({ spaceId: t.replace(/^space:/, "") })}
          >
            Open in Admin → Memory
          </button>
        </div>
        {adminHintEl}
      </>
    );
  }

  // ── record ────────────────────────────────────────────────────────────────
  if (node.kind === "record") {
    const color = tierColor(node.tier);
    const twins = neighborsVia(index, t, "twin").filter((id) => id.startsWith("note:"));
    const spaces = neighborsVia(index, t, "in_space", "out");
    const fromJobs = neighborsVia(index, t, "adopted_as", "in");
    const version = node.meta?.version;
    return (
      <>
        {banner(color, "RECORD", node.tier ? `[${node.tier}]` : undefined)}
        <Section title="Record">
          <Row label="Tier" value={node.tier ?? "—"} color={color} />
          <Row label="Version" value={version != null ? `v${version}` : "—"} />
          {node.state && <Row label="State" value={node.state} />}
          {node.entityName && <Row label="Owner" value={node.entityName} />}
          <Row label="Created" value={node.at ? fmtMemoryAge(nowMs - node.at) : "—"} />
          <div className="uc-context-row">
            <span className="uc-context-key">Twin note</span>
            <span className="uc-context-value">
              {twins.length === 0
                ? "— (service-only record)"
                : twins.map((id) => (
                    <LinkBtn key={id} onClick={() => go(id)} color="#3b82f6">
                      #{id.slice("note:".length)}
                    </LinkBtn>
                  ))}
            </span>
          </div>
          {spaces.length > 0 && (
            <div className="uc-context-row">
              <span className="uc-context-key">Space</span>
              <span className="uc-context-value">{spaces.map((s) => nodeLink(s, "#FFDD00"))}</span>
            </div>
          )}
          {fromJobs.length > 0 && (
            <div className="uc-context-row">
              <span className="uc-context-key">Adopted from</span>
              <span className="uc-context-value">{fromJobs.map((j) => nodeLink(j))}</span>
            </div>
          )}
        </Section>
        <div style={{ padding: "6px 12px" }}>
          <button
            type="button"
            className="uc-memory-action"
            onClick={() => openAdmin({ recordId: t.replace(/^record:/, "") })}
          >
            Open in Admin → Memory
          </button>
        </div>
        {adminHintEl}
      </>
    );
  }

  // ── proposal ──────────────────────────────────────────────────────────────
  if (node.kind === "proposal") {
    const color = UNIFIED_TIER_COLORS.proposal;
    const adopted = node.state === "adopted" || node.meta?.adopted === true;
    const jobs = edgesTouching(index, t)
      .map((e) => otherEnd(e, t))
      .filter((id) => id.startsWith("job:"));
    const cites = neighborsVia(index, t, "cites", "out");
    return (
      <>
        {banner(color, "PROPOSAL", adopted ? "adopted" : "awaiting adoption")}
        <Section title="Proposal">
          <Row label="Adopted" value={adopted ? "yes" : "no"} color={adopted ? "#10b981" : color} />
          {node.tier && <Row label="Tier" value={node.tier} color={tierColor(node.tier)} />}
          {jobs.length > 0 && (
            <div className="uc-context-row">
              <span className="uc-context-key">Job</span>
              <span className="uc-context-value">{jobs.map((j) => nodeLink(j))}</span>
            </div>
          )}
          <Row label="Created" value={node.at ? fmtMemoryAge(nowMs - node.at) : "—"} />
        </Section>
        <Section title={`Citations (${cites.length})`} defaultOpen={cites.length > 0}>
          {list(cites, "No citations.", color)}
        </Section>
      </>
    );
  }

  // ── helper ────────────────────────────────────────────────────────────────
  const helperColor = "#FFDD00";
  const worked = neighborsVia(index, t, "worker", "out");
  const requested = neighborsVia(index, t, "requester", "in");
  return (
    <>
      {banner(helperColor, "HELPER", node.role)}
      <Section title="Helper">
        <Row label="Role" value={node.role ?? "—"} />
        <div className="uc-context-row">
          <span className="uc-context-key">Entity</span>
          <span className="uc-context-value">
            <LinkBtn onClick={onEntityClick ? () => onEntityClick(node.label) : undefined}>
              {node.label}
            </LinkBtn>
          </span>
        </div>
      </Section>
      <Section title={`Jobs worked (${worked.length})`}>
        {list(worked, "No jobs worked yet.")}
      </Section>
      <Section title={`Jobs requested (${requested.length})`} defaultOpen={requested.length > 0}>
        {list(requested, "None.")}
      </Section>
    </>
  );
});

export type { MemoryGraphNode };
