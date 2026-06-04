/**
 * Viewer -- Full-screen overlay for media viewing.
 *
 * Opens on double-click of canvas nodes. Renders type-appropriate content:
 * image, video player, audio waveform, PDF pages, document editor,
 * A2UI components, intent detail.
 *
 * Close via the X button or Escape key.
 * This is currently a shell with placeholder content per type.
 */

import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { A2UIRenderer } from "../../canvas/nodes/a2ui/A2UIRenderer";
import { useChatState } from "../../hooks/use-chat-state";
import { sanitizeDocHtml } from "../../lib/sanitize";
import { claimIntent, completeIntent, failIntent } from "../hooks/use-canvas-integration";

/** Supported viewer content types. */
export type ViewerContentType =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "document"
  | "a2ui"
  | "intent"
  | "unknown";

/** Props for the Viewer component. */
export interface ViewerProps {
  /** Whether the viewer is open. */
  open: boolean;
  /** Title of the content being viewed. */
  title: string;
  /** Content type determines the renderer used. */
  contentType: ViewerContentType;
  /** Content URL or data (interpretation depends on contentType). */
  content?: string;
  /** Called when the viewer should close. */
  onClose: () => void;
}

// ── Type Badge Colors ───────────────────────────────────────────────────────

const TYPE_COLORS: Record<ViewerContentType, string> = {
  image: "var(--color-success)",
  video: "var(--color-teal)",
  audio: "var(--color-accent)",
  pdf: "var(--color-danger)",
  document: "var(--color-secondary)",
  a2ui: "var(--color-pink)",
  intent: "var(--color-primary)",
  unknown: "var(--color-text-dim)",
};

// ── Content Renderers (shells) ──────────────────────────────────────────────

const ImageViewer = memo(function ImageViewer({ content }: { content?: string }) {
  return (
    <div className="flex items-center justify-center">
      {content ? (
        <img
          src={content}
          alt="Viewer content"
          className="max-w-full max-h-[70vh]"
          style={{ border: "1px solid var(--color-border)", borderRadius: "4px" }}
        />
      ) : (
        <PlaceholderContent type="image" />
      )}
    </div>
  );
});

const VideoViewer = memo(function VideoViewer({ content }: { content?: string }) {
  return (
    <div
      className="w-full"
      style={{
        aspectRatio: "16/9",
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: "4px",
      }}
    >
      {content ? (
        <video src={content} controls className="w-full h-full" style={{ borderRadius: "4px" }}>
          <track kind="captions" />
        </video>
      ) : (
        <div className="flex items-center justify-center h-full">
          <PlaceholderContent type="video" />
        </div>
      )}
    </div>
  );
});

const AudioViewer = memo(function AudioViewer({ content }: { content?: string }) {
  // Placeholder waveform bars (deterministic heights based on index)
  const bars = Array.from({ length: 40 }, (_, i) => ({
    id: `bar-${i}`,
    height: 20 + Math.sin(i * 0.4) * 30 + ((i * 17) % 20),
  }));

  return (
    <div
      className="w-full p-6"
      style={{
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: "4px",
      }}
    >
      {content && (
        <audio src={content} controls className="w-full mb-4">
          <track kind="captions" />
        </audio>
      )}
      <div className="flex items-end gap-[3px]" style={{ height: "80px" }}>
        {bars.map((bar) => (
          <div
            key={bar.id}
            className="flex-1 cursor-pointer"
            style={{
              height: `${bar.height}%`,
              background: "var(--color-primary)",
              borderRadius: "2px",
              opacity: 0.3,
            }}
          />
        ))}
      </div>
    </div>
  );
});

