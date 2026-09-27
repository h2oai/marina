// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionWidgets } from "../components/ExtensionWidgets";
import { renderWithProviders } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("fetches widget content with session authentication and escapes supplied markup", async () => {
  localStorage.setItem("marina_chat_token", "fixture-session");
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ Authorization: "Bearer fixture-session" });
    if (path === "/api/extensions/widgets")
      return Response.json({
        widgets: [
          { id: "fixture:health", title: "Extension health", slot: "sidebar", source: "readiness" },
          { id: "fixture:admin", title: "Operator widget", slot: "admin-tab", source: "world" },
        ],
      });
    expect(path).toBe("/api/readiness");
    return Response.json({ status: "<script>injected</script>" });
  });
  vi.stubGlobal("fetch", fetcher);
  const { container } = renderWithProviders(<ExtensionWidgets slot="sidebar" />);
  expect(await screen.findByText(/injected/)).toBeInTheDocument();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.queryByText("Operator widget")).toBeNull();
});

it("does not turn a forged widget source into an arbitrary URL request", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      widgets: [
        {
          id: "fixture:invalid",
          title: "Invalid",
          slot: "sidebar",
          source: "https://example.invalid/private",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  renderWithProviders(<ExtensionWidgets slot="sidebar" />);
  expect(await screen.findByText("Invalid")).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
