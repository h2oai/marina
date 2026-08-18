// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LegendContent -- Color-key reference for the unified canvas. Three tabs:
 * note types, relationship edges, feed event kinds. Rendered inside the
 * WorldNav panel as the LEGEND flip side of WORLD.
 */

import { memo, useState } from "react";

const NOTE_TYPE_COLORS: Record<string, string> = {
  episode: "#a855f7",
  skill: "#f97316",
  fact: "#3b82f6",
  observation: "#9ca3af",
  inference: "#06b6d4",
  decision: "#22c55e",
  principle: "#eab308",
};

const RELATIONSHIP_COLORS: Record<string, string> = {
  supports: "#22c55e",
  contradicts: "#ef4444",
  extends: "#3b82f6",
  exemplifies: "#d946ef",
  related_to: "#6b7280",
  supersedes: "#f59e0b",
  part_of: "#14b8a6",
  derived_from: "#8b5cf6",
};

const FEED_KIND_COLORS: Record<string, string> = {
  board_post: "#a855f7",
  pool_note: "#14b8a6",
  channel_message: "#06b6d4",
  task_claimed: "#22c55e",
  task_submitted: "#eab308",
  task_approved: "#22c55e",
  task_rejected: "#ef4444",
  market_position: "#f97316",
  market_consensus: "#3b82f6",
  market_resolution: "#8b5cf6",
  canvas_intent: "#ec4899",
  note_created: "#60a5fa",
  note_link_created: "#818cf8",
};

const SIZE_EXPLAINER =
  "Graph note size = importance (1-10). Opacity fades with age since last recall.";

type Section = "notes" | "edges" | "feed";

function Swatch({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: 2,
        background: color,
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

function EdgeSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg width={22} height={10} style={{ marginRight: 6, flexShrink: 0 }}>
      <title>edge swatch</title>
      <line
        x1={1}
        y1={5}
        x2={21}
        y2={5}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={dashed ? "3 2" : undefined}
      />
    </svg>
  );
}

export interface LegendContentProps {
  onReplayTour?: () => void;
}

export const LegendContent = memo(function LegendContent({ onReplayTour }: LegendContentProps) {
  const [section, setSection] = useState<Section>("notes");

  return (
    <div
      style={{
        fontFamily: "'VT323', monospace",
        fontSize: 13,
        color: "#ccc",
      }}
    >
      {/* Section tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        {(["notes", "edges", "feed"] as Section[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSection(s);
            }}
            style={{
              flex: 1,
              padding: "3px 4px",
              background: section === s ? "rgba(255,221,0,0.15)" : "transparent",
              border: `1px solid ${section === s ? "#FFDD00" : "#333"}`,
              color: section === s ? "#FFDD00" : "#888",
              fontFamily: "inherit",
              fontSize: 12,
              cursor: "pointer",
              borderRadius: 2,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {section === "notes" && (
        <div>
          <div style={{ color: "#888", fontSize: 11, marginBottom: 4 }}>
            Note types (graph nodes):
          </div>
          {Object.entries(NOTE_TYPE_COLORS).map(([name, color]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", padding: "1px 0" }}>
              <Swatch color={color} />
              <span>{name}</span>
            </div>
          ))}
          <div
            style={{
              marginTop: 8,
              padding: "6px 0 0 0",
              borderTop: "1px solid #222",
              color: "#777",
              fontSize: 11,
              lineHeight: 1.35,
            }}
          >
            {SIZE_EXPLAINER}
          </div>
        </div>
      )}

      {section === "edges" && (
        <div>
          <div style={{ color: "#888", fontSize: 11, marginBottom: 4 }}>
            Relationship edges (graph + canvas):
          </div>
          {Object.entries(RELATIONSHIP_COLORS).map(([rel, color]) => (
            <div key={rel} style={{ display: "flex", alignItems: "center", padding: "1px 0" }}>
              <EdgeSwatch
                color={color}
                dashed={rel === "contradicts" || rel === "related_to" || rel === "supersedes"}
              />
              <span>{rel}</span>
            </div>
          ))}
          <div
            style={{
              marginTop: 8,
              padding: "6px 0 0 0",
              borderTop: "1px solid #222",
              color: "#777",
              fontSize: 11,
              lineHeight: 1.35,
            }}
          >
            Edges flash when part of an active recall trace.
          </div>
        </div>
      )}

      {section === "feed" && (
        <div>
          <div style={{ color: "#888", fontSize: 11, marginBottom: 4 }}>
            Feed event kinds (timeline dots):
          </div>
          {Object.entries(FEED_KIND_COLORS).map(([kind, color]) => (
            <div key={kind} style={{ display: "flex", alignItems: "center", padding: "1px 0" }}>
              <Swatch color={color} />
              <span>{kind}</span>
            </div>
          ))}
          <div
            style={{
              marginTop: 8,
              padding: "6px 0 0 0",
              borderTop: "1px solid #222",
              color: "#777",
              fontSize: 11,
              lineHeight: 1.35,
            }}
          >
            Timeline shows last 30 minutes. Click a chip above the strip to filter.
          </div>
        </div>
      )}

      {onReplayTour && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 6,
            borderTop: "1px solid #222",
            textAlign: "center",
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReplayTour();
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "#666",
              fontFamily: "inherit",
              fontSize: 11,
              cursor: "pointer",
              textDecoration: "underline",
              padding: "2px 4px",
            }}
            title="Show the orientation tour again"
          >
            replay orientation
          </button>
        </div>
      )}
    </div>
  );
});
