// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { MarinaRoutingClient, RoutingApiError } from "../../../src/sdk/routing-client";
import type { RoutingSession, RoutingSessionPage } from "../../../src/sdk/routing-types";
import { useChatState } from "../hooks/use-chat-state";
import { useParticipantOutput } from "../hooks/use-participant-output";
import { useWorkspaceState } from "../hooks/use-workspace-state";
import { getToken } from "../lib/api";
import { ParticipantActivity } from "./ParticipantActivity";
import { ParticipantDeliveryLog } from "./ParticipantDeliveryLog";
import { ParticipantRuntimeControls } from "./ParticipantRuntimeControls";

function errorText(error: unknown): string {
  if (error instanceof RoutingApiError && [401, 403].includes(error.status))
    return "Log in to view streams shared with your Marina account.";
  return error instanceof Error ? error.message : "Could not load participant streams.";
}
function StreamOutput({
  client,
  session,
  active,
}: {
  client: MarinaRoutingClient;
  session: RoutingSession;
  active: boolean;
}) {
  const { events, gap, error, loaded, catchingUp, replay } = useParticipantOutput(
    client,
    session.id,
    session.lastSequence,
    active,
  );
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [following, setFollowing] = useState(true);
  const viewport = useRef<HTMLElement>(null);
  const sequence = events.at(-1)?.sequence;
  useEffect(() => {
    if (active && following && sequence !== undefined && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [active, following, sequence]);
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
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-primary">
          <button type="button" onClick={replay}>
            Replay retained history
          </button>
          <button type="button" aria-pressed={following} onClick={() => setFollowing(!following)}>
            {following ? "Pause following" : "Follow latest"}
          </button>
        </div>
      </div>
      {session.capabilities.includes("runtime.control") && (
        <ParticipantRuntimeControls client={client} sessionId={session.id} active={active} />
      )}
      {error ? (
        <div role="alert" className="p-3 text-sm">
          {error}{" "}
          <button type="button" onClick={replay} className="text-primary">
            Retry
          </button>
        </div>
      ) : (
        <section
          ref={viewport}
          className="min-h-0 flex-1 overflow-auto p-3"
          aria-label="Published output"
          onScroll={(event) => {
            const node = event.currentTarget;
            if (node.scrollHeight - node.scrollTop - node.clientHeight > 40) setFollowing(false);
          }}
        >
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
          {catchingUp && (
            <p role="status" className="text-xs text-text-dim">
              Loading retained activity…
            </p>
          )}
          {loaded && <ParticipantActivity events={events} adapter={session.kind} />}
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
      {showDeliveries && (
        <ParticipantDeliveryLog client={client} sessionId={session.id} active={active} />
      )}
    </section>
  );
}

export function ParticipantStreamWorkspace({
  token,
  autoSelect = false,
  active = true,
}: {
  token: string;
  autoSelect?: boolean;
  active?: boolean;
}) {
  const [client] = useState(() => new MarinaRoutingClient({ url: window.location.origin, token }));
  const [page, setPage] = useState<RoutingSessionPage>();
  const [after, setAfter] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const requested = useWorkspaceState((state) => state.participantId);
  const [direct, setDirect] = useState<RoutingSession>();
  const [directError, setDirectError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly repeats a failed direct lookup.
  useEffect(() => {
    if (!active || !requested) return;
    setSelected(requested);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      void client
        .session(requested, controller.signal)
        .then((session) => {
          if (!controller.signal.aborted) {
            setDirect(session);
            setDirectError("");
            timer = setTimeout(poll, 5000);
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setDirect(undefined);
            setDirectError(errorText(cause));
          }
        });
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, client, requested, retry]);
  useEffect(() => {
    if (!autoSelect || selected !== undefined) return;
    const newest = page?.sessions
      .filter((session) => session.kind !== "supervisor")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest) setSelected(newest.id);
  }, [autoSelect, page, selected]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly restarts a failed request.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
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
          setDirect(undefined);
          setError(errorText(err));
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, after, retry, active]);
  const selectedId =
    selected ??
    (autoSelect
      ? page?.sessions
          .filter((session) => session.kind !== "supervisor")
          .sort((a, b) => b.createdAt - a.createdAt)[0]?.id
      : undefined);
  const chosen =
    error || (requested && directError)
      ? undefined
      : (page?.sessions.find((session) => session.id === selectedId) ??
        (direct?.id === selectedId ? direct : undefined));
  const visible = page?.sessions.filter((session) =>
    `${session.label} ${session.kind}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div
      hidden={!active}
      className={active ? "flex h-full min-h-0 flex-col sm:flex-row" : "hidden"}
    >
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
        {(error || (requested && directError)) && (
          <div role="alert" className="text-sm">
            {error || directError}{" "}
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
        {page && page.sessions.length > 0 && visible?.length === 0 && (
          <p role="status" className="mb-2 text-sm text-text-dim">
            No participants match on this page.
          </p>
        )}
        {visible?.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={selectedId === s.id}
            onClick={() => {
              setSelected(s.id);
              useWorkspaceState.setState({ participantId: null });
              setDirect(undefined);
            }}
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
                setPage(undefined);
                setSelected(undefined);
                useWorkspaceState.setState({ participantId: null });
                setDirect(undefined);
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
                setPage(undefined);
                setSelected(undefined);
                useWorkspaceState.setState({ participantId: null });
                setDirect(undefined);
              }}
            >
              Next page
            </button>
          )}
        </div>
      </aside>
      {chosen ? (
        <StreamOutput key={chosen.id} client={client} session={chosen} active={active} />
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
  if (!loggedIn || !token)
    return active ? (
      <p className="p-4 text-sm">Log in through Chat to view participant streams.</p>
    ) : null;
  return <ParticipantStreamWorkspace key={token} token={token} active={active} />;
}
