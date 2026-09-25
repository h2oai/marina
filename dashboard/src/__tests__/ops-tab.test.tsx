// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS_EMPTY_TEXT, stopUrl } from "../components/ops/AgentsSection";
import {
  capFraction,
  descendantsOf,
  formatCount,
  formatDuration,
  formatUsd,
  neverPruned,
  providerVerdict,
  resumeLabel,
  spendAtRisk,
  spendTone,
  stopConfirmText,
  topSpenders,
  totalDeleted,
} from "../components/ops/format";
import { OPS_REFRESH_EVENTS, OpsTab } from "../components/ops/OpsTab";
import { PROMPT_SECTIONS_EMPTY_TEXT } from "../components/ops/PromptBudgetSection";
import { PROVIDERS_EMPTY_HINT, PROVIDERS_SCOPED_TEXT } from "../components/ops/ProvidersSection";
import { RETENTION_NO_PASS_TEXT } from "../components/ops/RetentionSection";
import type {
  AgentOperatorRow,
  OpsAgentStopResponse,
  OpsOverview,
  ProviderProbeSummary,
} from "../lib/ops-types";
import { renderWithProviders, resetWorldState } from "./test-utils";

const fetchApi = vi.fn();
const postApi = vi.fn();

vi.mock("../lib/api", () => ({
  fetchApi: (...args: unknown[]) => fetchApi(...args),
  postApi: (...args: unknown[]) => postApi(...args),
  deleteApi: vi.fn(),
  putApi: vi.fn(),
  patchApi: vi.fn(),
  describeApiError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const NOW = Date.now();

const row = (overrides: Partial<AgentOperatorRow> = {}): AgentOperatorRow => ({
  name: "Lead",
  entityId: "e_lead",
  state: "autonomous",
  health: "ready",
  role: "watcher",
  model: "anthropic/claude-x",
  toolProfile: "full",
  spawnedBy: "system",
  uptimeMs: 5 * 60_000,
  toolCalls: 12,
  modelCalls: 4,
  tokens: { input: 12_500, output: 800 },
  cost: { totalUsd: 2.5, lastHourUsd: 0.5 },
  consecutiveErrors: 0,
  lastError: null,
  paused: null,
  nextTickInMs: 1500,
  operatorStatus: true,
  ...overrides,
});

const probe = (overrides: Partial<ProviderProbeSummary> = {}): ProviderProbeSummary => ({
  provider: "anthropic",
  model: "claude-x",
  ok: true,
  status: 200,
  latencyMs: 640,
  textOk: true,
  systemHonored: true,
  toolCallOk: true,
  toolCallError: null,
  servedBy: "anthropic/claude-x",
  error: null,
  checkedAt: NOW - 30_000,
  ...overrides,
});

const overview = (overrides: Partial<OpsOverview> = {}): OpsOverview => ({
  generatedAt: NOW,
  scope: "privileged",
  agents: [
    row(),
    row({
      name: "Worker",
      spawnedBy: "Lead",
      role: "mathematician",
      toolProfile: "crew",
      cost: { totalUsd: 0.25, lastHourUsd: 0.25 },
      consecutiveErrors: 3,
      lastError: { text: "429 rate limited", at: NOW - 10_000 },
      paused: {
        kind: "upstream-errors",
        reason: "3 consecutive upstream errors",
        since: NOW - 60_000,
        until: NOW + 4 * 60_000,
      },
      nextTickInMs: null,
    }),
    row({ name: "Grandchild", spawnedBy: "Worker", cost: { totalUsd: 0, lastHourUsd: 0 } }),
  ],
  spend: { lastHourUsd: 0.75, totalUsd: 2.75, caps: { perAgentUsd: 1, globalUsd: 5 } },
  retention: {
    lastReport: {
      at: NOW - 120_000,
      deleted: { feed_events: 40, primitive_usage: 1200 },
      skipped: ["media_jobs"],
      durationMs: 312,
    },
    policies: [
      { table: "feed_events", kind: "telemetry", keep: "7d", overridden: false },
      { table: "primitive_usage", kind: "telemetry", keep: "30d", overridden: true },
      { table: "chronicle", kind: "append-only", keep: "never", overridden: false },
    ],
  },
  prompt: {
    deferredTools: true,
    systemPromptBytes: 6100,
    systemPromptCapBytes: 6500,
    residentSchemaBytesByProfile: { full: 14_000, crew: 9_800, minimal: 5_100 },
    deferredSchemaBytes: 17_000,
    deferredToolCount: 51,
    continuationBudgetBytes: 6000,
    computedAt: NOW - 5_000,
    sections: [
      {
        name: "world-events",
        turns: 40,
        meanBytes: 2200,
        p95Bytes: 3900,
        deferralRate: 0,
        share: 0.42,
      },
      {
        name: "relevant-notes",
        turns: 40,
        meanBytes: 1300,
        p95Bytes: 2100,
        deferralRate: 0.25,
        share: 0.25,
      },
      { name: "reflection", turns: 8, meanBytes: 0, p95Bytes: 0, deferralRate: 1, share: 0 },
    ],
    turnsSampled: 40,
  },
  providers: [
    probe(),
    probe({
      provider: "openai",
      model: "gpt-x",
      servedBy: "openai/gpt-x",
      toolCallOk: false,
      toolCallError: "no tool_calls",
    }),
  ],
  decisions: {
    configured: false,
    backend: null,
    model: null,
    calibrated: null,
    gate: false,
    verify: false,
    windowMs: 86_400_000,
    counts: {},
    recent: [],
    health: { status: "ok", total: 0, errors: 0 },
  },
  security: {
    trustProfile: "shared",
    ungated: false,
    autonomy: "guarded",
    mcpAuthRequired: true,
    openApi: false,
    trustProxy: false,
    authRequired: false,
    loopbackBind: true,
    commandLimiterBypassed: false,
    limiters: [
      { name: "dashboard", maxTokens: 60, refillIntervalMs: 10_000, keyedBy: "principal" },
    ],
  },
  ...overrides,
});

beforeEach(() => {
  resetWorldState();
  fetchApi.mockReset();
  postApi.mockReset();
});

describe("ops format helpers", () => {
  it("formats money, counts and durations", () => {
    expect(formatUsd(0.5)).toBe("$0.5000");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatCount(950)).toBe("950");
    expect(formatCount(12_500)).toBe("12.5k");
    expect(formatCount(2_000_000)).toBe("2.0M");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(2 * 3_600_000 + 3 * 60_000)).toBe("2h 3m");
  });

  it("grades spend against caps and flags the 80 % line", () => {
    expect(capFraction(0.5, null)).toBeNull();
    expect(capFraction(0.5, 1)).toBe(0.5);
    expect(spendTone(0.5, null)).toBe("default");
    expect(spendTone(0.5, 1)).toBe("warning");
    expect(spendTone(0.8, 1)).toBe("danger");
    const o = overview();
    expect(spendAtRisk(o.spend, o.agents)).toBe(false);
    expect(spendAtRisk({ ...o.spend, lastHourUsd: 4.2 }, o.agents)).toBe(true);
    expect(spendAtRisk(o.spend, [row({ cost: { totalUsd: 1, lastHourUsd: 0.9 } })])).toBe(true);
    expect(
      spendAtRisk({ ...o.spend, caps: { perAgentUsd: null, globalUsd: null } }, o.agents),
    ).toBe(false);
  });

  it("ranks top spenders and drops idle agents", () => {
    expect(topSpenders(overview().agents).map((a) => a.name)).toEqual(["Lead", "Worker"]);
  });

  it("describes pauses", () => {
    expect(
      resumeLabel({ kind: "upstream-errors", reason: "", since: 0, until: NOW + 90_000 }, NOW),
    ).toBe("resumes in 1m 30s");
    expect(resumeLabel({ kind: "spend-cap", reason: "", since: 0, until: null }, NOW)).toContain(
      "cap",
    );
    expect(resumeLabel({ kind: "budget", reason: "", since: 0, until: null }, NOW)).toContain(
      "respawned",
    );
  });

  it("walks the lineage for the cascade confirmation", () => {
    const agents = overview().agents;
    expect(descendantsOf(agents, "Lead")).toEqual(["Grandchild", "Worker"]);
    expect(descendantsOf(agents, "Grandchild")).toEqual([]);
    expect(stopConfirmText("Lead", ["Grandchild", "Worker"])).toContain("2 agents it spawned");
    expect(stopConfirmText("Solo", [])).toBe('Stop agent "Solo"?');
  });

  it("summarizes retention", () => {
    const r = overview().retention;
    expect(totalDeleted(r.lastReport)).toBe(1240);
    expect(neverPruned(r)).toEqual(["chronicle"]);
    expect(neverPruned({ ...r, lastReport: null })).toEqual([
      "feed_events",
      "primitive_usage",
      "chronicle",
    ]);
  });

  it("gives each provider a one-word verdict", () => {
    expect(providerVerdict(probe())).toBe("ok");
    expect(providerVerdict(probe({ toolCallOk: false }))).toBe("tools");
    expect(providerVerdict(probe({ toolCallOk: null }))).toBe("ok");
    expect(providerVerdict(probe({ servedBy: "openai/gpt-x" }))).toBe("fallback");
    expect(providerVerdict(probe({ ok: false, textOk: false, error: "empty" }))).toBe("text");
    expect(providerVerdict(probe({ ok: false, error: "HTTP 500" }))).toBe("error");
  });

  it("refreshes on lifecycle events only, never streaming deltas", () => {
    expect(OPS_REFRESH_EVENTS.has("agent_spawn")).toBe(true);
    expect(OPS_REFRESH_EVENTS.has("agent_stop")).toBe(true);
    expect(OPS_REFRESH_EVENTS.has("agent_text_delta")).toBe(false);
    expect(OPS_REFRESH_EVENTS.has("agent_turn_start")).toBe(false);
  });
});

describe("OpsTab", () => {
  it("renders every section from the overview for an operator", async () => {
    fetchApi.mockResolvedValue(overview());
    renderWithProviders(<OpsTab />);
    await waitFor(() => expect(screen.getByTestId("ops-agent-Lead")).toBeInTheDocument());
    expect(fetchApi).toHaveBeenCalledWith("/api/ops/overview");

    const worker = screen.getByTestId("ops-agent-Worker");
    expect(within(worker).getByText(/paused · upstream errors/)).toBeInTheDocument();
    expect(within(worker).getByText(/resumes in/)).toBeInTheDocument();
    expect(within(worker).getByText(/429 rate limited/)).toBeInTheDocument();
    expect(within(worker).getByText("crew")).toBeInTheDocument();
    expect(screen.getByText("operator scope")).toBeInTheDocument();

    // Spend: caps + top spenders.
    expect(screen.getByTestId("ops-spender-Lead")).toBeInTheDocument();
    expect(screen.queryByTestId("ops-spender-Grandchild")).toBeNull();

    // Retention: deleted chips, override flag, never-pruned list.
    expect(screen.getByText("primitive_usage", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("overridden")).toBeInTheDocument();
    expect(screen.getByText(/Never pruned/).closest("div")).toHaveTextContent("chronicle");

    // Prompt budget: profile bars + deferral flag.
    expect(screen.getByTestId("ops-profile-minimal")).toHaveTextContent("5.0 KB");
    expect(screen.getByText("51")).toBeInTheDocument();

    // Prompt sections: one bar per section (share of prompt), deferral rate as a chip.
    const sections = screen.getByLabelText("Prompt sections");
    expect(sections).toHaveTextContent("40 turns sampled");
    const events = within(sections).getByTestId("ops-prompt-section-world-events");
    expect(events).toHaveTextContent("2.1 KB");
    expect(events).toHaveTextContent("p95 3.8 KB");
    expect(events).toHaveTextContent("42%");
    expect(within(events).getByText("deferred 0%")).toBeInTheDocument();
    // Largest share fills the track; the 25 % section is scaled against it.
    expect(events.querySelector("[aria-hidden] > div")).toHaveStyle({ width: "100%" });
    const notes = within(sections).getByTestId("ops-prompt-section-relevant-notes");
    expect(notes.querySelector("[aria-hidden] > div")).toHaveStyle({
      width: `${(0.25 / 0.42) * 100}%`,
    });
    expect(within(notes).getByText("deferred 25%").className).toContain("text-warning");
    const reflection = within(sections).getByTestId("ops-prompt-section-reflection");
    expect(within(reflection).getByText("deferred 100%").className).toContain("text-danger");

    // Providers: tool-call failure is visible.
    const openai = screen.getByTestId("ops-provider-openai");
    expect(within(openai).getByText("tools")).toBeInTheDocument();
    expect(within(openai).getByLabelText("openai tool call: failed")).toBeInTheDocument();

    // Security posture.
    expect(screen.getByText("SHARED")).toBeInTheDocument();
    expect(screen.getByText("bearer required")).toBeInTheDocument();
  });

  it("confirms the cascade with the children listed, posts the stop and reports them", async () => {
    fetchApi.mockResolvedValue(overview());
    const stopResult: OpsAgentStopResponse = {
      stopped: "Lead",
      stoppedChildren: ["Grandchild", "Worker"],
    };
    postApi.mockResolvedValue(stopResult);
    const confirm = vi.fn(() => true);
    renderWithProviders(<OpsTab confirm={confirm} />);
    await waitFor(() => expect(screen.getByTestId("ops-agent-Lead")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Stop Lead"));
    await waitFor(() => expect(postApi).toHaveBeenCalledWith(stopUrl("Lead")));
    expect(confirm).toHaveBeenCalledWith(stopConfirmText("Lead", ["Grandchild", "Worker"]));
    await waitFor(() =>
      expect(screen.getByText(/Stopped/)).toHaveTextContent("Grandchild, Worker"),
    );
  });

  it("does not post when the cascade confirmation is declined", async () => {
    fetchApi.mockResolvedValue(overview());
    renderWithProviders(<OpsTab confirm={() => false} />);
    await waitFor(() => expect(screen.getByTestId("ops-agent-Lead")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Stop Lead"));
    expect(postApi).not.toHaveBeenCalled();
  });

  it("hides stop buttons and provider probes for a resident scope", async () => {
    fetchApi.mockResolvedValue(overview({ scope: "resident", providers: null, agents: [row()] }));
    renderWithProviders(<OpsTab />);
    await waitFor(() => expect(screen.getByTestId("ops-agent-Lead")).toBeInTheDocument());
    expect(screen.queryByLabelText("Stop Lead")).toBeNull();
    expect(screen.getByText("your agents only")).toBeInTheDocument();
    expect(screen.getByText(PROVIDERS_SCOPED_TEXT)).toBeInTheDocument();
  });

  it("shows the prompt-sections empty state before any producer reports metrics", async () => {
    fetchApi.mockResolvedValue(
      overview({ prompt: { ...overview().prompt, sections: [], turnsSampled: 0 } }),
    );
    renderWithProviders(<OpsTab />);
    await waitFor(() => expect(screen.getByTestId("ops-agent-Lead")).toBeInTheDocument());
    const sections = screen.getByLabelText("Prompt sections");
    expect(sections).toHaveTextContent("0 turns sampled");
    expect(within(sections).getByText(PROMPT_SECTIONS_EMPTY_TEXT)).toBeInTheDocument();
    expect(screen.queryByTestId("ops-prompt-section-world-events")).toBeNull();
  });

  it("shows empty states with the exact commands, and a retention pass that never ran", async () => {
    fetchApi.mockResolvedValue(
      overview({
        agents: [],
        spend: { lastHourUsd: 0, totalUsd: 0, caps: { perAgentUsd: null, globalUsd: null } },
        providers: null,
        retention: { lastReport: null, policies: overview().retention.policies },
      }),
    );
    renderWithProviders(<OpsTab />);
    await waitFor(() =>
      expect(screen.getByText(new RegExp(AGENTS_EMPTY_TEXT))).toBeInTheDocument(),
    );
    expect(screen.getByText(PROVIDERS_EMPTY_HINT)).toBeInTheDocument();
    expect(screen.getAllByText(RETENTION_NO_PASS_TEXT).length).toBeGreaterThan(0);
    // "never" appears twice: the Last-pass metric and chronicle's keep window.
    expect(screen.getAllByText("never").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the fetch error notice with a retry", async () => {
    fetchApi.mockRejectedValueOnce(new Error("HTTP 500")).mockResolvedValue(overview());
    renderWithProviders(<OpsTab />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("HTTP 500"));
    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(screen.getByTestId("ops-agent-Lead")).toBeInTheDocument());
  });
});
