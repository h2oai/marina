// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import type { MarinaRoutingClient } from "../../../src/sdk/routing-client";
import type { RoutingMessage } from "../../../src/sdk/routing-types";
import { useWorkspaceState } from "../hooks/use-workspace-state";

/** Inspecting a delivery never consumes or acknowledges it. */
export function ParticipantDeliveryLog({
  client,
  sessionId,
}: {
  client: MarinaRoutingClient;
  sessionId: string;
}) {
  const [messages, setMessages] = useState<RoutingMessage[]>([]);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly restarts failed polling.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await client.deliveries(sessionId, 100, controller.signal);
        if (controller.signal.aborted) return;
        setMessages(next);
        setError("");
        timer = setTimeout(poll, 5000);
      } catch (err) {
        if (!controller.signal.aborted) {
          setMessages([]);
          setError(err instanceof Error ? err.message : "Could not load deliveries");
        }
      }
    };
    void poll();
    void client
      .channels(sessionId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setChannels(value.channels);
      })
      .catch(() => {
        if (!controller.signal.aborted) setChannels([]);
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, sessionId, retry]);
  return (
    <section
      aria-label="Participant delivery log"
      className="max-h-64 overflow-auto border-t border-border p-3 text-xs"
    >
      <p className="mb-2 text-text-dim">
        Latest 100 deliveries. Queued and acknowledged are transport states; neither proves that
        work is complete.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" className="text-primary" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {channels.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          <span>Native conversations:</span>
          {channels.map((channel) => (
            <button
              type="button"
              key={channel.id}
              className="text-primary"
              onClick={() =>
                useWorkspaceState.getState().inspect({ type: "channel", name: channel.name })
              }
            >
              #{channel.name}
            </button>
          ))}
        </div>
      )}
      {!error && messages.length === 0 && <p className="text-text-dim">No retained deliveries.</p>}
      {!error &&
        messages.map((message) => (
          <article key={message.id} className="mb-3 rounded border border-border p-2">
            <p className="font-semibold">
              {message.sourceId === sessionId ? "Sent" : "Received"} · {message.status} ·{" "}
              {message.kind}
            </p>
            <p className="break-all text-text-dim">
              {message.sourceId} → {message.targetId}
            </p>
            <p className="break-all text-text-dim">
              Receipt {message.id} · Client ID {message.clientMessageId}
            </p>
            <p className="text-text-dim">
              Queued {new Date(message.createdAt).toLocaleString()}
              {message.acknowledgedAt
                ? ` · Acknowledged ${new Date(message.acknowledgedAt).toLocaleString()}`
                : " · Awaiting acknowledgment"}
            </p>
            <pre className="whitespace-pre-wrap break-words">
              {JSON.stringify(message.payload, null, 2)}
            </pre>
          </article>
        ))}
    </section>
  );
}
