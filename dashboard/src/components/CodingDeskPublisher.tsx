// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { codingDesk } from "../../../src/sdk/coding-desk";
import type { MarinaPanelClient } from "../../../src/sdk/panel-client";
import type { RoutingOverview } from "../../../src/sdk/routing-types";
import { getToken } from "../lib/api";
import { openBoundPanel } from "../lib/panel-bindings";

export function CodingDeskPublisher({
  canvasId,
  client,
  onPublished,
}: {
  canvasId: string;
  client: MarinaPanelClient;
  onPublished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessionId, setSession] = useState("");
  const [taskId, setTask] = useState("");
  const [participantId, setParticipant] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const sessions = useQuery({
    queryKey: ["desk-sessions", getToken()],
    queryFn: ({ signal }) =>
      client.request<{ items: Array<{ id: string; title: string }> }>(
        "/api/coding/sessions?limit=100",
        "GET",
        undefined,
        signal,
      ),
    enabled: open,
    retry: false,
  });
  const participants = useQuery({
    queryKey: ["desk-participants", getToken()],
    queryFn: ({ signal }) =>
      client.request<RoutingOverview>("/api/routing/overview?limit=100", "GET", undefined, signal),
    enabled: open,
    retry: false,
  });
  async function publish() {
    setPending(true);
    setError("");
    try {
      const node = await client.publish(
        canvasId,
        codingDesk({
          sessionId,
          ...(taskId ? { taskId } : {}),
          ...(participantId ? { participantId } : {}),
        }),
      );
      onPublished();
      openBoundPanel({ kind: "canvas-node", canvasId, nodeId: node.id });
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not publish desk.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-2 border-b border-border pb-3">
      <button
        type="button"
        className="text-primary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Create coding desk
      </button>
      {open && (
        <>
          <p className="text-xs">
            Use an existing coding session. Publishing adds a shared definition with references;
            each reader keeps their own access and drafts.
          </p>
          <label className="block text-sm">
            Coding session
            <select
              aria-label="Coding session"
              className="mission-field"
              value={sessionId}
              onChange={(e) => setSession(e.target.value)}
            >
              <option value="">Choose a session…</option>
              {!sessions.isError &&
                sessions.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} · {s.id}
                  </option>
                ))}
            </select>
          </label>
          {sessions.data?.items.length === 0 && (
            <p>No sessions yet. Start a coding session in Chat or the Marina terminal.</p>
          )}
          <label className="block text-sm">
            Task ID (optional)
            <input
              className="mission-field"
              inputMode="numeric"
              value={taskId}
              onChange={(e) => setTask(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Participant (optional)
            <select
              aria-label="Participant (optional)"
              className="mission-field"
              value={participantId}
              onChange={(e) => setParticipant(e.target.value)}
            >
              <option value="">No additional participant</option>
              {!participants.isError &&
                participants.data?.items.map(({ session }) => (
                  <option key={session.id} value={session.id}>
                    {session.label}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            className="mission-primary"
            disabled={!sessionId || pending || sessions.isError}
            onClick={() => void publish()}
          >
            {pending ? "Publishing…" : "Publish and open desk"}
          </button>
          {(error || sessions.isError) && (
            <p role="alert">{error || "Coding sessions unavailable or access denied."}</p>
          )}
        </>
      )}
    </section>
  );
}