const PdfViewer = memo(function PdfViewer({ content }: { content?: string }) {
  return (
    <div
      className="w-full flex flex-col"
      style={{
        background: "var(--color-bg-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "4px",
      }}
    >
      <div className="flex-1 p-6 overflow-y-auto max-h-[65vh]">
        {content ? (
          <iframe
            src={content}
            title="PDF Viewer"
            className="w-full h-full min-h-[400px]"
            style={{ border: "none" }}
          />
        ) : (
          <PlaceholderContent type="pdf" />
        )}
      </div>
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ borderTop: "1px solid var(--color-border)" }}
      >
        <button
          type="button"
          className="px-3 py-1 text-xs cursor-pointer"
          style={{
            border: "1px solid var(--color-border)",
            color: "var(--color-text-dim)",
            fontFamily: "var(--font-mono)",
            background: "none",
          }}
        >
          &larr; Prev
        </button>
        <span className="text-xs" style={{ color: "var(--color-text-dim)" }}>
          Page 1 of 1
        </span>
        <button
          type="button"
          className="px-3 py-1 text-xs cursor-pointer"
          style={{
            border: "1px solid var(--color-border)",
            color: "var(--color-text-dim)",
            fontFamily: "var(--font-mono)",
            background: "none",
          }}
        >
          Next &rarr;
        </button>
      </div>
    </div>
  );
});

const DOC_TOOLS: { label: string; cmd: string; value?: string; title: string }[] = [
  { label: "B", cmd: "bold", title: "Bold" },
  { label: "I", cmd: "italic", title: "Italic" },
  { label: "U", cmd: "underline", title: "Underline" },
  { label: "H1", cmd: "formatBlock", value: "h1", title: "Heading 1" },
  { label: "H2", cmd: "formatBlock", value: "h2", title: "Heading 2" },
  { label: "Link", cmd: "createLink", title: "Insert Link" },
];

const DocumentViewer = memo(function DocumentViewer({ content }: { content?: string }) {
  const editorRef = useRef<HTMLDivElement>(null);

  const exec = useCallback((cmd: string, value?: string) => {
    document.execCommand(cmd, false, value);
    editorRef.current?.focus();
  }, []);

  return (
    <div
      className="w-full min-h-[300px]"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: "4px",
      }}
    >
      <div
        className="flex gap-1.5 px-6 pt-6 pb-2 mb-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        {DOC_TOOLS.map((t) => (
          <button
            type="button"
            key={t.label}
            onClick={() => {
              if (t.cmd === "createLink") {
                const url = prompt("Enter URL:");
                if (url) exec(t.cmd, url);
              } else {
                exec(t.cmd, t.value);
              }
            }}
            title={t.title}
            className="px-2 py-0.5 text-xs cursor-pointer"
            style={{
              border: "1px solid var(--color-border)",
              color: "var(--color-text-dim)",
              fontFamily: t.label === "B" ? "inherit" : "var(--font-mono)",
              fontWeight: t.label === "B" ? 700 : undefined,
              fontStyle: t.label === "I" ? "italic" : undefined,
              textDecoration: t.label === "U" ? "underline" : undefined,
              background: "none",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        ref={editorRef}
        className="text-sm outline-none min-h-[200px]"
        style={{
          flex: 1,
          padding: "16px 24px",
          color: "var(--color-text)",
          lineHeight: "1.8",
          overflow: "auto",
        }}
        contentEditable
        suppressContentEditableWarning
        // biome-ignore lint/security/noDangerouslySetInnerHtml: rich-text editor surface; defense-in-depth via sanitizeDocHtml.
        dangerouslySetInnerHTML={{
          __html: content ? sanitizeDocHtml(content) : "<p>Start typing...</p>",
        }}
      />
    </div>
  );
});

const A2uiViewer = memo(function A2uiViewer({ content }: { content?: string }) {
  const parsed = useMemo(() => {
    if (!content) return null;
    try {
      return JSON.parse(content) as { components?: unknown[] };
    } catch {
      return null;
    }
  }, [content]);

  if (!parsed?.components) {
    return (
      <div
        className="w-full p-6"
        style={{
          background: "var(--color-bg)",
          border: "1px solid color-mix(in srgb, var(--color-pink) 30%, var(--color-border))",
          borderRadius: "4px",
        }}
      >
        <PlaceholderContent type="a2ui" />
      </div>
    );
  }

  return (
    <div
      className="w-full p-4"
      style={{
        background: "var(--color-bg)",
        border: "1px solid color-mix(in srgb, var(--color-pink) 30%, var(--color-border))",
        borderRadius: "4px",
      }}
    >
      <A2UIRenderer
        nodeData={parsed as import("../../canvas/nodes/a2ui/types").A2UINodeData}
        onAction={() => {}}
      />
    </div>
  );
});

