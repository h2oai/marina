/**
 * GraphNoteNode -- Renders a knowledge-graph note on the unified ReactFlow surface.
 *
 * Visual grammar:
 * - Size scales with importance (1-10)
 * - Color comes from note type (episode/skill/fact/observation/inference/decision/principle)
 * - Opacity fades with time-since-last-accessed (decay visualization)
 * - Pulsing outline when recently created or activated via recall_trace
 */

import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import { useZoom } from "../hooks/use-zoom";

export interface GraphNoteNodeData {
  id: number;
  entityName: string;
  content: string;
  importance: number;
  noteType: string;
  createdAt: number;
  lastAccessed: number | null;
  /** True if this note is in the most recent recall trace's activatedNoteIds */
  activated?: boolean;
  onClick?: (noteId: number, screenX: number, screenY: number) => void;
  [key: string]: unknown;
}

const TYPE_COLORS: Record<string, string> = {
  episode: "#a855f7", // purple
  skill: "#f97316", // orange
  fact: "#3b82f6", // blue
  observation: "#9ca3af", // gray
  inference: "#06b6d4", // cyan
  decision: "#22c55e", // green
  principle: "#eab308", // yellow
};

const DAY_MS = 86_400_000;
const ORPHAN_DECAY_DAYS = 7;
const LINKED_DECAY_DAYS = 14;

/**
 * Compute decay-based opacity. Matches the backend's NOTE_ORPHAN_DECAY_DAYS /
 * NOTE_LINKED_DECAY_DAYS constants so the dashboard shows what the engine sees.
 * Notes with lastAccessed=null fall back to createdAt for the age calculation.
 */
function decayOpacity(lastAccessed: number | null, createdAt: number, importance: number): number {
  const anchor = lastAccessed ?? createdAt;
  const ageDays = (Date.now() - anchor) / DAY_MS;
  // High importance notes decay slower (use LINKED window). Low importance use ORPHAN window.
  const decayDays = importance >= 6 ? LINKED_DECAY_DAYS : ORPHAN_DECAY_DAYS;
  if (ageDays <= 1) return 1.0;
  if (ageDays >= decayDays) return 0.15;
  // Linear fade from 1.0 at day 1 to 0.15 at decayDays
  const t = (ageDays - 1) / (decayDays - 1);
  return 1.0 - t * 0.85;
}

export const GraphNoteNode = memo(function GraphNoteNode({ data }: NodeProps) {
  const note = data as unknown as GraphNoteNodeData;
  const color = TYPE_COLORS[note.noteType] ?? TYPE_COLORS.observation!;
  const baseR = 8 + note.importance * 1.6; // 8-24 px radius
  const opacity = decayOpacity(note.lastAccessed, note.createdAt, note.importance);

  const ageMs = Date.now() - (note.lastAccessed ?? note.createdAt);
  const recentlyCreated = ageMs < 5_000;
  const pulsing = recentlyCreated || note.activated === true;

  const zoom = useZoom((s) => s.zoom);
  const showInlineLabel = zoom >= 0.7;

  const preview = note.content.length > 32 ? `${note.content.slice(0, 30)}…` : note.content;
  const size = baseR * 2 + 6;

  return (
    // biome-ignore lint/a11y/useSemanticElements: React Flow node wrapper hosts drag Handles + SVG; a <button> swallows the node's pointer/drag model
    <div
      role="button"
      tabIndex={note.onClick ? 0 : undefined}
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: note.onClick ? "pointer" : undefined,
      }}
      onClick={(e) => {
        if (note.onClick) {
          e.stopPropagation();
          note.onClick(note.id, e.clientX, e.clientY);
        }
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && note.onClick) {
          e.preventDefault();
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          note.onClick(note.id, rect.left, rect.top);
        }
      }}
    >
      <Handle type="source" position={Position.Top} id="t" className="!bg-transparent !border-0" />
      <Handle type="target" position={Position.Top} id="t" className="!bg-transparent !border-0" />
      <Handle
        type="source"
        position={Position.Bottom}
        id="b"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="b"
        className="!bg-transparent !border-0"
      />
      <Handle type="source" position={Position.Left} id="l" className="!bg-transparent !border-0" />
      <Handle type="target" position={Position.Left} id="l" className="!bg-transparent !border-0" />
      <Handle
        type="source"
        position={Position.Right}
        id="r"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="r"
        className="!bg-transparent !border-0"
      />
      <svg
        width={size}
        height={size}
        viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
        style={{ overflow: "visible" }}
      >
        <title>{`#${note.id} [${note.noteType}] ${preview}`}</title>
        {pulsing && (
          <circle r={baseR + 4} fill="none" stroke={color} strokeWidth={1} opacity={0.6}>
            <animate
              attributeName="r"
              values={`${baseR + 4};${baseR + 14}`}
              dur="1.5s"
              repeatCount={recentlyCreated ? "3" : "indefinite"}
            />
            <animate
              attributeName="opacity"
              values="0.6;0"
              dur="1.5s"
              repeatCount={recentlyCreated ? "3" : "indefinite"}
            />
          </circle>
        )}
        <circle r={baseR} fill={color} opacity={opacity * 0.25} />
        <circle r={baseR} fill="none" stroke={color} strokeWidth={1.5} opacity={opacity} />
        <circle r={baseR * 0.4} fill={color} opacity={opacity} />
        <text
          y={baseR + 10}
          textAnchor="middle"
          fontSize={8}
          fontFamily="'VT323', monospace"
          fill={color}
          opacity={opacity * 0.7}
        >
          #{note.id}
        </text>
        {showInlineLabel && (
          <text
            y={baseR + 22}
            textAnchor="middle"
            fontSize={10}
            fontFamily="'VT323', monospace"
            fill="#ccc"
            opacity={opacity * 0.85}
          >
            {preview}
          </text>
        )}
      </svg>
    </div>
  );
});
