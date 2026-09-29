// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Shield } from "lucide-react";
import { useState } from "react";
import { usePrincipals } from "../hooks/use-api";
import { describeApiError, postApi } from "../lib/api";
import { PanelSkeleton } from "./OperatorFeedback";

export function IdentityTab() {
  const query = usePrincipals();
  const [error, setError] = useState<string | null>(null);
  const changeStatus = async (principalId: string, status: "active" | "suspended" | "disabled") => {
    setError(null);
    try {
      await postApi(`/api/principals/${encodeURIComponent(principalId)}/status`, { status });
      await query.refetch();
    } catch (cause) {
      setError(describeApiError(cause));
    }
  };

  return (
    <div className="space-y-2 text-[10px]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 uppercase tracking-wider text-primary">
          <Shield size={10} /> Principal identities
        </span>
        <button
          type="button"
          onClick={() => query.refetch()}
          className="text-primary hover:underline"
        >
          Refresh
        </button>
      </div>
      <p className="rounded border border-border bg-bg/40 p-2 text-text-dim">
        Immutable local IDs, world scope, ownership, lineage, and lifecycle status. Suspension is
        enforced at human login and agent launch. Newly spawned runtime agents receive independent,
        short-lived, audience-bound bearer credentials; only their hashes are stored. Credential
        rotation details are intentionally not exposed in this profile list.
      </p>
      {error && (
        <div role="alert" className="text-danger">
          {error}
        </div>
      )}
      {query.isLoading && <PanelSkeleton />}
      {query.isError && <div className="text-danger">Identity registry unavailable.</div>}
      {(query.data ?? []).map((principal) => (
        <article key={principal.principal_id} className="rounded border border-border bg-bg/50 p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <a
                href={`/who/${encodeURIComponent(principal.display_name)}`}
                className="font-semibold text-text-bright hover:text-primary hover:underline"
              >
                {principal.display_name}
              </a>
              <div className="text-text-dim">
                {principal.principal_type} · {principal.home_world} · {principal.principal_id}
              </div>
              {principal.lineage_parent_id && (
                <div className="text-text-dim">parent · {principal.lineage_parent_id}</div>
              )}
            </div>
            <span className={principal.status === "active" ? "text-success" : "text-warning"}>
              {principal.status}
            </span>
          </div>
          <div className="mt-2 flex gap-2">
            {principal.status === "active" ? (
              <button
                type="button"
                onClick={() => changeStatus(principal.principal_id, "suspended")}
                className="text-warning hover:underline"
              >
                Suspend
              </button>
            ) : (
              <button
                type="button"
                onClick={() => changeStatus(principal.principal_id, "active")}
                className="text-success hover:underline"
              >
                Reactivate
              </button>
            )}
            {principal.status !== "disabled" && (
              <button
                type="button"
                onClick={() => changeStatus(principal.principal_id, "disabled")}
                className="text-danger hover:underline"
              >
                Disable
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
