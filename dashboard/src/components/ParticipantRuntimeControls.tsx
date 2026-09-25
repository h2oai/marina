// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { type MarinaRoutingClient, RoutingApiError } from "../../../src/sdk/routing-client";
import type { RuntimeControl, RuntimeState } from "../../../src/sdk/routing-runtime-types";

const field = "min-w-0 rounded border border-border bg-surface px-2 py-1 text-xs";
const button = "rounded border border-border px-2 py-1 text-xs text-primary disabled:opacity-40";

export function ParticipantRuntimeControls({
  client,
  sessionId,
}: {
  client: MarinaRoutingClient;
  sessionId: string;
}) {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [adapter, setAdapter] = useState("");
  const [label, setLabel] = useState("");
  const [directory, setDirectory] = useState(".");
  const [model, setModel] = useState("");
  const [workspace, setWorkspace] = useState<"worktree" | "shared">("worktree");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const pending = useRef<{ id: string; control: RuntimeControl } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries failed reads.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { state } = await client.runtime(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        if (
          state &&
          (state.version !== 1 ||
            typeof state.updatedAt !== "number" ||
            !["agent", "supervisor", "attachment"].includes(state.role))
        )
          throw new Error("Unsupported participant runtime state");
        setRuntime(state);
        timer = setTimeout(poll, 5000);
      } catch (err) {
        if (!controller.signal.aborted) {
          setRuntime(null);
          setError(err instanceof Error ? err.message : "Could not load runtime");
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, sessionId, refresh]);
  async function send(control: RuntimeControl) {
    const previous = pending.current;
    if (previous && JSON.stringify(previous.control) !== JSON.stringify(control)) {
      setError("Retry the pending request first so its delivery is known.");
      return;
    }
    const request = previous ?? { id: crypto.randomUUID(), control };
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await client.control(
        sessionId,
        sessionId,
        request.id,
        request.control,
        AbortSignal.timeout(15_000),
      );
      pending.current = null;
      setNotice(`Queued · ${message.id}. Delivery and execution appear in the stream below.`);
      if (control.action === "prompt" || control.action === "launch") setPrompt("");
      if (control.action === "respond") setAnswer("");
      setRefresh((n) => n + 1);
    } catch (err) {
      if (err instanceof RoutingApiError && [400, 401, 403, 404, 413].includes(err.status))
        pending.current = null;
      setError(err instanceof Error ? err.message : "Control request failed");
    } finally {
      setBusy(false);
    }
  }
  const stale = !runtime || Date.now() - runtime.updatedAt > 45_000;
  const disabled = busy || stale;
  const adapters = Array.isArray(runtime?.adapters) ? runtime.adapters : [];
  const selectedAdapter = adapter || adapters[0]?.id || "";
  return (
    <section
      aria-label="Agent controls"
      className="max-h-[45%] shrink-0 overflow-auto border-b border-border p-3"
    >
      {runtime && (
        <p className="mb-2 text-xs text-text-dim">
          {runtime.mode} · {runtime.status}
          {stale ? " · Supervisor connection is stale" : ""} · {runtime.cwd}
          {runtime.nativeSessionId ? ` · Native session ${runtime.nativeSessionId}` : ""}
        </p>
      )}
      {runtime?.error && (
        <p role="status" className="mb-2 text-xs text-warning">
          {runtime.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-2 text-xs">
          {error}{" "}
          <button
            type="button"
            className="text-primary"
            disabled={busy}
            onClick={() => {
              if (pending.current) void send(pending.current.control);
              else {
                setError("");
                setRefresh((n) => n + 1);
              }
            }}
          >
            Retry
          </button>
        </p>
      )}
      {runtime?.role === "supervisor" ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send({
              action: "launch",
              adapter: selectedAdapter,
              label,
              directory,
              workspace,
              ...(model.trim() ? { model: model.trim() } : {}),
              prompt,
            });
          }}
        >
          <select
            aria-label="Agent type"
            className={field}
            value={selectedAdapter}
            onChange={(event) => setAdapter(event.target.value)}
          >
            {adapters.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Agent name"
            required
            maxLength={128}
            placeholder="Agent name"
            className={field}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <input
            aria-label="Project directory"
            required
            placeholder="Directory within root"
            className={field}
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <input
            aria-label="Model (optional)"
            placeholder="Native default model"
            className={field}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <select
            aria-label="Agent workspace"
            className={field}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value as "worktree" | "shared")}
          >
            <option value="worktree">Isolated Git worktree</option>
            <option value="shared">Shared project directory</option>
          </select>
          <p className="w-full text-xs text-text-dim">
            {workspace === "worktree"
              ? "Starts at committed HEAD; uncommitted changes stay in the source project."
              : "Agents can edit the same files. Coordinate ownership before concurrent edits."}{" "}
            Runs locally with the selected agent's tools and permission settings.
          </p>
          <textarea
            aria-label="Initial agent task"
            className={`${field} w-full`}
            placeholder="Initial task (optional)"
            maxLength={16000}
            rows={2}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button type="submit" className={button} disabled={disabled || !selectedAdapter}>
            Launch agent
          </button>
          <span className="self-center text-xs text-text-dim">
            {runtime.activeCount ?? 0} managed agents
          </span>
        </form>
      ) : (
        runtime && (
          <div className="space-y-2">
            {runtime.request && (
              <div className="rounded border border-warning/40 p-2">
                <p className="text-sm font-semibold">{runtime.request.title}</p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(runtime.request.input, null, 2)}
                </pre>
                {runtime.request.kind === "question" && (
                  <textarea
                    aria-label="Agent answer"
                    className={`${field} my-2 w-full`}
                    placeholder={runtime.request.choices?.join(" / ") ?? "Answer"}
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                  />
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={button}
                    disabled={disabled}
                    onClick={() =>
                      void send({
                        action: "respond",
                        requestId: runtime.request!.id,
                        allow: true,
                        answer,
                      })
                    }
                  >
                    {runtime.request.kind === "question" ? "Send answer" : "Allow once"}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={disabled}
                    onClick={() =>
                      void send({ action: "respond", requestId: runtime.request!.id, allow: false })
                    }
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void send({ action: "prompt", text: prompt });
              }}
            >
              <textarea
                aria-label="Message agent"
                required
                className={`${field} flex-1`}
                rows={2}
                maxLength={16000}
                placeholder="Give this agent a task or follow-up…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <button
                type="submit"
                className={button}
                disabled={
                  disabled || ["stopped", "failed", "disconnected"].includes(runtime.status)
                }
              >
                Send
              </button>
            </form>
            <div className="flex gap-2">
              <button
                type="button"
                className={button}
                disabled={disabled || !["running", "waiting"].includes(runtime.status)}
                onClick={() => void send({ action: "interrupt" })}
              >
                Interrupt
              </button>
              {runtime.mode === "managed" && (
                <button
                  type="button"
                  className={button}
                  disabled={disabled || ["stopped", "disconnected"].includes(runtime.status)}
                  onClick={() => void send({ action: "stop" })}
                >
                  Stop agent
                </button>
              )}
            </div>
          </div>
        )
      )}
      {notice && (
        <p role="status" className="mt-2 break-all text-xs">
          {notice}
        </p>
      )}
    </section>
  );
}
