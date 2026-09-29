// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { TrustedDashboardPanels } from "../lib/panel-registry";
import { traceIdFromSearch } from "../lib/trace-links";
import { AdaptersTab } from "./AdminAdaptersTab";
import { CollectiveTab } from "./AdminCollectiveTab";
import { ConfigTab } from "./AdminConfigTab";
import { EndpointTab } from "./AdminEndpointTab";
import { IdentityTab } from "./AdminIdentityTab";
import { KeysTab } from "./AdminKeysTab";
import { McpTab } from "./AdminMcpTab";
import { OperationsTab } from "./AdminOperationsTab";
import { RolesTab } from "./AdminRolesTab";
import { SecurityTab } from "./AdminSecurityTab";
import { ExtensionWidgets } from "./ExtensionWidgets";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";
import { LogExplorer, MemoryOpsTab, OpsTab, TabSuspense, TraceExplorer } from "./lazy-tabs";

type Tab =
  | "keys"
  | "endpoint"
  | "adapters"
  | "roles"
  | "mcp"
  | "config"
  | "security"
  | "identity"
  | "collective"
  | "health"
  | "ops"
  | "memory"
  | "traces"
  | "logs"
  | "extensions";

const ADMIN_TABS: Tab[] = [
  "keys",
  "endpoint",
  "adapters",
  "roles",
  "mcp",
  "config",
  "security",
  "identity",
  "collective",
  "health",
  "ops",
  "memory",
  "traces",
  "logs",
  "extensions",
];

/**
 * Names other surfaces may use in `marina:open-admin` for a tab that renders
 * under a different id: readiness lives in the Health tab (with alerts and
 * productivity); `operations` is the legacy name of that same tab.
 */
export const ADMIN_TAB_ALIASES: Record<string, Tab> = {
  readiness: "health",
  operations: "health",
};

export function resolveAdminTab(requested: string | undefined): Tab | undefined {
  if (!requested) return undefined;
  if (ADMIN_TABS.includes(requested as Tab)) return requested as Tab;
  return ADMIN_TAB_ALIASES[requested];
}

export function AdminPanel({
  backContent,
  isFocused,
  onToggleFocus,
}: { backContent?: React.ReactNode } & PanelFocusProps) {
  const initialTraceId = traceIdFromSearch(window.location.search);
  const [tab, setTab] = useState<Tab>(initialTraceId ? "traces" : "keys");
  const [requestedTraceId, setRequestedTraceId] = useState<string | undefined>(initialTraceId);
  const [requestedJobId, setRequestedJobId] = useState<string | undefined>();

  useEffect(() => {
    const openOperations = () => setTab("health");
    // Hand-off from the unified canvas MEMORY layer (see
    // unified/lib/memory-map-admin-link.ts) and the header health badge /
    // spend chip (components/ops/admin-link.ts): `preventDefault()` tells the
    // dispatcher an admin surface claimed the event.
    const openAdmin = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: string; jobId?: string }>).detail;
      const tab = resolveAdminTab(detail?.tab);
      if (!tab) return;
      event.preventDefault();
      if (tab === "memory") setRequestedJobId(detail?.jobId);
      setTab(tab);
    };
    const openKeys = () => setTab("keys");
    const openTraces = (event: Event) => {
      const detail = (event as CustomEvent<{ traceId?: string }>).detail;
      setRequestedTraceId(detail?.traceId);
      setTab("traces");
    };
    window.addEventListener("marina:open-operations", openOperations);
    window.addEventListener("marina:open-keys", openKeys);
    window.addEventListener("marina:open-traces", openTraces);
    window.addEventListener("marina:open-admin", openAdmin);
    return () => {
      window.removeEventListener("marina:open-admin", openAdmin);
      window.removeEventListener("marina:open-operations", openOperations);
      window.removeEventListener("marina:open-keys", openKeys);
      window.removeEventListener("marina:open-traces", openTraces);
    };
  }, []);

  return (
    <GlassPanel
      title="Admin"
      icon={<Shield size={14} />}
      backContent={backContent}
      isFocused={isFocused}
      onToggleFocus={onToggleFocus}
    >
      <div className="flex overflow-x-auto border-b border-border text-[10px]">
        {ADMIN_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-none px-2 py-1 capitalize transition-colors ${
              tab === t ? "text-primary border-b border-primary" : "text-text-dim hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-2">
        {tab === "extensions" && (
          <>
            <ExtensionWidgets slot="admin-tab" />
            <TrustedDashboardPanels slot="admin-tab" />
          </>
        )}
        {tab === "keys" && <KeysTab />}
        {tab === "endpoint" && <EndpointTab />}
        {tab === "adapters" && <AdaptersTab />}
        {tab === "roles" && <RolesTab />}
        {tab === "mcp" && <McpTab />}
        {tab === "config" && <ConfigTab />}
        {tab === "security" && <SecurityTab />}
        {tab === "identity" && <IdentityTab />}
        {tab === "collective" && <CollectiveTab />}
        {tab === "health" && <OperationsTab />}
        <TabSuspense>
          {tab === "ops" && <OpsTab />}
          {tab === "memory" && (
            <MemoryOpsTab
              focusJobId={requestedJobId}
              onOpenTrace={(traceId) => {
                setRequestedTraceId(traceId);
                setTab("traces");
              }}
            />
          )}
          {tab === "traces" && <TraceExplorer requestedTraceId={requestedTraceId} />}
          {tab === "logs" && <LogExplorer />}
        </TabSuspense>
      </div>
    </GlassPanel>
  );
}
