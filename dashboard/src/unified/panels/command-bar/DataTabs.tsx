// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CommandBar read-only data tab bodies: markets, experiments (with evolution
 * sessions), benchmarks, room templates, recipes.
 * Extracted mechanically from CommandBar.tsx — no behavior change.
 */

import { memo, useState } from "react";
import {
  useBenchmarks,
  useEvolutionSessions,
  useExperiments,
  useMarkets,
  useRecipes,
  useRoomTemplates,
} from "../../../hooks/use-api";
import type {
  BenchmarkEntry,
  EvolutionSessionEntry,
  ExperimentEntry,
  MarketEntry,
  RecipeEntry,
  RoomTemplateEntry,
} from "../../../lib/types";
import { CoordEmpty, CoordLoading } from "./shared";

export const MarketsTab = memo(function MarketsTab() {
  const { data, isLoading } = useMarkets();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="markets" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((m: MarketEntry) => (
        <div key={m.id} className="uc-coord-item" style={{ cursor: "default" }}>
          <div
            className={`uc-coord-dot ${m.status === "open" ? "active" : m.status === "resolved" ? "done" : "pending"}`}
            aria-hidden="true"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{m.question}</div>
            <div className="uc-coord-meta">
              {m.category ?? "general"} &middot; {m.status}
              {m.outcome ? ` &middot; outcome: ${m.outcome}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

export const ExperimentsTab = memo(function ExperimentsTab() {
  const { data, isLoading } = useExperiments();
  const { data: evolutionSessions } = useEvolutionSessions();
  const [expandedSession, setExpandedSession] = useState<number | null>(null);
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="experiments" />;
  return (
    <div className="uc-cmd-msgs">
      {evolutionSessions?.map((session: EvolutionSessionEntry) => {
        const accepted = session.runs.filter((run) => run.status === "accepted").length;
        const lastRun = session.runs.at(-1);
        return (
          <button
            type="button"
            key={`evolution-${session.id}`}
            className="uc-coord-item"
            style={{
              cursor: "pointer",
              alignItems: "flex-start",
              width: "100%",
              border: 0,
              background: "transparent",
              color: "inherit",
              font: "inherit",
              textAlign: "left",
            }}
            onClick={() =>
              setExpandedSession((current) => (current === session.id ? null : session.id))
            }
          >
            <div
              className={`uc-coord-dot ${session.status === "active" ? "active" : session.status === "completed" ? "done" : "pending"}`}
              aria-hidden="true"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="uc-coord-title">
                {session.experiment_name ?? `Experiment ${session.experiment_id}`} · evolution
              </div>
              <div className="uc-coord-meta">
                {session.status} &middot; {session.runs.length} runs &middot; {accepted} accepted
                {session.budget.runsRemaining !== undefined
                  ? ` · ${session.budget.runsRemaining} remaining`
                  : ""}
                {session.budget.exhausted ? " · budget exhausted" : ""}
              </div>
              <div className="uc-coord-meta" style={{ color: "#777" }}>
                {session.objective}
              </div>
              {lastRun && (
                <div className="uc-coord-meta" style={{ color: "#555" }}>
                  Latest: {lastRun.status} · {lastRun.hypothesis}
                  {lastRun.parent_run_id ? ` · parent #${lastRun.parent_run_id}` : ""}
                </div>
              )}
              <div className="uc-coord-meta" style={{ color: "#555" }}>
                auto-continue off · auto-promote off
                {session.protocol.independentReview ? " · independent review" : ""}
              </div>
              <div className="uc-coord-meta" style={{ color: "#777" }}>
                {session.activity.activeParticipants}/{session.activity.participants.length} active
                · {session.activity.meaningfulActions} actions · {session.activity.communications}{" "}
                comms · {session.activity.marinaToolCalls}/{session.activity.toolCalls} Marina tools
                {session.activity.averageToolLatencyMs !== null
                  ? ` · ${Math.round(session.activity.averageToolLatencyMs)}ms avg tool latency`
                  : ""}
              </div>
              {session.protocol.guardrails.length > 0 && (
                <div className="uc-coord-meta" style={{ color: "#c99a45" }}>
                  Guardrails:{" "}
                  {session.protocol.guardrails
                    .map((guardrail) => `${guardrail.metric} ${guardrail.direction}`)
                    .join(" · ")}
                </div>
              )}
              {expandedSession === session.id && (
                <div
                  style={{
                    marginTop: 6,
                    paddingLeft: 8,
                    borderLeft: "1px solid rgba(201,154,69,.45)",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  {session.runs.length === 0 && (
                    <div className="uc-coord-meta">No proposals recorded.</div>
                  )}
                  {session.runs.map((run) => (
                    <div key={run.id} style={{ position: "relative" }}>
                      <div className="uc-coord-title" style={{ fontSize: 10 }}>
                        #{run.id} · run {run.sequence} · {run.status}
                        {run.parent_run_id ? ` ← #${run.parent_run_id}` : " · root"}
                      </div>
                      <div className="uc-coord-meta">{run.hypothesis}</div>
                      <div className="uc-coord-meta" style={{ color: "#777" }}>
                        candidate {run.candidate_ref} · proposed by {run.proposed_by}
                      </div>
                      {run.evidence && (
                        <div className="uc-coord-meta" style={{ color: "#8fb6a0" }}>
                          Evidence: {run.evidence}
                        </div>
                      )}
                      {(run.evaluator_name || run.reviewer_name) && (
                        <div className="uc-coord-meta" style={{ color: "#777" }}>
                          evaluator {run.evaluator_name ?? "pending"} · reviewer{" "}
                          {run.reviewer_name ?? "pending"}
                          {run.decision ? ` · ${run.decision}` : ""}
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="uc-coord-meta" style={{ color: "#555" }}>
                    Token and cost totals remain unavailable until provider-neutral per-session
                    attribution is durable; they are never inferred from activity.
                  </div>
                </div>
              )}
            </div>
          </button>
        );
      })}
      {data.map((e: ExperimentEntry) => (
        <div key={e.id} className="uc-coord-item" style={{ cursor: "default" }}>
          <div
            className={`uc-coord-dot ${e.status === "running" ? "active" : e.status === "completed" ? "done" : "pending"}`}
            aria-hidden="true"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{e.name}</div>
            <div className="uc-coord-meta">
              {e.status} &middot; by {e.creator_name}
              {e.required_agents > 0 ? ` &middot; ${e.required_agents} agents` : ""}
            </div>
            {e.description && (
              <div className="uc-coord-meta" style={{ color: "#555" }}>
                {e.description.length > 100 ? `${e.description.slice(0, 100)}...` : e.description}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

export const BenchmarksTab = memo(function BenchmarksTab() {
  const { data, isLoading } = useBenchmarks();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="benchmarks" />;

  // Sort by total score descending
  const sorted = [...data].sort((a: BenchmarkEntry, b: BenchmarkEntry) => {
    const sumA = Object.values(a.scores).reduce((s, v) => s + v, 0);
    const sumB = Object.values(b.scores).reduce((s, v) => s + v, 0);
    return sumB - sumA;
  });

  return (
    <div className="uc-cmd-msgs">
      {sorted.map((entry: BenchmarkEntry) => {
        const total = Object.values(entry.scores).reduce((s, v) => s + v, 0);
        return (
          <div key={entry.entity} className="uc-coord-item" style={{ cursor: "default" }}>
            <div className="uc-coord-dot active" aria-hidden="true" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="uc-coord-title">{entry.entity}</div>
              <div className="uc-coord-meta">
                total: {total.toFixed(1)} &middot;{" "}
                {Object.entries(entry.scores)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" &middot; ")}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

export const TemplatesTab = memo(function TemplatesTab() {
  const { data, isLoading } = useRoomTemplates();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="room templates" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((t: RoomTemplateEntry) => (
        <div key={t.name} className="uc-coord-item" style={{ cursor: "default" }}>
          <div className="uc-coord-dot active" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{t.name}</div>
            {t.description && (
              <div className="uc-coord-meta">
                {t.description.length > 80 ? `${t.description.slice(0, 80)}...` : t.description}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

export const RecipesTab = memo(function RecipesTab() {
  const { data, isLoading } = useRecipes();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="recipes" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((r: RecipeEntry) => (
        <div key={r.name} className="uc-coord-item" style={{ cursor: "default" }}>
          <div className="uc-coord-dot active" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{r.name}</div>
            <div className="uc-coord-meta">{r.description}</div>
            <div className="uc-coord-meta" style={{ color: "#666" }}>
              {r.orchestration} &middot; {r.taskCount} tasks &middot; {r.agentCount} agent
              {r.agentCount !== 1 ? "s" : ""}
              {r.agentRole ? ` &middot; ${r.agentRole}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});
