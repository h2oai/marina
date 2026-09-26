// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import type { MarinaRoutingClient } from "../../../src/sdk/routing-client";
import type { RuntimeControl, RuntimeState } from "../../../src/sdk/routing-runtime-types";
import { runtimeState } from "../hooks/use-routing-overview";
import { useRuntimeCommand } from "../hooks/use-runtime-command";

const field = "min-w-0 rounded border border-border bg-surface px-2 py-1 text-xs";
const button = "rounded border border-border px-2 py-1 text-xs text-primary disabled:opacity-40";

export function ParticipantRuntimeControls({
  client,
  sessionId,
  active = true,
}: {
  client: MarinaRoutingClient;
  sessionId: string;
  active?: boolean;
}) {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [readError, setError] = useState("");
  const command = useRuntimeCommand(client, sessionId);
  const { busy, notice } = command;
  const error = command.error || readError;
  const [refresh, setRefresh] = useState(0);
  const [adapter, setAdapter] = useState("");
  const [label, setLabel] = useState("");
  const [directory, setDirectory] = useState(".");
  const [model, setModel] = useState("");
  const [workspace, setWorkspace] = useState<"worktree" | "shared">("worktree");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries failed reads.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { state } = await client.runtime(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        const parsed = runtimeState(state);
        if (state && !parsed) throw new Error("Unsupported participant runtime state");
        setRuntime(parsed);
        setError("");
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
  }, [client, sessionId, refresh, active]);
  async function send(control: RuntimeControl) {
    setError("");
    if (await command.send(control)) {
      if (control.action === "prompt" || control.action === "launch") {
        const sent = control.action === "prompt" ? control.text : control.prompt;
        setPrompt((current) => (current === sent ? "" : current));
      }
      if (control.action === "respond")
        setAnswer((current) => (current === control.answer ? "" : current));
      setRefresh((n) => n + 1);
    }
  }
  const stale = !runtime || Date.now() - runtime.updatedAt > 45_000;
  const disabled = !active || busy || stale;
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
              if (command.pending) void send(command.pending.control);
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
