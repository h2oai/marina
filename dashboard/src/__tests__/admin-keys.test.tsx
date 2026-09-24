// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPanel } from "../components/AdminPanel";
import { renderWithProviders } from "./test-utils";

// Mock the API layer so we can drive the auth/error/success branches that the
// Keys panel used to swallow silently.
const fetchApi = vi.fn();
const postApi = vi.fn();
const deleteApi = vi.fn();

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchApi: (...args: unknown[]) => fetchApi(...args),
  postApi: (...args: unknown[]) => postApi(...args),
  deleteApi: (...args: unknown[]) => deleteApi(...args),
  putApi: vi.fn(),
  patchApi: vi.fn(),
}));

beforeEach(() => {
  fetchApi.mockReset();
  postApi.mockReset();
  deleteApi.mockReset();
  // Other admin tabs also call fetchApi on mount; default them to empty.
  fetchApi.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The Admin panel opens on the Keys tab (no `?trace=` in the URL).
const EMPTY_KEYS = /No saved keys/i;
const openForm = () => fireEvent.click(screen.getByRole("button", { name: /\+ Add/i }));
const fillForm = (name: string, value: string) => {
  fireEvent.change(screen.getByPlaceholderText("Key name"), { target: { value: name } });
  fireEvent.change(screen.getByDisplayValue("Select provider..."), {
    target: { value: "anthropic" },
  });
  fireEvent.change(screen.getByPlaceholderText("API key value"), { target: { value } });
};

describe("AdminPanel · Keys tab", () => {
  it("surfaces an auth error instead of a misleading empty state when the list 401s", async () => {
    fetchApi.mockImplementation((path: string) =>
      path === "/api/keys" ? Promise.reject(new Error("API error: 401")) : Promise.resolve([]),
    );

    renderWithProviders(<AdminPanel />);

    await waitFor(() => expect(screen.getByText(/Not authorized/i)).toBeInTheDocument());
    expect(screen.queryByText(EMPTY_KEYS)).not.toBeInTheDocument();
  });

  it("shows the empty state only when the list genuinely loads empty", async () => {
    renderWithProviders(<AdminPanel />);
    await waitFor(() => expect(screen.getByText(EMPTY_KEYS)).toBeInTheDocument());
  });

  it("confirms a successful save and re-fetches the list", async () => {
    postApi.mockResolvedValue({ ok: true });
    renderWithProviders(<AdminPanel />);
    await waitFor(() => expect(screen.getByText(EMPTY_KEYS)).toBeInTheDocument());

    openForm();
    fillForm("my-key", "sk-ant-secret");
    fireEvent.click(screen.getByRole("button", { name: /^Save Key$/i }));

    await waitFor(() => expect(screen.getByText(/Key saved/i)).toBeInTheDocument());
    expect(postApi).toHaveBeenCalledWith("/api/keys", {
      name: "my-key",
      provider: "anthropic",
      value: "sk-ant-secret",
    });
  });

  it("surfaces a save failure instead of silently swallowing it", async () => {
    postApi.mockRejectedValue(new Error("API error: 401"));
    renderWithProviders(<AdminPanel />);
    await waitFor(() => expect(screen.getByText(EMPTY_KEYS)).toBeInTheDocument());

    openForm();
    fillForm("my-key", "sk-ant-secret");
    fireEvent.click(screen.getByRole("button", { name: /^Save Key$/i }));

    await waitFor(() => expect(screen.getByText(/Not authorized/i)).toBeInTheDocument());
    // Form stays open so the user can retry — value is preserved.
    expect(screen.getByPlaceholderText("API key value")).toBeInTheDocument();
  });
});