/** Intent status badge colors. */
const INTENT_STATUS_COLORS: Record<string, string> = {
  pending: "#FFB800",
  active: "#06b6d4",
  done: "#22c55e",
  failed: "#ef4444",
};

const IntentViewer = memo(function IntentViewer({ content }: { content?: string }) {
  const currentEntityName = useChatState((s) => s.entityName);
  const [actionText, setActionText] = useState("");
  const [activeAction, setActiveAction] = useState<"complete" | "fail" | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when action mode is activated
  useEffect(() => {
    if (activeAction) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [activeAction]);

  const intent = useMemo(() => {
    if (!content) return null;
    try {
      return JSON.parse(content) as {
        status?: string;
        prompt?: string;
        claimedBy?: string;
        claimedAt?: number;
        result?: string;
        failReason?: string;
        canvasId?: string;
        nodeId?: string;
      };
    } catch {
      return null;
    }
  }, [content]);

  if (!intent) {
    return (
      <div
        className="w-full p-6"
        style={{
          background: "var(--color-bg)",
          border: "1px solid color-mix(in srgb, var(--color-primary) 20%, var(--color-border))",
          borderRadius: "4px",
        }}
      >
        <div className="text-xs mb-2" style={{ color: "var(--color-text-dim)" }}>
          Intent Detail
        </div>
        <div className="text-sm" style={{ color: "var(--color-text)" }}>
          No intent data available.
        </div>
      </div>
    );
  }

  const statusColor = INTENT_STATUS_COLORS[intent.status ?? "pending"] ?? "var(--color-text-dim)";
  const canAct = !!intent.canvasId && !!intent.nodeId;
  const isOwner = intent.claimedBy === currentEntityName;

  const handleClaim = async () => {
    if (!canAct) return;
    try {
      await claimIntent(intent.canvasId!, intent.nodeId!, currentEntityName ?? "dashboard-user");
      setActionStatus("Claimed successfully");
    } catch {
      setActionStatus("Failed to claim");
    }
  };

  const handleComplete = async () => {
    if (!canAct || !actionText.trim()) return;
    try {
      await completeIntent(intent.canvasId!, intent.nodeId!, actionText.trim());
      setActionStatus("Completed successfully");
      setActiveAction(null);
      setActionText("");
    } catch {
      setActionStatus("Failed to complete");
    }
  };

  const handleFail = async () => {
    if (!canAct || !actionText.trim()) return;
    try {
      await failIntent(intent.canvasId!, intent.nodeId!, actionText.trim());
      setActionStatus("Marked as failed");
      setActiveAction(null);
      setActionText("");
    } catch {
      setActionStatus("Failed to update");
    }
  };

  return (
    <div
      className="w-full p-6"
      style={{
        background: "var(--color-bg)",
        border: `1px solid color-mix(in srgb, ${statusColor} 30%, var(--color-border))`,
        borderRadius: "4px",
      }}
    >
      {/* Header row: title + status badge */}
      <div className="flex items-center gap-3 mb-4">
        <div className="text-xs" style={{ color: "var(--color-text-dim)" }}>
          Intent Detail
        </div>
        <span
          className="text-[10px] px-2 py-0.5 uppercase tracking-wider"
          style={{
            borderRadius: "3px",
            border: `1px solid ${statusColor}`,
            color: statusColor,
            fontFamily: "var(--font-mono)",
          }}
        >
          {intent.status ?? "unknown"}
        </span>
      </div>

      {/* Prompt */}
      {intent.prompt && (
        <div className="mb-4">
          <div
            className="text-[10px] uppercase tracking-wider mb-1"
            style={{ color: "var(--color-text-dim)" }}
          >
            Prompt
          </div>
          <div
            className="text-sm p-3"
            style={{
              color: "var(--color-text)",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid var(--color-border)",
              borderRadius: "3px",
              lineHeight: 1.6,
            }}
          >
            {intent.prompt}
          </div>
        </div>
      )}

      {/* Claimed by */}
      {intent.claimedBy && (
        <div className="mb-4">
          <div
            className="text-[10px] uppercase tracking-wider mb-1"
            style={{ color: "var(--color-text-dim)" }}
          >
            Claimed by
          </div>
          <div className="text-sm" style={{ color: "#06b6d4" }}>
            {intent.claimedBy}
            {intent.claimedAt && (
              <span style={{ color: "var(--color-text-dim)", marginLeft: "8px", fontSize: "11px" }}>
                {new Date(intent.claimedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Result */}
      {intent.result && (
        <div className="mb-4">
          <div
            className="text-[10px] uppercase tracking-wider mb-1"
            style={{ color: "var(--color-text-dim)" }}
          >
            Result
          </div>
          <div
            className="text-sm p-3"
            style={{
              color: "#22c55e",
              background: "rgba(34,197,94,0.05)",
              border: "1px solid rgba(34,197,94,0.2)",
              borderRadius: "3px",
              lineHeight: 1.6,
            }}
          >
            {intent.result}
          </div>
        </div>
      )}

      {/* Fail reason */}
      {intent.failReason && (
        <div className="mb-4">
          <div
            className="text-[10px] uppercase tracking-wider mb-1"
            style={{ color: "var(--color-text-dim)" }}
          >
            Failure Reason
          </div>
          <div
            className="text-sm p-3"
            style={{
              color: "#ef4444",
              background: "rgba(239,68,68,0.05)",
              border: "1px solid rgba(239,68,68,0.2)",
              borderRadius: "3px",
              lineHeight: 1.6,
            }}
          >
            {intent.failReason}
          </div>
        </div>
      )}

      {/* Action buttons */}
      {canAct && (
        <div
          className="mt-4 pt-4 flex flex-col gap-2"
          style={{ borderTop: "1px solid var(--color-border)" }}
        >
          {/* Pending: Claim button */}
          {intent.status === "pending" && (
            <button
              type="button"
              className="px-4 py-1.5 text-xs cursor-pointer"
              style={{
                border: "1px solid #FFB800",
                color: "#FFB800",
                background: "rgba(255,184,0,0.06)",
                fontFamily: "var(--font-mono)",
                borderRadius: "3px",
              }}
              onClick={handleClaim}
            >
              Claim Intent
            </button>
          )}

          {/* Active + owned: Complete / Fail */}
          {intent.status === "active" &&
            isOwner &&
            (activeAction ? (
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={actionText}
                  onChange={(e) => setActionText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && actionText.trim()) {
                      if (activeAction === "complete") handleComplete();
                      else handleFail();
                    }
                    if (e.key === "Escape") {
                      setActiveAction(null);
                      setActionText("");
                    }
                  }}
                  placeholder={activeAction === "complete" ? "Result text..." : "Failure reason..."}
                  className="flex-1 px-2 py-1 text-xs"
                  style={{
                    background: "rgba(17,17,24,0.8)",
                    border: `1px solid ${activeAction === "complete" ? "#22c55e" : "#ef4444"}`,
                    color: "#ddd",
                    fontFamily: "var(--font-mono)",
                    outline: "none",
                    borderRadius: "3px",
                  }}
                />
                <button
                  type="button"
                  className="px-3 py-1 text-xs cursor-pointer"
                  style={{
                    border: `1px solid ${activeAction === "complete" ? "#22c55e" : "#ef4444"}`,
                    color: activeAction === "complete" ? "#22c55e" : "#ef4444",
                    background: "none",
                    fontFamily: "var(--font-mono)",
                    borderRadius: "3px",
                  }}
                  onClick={() => {
                    if (activeAction === "complete") handleComplete();
                    else handleFail();
                  }}
                >
                  Submit
                </button>
                <button
                  type="button"
                  className="px-2 py-1 text-xs cursor-pointer"
                  style={{
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text-dim)",
                    background: "none",
                    fontFamily: "var(--font-mono)",
                    borderRadius: "3px",
                  }}
                  onClick={() => {
                    setActiveAction(null);
                    setActionText("");
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="px-4 py-1.5 text-xs cursor-pointer"
                  style={{
                    border: "1px solid #22c55e",
                    color: "#22c55e",
                    background: "rgba(34,197,94,0.06)",
                    fontFamily: "var(--font-mono)",
                    borderRadius: "3px",
                  }}
                  onClick={() => setActiveAction("complete")}
                >
                  Complete Intent
                </button>
                <button
                  type="button"
                  className="px-4 py-1.5 text-xs cursor-pointer"
                  style={{
                    border: "1px solid #ef4444",
                    color: "#ef4444",
                    background: "rgba(239,68,68,0.06)",
                    fontFamily: "var(--font-mono)",
                    borderRadius: "3px",
                  }}
                  onClick={() => setActiveAction("fail")}
                >
                  Fail Intent
                </button>
              </div>
            ))}

          {/* Status message */}
          {actionStatus && (
            <div className="text-xs mt-1" style={{ color: "var(--color-text-dim)" }}>
              {actionStatus}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const PlaceholderContent = memo(function PlaceholderContent({ type }: { type: ViewerContentType }) {
  return (
    <div
      className="flex flex-col items-center gap-2 py-8"
      style={{ color: "var(--color-text-dim)" }}
    >
      <div className="text-2xl">
        {
          {
            image: "\uD83D\uDDBC",
            video: "\uD83C\uDFA5",
            audio: "\uD83C\uDFB5",
            pdf: "\uD83D\uDCC4",
            document: "\uD83D\uDCDD",
            a2ui: "\uD83E\uDDE9",
            intent: "\uD83C\uDFAF",
            unknown: "\uD83D\uDCC1",
          }[type]
        }
      </div>
      <div className="text-xs">{type.toUpperCase()} viewer -- content will render here</div>
    </div>
  );
});

// ── Main Viewer ─────────────────────────────────────────────────────────────

/**
 * Full-screen overlay for viewing media and canvas node content.
 */
export const Viewer = memo(function Viewer(props: ViewerProps) {
  return <AnimatePresence>{props.open && <ViewerInner {...props} />}</AnimatePresence>;
});

function ViewerInner({ title, contentType, content, onClose }: Omit<ViewerProps, "open">) {
  // Escape to close
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="fixed inset-0 flex flex-col"
      style={{
        zIndex: 100,
        background: "rgba(3,3,6,0.92)",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-4 py-2 shrink-0"
        style={{ borderBottom: "2px solid var(--color-border)" }}
      >
        <span
          className="flex-1 font-bold"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(16px, 1.12vw, 24px)",
            color: "var(--color-primary)",
          }}
        >
          {title}
        </span>
        <span
          className="text-[10px] px-2 py-0.5 uppercase tracking-wider"
          style={{
            borderRadius: "3px",
            border: `1px solid ${TYPE_COLORS[contentType]}`,
            color: TYPE_COLORS[contentType],
          }}
        >
          {contentType}
        </span>
        <button
          type="button"
          className="px-2.5 py-0.5 cursor-pointer hover:brightness-150"
          style={{
            background: "none",
            border: "2px solid var(--color-border)",
            color: "var(--color-text-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: "clamp(18px, 1.12vw, 24px)",
          }}
          onClick={onClose}
        >
          &#10005; Close
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto flex items-center justify-center p-8">
        <div className="w-full max-w-[900px] min-h-[200px]">
          {contentType === "image" && <ImageViewer content={content} />}
          {contentType === "video" && <VideoViewer content={content} />}
          {contentType === "audio" && <AudioViewer content={content} />}
          {contentType === "pdf" && <PdfViewer content={content} />}
          {contentType === "document" && <DocumentViewer content={content} />}
          {contentType === "a2ui" && <A2uiViewer content={content} />}
          {contentType === "intent" && <IntentViewer content={content} />}
          {contentType === "unknown" && <PlaceholderContent type="unknown" />}
        </div>
      </div>
    </motion.div>
  );
}
