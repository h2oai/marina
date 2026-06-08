import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "../components/AuthGate";
import { useChatState } from "../hooks/use-chat-state";

function mockStatus(status: { required: boolean; methods: string[]; socialProviders: string[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  useChatState.setState({ loggedIn: false });
});

describe("AuthGate", () => {
  it("renders children unchanged when auth is off", async () => {
    mockStatus({ required: false, methods: [], socialProviders: [] });
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    expect(await screen.findByText("app-content")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Email")).toBeNull();
  });

  it("shows the sign-in form when auth is required and not logged in", async () => {
    mockStatus({ required: true, methods: ["email"], socialProviders: [] });
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    // App still renders behind the overlay; the sign-in form appears after the
    // grace window elapses.
    expect(await screen.findByText("app-content")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText("Email")).toBeInTheDocument(), {
      timeout: 2500,
    });
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
  });

  it("stays out of the way when already logged in", async () => {
    mockStatus({ required: true, methods: ["email"], socialProviders: [] });
    useChatState.setState({ loggedIn: true });
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    expect(await screen.findByText("app-content")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1400));
    expect(screen.queryByPlaceholderText("Email")).toBeNull();
  });
});
