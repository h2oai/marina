// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Header health badge + spend chip: counts from `/api/readiness`, the
 * remediation popover, the Admin hand-off event, and the 80 %-of-cap red.
 */

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_ADMIN_EVENT, openAdminTab } from "../components/ops/admin-link";
import {
  attentionChecks,
  HealthBadge,
  healthCounts,
  healthTone,
} from "../components/ops/HealthBadge";
import { SpendChip, spendChipVisible } from "../components/ops/SpendChip";
import type { OpsOverview } from "../lib/ops-types";
import type { ReadinessReport } from "../lib/types";
import { renderWithProviders, resetWorldState } from "./test-utils";

const fetchApi = vi.fn();

vi.mock("../lib/api", () => ({
  fetchApi: (...args: unknown[]) => fetchApi(...args),
  postApi: vi.fn(),
  deleteApi: vi.fn(),
  putApi: vi.fn(),
  patchApi: vi.fn(),
  describeApiError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const report = (checks: ReadinessReport["checks"]): ReadinessReport =>
  ({
    instanceName: "test",
    world: "default",
    generatedAt: Date.now(),
    checks,
    demo: {
      score: 80,
      status: "ready",
      warmAgents: 1,
      expectedAgents: 1,
      recentMeaningfulEvents: 0,
      recentPrimitiveActions: 0,
      activeParticipants: 0,
      activeAgents: 0,
      recentCommunications: 0,
      marinaToolCalls: 0,
      autonomyQualified: true,
    },
  }) as unknown as ReadinessReport;

const CHECKS: ReadinessReport["checks"] = [
  { id: "llm", label: "Model routing", status: "ok", detail: "anthropic" },
  {
    id: "tabh2o",
    label: "TabH2O",
    status: "off",
    detail: "no key",
    remediation: "Set TABH2O_API_KEY",
  },
  {
    id: "room-agents",
    label: "Room agents",
    status: "degraded",
    detail: "no key",
    remediation: "Configure an LLM provider key.",
  },
];

const ops = (overrides: Partial<OpsOverview["spend"]> = {}, agentHour = 0.1): OpsOverview =>
  ({
    generatedAt: Date.now(),
    scope: "privileged",
    agents: [
      {
        name: "Lead",
        entityId: null,
        state: "autonomous",
        health: null,
        role: "",
        model: "x/y",
        toolProfile: "full",
        spawnedBy: "system",
        uptimeMs: 0,
        toolCalls: 0,
        modelCalls: null,
        tokens: { input: 0, output: 0 },
        cost: { totalUsd: agentHour, lastHourUsd: agentHour },
        consecutiveErrors: 0,
        lastError: null,
        paused: null,
        nextTickInMs: null,
        operatorStatus: true,
      },
    ],
    spend: {
      lastHourUsd: 0.1,
      totalUsd: 0.1,
      caps: { perAgentUsd: null, globalUsd: null },
      ...overrides,
    },
    retention: { lastReport: null, policies: [] },
    prompt: {
      deferredTools: true,
      systemPromptBytes: 1,
      systemPromptCapBytes: 1,
      residentSchemaBytesByProfile: { full: 1, crew: 1, minimal: 1 },
      deferredSchemaBytes: 0,
      deferredToolCount: 0,
      continuationBudgetBytes: 6000,
      computedAt: Date.now(),
      sections: [],
      turnsSampled: 0,
    },
    providers: null,
    security: {
      trustProfile: "local",
      ungated: true,
      autonomy: "guarded",
      mcpAuthRequired: false,
      openApi: false,
      trustProxy: false,
      authRequired: false,
      loopbackBind: true,
      commandLimiterBypassed: true,
      limiters: [],
    },
  }) as OpsOverview;

beforeEach(() => {
  resetWorldState();
  fetchApi.mockReset();
});

describe("health helpers", () => {
  it("counts statuses, orders attention degraded-first and grades the tone", () => {
    expect(healthCounts(CHECKS)).toEqual({ ok: 1, degraded: 1, off: 1 });
    expect(attentionChecks(CHECKS).map((c) => c.id)).toEqual(["room-agents", "tabh2o"]);
    expect(healthTone({ ok: 3, degraded: 0, off: 0 })).toBe("success");
    expect(healthTone({ ok: 3, degraded: 0, off: 2 })).toBe("success");
    expect(healthTone({ ok: 1, degraded: 1, off: 0 })).toBe("warning");
    expect(healthTone({ ok: 0, degraded: 0, off: 2 })).toBe("danger");
  });

  it("openAdminTab dispatches a cancelable marina:open-admin and reports whether it was claimed", () => {
    const seen: unknown[] = [];
    const claim = (e: Event) => {
      seen.push((e as CustomEvent).detail);
      e.preventDefault();
    };
    expect(openAdminTab("readiness")).toBe(false);
    window.addEventListener(OPEN_ADMIN_EVENT, claim);
    try {
      expect(openAdminTab("readiness")).toBe(true);
      expect(seen).toEqual([{ tab: "readiness" }]);
    } finally {
      window.removeEventListener(OPEN_ADMIN_EVENT, claim);
    }
  });
});

describe("HealthBadge", () => {
  it("shows ok/degraded/off counts, a remediation popover on hover, and opens Admin → Readiness on click", async () => {
    fetchApi.mockImplementation((path: string) =>
      path === "/api/readiness" ? Promise.resolve(report(CHECKS)) : Promise.resolve(ops()),
    );
    const seen: unknown[] = [];
    const claim = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_ADMIN_EVENT, claim);
    try {
      renderWithProviders(<HealthBadge />);
      const badge = await screen.findByTestId("health-badge");
      expect(badge).toHaveAccessibleName("Capability health: 1 ok, 1 degraded, 1 off");
      expect(screen.queryByTestId("health-popover")).toBeNull();

      fireEvent.mouseEnter(badge);
      const popover = screen.getByTestId("health-popover");
      expect(popover).toHaveTextContent("Room agents");
      expect(popover).toHaveTextContent("Configure an LLM provider key.");
      expect(popover).toHaveTextContent("Set TABH2O_API_KEY");
      expect(popover).not.toHaveTextContent("Model routing");

      fireEvent.click(badge);
      expect(seen).toEqual([{ tab: "readiness" }]);

      fireEvent.mouseLeave(badge);
      expect(screen.queryByTestId("health-popover")).toBeNull();
    } finally {
      window.removeEventListener(OPEN_ADMIN_EVENT, claim);
    }
  });

  it("renders nothing until the readiness report arrives", () => {
    fetchApi.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<HealthBadge />);
    expect(screen.queryByTestId("health-badge")).toBeNull();
  });
});

describe("SpendChip", () => {
  it("is hidden with no spend and no caps, visible with a cap, red at ≥ 80 % of a cap", async () => {
    expect(spendChipVisible(ops({ lastHourUsd: 0 }))).toBe(false);
    expect(
      spendChipVisible(ops({ lastHourUsd: 0, caps: { perAgentUsd: 1, globalUsd: null } })),
    ).toBe(true);

    fetchApi.mockResolvedValue(
      ops({ lastHourUsd: 4.5, caps: { perAgentUsd: null, globalUsd: 5 } }),
    );
    renderWithProviders(<SpendChip />);
    const chip = await screen.findByTestId("spend-chip");
    expect(chip).toHaveTextContent("$4.50/h");
    expect(chip).toHaveAttribute("data-at-risk", "true");
  });

  it("goes red when one agent nears the per-agent cap even if the runtime total is small", async () => {
    fetchApi.mockResolvedValue(
      ops({ lastHourUsd: 0.9, caps: { perAgentUsd: 1, globalUsd: 100 } }, 0.9),
    );
    renderWithProviders(<SpendChip />);
    const chip = await screen.findByTestId("spend-chip");
    expect(chip).toHaveAttribute("data-at-risk", "true");
  });

  it("stays neutral under the line and opens Admin → Ops on click", async () => {
    fetchApi.mockResolvedValue(ops({ lastHourUsd: 0.2, caps: { perAgentUsd: 1, globalUsd: 5 } }));
    const seen: unknown[] = [];
    const claim = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_ADMIN_EVENT, claim);
    try {
      renderWithProviders(<SpendChip />);
      const chip = await screen.findByTestId("spend-chip");
      expect(chip).toHaveAttribute("data-at-risk", "false");
      fireEvent.click(chip);
      await waitFor(() => expect(seen).toEqual([{ tab: "ops" }]));
    } finally {
      window.removeEventListener(OPEN_ADMIN_EVENT, claim);
    }
  });
});
