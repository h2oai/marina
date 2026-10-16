// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ArrowUpRight, BookOpen, GitBranch, ListTree, MessageSquare, Users } from "lucide-react";
import { useState } from "react";
import type {
  InvestigationEvent,
  InvestigationSnapshot,
} from "../../../../src/sdk/investigation-types";
import { investigations } from "../../hooks/use-investigations";
import { draftCommand } from "../../lib/command-discovery";
import { renderChatText } from "../chat-render-text";
import { InvestigationEvidence } from "./InvestigationEvidence";

const tabs = [
  ["why", "Why", MessageSquare],
  ["sources", "Sources", BookOpen],
  ["canvas", "Evidence canvas", GitBranch],
  ["activity", "Activity", ListTree],
  ["people", "Collaborate", Users],
  ["report", "Report", BookOpen],
] as const;
type Tab = (typeof tabs)[number][0];

export function InvestigationDetails({
  snapshot,
  events,
}: {
  snapshot: InvestigationSnapshot;
  events: InvestigationEvent[];
}) {
  const [tab, setTab] = useState<Tab>("why");
  const result = snapshot.attempt.result;
  const actors = [
    ...new Set(
      events.filter((event) => event.kind === "stage_started").map((event) => event.actor),
    ),
  ];
  const completed = events.filter((event) => event.kind === "stage_completed").length;
  const started = events.filter((event) => event.kind === "stage_started").length;
  return (
    <section
      className="rounded-2xl border border-border bg-surface/70"
      aria-label="Explore investigation"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs text-text-secondary">
        <span>
          {completed} completed stages · {started} started · {actors.length} model/worker identities
        </span>
        <span>{snapshot.attempt.state}</span>
      </div>
      <div
        className="flex flex-wrap gap-1 border-b border-border p-2"
        role="tablist"
        aria-label="Investigation detail views"
      >
        {tabs
          .filter(([id]) => id !== "report" || result?.report)
          .map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors ${tab === id ? "bg-primary/15 text-primary" : "text-text-secondary hover:bg-primary/5"}`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
      </div>
      <div className="p-4 sm:p-5" role="tabpanel" aria-label={tabs.find(([id]) => id === tab)?.[1]}>
        {tab === "why" && (
          <div className="space-y-4">
            {result?.reasons.length ? (
              result.reasons.map((reason, i) => (
                <article
                  key={`${i}:${reason.actor}`}
                  className="rounded-xl border border-border p-4"
                >
                  <h3 className="mb-2 text-xs font-semibold text-primary">{reason.actor}</h3>
                  {renderChatText(reason.text)}
                  {!!reason.sourceIds.length && (
                    <p className="mt-2 text-xs text-text-dim">
                      Declared citations: {reason.sourceIds.join(", ")}
                    </p>
                  )}
                </article>
              ))
            ) : (
              <p className="text-sm text-text-secondary">
                {result
                  ? "No detailed rationale was returned. The evidence canvas contains the captured work."
                  : "The answer and its rationale will appear here when the attempt finishes. Watch Activity for live progress."}
              </p>
            )}
            <div className="rounded-xl border border-dashed border-border p-4 text-xs text-text-dim">
              <h3 className="mb-2 font-medium">
                Capture coverage: {result?.capture.status ?? "in progress"}
              </h3>
              <ul className="list-disc space-y-1 pl-4">
                {(
                  result?.capture.gaps ?? [
                    "Only observed inputs and outputs are shown; hidden model reasoning is not available.",
                  ]
                ).map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
              <p className="mt-3">
                Agreement between models is not calibrated confidence. Repeated citations may refer
                to the same underlying evidence.
              </p>
            </div>
          </div>
        )}
        {tab === "sources" && (
          <ul className="space-y-3">
            {result?.sources.length ? (
              result.sources.map((source) => (
                <li key={source.id} className="rounded-xl border border-border p-4">
                  <span className="mr-2 text-xs text-text-dim">[{source.id}]</span>
                  {/^https?:\/\//i.test(source.url) ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-words text-sm text-primary hover:underline"
                    >
                      {source.title ?? source.url}
                      <ArrowUpRight className="ml-1 inline" size={13} />
                    </a>
                  ) : (
                    <span className="break-words text-sm">{source.title ?? source.url}</span>
                  )}
                  <p className="mt-1 break-all text-xs text-text-dim">{source.url}</p>
                </li>
              ))
            ) : (
              <li className="text-sm text-text-secondary">No sources returned yet.</li>
            )}
          </ul>
        )}
        {tab === "canvas" && <InvestigationEvidence events={events} />}
        {tab === "activity" && (
          <ol
            className="max-h-[540px] space-y-3 overflow-auto"
            aria-label="Live investigation activity"
          >
            {events.length ? (
              [...events]
                .reverse()
                .slice(0, 200)
                .map((event) => (
                  <li key={event.sequence} className="flex gap-3 border-b border-border/50 pb-3">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary/70" />
                    <div className="min-w-0">
                      <p className="text-xs text-text-dim">
                        #{event.sequence} · {new Date(event.at).toLocaleTimeString()} ·{" "}
                        {event.actor}
                      </p>
                      <p className="break-words text-sm">
                        {event.kind.replaceAll("_", " ")}
                        {event.message ? ` · ${event.message}` : ""}
                      </p>
                    </div>
                  </li>
                ))
            ) : (
              <li className="text-sm text-text-dim">Waiting for journal events…</li>
            )}
          </ol>
        )}
        {tab === "report" && (
          <article className="space-y-4">
            {result?.report?.split(/\n\s*\n/).map((paragraph, i) =>
              /^#{1,6} /.test(paragraph) ? (
                <h3
                  key={`${i}:${paragraph.slice(0, 40)}`}
                  className="font-display text-lg font-medium text-primary"
                >
                  {paragraph.replace(/^#{1,6} /, "")}
                </h3>
              ) : (
                <div key={`${i}:${paragraph.slice(0, 40)}`}>{renderChatText(paragraph)}</div>
              ),
            )}
          </article>
        )}
        {tab === "people" && <Collaboration snapshot={snapshot} actors={actors} />}
      </div>
    </section>
  );
}

function Collaboration({
  snapshot,
  actors,
}: {
  snapshot: InvestigationSnapshot;
  actors: string[];
}) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "work">("read");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState("");
  const grant = async (revoke = false) => {
    setBusy(true);
    setNotice("");
    try {
      const saved = await investigations.grant(snapshot.case.id, name, revoke ? null : access);
      setNotice(`${saved.name}: ${revoke ? "access revoked" : `${access} access granted`}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not change access");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <p>
        Owned by <strong>{snapshot.case.owner.name}</strong>. Started by{" "}
        <strong>{snapshot.attempt.actor.name}</strong>.
      </p>
      <p className="text-text-secondary">
        People, resident agents and external clients can collaborate through the same account
        grants. Work access permits new attempts and child investigations; read access permits
        inspection.
      </p>
      {snapshot.case.access === "owner" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void grant();
          }}
          className="flex flex-wrap gap-2"
        >
          <input
            aria-label="Collaborator account"
            required
            maxLength={100}
            placeholder="Marina account name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2"
          />
          <select
            aria-label="Collaborator access"
            value={access}
            onChange={(event) => setAccess(event.target.value as typeof access)}
            className="rounded-lg border border-border bg-bg px-3 py-2"
          >
            <option value="read">Read</option>
            <option value="work">Work</option>
          </select>
          <button
            disabled={busy || !name.trim()}
            className="rounded-lg bg-primary px-3 py-2 text-bg"
            type="submit"
          >
            Grant
          </button>
          <button
            disabled={busy || !name.trim()}
            className="rounded-lg border border-border px-3 py-2"
            type="button"
            onClick={() => void grant(true)}
          >
            Revoke
          </button>
        </form>
      )}
      {notice && (
        <p role="status" className="text-primary">
          {notice}
        </p>
      )}
      {!!snapshot.grants?.length && (
        <ul className="space-y-1 text-xs text-text-secondary" aria-label="Case grants">
          {snapshot.grants.map((grant) => (
            <li key={grant.name}>
              {grant.name} · {grant.access}
            </li>
          ))}
        </ul>
      )}
      {snapshot.case.access !== "read" && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await investigations.review(snapshot.attempt.id, review);
              setReview("");
              setNotice(
                "Review saved in Activity. It does not automatically start another attempt.",
              );
            } catch (error) {
              setNotice(error instanceof Error ? error.message : "Review failed");
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-2"
        >
          <label className="block text-xs text-text-secondary">
            Review or challenge
            <textarea
              value={review}
              onChange={(event) => setReview(event.target.value)}
              maxLength={4000}
              required
              rows={3}
              className="mt-1 w-full rounded-lg border border-border bg-bg p-3 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !review.trim()}
            className="rounded-lg border border-primary/30 px-3 py-2 text-primary disabled:opacity-40"
          >
            Add review
          </button>
        </form>
      )}
      {!!snapshot.children.length && (
        <div>
          <h3 className="mb-2 font-medium">Related child investigations</h3>
          <ul className="space-y-2">
            {snapshot.children.map((child) => (
              <li key={child.attemptId}>
                <a
                  className="text-primary underline"
                  href={`/predict/${child.caseId}?attempt=${child.attemptId}`}
                >
                  {child.question}
                </a>
                <span className="ml-2 text-xs text-text-dim">{child.state}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-text-dim">
        Observed participants: {actors.length ? actors.join(", ") : "No model calls yet"}
      </p>
      <button
        type="button"
        disabled={!name.trim() || !/^[a-zA-Z0-9_-]+$/.test(name)}
        onClick={() =>
          draftCommand(
            `tell ${name} Please review inquiry ${snapshot.case.id}; use inquiry show ${snapshot.case.id}.`,
          )
        }
        className="rounded-lg border border-border px-3 py-2 text-primary disabled:opacity-40"
      >
        Draft a private message in chat
      </button>
      <p className="text-xs text-text-dim">
        A link grants no access. Messages use Marina’s existing private messaging; granting access
        sends no message automatically.
      </p>
    </div>
  );
}
