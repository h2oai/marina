// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, type ReactNode, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./components/AuthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initTheme } from "./hooks/use-theme";
import "./index.css";

const LazyUnifiedCanvas = lazy(() =>
  import("./unified/UnifiedCanvas").then((m) => ({ default: m.UnifiedCanvas })),
);

const LazyWhoPage = lazy(() => import("./who/WhoPage").then((m) => ({ default: m.WhoPage })));
const LazyTerminalWorkspace = lazy(() =>
  import("./components/TerminalWorkspace").then((m) => ({ default: m.TerminalWorkspace })),
);

// Apply saved theme before first render
initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

/** Small centered loading line for lazily loaded route chunks. */
function RouteFallback({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex h-full min-h-[40vh] items-center justify-center text-[12px] text-text-dim"
    >
      Loading {label}…
    </div>
  );
}

const isUnified = new URLSearchParams(window.location.search).has("unified");
const isWho = window.location.pathname.startsWith("/who");

/**
 * The Unified Canvas is an opt-in ALTERNATE interface, retired from the standard
 * dashboard. It's only reachable at `?unified` and only when the server enables
 * it via MARINA_UNIFIED_CANVAS=true (surfaced through the open /api/ui-config).
 * When disabled (the default), `?unified` bounces back to the standard dashboard.
 */
function UnifiedSurface() {
  const [status, setStatus] = useState<"loading" | "on" | "off">("loading");
  useEffect(() => {
    fetch("/api/ui-config")
      .then((r) => (r.ok ? r.json() : { unifiedCanvas: false }))
      .then((d) => setStatus(d.unifiedCanvas ? "on" : "off"))
      .catch(() => setStatus("off"));
  }, []);
  if (status === "loading") return null;
  if (status === "off") {
    // Not enabled — return to the standard dashboard rather than render it.
    window.location.replace("/");
    return null;
  }
  return (
    <ErrorBoundary fallbackTitle="Unified canvas crashed">
      <Suspense fallback={<RouteFallback label="unified canvas" />}>
        <LazyUnifiedCanvas />
      </Suspense>
    </ErrorBoundary>
  );
}

function RootContent() {
  if (window.location.pathname === "/terminal") {
    return (
      <ErrorBoundary fallbackTitle="Terminal workspace crashed">
        <Suspense fallback={<RouteFallback label="terminal workspace" />}>
          <LazyTerminalWorkspace />
        </Suspense>
      </ErrorBoundary>
    );
  }
  // Public per-entity pages are read-only and never gated.
  if (isWho) {
    return (
      <ErrorBoundary fallbackTitle="Profile page crashed">
        <Suspense fallback={<RouteFallback label="profile" />}>
          <LazyWhoPage />
        </Suspense>
      </ErrorBoundary>
    );
  }
  // All interactive surfaces sit behind the optional sign-in gate (no-op when
  // auth is off).
  let surface: ReactNode;
  if (isUnified) {
    surface = <UnifiedSurface />;
  } else {
    // The grid dashboard is one React tree of live panels; a throw in any of
    // them lands here instead of unmounting the page.
    surface = (
      <ErrorBoundary fallbackTitle="Dashboard crashed">
        <App />
      </ErrorBoundary>
    );
  }
  return <AuthGate>{surface}</AuthGate>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RootContent />
    </QueryClientProvider>
  </StrictMode>,
);
