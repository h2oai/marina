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

it.each(["together", "nebius"])(
  "adding %s exposes its priced models immediately",
  async (provider) => {
    let saved = false;
    const model = `${provider}/vendor/chat-model`;
    fetchApi.mockImplementation((path: string) => {
      if (path === "/api/models" || path === "/api/models?refresh=1")
        return Promise.resolve({
          groups: saved
            ? [
                {
                  provider,
                  keySource: "db",
                  error: null,
                  models: [
                    {
                      value: model,
                      label: "Hosted chat",
                      pricing: { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 1 },
                    },
                  ],
                },
              ]
            : [],
          fetchedAt: 1,
          cached: false,
        });
      return Promise.resolve([]);
    });
    postApi.mockImplementation(async () => {
      saved = true;
      return { ok: true };
    });
    renderWithProviders(<AdminPanel />);
    await waitFor(() => expect(screen.getByText(EMPTY_KEYS)).toBeInTheDocument());
    openForm();
    fillForm("hosted", "fixture-secret");
    fireEvent.change(screen.getByDisplayValue("Anthropic"), { target: { value: provider } });
    fireEvent.click(screen.getByRole("button", { name: /^Save Key$/i }));
    const option = await screen.findByRole("option", {
      name: /Hosted chat · \$1\/\$4 per 1M in\/out/,
    });
    expect(option).toHaveAttribute("value", model);
    expect(postApi).toHaveBeenCalledWith("/api/keys", {
      name: "hosted",
      provider,
      value: "fixture-secret",
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh model catalog" }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith("/api/models?refresh=1"));
  },
);
