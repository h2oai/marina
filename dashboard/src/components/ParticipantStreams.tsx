// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { MarinaRoutingClient, RoutingApiError } from "../../../src/sdk/routing-client";
import type {
  RoutingEvent,
  RoutingSession,
  RoutingSessionPage,
} from "../../../src/sdk/routing-types";
import { useChatState } from "../hooks/use-chat-state";
import { getToken } from "../lib/api";
import { ParticipantDeliveryLog } from "./ParticipantDeliveryLog";
import { ParticipantRuntimeControls } from "./ParticipantRuntimeControls";

function errorText(error: unknown): string {
  if (error instanceof RoutingApiError && [401, 403].includes(error.status))
    return "Log in to view streams shared with your Marina account.";
  return error instanceof Error ? error.message : "Could not load participant streams.";
}
function output(event: RoutingEvent): string {
  if (typeof event.payload === "string") return event.payload;
  if (
    event.payload &&
    typeof event.payload === "object" &&
    "text" in event.payload &&
    typeof event.payload.text === "string"
  )
    return event.payload.text;
  return JSON.stringify(event.payload, null, 2);
}

function StreamOutput({
  client,
  session,
}: {
  client: MarinaRoutingClient;
  session: RoutingSession;
}) {
  const [initialCursor] = useState(() => Math.max(0, session.lastSequence - 100));
  const [events, setEvents] = useState<RoutingEvent[]>([]);
  const [gap, setGap] = useState(false);
  const [error, setError] = useState("");
  const [restart, setRestart] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [showDeliveries, setShowDeliveries] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = restart ? 0 : initialCursor;
    setEvents([]);
    setGap(false);
    setLoaded(false);
    setError("");
    const poll = async () => {
      try {
        const page = await client.events(session.id, cursor, 100, controller.signal);
        if (controller.signal.aborted) return;
        cursor = page.nextCursor;
        setEvents((previous) => [...previous, ...page.events].slice(-500));
        setGap((previous) => previous || page.gap);
        setError("");
        setLoaded(true);
        timer = setTimeout(poll, 2000);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(errorText(err));
        // Hide previously fetched content when access is lost. Retry is explicit.
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // A roster refresh must not reset the selected stream's cursor.
  }, [client, session.id, restart, initialCursor]);
  return (
    <section
      aria-label={`${session.label} output`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b border-border p-3">
        <h3 className="font-semibold">{session.label}</h3>
        <p className="break-all text-xs text-text-dim">
          {session.kind} · {session.state === "left" ? "Left" : "Registered"} · Last seen{" "}
          {new Date(session.lastSeenAt).toLocaleString()}
        </p>
        <p className="break-all text-xs text-text-dim">
          {session.id} · {session.groupId ? `Group ${session.groupId}` : "Private"}
        </p>
        <button
          type="button"
          className="mt-2 text-xs text-primary"
          onClick={() => setRestart((n) => n + 1)}
        >
          Replay retained history
        </button>
      </div>
      {session.capabilities.includes("runtime.control") && (
        <ParticipantRuntimeControls client={client} sessionId={session.id} />
      )}
      {error ? (
        <div role="alert" className="p-3 text-sm">
          {error}{" "}
          <button type="button" onClick={() => setRestart((n) => n + 1)} className="text-primary">
            Retry
          </button>
        </div>
      ) : (
        <section className="min-h-0 flex-1 overflow-auto p-3" aria-label="Published output">
          {gap && (
            <p role="status" className="mb-2 text-sm text-warning">
              Some earlier output has expired. This history is incomplete.
            </p>
          )}
          {!loaded && (
            <p role="status" className="animate-pulse text-sm text-text-dim">
              Loading output…
            </p>
          )}
          {loaded && events.length === 0 && (
            <p className="text-sm text-text-dim">Waiting for this participant to publish output.</p>
          )}
          {events.length >= 500 && (
            <p className="text-xs text-text-dim">Showing the latest 500 loaded events.</p>
          )}
          {events.map((event) => (
            <article key={event.sequence} className="mb-3">
              <p className="text-xs text-text-dim">
                #{event.sequence} · {event.kind} · {new Date(event.createdAt).toLocaleTimeString()}
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {output(event)}
              </pre>
            </article>
          ))}
        </section>
      )}
      <div className="shrink-0 border-t border-border p-2 text-xs">
        <button
          type="button"
          className="text-primary"
          aria-expanded={showDeliveries}
          onClick={() => setShowDeliveries((value) => !value)}
        >
          {showDeliveries ? "Hide delivery log" : "Inspect deliveries and conversations"}
        </button>
      </div>
      {showDeliveries && <ParticipantDeliveryLog client={client} sessionId={session.id} />}
    </section>
  );
}

export function ParticipantStreamWorkspace({
  token,
  autoSelect = false,
}: {
  token: string;
  autoSelect?: boolean;
}) {
  const [client] = useState(() => new MarinaRoutingClient({ url: window.location.origin, token }));
  const [page, setPage] = useState<RoutingSessionPage>();
  const [after, setAfter] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly restarts a failed request.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setPage(undefined);
    setError("");
    const poll = async () => {
      try {
        const next = await client.discover(after, 100, controller.signal);
        if (controller.signal.aborted) return;
        setPage(next);
        setError("");
        timer = setTimeout(poll, 5000);
      } catch (err) {
        if (!controller.signal.aborted) {
          setPage(undefined);
          setError(errorText(err));
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, after, retry]);
  const selectedId =
    selected ??
    (autoSelect
      ? page?.sessions
          .filter((session) => session.kind !== "supervisor")
          .sort((a, b) => b.createdAt - a.createdAt)[0]?.id
      : undefined);
  const chosen = page?.sessions.find((session) => session.id === selectedId);
  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <aside
        aria-label="Participants"
        className="max-h-[40%] shrink-0 overflow-auto border-b border-border p-3 sm:max-h-full sm:w-56 sm:border-b-0 sm:border-r"
      >
        <h2 className="mb-1 font-semibold">Participant streams</h2>
        <p className="mb-3 text-xs text-text-dim">
          Output published by connected clients. Registration does not mean a process is running.
        </p>
        <input
          aria-label="Filter this participant page"
          placeholder="Filter this page…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mb-2 w-full rounded border border-border bg-surface px-2 py-1 text-sm"
        />
        {error && (
          <div role="alert" className="text-sm">
            {error}{" "}
            <button type="button" className="text-primary" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {!error && !page && (
          <p role="status" className="animate-pulse text-sm">
            Loading participants…
          </p>
        )}
        {page?.sessions.length === 0 && (
          <p className="text-sm text-text-dim">
            Start marina supervise --root /path/to/project to manage local agents here, or join with
            the routing SDK or HTTP API.
          </p>
        )}
        {page?.sessions
          .filter((s) => `${s.label} ${s.kind}`.toLowerCase().includes(filter.toLowerCase()))
          .map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={selectedId === s.id}
              onClick={() => setSelected(s.id)}
              className={`mb-1 block w-full rounded p-2 text-left text-sm ${selectedId === s.id ? "bg-primary/15 text-primary" : "hover:bg-surface"}`}
            >
              <span className="block truncate">{s.label}</span>
              <span className="text-xs text-text-dim">
                {s.kind} · {s.state === "left" ? "Left" : "Registered"}
              </span>
            </button>
          ))}
        <div className="flex gap-3 text-xs text-primary">
          {after && (
            <button
              type="button"
              onClick={() => {
                setAfter("");
                setSelected(undefined);
              }}
            >
              First page
            </button>
          )}
          {page?.nextCursor && (
            <button
              type="button"
              onClick={() => {
                setAfter(page.nextCursor!);
                setSelected(undefined);
              }}
            >
              Next page
            </button>
          )}
        </div>
      </aside>
      {chosen ? (
        <StreamOutput key={chosen.id} client={client} session={chosen} />
      ) : (
        <p className="p-4 text-sm text-text-dim">Select a participant to follow its output.</p>
      )}
    </div>
  );
}

export function ParticipantStreams({ active }: { active: boolean }) {
  // Subscribe to login/logout transitions so private output is unmounted immediately.
  const loggedIn = useChatState((s) => s.loggedIn);
  const token = getToken();
  if (!active) return null;
  if (!loggedIn || !token)
    return <p className="p-4 text-sm">Log in through Chat to view participant streams.</p>;
  return <ParticipantStreamWorkspace key={token} token={token} />;
}
