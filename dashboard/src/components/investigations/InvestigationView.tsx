// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { investigationAttemptText } from "../../../../src/sdk/investigation-text";
import {
  type InvestigationAttempt,
  investigationTerminal,
} from "../../../../src/sdk/investigation-types";
import { useChatState } from "../../hooks/use-chat-state";
import {
  investigations,
  useInvestigation,
  useInvestigationEvents,
} from "../../hooks/use-investigations";
import { InvestigationAnswer } from "./InvestigationAnswer";
import { InvestigationComposer } from "./InvestigationComposer";
import { InvestigationDetails } from "./InvestigationDetails";
import { InvestigationResolution } from "./InvestigationResolution";

export function InvestigationView({
  caseId,
  attemptId,
  onAttempt,
  onErased,
  active = true,
}: {
  caseId: string;
  attemptId?: string;
  onAttempt(attempt: InvestigationAttempt): void;
  onErased?(): void;
  active?: boolean;
}) {
  const query = useInvestigation(caseId, attemptId, active);
  const journal = useInvestigationEvents(query.data?.attempt.id, active && !query.isError);
  const loggedIn = useChatState((s) => s.loggedIn);
  const cache = useQueryClient();
  const [revise, setRevise] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [erasing, setErasing] = useState(false);
  if (!loggedIn)
    return (
      <p className="p-4 text-sm text-text-secondary">Sign in to read this private investigation.</p>
    );
  if (query.isError)
    return (
      <div className="rounded-xl border border-red-400/30 p-4" role="alert">
        <p>{query.error.message}</p>
        <button className="mt-3 text-primary" type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  if (!query.data)
    return (
      <div
        role="status"
        className="h-48 animate-pulse rounded-2xl border border-border bg-primary/5 p-5 motion-reduce:animate-none"
      >
        Loading investigation…
      </div>
    );
  const snapshot = query.data;
  const attempt = snapshot.attempt;
  const writable = snapshot.case.access !== "read";
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setNotice("");
    try {
      await work();
      await query.refetch();
      await journal.refetch();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };
  const download = (format: "text" | "json") => {
    const body =
      format === "json"
        ? JSON.stringify(snapshot, null, 2)
        : investigationAttemptText(attempt, attempt.result?.report ? "report" : "answer");
    const url = URL.createObjectURL(
      new Blob([body], { type: format === "json" ? "application/json" : "text/plain" }),
    );
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = `marina-${attempt.id}.${format === "json" ? "json" : "txt"}`;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-2 text-text-secondary">
          Attempt
          <select
            aria-label="Select investigation attempt"
            value={attempt.id}
            onChange={(event) =>
              void action(async () => {
                const found = await investigations.attempt(event.target.value);
                onAttempt(found);
              })
            }
            className="max-w-64 rounded-lg border border-border bg-surface p-2"
          >
            {snapshot.attempts.map((item, index) => (
              <option key={item.id} value={item.id}>
                {snapshot.attempts.length - index} · {item.state} · {item.actor.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="ml-auto rounded-lg border border-border p-2 text-text-secondary"
          type="button"
          onClick={() => download("text")}
        >
          <Download className="mr-1 inline" size={12} />
          Text
        </button>
        <button
          className="rounded-lg border border-border p-2 text-text-secondary"
          type="button"
          onClick={() => download("json")}
        >
          JSON
        </button>
      </div>
      {snapshot.case.currentAttemptId && snapshot.case.currentAttemptId !== attempt.id && (
        <p className="text-xs text-text-secondary">
          This is a separate attempt.{" "}
          <button
            className="text-primary underline"
            type="button"
            onClick={() =>
              void action(async () =>
                onAttempt(await investigations.attempt(snapshot.case.currentAttemptId!)),
              )
            }
          >
            View the published answer
          </button>
        </p>
      )}
      <InvestigationAnswer attempt={attempt} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <span className="mr-auto">
          ${attempt.accounting.knownUsd.toFixed(4)} recorded ·{" "}
          {attempt.accounting.complete ? "accounting complete" : "accounting incomplete"}
          {attempt.accounting.outstanding
            ? ` · ${attempt.accounting.outstanding} outstanding calls`
            : ""}
        </span>
        {writable && !investigationTerminal(attempt.state) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void action(() => investigations.cancel(attempt.id))}
            className="rounded-lg border border-border px-3 py-2"
          >
            <Square className="mr-1 inline" size={12} />
            Stop this attempt
          </button>
        )}
        {writable && (
          <button
            type="button"
            className="rounded-lg border border-primary/30 px-3 py-2 text-primary"
            onClick={() => setRevise((value) => !value)}
          >
            <RefreshCw className="mr-1 inline" size={12} />
            Refine / try again
          </button>
        )}
        {writable && attempt.result && snapshot.case.currentAttemptId !== attempt.id && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void action(() => investigations.select(attempt.id))}
            className="rounded-lg border border-border px-3 py-2"
          >
            Publish this answer
          </button>
        )}
      </div>
      {notice && (
        <p role="alert" className="text-sm text-red-400">
          {notice}
        </p>
      )}
      {revise && (
        <InvestigationComposer
          key={attempt.id}
          kind={attempt.request.kind}
          previous={attempt}
          onStarted={(next) => {
            setRevise(false);
            onAttempt(next);
          }}
          onCancel={() => setRevise(false)}
        />
      )}
      {journal.isError && (
        <p
          role="alert"
          className="rounded-lg border border-amber-400/30 p-3 text-sm text-amber-300"
        >
          Live activity is unavailable.{" "}
          <button type="button" className="underline" onClick={() => void journal.refetch()}>
            Reconnect
          </button>
        </p>
      )}
      <InvestigationDetails
        snapshot={snapshot}
        events={journal.isError ? [] : (journal.data?.events ?? [])}
      />
      <InvestigationResolution
        snapshot={snapshot}
        onSaved={() => {
          void query.refetch();
          void journal.refetch();
        }}
      />
      <footer className="flex flex-wrap items-center gap-3 text-xs text-text-dim">
        <span className="min-w-0 flex-1 break-all">
          Case {snapshot.case.id} · attempt {attempt.id}
        </span>
        {snapshot.case.access === "owner" && (
          <button
            type="button"
            className="flex items-center gap-1 text-text-dim hover:text-red-400"
            onClick={() => setErasing((value) => !value)}
          >
            <Trash2 size={12} />
            Erase
          </button>
        )}
      </footer>
      {erasing && (
        <div className="rounded-lg border border-red-400/30 p-3 text-sm">
          <p>Erase this case, its child cases and stored evidence? This cannot be undone.</p>
          <div className="mt-3 flex gap-4">
            <button
              type="button"
              disabled={busy}
              className="text-red-400"
              onClick={() =>
                void action(async () => {
                  await investigations.erase(caseId);
                  cache.removeQueries({ queryKey: ["investigations"] });
                  onErased?.();
                })
              }
            >
              Erase permanently
            </button>
            <button type="button" onClick={() => setErasing(false)}>
              Keep case
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
