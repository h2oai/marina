// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useChatState } from "../hooks/use-chat-state";
import type { DashboardPanelProps } from "../lib/panel-registry";
import { GlassPanel } from "./GlassPanel";
import { PanelResource } from "./panel-resources";

/** Personal projection of an existing session. No publication or selected-session mutation. */
export function CodingDeskPanel({ binding, ...props }: DashboardPanelProps) {
  const sessionId = binding?.kind === "coding" ? binding.id : undefined;
  const resident = useChatState((s) => s.entityName);
  return (
    <CodingDeskView
      key={JSON.stringify([resident, sessionId])}
      sessionId={sessionId}
      resident={resident}
      {...props}
    />
  );
}

function CodingDeskView({
  sessionId,
  resident,
  active = true,
  ...props
}: DashboardPanelProps & {
  sessionId?: string;
  resident: string | null;
}) {
  const connected = useChatState((s) => s.loggedIn && s.connected && s.codingTargetSupported);
  const [draft, setDraft] = useState("");
  const [review, setReview] = useState<{
    request: string;
    sessionId: string;
    resident: string | null;
  }>();
  const [message, setMessage] = useState("");
  const submit = () => {
    if (!review || review.sessionId !== sessionId || review.resident !== resident) return;
    try {
      const sent = useChatState
        .getState()
        .sendCommand(`code ask ${review.request}`, false, { sessionId: review.sessionId });
      if (!sent) {
        setMessage("Sign in to a Marina connection that supports targeted coding requests.");
        return;
      }
      setReview(undefined);
      setMessage(
        "Request sent. Follow session activity and Chat for the outcome; it is not automatically retried.",
      );
    } catch {
      setReview(undefined);
      setMessage("Submission could not be confirmed. Check session activity before sending again.");
    }
  };
  return (
    <GlassPanel title="Coding desk" {...props}>
      {sessionId ? (
        <div className="space-y-3 p-3">
          <PanelResource reference={{ kind: "coding", id: sessionId }} active={active} />
          <label className="block text-sm">
            Request for coder
            <textarea
              className="mission-field"
              value={draft}
              maxLength={16384}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="text-primary"
            disabled={!connected || !draft.trim()}
            onClick={() => {
              setReview({ request: draft.trim(), sessionId, resident });
              setMessage("");
            }}
          >
            Review coding request
          </button>
          {review && (
            <section
              aria-label="Review coding request"
              className="rounded border border-border p-3 space-y-2"
            >
              <p>
                Send as {review.resident} to session {review.sessionId}
              </p>
              <pre className="whitespace-pre-wrap break-words">{review.request}</pre>
              <button
                type="button"
                className="mr-3 text-primary"
                onClick={() => setReview(undefined)}
              >
                Cancel
              </button>
              <button type="button" className="text-primary" disabled={!connected} onClick={submit}>
                Confirm request
              </button>
            </section>
          )}
          {message && <p role="status">{message}</p>}
          <p className="text-xs">
            This is your local view. Closing it leaves the coder and world running.
          </p>
          <PanelResource reference={{ kind: "feed", limit: 10 }} active={active} />
        </div>
      ) : (
        <p className="p-3">Open an existing coding session from Work.</p>
      )}
    </GlassPanel>
  );
}
