// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useInvestigationList } from "../../hooks/use-investigations";
import type { DashboardPanelProps } from "../../lib/panel-registry";
import { GlassPanel } from "../GlassPanel";
import { InvestigationView } from "./InvestigationView";

export function InvestigationPanel({
  binding,
  onBindingChange,
  active = true,
  ...focus
}: DashboardPanelProps) {
  const list = useInvestigationList(active);
  const [local, setLocal] = useState<{ caseId: string; attemptId?: string }>();
  const target = binding?.kind === "investigation" ? binding : local;
  const select = (caseId: string, attemptId?: string) => {
    setLocal({ caseId, attemptId });
    onBindingChange?.({ kind: "investigation", caseId, ...(attemptId ? { attemptId } : {}) });
  };
  return (
    <GlassPanel title="Prediction & research" icon={<Sparkles size={12} />} {...focus}>
      <div className="nodrag space-y-3 p-3">
        <div className="flex items-center gap-2">
          <select
            aria-label="Choose saved investigation"
            value={target?.caseId ?? ""}
            onChange={(event) => select(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-2 text-xs"
          >
            <option value="">Choose an investigation</option>
            {!list.isError &&
              list.data?.cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.question}
                </option>
              ))}
          </select>
          <a className="text-xs text-primary" href="/predict">
            New ↗
          </a>
        </div>
        {target?.caseId ? (
          <InvestigationView
            key={`${target.caseId}:${target.attemptId ?? "current"}`}
            caseId={target.caseId}
            attemptId={target.attemptId}
            active={active}
            onAttempt={(attempt) => select(attempt.caseId, attempt.id)}
            onErased={() => {
              setLocal(undefined);
              onBindingChange?.(null);
              void list.refetch();
            }}
          />
        ) : (
          <p className="py-6 text-center text-sm text-text-secondary">
            Your answer, reasoning and evidence canvas, alongside the rest of Marina.
          </p>
        )}
      </div>
    </GlassPanel>
  );
}
