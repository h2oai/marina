/**
 * WelcomeTour -- Ambient orientation card for the unified dashboard.
 *
 * Sits top-left under the layer chips. Non-blocking (the world keeps humming
 * behind it) and instance-scoped — each distinct Marina instance triggers
 * a fresh orientation pass even in the same browser, because a restart,
 * import, or clone is a new world that may benefit from being introduced.
 *
 * Can be force-reopened via the `force` prop from a "replay tour" link on
 * the LEGEND tab of the WorldNav panel.
 */

import { AnimatePresence, motion } from "motion/react";
import { memo, useState } from "react";

const STORAGE_PREFIX = "uc:tour-seen:";

function storageKey(instanceName: string | null | undefined): string {
  return `${STORAGE_PREFIX}${instanceName ?? "default"}`;
}

/** Did the user already dismiss the tour for this instance? */
export function hasSeenTour(instanceName: string | null | undefined): boolean {
  try {
    return localStorage.getItem(storageKey(instanceName)) === "true";
  } catch {
    return true;
  }
}

function markSeen(instanceName: string | null | undefined): void {
  try {
    localStorage.setItem(storageKey(instanceName), "true");
  } catch {
    // ignore
  }
}

/** Clear the seen flag for an instance — used by the "replay tour" action. */
export function clearSeenTour(instanceName: string | null | undefined): void {
  try {
    localStorage.removeItem(storageKey(instanceName));
  } catch {
    // ignore
  }
}

export interface WelcomeTourProps {
  /** Instance name — used to scope the seen flag so each world gets its own pass. */
  instanceName?: string | null;
  /** Override automatic first-visit detection (for a "replay" button). */
  force?: boolean;
  /** Suppress entirely (e.g., clearView mode). */
  hidden?: boolean;
}

export const WelcomeTour = memo(function WelcomeTour({
  instanceName,
  force,
  hidden,
}: WelcomeTourProps) {
  const [dismissed, setDismissed] = useState<boolean>(() =>
    force ? false : hasSeenTour(instanceName),
  );

  const close = () => {
    markSeen(instanceName);
    setDismissed(true);
  };

  const visible = !hidden && !dismissed;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: -16, y: -4 }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, x: -16, y: -4 }}
          transition={{ type: "spring", stiffness: 280, damping: 30 }}
          style={{
            position: "absolute",
            top: 82,
            left: 12,
            width: "min(340px, 26vw)",
            background: "rgba(10, 10, 16, 0.94)",
            border: "1px solid rgba(255,221,0,0.4)",
            borderRadius: 4,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            padding: "10px 12px",
            fontFamily: "'VT323', monospace",
            color: "#ddd",
            fontSize: 13,
            lineHeight: 1.4,
            zIndex: 35,
            pointerEvents: "auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <span
              style={{
                color: "#FFDD00",
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 9,
                letterSpacing: 1.2,
                flex: 1,
              }}
            >
              {instanceName ? instanceName.toUpperCase() : "MARINA"}
            </span>
            <button
              type="button"
              onClick={close}
              style={{
                padding: "1px 6px",
                background: "transparent",
                border: "1px solid #444",
                color: "#888",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                borderRadius: 2,
              }}
              title="Dismiss orientation"
            >
              ×
            </button>
          </div>

          <p style={{ margin: "0 0 6px 0", color: "#ccc" }}>
            You're seeing four live layers at once:
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
            <Row color="#FFDD00" label="WORLD" desc="rooms + who's in them" />
            <Row color="#06b6d4" label="CANVAS" desc="docs, intents, drop-ins" />
            <Row color="#a855f7" label="GRAPH" desc="agents' knowledge" />
            <Row color="#22c55e" label="FEED" desc="live activity timeline" />
          </div>

          <p style={{ margin: "0 0 6px 0", color: "#aaa", fontSize: 12 }}>
            Chips top-left toggle layers. <b style={{ color: "#FFDD00" }}>1–4</b> from anywhere.{" "}
            <b style={{ color: "#FFDD00" }}>LEGEND</b> top-right for colors.
          </p>

          <p style={{ margin: "0", color: "#777", fontSize: 11, lineHeight: 1.3 }}>
            Same data, same commands are available from the terminal.
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

function Row({ color, label, desc }: { color: string; label: string; desc: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12 }}>
      <span
        style={{
          display: "inline-block",
          minWidth: 56,
          padding: "1px 4px",
          background: `${color}22`,
          border: `1px solid ${color}`,
          color,
          fontFamily: "'Press Start 2P', monospace",
          fontSize: 8,
          letterSpacing: 0.8,
          textAlign: "center",
          borderRadius: 2,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span style={{ color: "#aaa" }}>{desc}</span>
    </div>
  );
}
