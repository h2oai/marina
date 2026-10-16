// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ArrowLeft, ArrowUpRight, BookOpen, Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  InvestigationAttempt,
  InvestigationKind,
} from "../../../../src/sdk/investigation-types";
import { useChatState } from "../../hooks/use-chat-state";
import { useInvestigationList } from "../../hooks/use-investigations";
import { WebChat } from "../WebChat";
import { InvestigationComposer } from "./InvestigationComposer";
import { InvestigationView } from "./InvestigationView";

function location(): { kind: InvestigationKind; caseId?: string; attemptId?: string } {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return {
    kind: (parts[0] === "research" ? "research" : "prediction") as InvestigationKind,
    caseId: parts[1],
    attemptId: new URLSearchParams(window.location.search).get("attempt") ?? undefined,
  };
}

export function InvestigationPage() {
  const [route, setRoute] = useState(location);
  const loggedIn = useChatState((s) => s.loggedIn);
  const name = useChatState((s) => s.entityName);
  const list = useInvestigationList();
  useEffect(() => {
    const update = () => setRoute(location());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = (caseId?: string, attemptId?: string, kind = route.kind) => {
    const url = new URL(window.location.href);
    url.pathname = `/${kind === "prediction" ? "predict" : "research"}${caseId ? `/${encodeURIComponent(caseId)}` : ""}`;
    url.search = attemptId ? new URLSearchParams({ attempt: attemptId }).toString() : "";
    window.history.pushState(null, "", url);
    setRoute({ kind, caseId, attemptId });
  };
  const started = (attempt: InvestigationAttempt) => {
    navigate(attempt.caseId, attempt.id, attempt.request.kind);
    void list.refetch();
  };
  return (
    <div className="h-dvh overflow-auto bg-bg text-text">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-border bg-bg/95 px-4 py-3 backdrop-blur sm:px-7">
        <a
          href="/dashboard"
          className="flex items-center gap-2 font-display font-semibold tracking-wide text-primary"
        >
          <ArrowLeft size={16} /> MARINA
        </a>
        <span className="text-text-dim">/</span>
        <nav className="flex gap-1" aria-label="Investigation service">
          <button
            type="button"
            className={`rounded-lg px-3 py-2 text-sm ${route.kind === "prediction" ? "bg-primary/15 text-primary" : "text-text-secondary"}`}
            onClick={() => navigate(undefined, undefined, "prediction")}
          >
            Predict
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-2 text-sm ${route.kind === "research" ? "bg-primary/15 text-primary" : "text-text-secondary"}`}
            onClick={() => navigate(undefined, undefined, "research")}
          >
            Research
          </button>
        </nav>
        <span className="ml-auto text-xs text-text-dim">
          {loggedIn
            ? `${name} · private workspace`
            : "Your question. Marina’s collective intelligence."}
        </span>
      </header>
      {!loggedIn ? (
        <main className="mx-auto max-w-2xl space-y-5 p-6">
          <h1 className="font-display text-3xl">A clear answer. The evidence behind it.</h1>
          <p className="text-text-secondary">
            Join Marina below to save private predictions and research, then explore the work behind
            every answer.
          </p>
          <div className="h-[420px]">
            <WebChat />
          </div>
        </main>
      ) : (
        <div className="mx-auto grid max-w-[1440px] gap-6 p-4 sm:p-7 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-4" aria-label="Saved investigations">
            <button
              type="button"
              onClick={() => navigate()}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary"
            >
              <Plus size={16} />
              New {route.kind === "prediction" ? "prediction" : "research"}
            </button>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-dim">
              Your investigations
            </h2>
            {list.isError ? (
              <p role="alert" className="text-xs text-red-400">
                {list.error.message}{" "}
                <button type="button" onClick={() => void list.refetch()} className="underline">
                  Retry
                </button>
              </p>
            ) : (
              <ul className="flex gap-2 overflow-x-auto lg:max-h-[70vh] lg:flex-col lg:overflow-y-auto">
                {list.data?.cases.map((item) => (
                  <li key={item.id} className="min-w-48 lg:min-w-0">
                    <button
                      type="button"
                      aria-current={route.caseId === item.id ? "page" : undefined}
                      onClick={() => navigate(item.id, undefined, item.kind)}
                      className={`w-full rounded-xl border p-3 text-left transition-colors ${route.caseId === item.id ? "border-primary/40 bg-primary/10" : "border-border hover:border-primary/30"}`}
                    >
                      <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-dim">
                        {item.kind === "prediction" ? (
                          <Sparkles size={11} />
                        ) : (
                          <BookOpen size={11} />
                        )}
                        {item.kind}
                      </span>
                      <span className="line-clamp-3 text-sm">{item.question}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {list.data?.cases.length === 0 && (
              <p className="text-xs text-text-dim">Your saved answers will appear here.</p>
            )}
          </aside>
          <main className="min-w-0 space-y-5">
            {route.caseId ? (
              <>
                <a
                  className="inline-flex items-center gap-1 text-xs text-primary"
                  href={`/dashboard?inquiry=${encodeURIComponent(route.caseId)}${route.attemptId ? `&attempt=${encodeURIComponent(route.attemptId)}` : ""}`}
                >
                  Open as a dashboard panel <ArrowUpRight size={12} />
                </a>
                <InvestigationView
                  key={`${route.caseId}:${route.attemptId ?? "selected"}`}
                  caseId={route.caseId}
                  attemptId={route.attemptId}
                  onAttempt={started}
                  onErased={() => {
                    navigate();
                    void list.refetch();
                  }}
                />
              </>
            ) : (
              <>
                <div className="py-6 sm:py-10">
                  <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs text-primary">
                    <Sparkles size={14} />
                    {route.kind === "prediction"
                      ? "From uncertainty to an informed answer"
                      : "From a question to a connected body of evidence"}
                  </div>
                  <h1 className="max-w-2xl font-display text-4xl font-medium leading-tight tracking-tight sm:text-5xl">
                    {route.kind === "prediction"
                      ? "A clearer view of what comes next."
                      : "Go deeper. See the whole picture."}
                  </h1>
                  <p className="mt-4 max-w-xl text-base leading-relaxed text-text-secondary">
                    {route.kind === "prediction"
                      ? "Ask a question. Marina gathers evidence, evaluates possible outcomes and gives you its prediction. Explore every captured step when you want to know why."
                      : "Marina investigates your question and builds a sourced report. Follow its progress, inspect the evidence and invite collaborators into the work."}
                  </p>
                </div>
                <InvestigationComposer key={route.kind} kind={route.kind} onStarted={started} />
                <div className="grid gap-3 text-sm text-text-secondary sm:grid-cols-3">
                  {[
                    "One answer, with uncertainty visible",
                    "Live work and traceable evidence",
                    "Shared across chat, dashboard and terminal",
                  ].map((text) => (
                    <div key={text} className="rounded-xl border border-border bg-surface/50 p-4">
                      {text}
                    </div>
                  ))}
                </div>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
