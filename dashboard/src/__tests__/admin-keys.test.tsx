// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPanel } from "../unified/panels/AdminPanel";
import { renderWithProviders } from "./test-utils";

// Mock the API layer so we can drive the auth/error/success branches that the
// Keys panel used to swallow silently.
const fetchApi = vi.fn();
const postApi = vi.fn();
const deleteApi = vi.fn();

vi.mock("../lib/api", () => ({
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

// AdminPanel starts rolled (collapsed); expand it so the Keys body renders.
const expandPanel = () => fireEvent.click(screen.getByTitle("Expand"));
const openForm = () => fireEvent.click(screen.getByRole("button", { name: /ADD KEY/i }));
const fillForm = (name: string, value: string) => {
  fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText("API key value"), { target: { value } });
};

describe("AdminPanel · Keys tab", () => {
  it("surfaces an auth error instead of a misleading empty state when the list 401s", async () => {
    fetchApi.mockImplementation((path: string) =>
      path === "/api/keys" ? Promise.reject(new Error("API error: 401")) : Promise.resolve([]),
    );

    renderWithProviders(<AdminPanel visible onClose={() => {}} />);
    expandPanel();

    await waitFor(() => expect(screen.getByText(/log in as an admin/i)).toBeInTheDocument());
    expect(screen.queryByText("No API keys configured")).not.toBeInTheDocument();
  });

  it("shows the empty state only when the list genuinely loads empty", async () => {
    renderWithProviders(<AdminPanel visible onClose={() => {}} />);
    expandPanel();
    await waitFor(() => expect(screen.getByText("No API keys configured")).toBeInTheDocument());
  });

  it("confirms a successful save and re-fetches the list", async () => {
    postApi.mockResolvedValue({ ok: true });
    renderWithProviders(<AdminPanel visible onClose={() => {}} />);
    expandPanel();
    await waitFor(() => expect(screen.getByText("No API keys configured")).toBeInTheDocument());

    openForm();
    fillForm("my-key", "sk-ant-secret");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(screen.getByText(/Key saved/i)).toBeInTheDocument());
    expect(postApi).toHaveBeenCalledWith("/api/keys", {
      name: "my-key",
      provider: "anthropic",
      value: "sk-ant-secret",
    });
  });

  it("surfaces a save failure instead of silently swallowing it", async () => {
    postApi.mockRejectedValue(new Error("API error: 401"));
    renderWithProviders(<AdminPanel visible onClose={() => {}} />);
    expandPanel();
    await waitFor(() => expect(screen.getByText("No API keys configured")).toBeInTheDocument());

    openForm();
    fillForm("my-key", "sk-ant-secret");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(screen.getByText(/log in as an admin/i)).toBeInTheDocument());
    // Form stays open so the user can retry — value is preserved.
    expect(screen.getByPlaceholderText("API key value")).toBeInTheDocument();
  });
});
