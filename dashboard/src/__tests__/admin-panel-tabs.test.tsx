// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * AdminPanel tab routing: every locally rendered tab mounts its own content,
 * and the `marina:open-admin` / `marina:open-keys` hand-offs switch tabs
 * (including the `readiness` / `operations` aliases for Health).
 */

import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPanel, resolveAdminTab } from "../components/AdminPanel";
import { renderWithProviders } from "./test-utils";

const fetchApi = vi.fn();
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchApi: (...args: unknown[]) => fetchApi(...args),
  postApi: vi.fn(),
  deleteApi: vi.fn(),
  putApi: vi.fn(),
  patchApi: vi.fn(),
}));

const RESPONSES: Record<string, unknown> = {
  "/api/model-endpoint": {
    mode: "passthru",
    passthruModel: "",
    fallback: false,
    strategy: "least-busy",
    panelSynthesis: "concat",
  },
  "/api/mcp": {
    url: "http://127.0.0.1:3302/mcp",
    port: 3302,
    tools: { world: [{ name: "look", description: "Look around" }] },
  },
  "/api/env": [
    {
      key: "MARINA_NAME",
      value: "harbour",
      category: "general",
      description: "Instance name",
      sensitive: false,
    },
  ],
};

beforeEach(() => {
  fetchApi.mockReset();
  fetchApi.mockImplementation((path: string) =>
    path in RESPONSES
      ? Promise.resolve(RESPONSES[path])
      : Promise.reject(new Error("API error: 503")),
  );
});

describe("AdminPanel tabs", () => {
  it.each([
    ["keys", "Default model"],
    ["endpoint", "Model Endpoint"],
    ["adapters", "Platform Adapters"],
    ["roles", "Traits"],
    ["mcp", "MCP Server"],
    ["config", "Environment Config"],
    ["security", "Security Status"],
    ["identity", "Principal identities"],
    ["collective", "World Collective"],
    ["health", "Operations Inbox"],
  ])("renders the %s tab", async (tab, marker) => {
    renderWithProviders(<AdminPanel />);
    fireEvent.click(screen.getByRole("button", { name: tab }));
    expect(await screen.findByText(marker)).toBeInTheDocument();
  });

  it("switches tabs on the open-admin and open-keys hand-offs", async () => {
    renderWithProviders(<AdminPanel />);
    const event = new CustomEvent("marina:open-admin", {
      detail: { tab: "readiness" },
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText("Operations Inbox")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("marina:open-keys"));
    });
    expect(await screen.findByText("Default model")).toBeInTheDocument();
    const unknown = new CustomEvent("marina:open-admin", {
      detail: { tab: "nope" },
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(unknown);
    });
    expect(unknown.defaultPrevented).toBe(false);
  });

  it("resolves tab names and aliases", () => {
    expect(resolveAdminTab("operations")).toBe("health");
    expect(resolveAdminTab("mcp")).toBe("mcp");
    expect(resolveAdminTab("nope")).toBeUndefined();
    expect(resolveAdminTab(undefined)).toBeUndefined();
  });
});
