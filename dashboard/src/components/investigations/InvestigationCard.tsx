// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { INVESTIGATION_SCHEMA } from "../../../../src/sdk/investigation-types";
import { useChatState } from "../../hooks/use-chat-state";
import { useInvestigation } from "../../hooks/use-investigations";
import { openBoundPanel } from "../../lib/panel-bindings";
import { InvestigationAnswer } from "./InvestigationAnswer";

export function investigationReference(
  value: unknown,
): { caseId: string; attemptId: string } | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  return ref.schema === INVESTIGATION_SCHEMA &&
    typeof ref.caseId === "string" &&
    typeof ref.attemptId === "string" &&
    /^[a-zA-Z0-9-]{1,100}$/.test(ref.caseId) &&
    /^[a-zA-Z0-9-]{1,100}$/.test(ref.attemptId)
    ? { caseId: ref.caseId, attemptId: ref.attemptId }
    : null;
}

/** Perception stores identifiers only. The card reauthorizes on read and never runs a prediction. */
export function InvestigationCard({ caseId, attemptId }: { caseId: string; attemptId: string }) {
  const [expanded, setExpanded] = useState(false);
  const loggedIn = useChatState((s) => s.loggedIn);
  const query = useInvestigation(caseId, attemptId, expanded);
  return (
    <section
      className="my-2 rounded-xl border border-primary/25 bg-primary/5 p-3"
      aria-label="Private investigation card"
    >
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="font-medium text-primary"
        >
          {expanded ? "Hide answer" : "Show private answer"}
        </button>
        <button
          type="button"
          onClick={() => openBoundPanel({ kind: "investigation", caseId, attemptId })}
          className="text-text-secondary"
        >
          Open in a panel
        </button>
        <a
          href={`/predict/${encodeURIComponent(caseId)}?attempt=${encodeURIComponent(attemptId)}`}
          className="ml-auto text-primary"
        >
          Full view ↗
        </a>
      </div>
      {expanded && (
        <div className="mt-3">
          {!loggedIn ? (
            <p className="text-sm">Sign in to read this investigation.</p>
          ) : query.isError ? (
            <p role="alert" className="text-sm text-text-secondary">
              {query.error.message}
            </p>
          ) : query.data ? (
            <InvestigationAnswer attempt={query.data.attempt} compact />
          ) : (
            <p role="status" className="text-sm">
              Loading saved answer…
            </p>
          )}
        </div>
      )}
    </section>
  );
}
