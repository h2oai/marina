// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { CheckCheck, FileCode2, History, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useChatState } from "../hooks/use-chat-state";
import { openMemory, useWorkspaceState } from "../hooks/use-workspace-state";
import { fetchApi, getToken } from "../lib/api";
import type { CodingArtifactEntry, TaskDetail } from "../lib/types";
import { PinToCanvas } from "./CanvasReference";
import { DiffViewer } from "./DiffViewer";

function metadata(artifact: CodingArtifactEntry): Record<string, unknown> {
  try {
    const value = JSON.parse(artifact.metadata_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
export function TaskEvidence({ task }: { task: TaskDetail }) {
  const [selected, setSelected] = useState<string>();
  const runs = task.codingRuns ?? [];
  const run = runs.find((item) => item.id === selected) ?? runs[0];
  return (
    <section aria-label="Task evidence" className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="flex items-center gap-2 text-primary">
        <ShieldCheck size={16} />
        <h3 className="font-semibold">Evidence & review</h3>
      </div>
      <div className="flex flex-wrap gap-2">
        <PinToCanvas reference={{ kind: "task", id: String(task.id) }} />
        <button type="button" className="mission-secondary" onClick={() => openMemory(task.title)}>
          Find related memory
        </button>
      </div>
      {runs.length > 1 && (
        <label className="block text-xs">
          Recent attempts · up to 25
          <select
            className="mission-field mt-1"
            value={run?.id}
            onChange={(event) => setSelected(event.target.value)}
          >
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.created_at).toLocaleString()} · {item.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {run ? (
        <RunEvidence key={run.id} run={run} task={task} />
      ) : (
        <>
          <p className="text-xs text-text-dim">
            No linked coding attempt. Published agent output alone does not establish task
            verification.
          </p>
          {task.claims?.map((claim) => (
            <article key={claim.entity_id} className="mission-card p-3">
              <p className="text-xs text-primary">
                {claim.entity_name} · {claim.status}
              </p>
              <p className="whitespace-pre-wrap text-sm">
                {claim.submission_text ?? "No submission yet."}
              </p>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
function RunEvidence({ run, task }: { run: CodingArtifactEntry; task: TaskDetail }) {
  const identity = useChatState((state) => state.entityName);
  const loggedIn = useChatState((state) => state.loggedIn);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [artifactId, setArtifact] = useState<string>();
  const query = useQuery({
    queryKey: ["coding-run-evidence", identity, getToken(), run.id],
    queryFn: () =>
      fetchApi<{ run: CodingArtifactEntry; artifacts: CodingArtifactEntry[] }>(
        `/api/coding/runs/${encodeURIComponent(run.id)}`,
      ),
    refetchInterval: 5000,
  });
  const meta = metadata(query.data?.run ?? run);
  const artifacts = query.isError ? [] : (query.data?.artifacts ?? []);
  const selected =
    artifacts.find((item) => item.id === artifactId) ??
    artifacts.find((item) => item.kind === "summary") ??
    artifacts[0];
  const claim = task.claims?.find((item) => item.entity_name === meta.workerName);
  const canReview = loggedIn && identity === task.creator_name && claim?.status === "submitted";
  function review(action: "approve" | "reject") {
    // Commands remain ordered through the existing resident connection and server permission gates.
    const send = useChatState.getState().sendCommand;
    if (!send(`code resume ${run.session_id}`) || !send(`code review ${action} ${run.id}`)) {
      setNotice("Chat is disconnected. Reconnect before requesting review.");
      return;
    }
    setPending(true);
    // Make the authoritative command response visible on narrow screens too.
    useWorkspaceState.setState({ pane: "webchat", fullscreen: false });
    setNotice(
      "Review requested. The task status updates when Marina processes it; inspect Chat for any refusal.",
    );
  }
  return (
    <>
      <div className="mission-card space-y-2 p-3">
        <div className="flex items-center gap-2">
          <History size={14} className="text-primary" />
          <span className="text-sm font-semibold">{String(meta.workerName ?? run.created_by)}</span>
          <span className="mission-count ml-auto">{claim?.status ?? run.status}</span>
        </div>
        <p className="break-all text-xs text-text-dim">
          {String(meta.workspace ?? "Workspace not recorded")}
        </p>
        <p className="flex items-center gap-2 text-xs">
          <CheckCheck size={14} />
          Recorded verification:{" "}
          <strong className={meta.verification === "passed" ? "text-success" : "text-warning"}>
            {String(meta.verification ?? "not recorded")}
          </strong>
        </p>
        <p className="text-xs text-text-dim">
          Recorded checks describe observed work; later edits may require new verification.
        </p>
      </div>
      {query.isPending && (
        <p role="status" className="mission-skeleton p-3">
          Loading evidence…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="text-danger">
          Could not load evidence.{" "}
          <button type="button" onClick={() => void query.refetch()}>
            Retry evidence
          </button>
        </p>
      )}
      {!!artifacts.length && (
        <>
          <label className="block text-xs">
            Inspect evidence
            <select
              className="mission-field mt-1"
              value={selected?.id ?? ""}
              onChange={(event) => setArtifact(event.target.value)}
            >
              {artifacts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.kind} · {item.title}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <article className="min-w-0 space-y-2">
              <h4 className="flex items-center gap-2 text-sm">
                <FileCode2 size={14} />
                {selected.title}
              </h4>
              {selected.kind === "patch" || selected.kind === "diff" ? (
                <DiffViewer patch={selected.content_text} />
              ) : (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {selected.content_text}
                </pre>
              )}
              <PinToCanvas
                reference={{ kind: "artifact", id: selected.id, sessionId: run.session_id }}
              />
              <details className="text-xs text-text-dim">
                <summary>Provenance</summary>
                <pre className="overflow-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(
                    {
                      artifactId: selected.id,
                      attemptId: run.id,
                      sessionId: run.session_id,
                      author: selected.created_by,
                      createdAt: selected.created_at,
                      metadata: metadata(selected),
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </article>
          )}
        </>
      )}
      {canReview && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="mission-primary"
            disabled={pending}
            onClick={() => review("approve")}
          >
            Approve submission
          </button>
          <button
            type="button"
            className="mission-secondary"
            disabled={pending}
            onClick={() => review("reject")}
          >
            Request changes
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-primary">
          {notice}
          {pending && (
            <button
              className="ml-2 underline"
              type="button"
              onClick={() => {
                setPending(false);
                setNotice("");
              }}
            >
              Review response in Chat, then unlock
            </button>
          )}
        </p>
      )}
    </>
  );
}
