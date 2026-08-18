// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "../components/AuthGate";
import { useChatState } from "../hooks/use-chat-state";

interface Status {
  required: boolean;
  methods: string[];
  socialProviders: string[];
}

/** Route fetch by URL+method: /api/auth-status → status; /api/auth-session → sessionStatus. */
function mockFetch(status: Status, sessionStatus: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth-status")) {
        return new Response(JSON.stringify(status), { status: 200 });
      }
      if (url.includes("/api/auth-session")) {
        return new Response(JSON.stringify({ token: "marina-tok" }), { status: sessionStatus });
      }
      return new Response("{}", { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  useChatState.setState({ loggedIn: false });
  localStorage.clear();
});

describe("AuthGate", () => {
  it("renders children unchanged when auth is off", async () => {
    mockFetch({ required: false, methods: [], socialProviders: [] }, 401);
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    expect(await screen.findByText("app-content")).toBeInTheDocument();
    // Give the effect a tick; no overlay should ever appear.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByPlaceholderText("Email")).toBeNull();
  });

  it("shows the sign-in form when required and there is no session", async () => {
    mockFetch({ required: true, methods: ["email"], socialProviders: [] }, 401);
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByPlaceholderText("Email")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
  });

  it("shows a social button when a provider is configured", async () => {
    mockFetch({ required: true, methods: ["email", "google"], socialProviders: ["google"] }, 401);
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Continue with Google/i })).toBeInTheDocument(),
    );
  });

  it("shows the handle-claim step when the session needs a handle (post-OAuth)", async () => {
    // 400 from the silent exchange ⇒ an authenticated identity with no handle yet.
    mockFetch({ required: true, methods: ["email", "google"], socialProviders: ["google"] }, 400);
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("Claim your handle")).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/Handle/i)).toBeInTheDocument();
    // Not the credentials form.
    expect(screen.queryByPlaceholderText("Password")).toBeNull();
  });

  it("stays out of the way when already logged in", async () => {
    mockFetch({ required: true, methods: ["email"], socialProviders: [] }, 401);
    useChatState.setState({ loggedIn: true });
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    expect(await screen.findByText("app-content")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByPlaceholderText("Email")).toBeNull();
  });
});
