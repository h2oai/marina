// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CodingArtifactEntry } from "../lib/types";
import { DiffViewer } from "./DiffViewer";

/** Read existing session/evidence rows; an artifact's status is never promoted into proof. */
export function CodingDeskResource({ value }: { value: Record<string, unknown> }) {
  const session = value.session as {
    title: string;
    status: string;
    agent: string | null;
    workspace_root?: string;
  };
  const artifacts = (value.artifacts ?? []) as CodingArtifactEntry[];
  const events = (value.events ?? []) as Array<{
    id: string;
    kind: string;
    actor: string;
    payload_json: string;
  }>;
  return (
    <section
      aria-label="Coding session"
      className="space-y-3 rounded border border-border p-3 text-sm"
    >
      <h3 className="font-semibold">{session.title}</h3>
      <p>
        {session.status} · {session.agent ?? "No coder attached"}
      </p>
      <p className="break-all">Repository: {session.workspace_root ?? "Not recorded"}</p>
      <details open>
        <summary>Recent activity</summary>
        <ol className="max-h-48 overflow-auto space-y-2">
          {events.slice(-20).map((event) => (
            <li key={event.id}>
              <span>
                {event.actor} · {event.kind.replaceAll("_", " ")}
              </span>
              <details>
                <summary>Details</summary>
                <pre className="whitespace-pre-wrap break-words">
                  {event.payload_json.slice(0, 4000)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
        {!events.length && <p>No coding activity yet.</p>}
      </details>
      <details open>
        <summary>Artifacts & verification</summary>
        <div className="space-y-2">
          {artifacts.slice(0, 30).map((artifact) => (
            <details key={artifact.id} className="rounded border border-border p-2">
              <summary>
                {artifact.title} · {artifact.kind.replaceAll("_", " ")} · {artifact.status}
              </summary>
              {artifact.kind === "patch" || artifact.kind === "diff" ? (
                <DiffViewer patch={artifact.content_text} />
              ) : (
                <pre className="whitespace-pre-wrap break-words">
                  {artifact.content_text.slice(0, 16000)}
                </pre>
              )}
              {artifact.kind === "task_run" && (
                <p>
                  Recorded verification: {verification(artifact)}. Later edits may require new
                  verification. Submitted work still needs review.
                </p>
              )}
              <details>
                <summary>Provenance</summary>
                <pre className="whitespace-pre-wrap break-words">
                  {artifact.metadata_json.slice(0, 16000)}
                </pre>
              </details>
            </details>
          ))}
        </div>
        {!artifacts.length && <p>No artifacts or verification receipts yet.</p>}
      </details>
    </section>
  );
}

function verification(artifact: CodingArtifactEntry): string {
  try {
    return String(JSON.parse(artifact.metadata_json).verification ?? "not recorded");
  } catch {
    return "not recorded";
  }
}
