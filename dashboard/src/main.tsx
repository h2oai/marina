import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, type ReactNode, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./components/AuthGate";
import { initTheme } from "./hooks/use-theme";
import "./index.css";

const LazyCanvasPage = lazy(() =>
  import("./canvas/CanvasPage").then((m) => ({ default: m.CanvasPage })),
);

const LazyUnifiedCanvas = lazy(() =>
  import("./unified/UnifiedCanvas").then((m) => ({ default: m.UnifiedCanvas })),
);

const LazyWhoPage = lazy(() => import("./who/WhoPage").then((m) => ({ default: m.WhoPage })));

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

const isCanvas = window.location.pathname.startsWith("/canvas");
const isUnified = new URLSearchParams(window.location.search).has("unified");
const isWho = window.location.pathname.startsWith("/who");

function RootContent() {
  // Public per-entity pages are read-only and never gated.
  if (isWho) {
    return (
      <Suspense>
        <LazyWhoPage />
      </Suspense>
    );
  }
  // All interactive surfaces sit behind the optional sign-in gate (no-op when
  // auth is off).
  let surface: ReactNode;
  if (isUnified) {
    surface = (
      <Suspense>
        <LazyUnifiedCanvas />
      </Suspense>
    );
  } else if (isCanvas) {
    surface = (
      <Suspense>
        <LazyCanvasPage />
      </Suspense>
    );
  } else {
    surface = <App />;
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
