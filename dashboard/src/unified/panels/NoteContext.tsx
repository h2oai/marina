// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Note inspector for the ContextPanel: content, metadata, provenance,
 * verification history and links of one note.
 * Split out of ContextPanel.tsx without behaviour change.
 */

import { memo } from "react";
import { useNoteDetail } from "../../hooks/use-api";
import { CascadeSection, PropRow } from "./context-panel-sections";

// ── Note Context ────────────────────────────────────────────────────────────

const NOTE_TYPE_COLORS: Record<string, string> = {
  episode: "#a855f7",
  skill: "#f97316",
  fact: "#3b82f6",
  observation: "#9ca3af",
  inference: "#06b6d4",
  decision: "#22c55e",
  principle: "#eab308",
};

const REL_COLORS: Record<string, string> = {
  supports: "#22c55e",
  contradicts: "#ef4444",
  extends: "#3b82f6",
  exemplifies: "#d946ef",
  related_to: "#6b7280",
  supersedes: "#f59e0b",
  part_of: "#14b8a6",
  derived_from: "#8b5cf6",
};

function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const NoteContext = memo(function NoteContext({
  noteId,
  onEntityClick,
  onNoteClick,
}: {
  noteId: number;
  onEntityClick?: (name: string) => void;
  onNoteClick?: (id: number) => void;
}) {
  const { data, isLoading } = useNoteDetail(noteId);

  if (isLoading) {
    return <div style={{ padding: 12, color: "#888" }}>Loading note #{noteId}…</div>;
  }
  if (!data) {
    return <div style={{ padding: 12, color: "#ef4444" }}>Note #{noteId} not found.</div>;
  }

  const color = NOTE_TYPE_COLORS[data.noteType] ?? "#9ca3af";
  const accessed = data.lastAccessed ?? data.createdAt;

  return (
    <>
      {/* Banner */}
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #222",
          display: "flex",
          alignItems: "center",
          gap: 8,
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
        <span style={{ color, fontFamily: "'Press Start 2P', monospace", fontSize: 10 }}>
          #{data.id}
        </span>
        <span style={{ color: "#888", fontSize: 12 }}>
          [{data.noteType}] · importance {data.importance}
        </span>
      </div>

      <CascadeSection title="Content">
        <div
          style={{
            padding: "8px 12px",
            fontSize: 13,
            color: "#ddd",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {data.content}
        </div>
      </CascadeSection>

      <CascadeSection title="Meta">
        <div className="uc-context-row">
          <span className="uc-context-key">Author</span>
          <span className="uc-context-value">
            {onEntityClick ? (
              <button
                type="button"
                onClick={() => onEntityClick(data.entityName)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#FFDD00",
                  cursor: "pointer",
                  padding: 0,
                  font: "inherit",
                  textDecoration: "underline",
                }}
              >
                {data.entityName}
              </button>
            ) : (
              data.entityName
            )}
          </span>
        </div>
        <PropRow label="Created" value={fmtAge(Date.now() - data.createdAt)} />
        <PropRow label="Last recalled" value={fmtAge(Date.now() - accessed)} />
        <PropRow
          label="Verification"
          value={`${data.verificationStatus} · confidence ${data.confidence.toFixed(2)}`}
        />
        {data.roomId && <PropRow label="Room" value={data.roomId} />}
        {data.poolId && <PropRow label="Pool" value={data.poolId} />}
        {data.supersedesId !== null && (
          <div className="uc-context-row">
            <span className="uc-context-key">Supersedes</span>
            <span className="uc-context-value">
              {onNoteClick ? (
                <button
                  type="button"
                  onClick={() => onNoteClick(data.supersedesId!)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#f59e0b",
                    cursor: "pointer",
                    padding: 0,
                    font: "inherit",
                    textDecoration: "underline",
                  }}
                >
                  #{data.supersedesId}
                </button>
              ) : (
                `#${data.supersedesId}`
              )}
            </span>
          </div>
        )}
      </CascadeSection>

      <CascadeSection
        title={`Provenance (${data.sources.length})`}
        defaultOpen={data.sources.length > 0}
      >
        {data.sources.length === 0 ? (
          <div style={{ padding: "6px 12px", color: "#666", fontSize: 12 }}>
            No explicit evidence attached.
          </div>
        ) : (
          data.sources.map((source) => (
            <div
              key={source.id}
              style={{ padding: "6px 12px", borderBottom: "1px solid #1a1a22", fontSize: 11 }}
            >
              <div>
                <span style={{ color: "#14b8a6" }}>[{source.source_type}]</span>{" "}
                {source.source_note_id && onNoteClick ? (
                  <button
                    type="button"
                    onClick={() => onNoteClick(source.source_note_id!)}
                    style={{ background: "none", border: 0, color: "#FFDD00", cursor: "pointer" }}
                  >
                    #{source.source_note_id}
                  </button>
                ) : (
                  <span style={{ color: "#bbb", wordBreak: "break-all" }}>{source.url}</span>
                )}
              </div>
              <div style={{ color: "#777" }}>
                credibility {source.credibility.toFixed(2)}
                {source.source_entity ? ` · via ${source.source_entity}` : ""}
              </div>
              {source.excerpt && (
                <div style={{ color: "#999", marginTop: 2 }}>{source.excerpt}</div>
              )}
            </div>
          ))
        )}
      </CascadeSection>

      <CascadeSection
        title={`Verification history (${data.verifications.length})`}
        defaultOpen={data.verifications.length > 0}
      >
        {data.verifications.map((entry) => (
          <div
            key={entry.id}
            style={{ padding: "6px 12px", borderBottom: "1px solid #1a1a22", fontSize: 11 }}
          >
            <div
              style={{
                color:
                  entry.status === "verified"
                    ? "#22c55e"
                    : entry.status === "disputed"
                      ? "#ef4444"
                      : "#999",
              }}
            >
              {entry.status} · {entry.confidence.toFixed(2)} · {entry.verifier}
            </div>
            {entry.rationale && <div style={{ color: "#888" }}>{entry.rationale}</div>}
          </div>
        ))}
      </CascadeSection>

      <CascadeSection title={`Links (${data.links.length})`} defaultOpen={data.links.length > 0}>
        {data.links.length === 0 ? (
          <div style={{ padding: "6px 12px", color: "#666", fontSize: 12 }}>
            No links yet. Use <code>note link #{data.id} &lt;other&gt; &lt;rel&gt;</code> to
            connect.
          </div>
        ) : (
          data.links.map((l) => {
            const relColor = REL_COLORS[l.relationship] ?? "#888";
            const arrow = l.direction === "out" ? "→" : "←";
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onNoteClick?.(l.otherId)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  borderBottom: "1px solid #1a1a22",
                  color: "#ccc",
                  padding: "6px 12px",
                  cursor: onNoteClick ? "pointer" : "default",
                  font: "inherit",
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: relColor }}>{l.relationship}</span>{" "}
                  <span style={{ color: "#888" }}>{arrow}</span>{" "}
                  <span style={{ color: "#FFDD00" }}>#{l.otherId}</span>
                  {l.otherType && <span style={{ color: "#666" }}> [{l.otherType}]</span>}
                </div>
                {l.otherPreview && (
                  <div style={{ fontSize: 11, color: "#888", lineHeight: 1.3 }}>
                    {l.otherPreview}
                  </div>
                )}
              </button>
            );
          })
        )}
      </CascadeSection>
    </>
  );
});
