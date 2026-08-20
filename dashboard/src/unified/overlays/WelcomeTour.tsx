// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

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
import { useChatState } from "../../hooks/use-chat-state";

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
  /** Expand and focus the command bar. */
  onOpenTerminal?: () => void;
}

export const WelcomeTour = memo(function WelcomeTour({
  instanceName,
  force,
  hidden,
  onOpenTerminal,
}: WelcomeTourProps) {
  const loggedIn = useChatState((state) => state.loggedIn);
  const entityName = useChatState((state) => state.entityName);
  const sendCommand = useChatState((state) => state.sendCommand);
  const [dismissed, setDismissed] = useState<boolean>(() =>
    force ? false : hasSeenTour(instanceName),
  );

  const close = () => {
    markSeen(instanceName);
    setDismissed(true);
  };

  const visible = !hidden && !dismissed;

  const run = (command: string) => {
    onOpenTerminal?.();
    sendCommand(command);
  };

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
            width: "min(390px, calc(100vw - 24px))",
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
              START HERE · {instanceName ? instanceName.toUpperCase() : "MARINA"}
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

          {!loggedIn ? (
            <>
              <p style={{ margin: "0 0 8px", color: "#ccc" }}>
                Join the world first. Choose a name in the command bar; no account is required on
                the default local setup.
              </p>
              <TourButton label="1 · CHOOSE A NAME" onClick={onOpenTerminal} />
              <p style={{ margin: "8px 0 0", color: "#777", fontSize: 11 }}>
                If login is disabled, ask the instance operator which authentication method to use.
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 8px", color: "#ccc" }}>
                You're in{entityName ? ` as ${entityName}` : ""}. These safe commands provide a
                complete first orientation; their results appear in the command bar.
              </p>
              <div style={{ display: "grid", gap: 5 }}>
                <TourButton label="1 · LOOK AROUND" onClick={() => run("look")} />
                <TourButton label="2 · READ YOUR BRIEF" onClick={() => run("brief")} />
                <TourButton label="3 · FIND THE NEXT ACTION" onClick={() => run("next")} />
              </div>
              <p style={{ margin: "8px 0 0", color: "#888", fontSize: 11, lineHeight: 1.35 }}>
                WORLD, CANVAS, GRAPH, and FEED chips toggle the live layers. Replay this guide from
                LEGEND.
              </p>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
});

function TourButton({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: "100%",
        padding: "6px 8px",
        background: "rgba(255,221,0,0.08)",
        border: "1px solid rgba(255,221,0,0.45)",
        color: "#FFDD00",
        cursor: "pointer",
        fontFamily: "'Press Start 2P', monospace",
        fontSize: 8,
        letterSpacing: 0.6,
        textAlign: "left",
        borderRadius: 2,
      }}
    >
      {label} →
    </button>
  );
}
