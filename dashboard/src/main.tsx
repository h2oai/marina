import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
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
  if (isUnified) {
    return (
      <Suspense>
        <LazyUnifiedCanvas />
      </Suspense>
    );
  }
  if (isCanvas) {
    return (
      <Suspense>
        <LazyCanvasPage />
      </Suspense>
    );
  }
  if (isWho) {
    return (
      <Suspense>
        <LazyWhoPage />
      </Suspense>
    );
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RootContent />
    </QueryClientProvider>
  </StrictMode>,
);
