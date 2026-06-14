import { Pause, Play, SkipBack, SkipForward, Timeline } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFeedState } from "../hooks/use-feed-state";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";

export function NarrativePlayback({ isFocused, onToggleFocus }: PanelFocusProps = {}) {
  const events = useFeedState((s) => s.events);
  const ordered = useMemo(() => [...events].reverse(), [events]);
  const [cursor, setCursor] = useState(ordered.length > 0 ? ordered.length - 1 : 0);
  const [playing, setPlaying] = useState(false);

  // Follow the live edge only when the viewer is already parked at it; if they
  // scrubbed back, incoming events must not yank the playhead to the end.
  const prevLenRef = useRef(ordered.length);
  useEffect(() => {
    const prevLen = prevLenRef.current;
    prevLenRef.current = ordered.length;
    if (ordered.length === 0) {
      setCursor(0);
      return;
    }
    setCursor((c) => (c >= prevLen - 1 ? ordered.length - 1 : Math.min(c, ordered.length - 1)));
  }, [ordered.length]);

  useEffect(() => {
    if (!playing || ordered.length === 0) return undefined;
    const id = window.setInterval(() => {
      setCursor((prev) => {
        const next = prev + 1;
        return next >= ordered.length ? 0 : next;
      });
    }, 2500);
    return () => window.clearInterval(id);
  }, [playing, ordered.length]);

  const current = ordered[cursor] ?? null;

  return (
    <GlassPanel
      title="Narrative Playback"
      icon={<Timeline size={14} />}
      isFocused={isFocused}
      onToggleFocus={onToggleFocus}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-3 py-2 text-[11px] text-text">
        {/* Transport controls — fixed; never scroll out of reach. */}
        <div className="shrink-0 space-y-2">
          <div className="flex items-center gap-1 text-text-dim">
            <button
              type="button"
              onClick={() =>
                setCursor((prev) => (prev > 0 ? prev - 1 : Math.max(ordered.length - 1, 0)))
              }
              className="rounded border border-border bg-bg px-1 py-0.5 text-text hover:text-primary transition-colors disabled:opacity-40 disabled:hover:text-text"
              disabled={ordered.length === 0}
              title="Previous event"
            >
              <SkipBack size={11} />
            </button>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="rounded border border-border bg-bg px-1 py-0.5 text-text hover:text-primary transition-colors disabled:opacity-40 disabled:hover:text-text"
              disabled={ordered.length === 0}
              title={playing ? "Pause playback" : "Play timeline"}
            >
              {playing ? <Pause size={11} /> : <Play size={11} />}
            </button>
            <button
              type="button"
              onClick={() => setCursor((prev) => (prev + 1) % Math.max(ordered.length, 1))}
              className="rounded border border-border bg-bg px-1 py-0.5 text-text hover:text-primary transition-colors disabled:opacity-40 disabled:hover:text-text"
              disabled={ordered.length === 0}
              title="Next event"
            >
              <SkipForward size={11} />
            </button>
            <span className="ml-2 text-text-dim">
              {ordered.length === 0
                ? "Waiting for activity…"
                : `Event ${cursor + 1} / ${ordered.length}`}
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={Math.max(ordered.length - 1, 0)}
            value={cursor}
            onChange={(e) => setCursor(Number.parseInt(e.target.value, 10))}
            disabled={ordered.length === 0}
            className="w-full accent-primary"
            aria-label="Narrative timeline position"
          />
        </div>

        {/* Event detail — scrolls when the summary/payload exceeds panel height. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {current ? (
            <div className="rounded border border-border bg-bg/50 px-2 py-2">
              <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
                <span>{current.kind}</span>
                <span>{new Date(current.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-text-bright">
                {current.summary}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-text-dim">
                <div>
                  <span className="text-text">Entity:</span>{" "}
                  <span className="text-text-bright">{current.entity ?? "system"}</span>
                </div>
                <div>
                  <span className="text-text">Ref:</span>{" "}
                  <span className="text-text-bright">{current.ref ?? "—"}</span>
                </div>
              </div>
              {current.payload && Object.keys(current.payload).length > 0 && (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-bg px-2 py-1 text-[10px] text-text/80">
                  {JSON.stringify(current.payload, null, 2)}
                </pre>
              )}
            </div>
          ) : (
            <div className="rounded border border-border bg-bg/40 px-2 py-2 text-text-dim">
              Playback will appear once feed events arrive.
            </div>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
