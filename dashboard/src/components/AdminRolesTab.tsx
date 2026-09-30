// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Tags } from "lucide-react";
import { useRoles, useTraits } from "../hooks/use-api";
import { PanelSkeleton } from "./OperatorFeedback";

export function RolesTab() {
  const { data: roles, isLoading: rolesLoading } = useRoles();
  const { data: traits, isLoading: traitsLoading } = useTraits();
  if (rolesLoading || traitsLoading) return <PanelSkeleton />;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
        <Tags size={10} /> Roles
      </div>
      {roles?.map((r) => {
        const traitNames: string[] = JSON.parse(r.traits || "[]");
        return (
          <div key={r.name} className="text-[10px]">
            <span className="text-text-bright font-medium">{r.name}</span>
            {traitNames.length > 0 && (
              <span className="text-text-dim ml-1">[{traitNames.join(", ")}]</span>
            )}
            {r.description && <div className="text-text-dim ml-2">{r.description}</div>}
          </div>
        );
      })}

      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider mt-3">
        Traits
      </div>
      {traits?.map((t) => (
        <div key={t.name} className="text-[10px]">
          <span className="text-text-bright">{t.name}</span>
          <span className="text-text-dim ml-1">({t.category})</span>
        </div>
      ))}
    </div>
  );
}
