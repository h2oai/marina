// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { ArrowUpRight, Bot, Layers3, Rocket, Save, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { MarinaRoutingClient } from "../../../src/sdk/routing-client";
import { useProjects } from "../hooks/use-api";
import { useChatState } from "../hooks/use-chat-state";
import { runtimeState, useRoutingOverview } from "../hooks/use-routing-overview";
import { useRuntimeCommand } from "../hooks/use-runtime-command";
import { openParticipant, useWorkspaceState } from "../hooks/use-workspace-state";
import { getToken } from "../lib/api";

interface Harness {
  mode: "solo" | "crew" | "native";
  adapter: string;
  model: string;
  directory: string;
  workspace: "worktree" | "shared";
}
const defaults: Harness = {
  mode: "solo",
  adapter: "",
  model: "",
  directory: ".",
  workspace: "worktree",
};
function loadHarness(key: string): Harness {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      ["solo", "crew", "native"].includes(value.mode) &&
      ["worktree", "shared"].includes(value.workspace) &&
      [value.adapter, value.model, value.directory].every(
        (field) => typeof field === "string" && field.length <= 1024,
      )
    )
      return value;
  } catch {
    /* Storage is optional; keep this launch usable. */
  }
  return defaults;
}

export function WorkLauncher({ active = true }: { active?: boolean }) {
  const identity = useChatState((state) => state.entityName);
  const loggedIn = useChatState((state) => state.loggedIn);
  return (
    <LaunchForm key={identity ?? "guest"} identity={identity} loggedIn={loggedIn} active={active} />
  );
}
function LaunchForm({
  identity,
  loggedIn,
  active,
}: {
  identity: string | null;
  loggedIn: boolean;
  active: boolean;
}) {
  const storageKey = `marina:work-harness:${window.location.origin}:${identity}`;
  const [harness, setHarness] = useState(() => loadHarness(storageKey));
  const [goal, setGoal] = useState("");
  const [projectId, setProject] = useState("");
  const [name, setName] = useState("");
  const [after, setAfter] = useState("");
  const [supervisorId, setSupervisor] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const projects = useProjects();
  const participants = useRoutingOverview(false, after, active && harness.mode === "native");
  const supervisors = (participants.data?.items ?? []).filter(
    (item) =>
      item.owned &&
      item.session.state === "active" &&
      runtimeState(item.runtime)?.role === "supervisor",
  );
  const selected = supervisors.find((item) => item.session.id === supervisorId) ?? supervisors[0];
  const runtime = runtimeState(selected?.runtime);
  const adapters = runtime?.adapters ?? [];
  const adapter =
    adapters.find((value) => value.id === harness.adapter)?.id ?? adapters[0]?.id ?? "";
  const token = getToken() ?? "";
  const client = useMemo(
    () => new MarinaRoutingClient({ url: window.location.origin, token }),
    [token],
  );
  const command = useRuntimeCommand(client, selected?.session.id ?? "");
  const locked = command.busy || !!command.pending;
  const patch = (value: Partial<Harness>) => {
    if (value.mode) {
      setNotice("");
      setError("");
      command.clearFeedback();
    }
    setHarness((current) => ({ ...current, ...value }));
  };
  const project = projects.data?.find((item) => item.id === projectId);
  const prompt = project
    ? `Project context: ${project.name}\n${project.description ?? ""}\n\n${goal}`
    : goal;
  const stale = !runtime || Date.now() - runtime.updatedAt > 45000;
  return (
    <section className="mission-launch mb-4" aria-label="Start work">
      <div className="relative mb-4 flex items-start gap-3">
        <span className="mission-icon mission-icon-large">
          <Sparkles size={22} />
        </span>
        <div>
          <p className="mission-eyebrow">Ideas into motion</p>
          <h3 className="font-display text-lg font-semibold text-text-bright">Start something.</h3>
          <p className="mt-1 text-sm text-text-dim">
            A small fix. A bold experiment. A whole new world.
          </p>
        </div>
      </div>
      <form
        className="relative space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          if (!loggedIn) {
            setError("Connect in Chat to start work.");
            return;
          }
          if (harness.mode === "native") {
            if (!selected || stale || !adapter) {
              setError("Choose an available supervisor and runtime.");
              return;
            }
            const sent = await command.send({
              action: "launch",
              adapter,
              label: name.trim(),
              directory: harness.directory,
              workspace: harness.workspace,
              ...(harness.model.trim() ? { model: harness.model.trim() } : {}),
              prompt,
            });
            if (sent) {
              setGoal("");
              openParticipant(selected.session.id);
            }
          } else {
            if (
              !useChatState
                .getState()
                .sendCommand(`code ${harness.mode === "crew" ? "crew" : "do"} ${prompt}`)
            ) {
              setError("Chat is disconnected. Reconnect before sending this task.");
              return;
            }
            setGoal("");
            setNotice(
              "Sent to Marina. Follow progress in Chat and review the recorded work below.",
            );
            useWorkspaceState.setState({ pane: "webchat" });
          }
        }}
      >
        <fieldset className="grid grid-cols-3 gap-2" aria-label="Work harness">
          {(
            [
              ["solo", "Marina", Sparkles],
              ["crew", "Crew", Layers3],
              ["native", "Native agent", Bot],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              className={`mission-choice ${harness.mode === mode ? "mission-choice-active" : ""}`}
              aria-pressed={harness.mode === mode}
              disabled={locked}
              onClick={() => patch({ mode })}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </fieldset>
        <label className="block text-xs text-text-dim">
          Project context <span className="text-text-dim">· optional</span>
          <select
            className="mission-field mt-1"
            value={projectId}
            disabled={locked}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">Independent work</option>
            {projects.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {project && (
          <p className="text-xs text-text-dim">
            This project’s name and description accompany your request.
          </p>
        )}
        {harness.mode === "native" && (
          <div className="mission-card space-y-2 p-3">
            <label className="block text-xs">
              Supervisor
              <select
                className="mission-field mt-1"
                value={selected?.session.id ?? ""}
                disabled={locked}
                onChange={(event) => setSupervisor(event.target.value)}
              >
                {!supervisors.length && <option value="">No supervisor on this page</option>}
                {supervisors.map((item) => (
                  <option key={item.session.id} value={item.session.id}>
                    {item.session.label}
                  </option>
                ))}
              </select>
            </label>
            {participants.isError && (
              <p role="alert" className="text-xs text-danger">
                Could not load supervisors.{" "}
                <button type="button" onClick={() => void participants.refetch()}>
                  Retry supervisors
                </button>
              </p>
            )}
            <div className="flex gap-3 text-xs text-primary">
              {after && (
                <button type="button" disabled={locked} onClick={() => setAfter("")}>
                  First supervisors
                </button>
              )}
              {participants.data?.nextCursor && (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setAfter(participants.data!.nextCursor!)}
                >
                  More participants
                </button>
              )}
            </div>
            {!selected ? (
              <p className="text-xs text-text-dim">
                Connect a supervisor with <code>marina supervise --root /path/to/project</code> to
                launch installed coding tools here.
              </p>
            ) : (
              <>
                <p className="break-all text-xs text-text-dim">
                  {runtime?.root ?? runtime?.cwd}
                  {stale ? " · reconnect supervisor to launch" : " · ready for work"}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs">
                    Runtime
                    <select
                      className="mission-field mt-1"
                      value={adapter}
                      disabled={locked}
                      onChange={(event) => patch({ adapter: event.target.value })}
                    >
                      {adapters.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs">
                    Agent name
                    <input
                      className="mission-field mt-1"
                      value={name}
                      maxLength={128}
                      required
                      disabled={locked}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. comet"
                    />
                  </label>
                  <label className="text-xs">
                    Project directory
                    <input
                      className="mission-field mt-1"
                      value={harness.directory}
                      required
                      disabled={locked}
                      onChange={(event) => patch({ directory: event.target.value })}
                    />
                  </label>
                  <label className="text-xs">
                    Model
                    <input
                      className="mission-field mt-1"
                      value={harness.model}
                      maxLength={256}
                      disabled={locked}
                      onChange={(event) => patch({ model: event.target.value })}
                      placeholder="Runtime default"
                    />
                  </label>
                </div>
                <label className="block text-xs">
                  Workspace
                  <select
                    className="mission-field mt-1"
                    value={harness.workspace}
                    disabled={locked}
                    onChange={(event) =>
                      patch({ workspace: event.target.value as Harness["workspace"] })
                    }
                  >
                    <option value="worktree">Isolated Git worktree</option>
                    <option value="shared">Shared project folder</option>
                  </select>
                </label>
                <p className="text-xs text-text-dim">
                  {harness.workspace === "worktree"
                    ? "Starts from committed HEAD; uncommitted edits stay in the original folder."
                    : "Uses the supervisor’s project files directly. Coordinate concurrent edits."}
                </p>
              </>
            )}
          </div>
        )}
        {harness.mode !== "native" && (
          <p className="text-xs text-text-dim">
            {harness.mode === "crew"
              ? "Marina’s implementer, reviewer and tester collaborate using the configured coding workspace and models."
              : "Marina uses your current coding session, workspace and model settings."}
          </p>
        )}
        <textarea
          aria-label="What would you like to make?"
          className="mission-field min-h-24 resize-y"
          placeholder="What would you like to make?"
          required
          maxLength={12000}
          value={goal}
          disabled={locked}
          onChange={(event) => setGoal(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className="mission-primary"
            disabled={
              !loggedIn || locked || (harness.mode === "native" && (!selected || stale || !adapter))
            }
          >
            <Rocket size={15} />
            {command.busy ? "Sending…" : "Start work"}
            <ArrowUpRight size={14} />
          </button>
          <button
            type="button"
            className="mission-secondary ml-auto"
            disabled={!identity || locked}
            onClick={() => {
              try {
                localStorage.setItem(storageKey, JSON.stringify({ ...harness, adapter }));
                setNotice("Harness saved for your next visit in this browser.");
              } catch {
                setError("Could not save this preference in browser storage.");
              }
            }}
          >
            <Save size={13} />
            Remember harness
          </button>
        </div>
        {!loggedIn && (
          <p className="text-xs text-text-dim">Connect in Chat to start. Your draft stays here.</p>
        )}
        {(error || command.error) && (
          <p role="alert" className="text-sm text-danger">
            {error || command.error}
            {command.pending && (
              <button
                className="ml-2 underline"
                type="button"
                disabled={command.busy}
                onClick={() => {
                  const target = command.pending!.sessionId;
                  void command.retry().then((sent) => {
                    if (sent) {
                      setGoal("");
                      openParticipant(target);
                    }
                  });
                }}
              >
                Retry same request
              </button>
            )}
          </p>
        )}
        {(notice || command.notice) && (
          <p role="status" className="text-xs text-primary">
            {notice || command.notice}
          </p>
        )}
      </form>
    </section>
  );
}
