import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { useEntityActivity } from "../hooks/use-entity-activity";
import { useWorldState } from "../hooks/use-world-state";

/**
 * Reset the Zustand world state store to its initial defaults.
 * Call this in beforeEach to isolate tests.
 */
export function resetWorldState() {
  useWorldState.setState({
    worldName: "",
    startRoom: "",
    entities: [],
    rooms: [],
    roomPopulations: {},
    connections: 0,
    memory: { heapUsed: 0, rss: 0 },
    eventFeed: [],
    connectedSince: 0,
    thinkingAgents: {},
    agentRanks: {},
    selectedRoom: null,
    selectedEntity: null,
  });
  useEntityActivity.getState().reset();
}

/** Create a fresh QueryClient that never retries (fast test failures). */
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

function TestProviders({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/**
 * Custom render that wraps the component in all required providers
 * (React Query, etc.). Use instead of `render()` from @testing-library/react.
 */
export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: TestProviders, ...options });
}
