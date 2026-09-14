// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryOpsTab } from "../components/MemoryOpsTab";
import {
  parseHygieneLine,
  parseReceiptAttribute,
  sortTiers,
} from "../components/memory-ops/format";
import { JOBS_EMPTY_COMMANDS } from "../components/memory-ops/JobsSection";
import { useWorldState } from "../hooks/use-world-state";
import type {
  MemoryJobsResponse,
  MemoryJobView,
  MemoryOverview,
} from "../lib/memory-observability-types";
import type { DashboardEvent } from "../lib/types";
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

const job = (overrides: Partial<MemoryJobView> = {}): MemoryJobView => ({
  id: "job-1",
  state: "running",
  workOpen: true,
  role: "evaluator",
  workerName: "Steward",
  requesterName: "Ada",
  spaceId: "space-ada",
  spaceName: "Ada's resident space",
  rootId: "job-1",
  parentId: null,
  depth: 0,
  remainingOperations: 17,
  deadline: NOW + 4 * 60_000,
  createdAt: NOW - 90_000,
  marker: "hygiene",
  task: "Review 5 competing records and propose a resolve policy.",
  citations: 3,
  adopted: null,
  ...overrides,
});

const overview: MemoryOverview = {
  trust: { profile: "local", ungated: true, autonomy: "guarded" },
  hygiene: [
    {
      entityName: "Ada",
      line: "[hygiene] stale=2 competing=1 pending=4 duplicates=0 overlong=1 unsupported=3",
      at: NOW - 600_000,
    },
  ],
  jobs: {
    open: 1,
    answered24h: 4,
    abstained24h: 1,
    cancelled24h: 0,
    byMarker: { hygiene: 1 },
  },
  resolutions: [
    {
      id: "res-1",
      policy: "evidence_weighted",
      spaceId: "space-ada",
      spaceName: "Ada's resident space",
      actorName: "Ada",
      at: NOW - 300_000,
      winnerId: "rec-win",
      loserIds: ["rec-a", "rec-b"],
      rationale: "Two independent writers corroborated the winner.",
    },
  ],
  ratifications: [
    {
      recordId: "rec-guide-1",
      spaceId: "guide",
      spaceName: "guide",
      ratifiedBy: { name: "Sovereign", standing: 42.5, basis: "standing>=15" },
      at: NOW - 120_000,
      preview: "Always cite the record id when adopting a proposal.",
    },
  ],
  credits: [
    {
      kind: "assistance_adopted",
      entityName: "Steward",
      amount: 1,
      ref: "job:job-0",
      at: NOW - 50_000,
    },
    {
      kind: "assistance_superseded",
      entityName: "Janitor",
      amount: -0.5,
      ref: "resolution:res-1",
      at: NOW - 40_000,
    },
  ],
  receipts: {
    recent: [
      {
        requestId: "req-1",
        entity: "Ada",
        surface: "openai",
        tiers: [
          { tier: "evidence", count: 2, bytes: 800 },
          { tier: "trusted", count: 1, bytes: 400 },
          { tier: "unverified", count: 3, bytes: 300 },
        ],
        usedBytes: 1500,
        budgetBytes: 2048,
        truncated: true,
        cacheHit: true,
        at: NOW - 10_000,
      },
    ],
    cache: { hits: 3, misses: 1, stores: 2 },
  },
  dispatch: { accumulationJobs24h: 2, sharedWriteJobs24h: 1, hygieneJobs24h: 1 },
  spaces: {
    institutional: [
      { id: "guide", name: "guide", records: 12, ratified: 7 },
      { id: "tradition-lore", name: "tradition · lore", records: 3, ratified: 1 },
    ],
  },
};

const emptyOverview: MemoryOverview = {
  ...overview,
  hygiene: [],
  jobs: { open: 0, answered24h: 0, abstained24h: 0, cancelled24h: 0, byMarker: {} },
  resolutions: [],
  ratifications: [],
  credits: [],
  receipts: { recent: [], cache: { hits: 0, misses: 0, stores: 0 } },
  spaces: { institutional: [] },
};

function routeFetch(view: MemoryOverview, jobs: MemoryJobView[], details?: MemoryJobView) {
  fetchApi.mockImplementation((path: string) => {
    if (path === "/api/memory/overview") return Promise.resolve(view);
    if (path.startsWith("/api/memory/jobs?"))
      return Promise.resolve({ jobs, nextCursor: null } satisfies MemoryJobsResponse);
    if (path.startsWith("/api/memory/jobs/") && details) return Promise.resolve(details);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

beforeEach(() => {
  resetWorldState();
  fetchApi.mockReset();
  postApi.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MemoryOpsTab", () => {
  it("renders all seven sections from the overview + jobs fixtures", async () => {
    routeFetch(overview, [job()]);
    renderWithProviders(<MemoryOpsTab />);

    for (const title of [
      "Posture",
      "Jobs",
      "Resolutions & ratifications",
      "Standing credits",
      "Receipts",
      "Hygiene",
      "Institutional spaces",
    ]) {
      expect(screen.getByLabelText(title)).toBeInTheDocument();
    }

    // Posture
    await waitFor(() => expect(screen.getByText("LOCAL · ungated")).toBeInTheDocument());
    expect(screen.getByText("autonomy · guarded")).toBeInTheDocument();
    expect(screen.getByText("Hygiene / 24h").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Accumulation / 24h").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Shared-write / 24h").nextElementSibling).toHaveTextContent("1");

    // Jobs row
    const row = await screen.findByTestId("job-job-1");
    expect(within(row).getByTestId("job-state-job-1")).toHaveTextContent("running");
    expect(within(row).getByText("Steward")).toBeInTheDocument();
    expect(within(row).getByText("hygiene")).toBeInTheDocument();
    expect(within(row).getByText(/17 ops left/)).toBeInTheDocument();
    expect(within(row).getByText(/\d+s left$/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Expand shows the scoped task
    fireEvent.click(within(row).getByRole("button", { name: /Expand job/ }));
    expect(
      within(row).getByText("Review 5 competing records and propose a resolve policy."),
    ).toBeInTheDocument();

    // Resolutions & ratifications
    const resolution = screen.getByTestId("resolution-res-1");
    expect(within(resolution).getByText("evidence weighted")).toBeInTheDocument();
    expect(within(resolution).getByText(/2 losers/)).toBeInTheDocument();
    expect(resolution).toHaveAttribute("title", "Two independent writers corroborated the winner.");
    expect(screen.getByText(/ratified by/)).toHaveTextContent(
      "Sovereign · standing 42.5 · standing>=15",
    );

    // Credits: sign + color
    const amounts = screen.getAllByTestId("credit-amount");
    expect(amounts[0]).toHaveTextContent("+1.00");
    expect(amounts[0]!.className).toContain("emerald");
    expect(amounts[1]).toHaveTextContent("−0.50");
    expect(amounts[1]!.className).toContain("red");

    // Hygiene mini-stats
    const hygiene = screen.getByTestId("hygiene-Ada");
    expect(within(hygiene).getByText("pending").nextElementSibling).toHaveTextContent("4");
    expect(within(hygiene).getByText("unsupported").nextElementSibling).toHaveTextContent("3");

    // Institutional spaces
    expect(screen.getByTestId("space-guide")).toHaveTextContent("12 records · 7 ratified");
    expect(screen.getByTestId("space-tradition-lore")).toBeInTheDocument();
  });

  it("cancels a job: optimistic patch, POST, then reconcile with the server row", async () => {
    routeFetch(overview, [job()]);
    let resolveCancel: (value: MemoryJobView) => void = () => {};
    postApi.mockImplementation(
      () =>
        new Promise<MemoryJobView>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    renderWithProviders(<MemoryOpsTab />);

    const row = await screen.findByTestId("job-job-1");
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));

    // Optimistic: state flips before the server answers, Cancel button is gone.
    expect(within(row).getByTestId("job-state-job-1")).toHaveTextContent("cancelled");
    expect(within(row).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(postApi).toHaveBeenCalledWith("/api/memory/jobs/job-1/cancel");

    await act(async () => {
      resolveCancel(job({ state: "cancelled", workOpen: false, remainingOperations: 0 }));
    });
    await waitFor(() => expect(within(row).getByText(/0 ops left/)).toBeInTheDocument());
    expect(row).toHaveAttribute("data-state", "cancelled");
  });

  it("reverts the optimistic cancel and surfaces the error when the POST fails", async () => {
    routeFetch(overview, [job()]);
    postApi.mockRejectedValue(new Error("API error: 403"));
    renderWithProviders(<MemoryOpsTab />);

    const row = await screen.findByTestId("job-job-1");
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("API error: 403"));
    expect(within(row).getByTestId("job-state-job-1")).toHaveTextContent("running");
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("patches a job in place and prepends new open jobs from live memory_job events", async () => {
    routeFetch(overview, [job()]);
    renderWithProviders(<MemoryOpsTab />);
    const row = await screen.findByTestId("job-job-1");
    expect(within(row).getByTestId("job-state-job-1")).toHaveTextContent("running");

    act(() => {
      useWorldState.getState().pushEvent({
        type: "memory_job",
        job: job({
          state: "answered",
          workOpen: false,
          citations: 5,
          adopted: { recordId: "rec-9", spaceId: "space-ada", at: NOW },
        }),
        timestamp: Date.now(),
      } as unknown as DashboardEvent);
    });

    await waitFor(() =>
      expect(within(row).getByTestId("job-state-job-1")).toHaveTextContent("answered"),
    );
    expect(within(row).getByText("adopted")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    // Task from the bootstrap fetch survives an event that omitted it.
    fireEvent.click(within(row).getByRole("button", { name: /Expand job/ }));
    expect(
      within(row).getByText("Review 5 competing records and propose a resolve policy."),
    ).toBeInTheDocument();

    act(() => {
      useWorldState.getState().pushEvent({
        type: "memory_job",
        job: job({
          id: "job-2",
          role: "reflector",
          workerName: "Janitor",
          marker: "accumulation",
          task: undefined,
        }),
        timestamp: Date.now() + 1,
      } as unknown as DashboardEvent);
    });
    const list = screen.getByLabelText("Assistance jobs");
    await waitFor(() => expect(within(list).getByTestId("job-job-2")).toBeInTheDocument());
    expect(list.firstElementChild).toHaveTextContent("Janitor");
  });

  it("renders receipt tier bars by bytes and routes 'open trace' to the trace explorer", async () => {
    routeFetch(overview, []);
    const onOpenTrace = vi.fn();
    renderWithProviders(<MemoryOpsTab onOpenTrace={onOpenTrace} />);

    const receipt = await screen.findByTestId("receipt-req-1");
    const bars = within(receipt).getByTestId("tier-bars");
    const segments = [...bars.querySelectorAll<HTMLElement>("[data-tier]")];
    // Injection order, not payload order.
    expect(segments.map((segment) => segment.dataset.tier)).toEqual([
      "trusted",
      "evidence",
      "unverified",
    ]);
    const evidence = segments.find((segment) => segment.dataset.tier === "evidence")!;
    expect(evidence.dataset.bytes).toBe("800");
    expect(evidence.style.width).toBe(`${(800 / 2048) * 100}%`);
    expect(within(receipt).getByText("cache hit")).toBeInTheDocument();
    expect(within(receipt).getByText("truncated")).toBeInTheDocument();
    expect(within(receipt).getByText(/1\.5 KB \/ 2\.0 KB \(73%\)/)).toBeInTheDocument();

    fireEvent.click(within(receipt).getByRole("button", { name: /open trace/ }));
    expect(onOpenTrace).toHaveBeenCalledWith("req-1");
  });

  it("shows helpful empty states with the exact world commands", async () => {
    routeFetch(emptyOverview, []);
    renderWithProviders(<MemoryOpsTab />);

    await waitFor(() => expect(screen.getByText(JOBS_EMPTY_COMMANDS.assist)).toBeInTheDocument());
    expect(screen.getByText(JOBS_EMPTY_COMMANDS.spawn)).toBeInTheDocument();
    expect(screen.getByText(/No resolutions yet/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing ratified/)).toBeInTheDocument();
    expect(screen.getByText(/No assistance credits/)).toBeInTheDocument();
    expect(screen.getByText(/No memory receipts yet/)).toBeInTheDocument();
    expect(screen.getByText(/No hygiene lines yet/)).toBeInTheDocument();
    expect(screen.getByText(/No institutional spaces/)).toBeInTheDocument();
  });

  it("filters jobs server-side by state/role and client-side by marker", async () => {
    routeFetch(overview, [job(), job({ id: "job-3", marker: "accumulation", role: "reflector" })]);
    renderWithProviders(<MemoryOpsTab />);
    await screen.findByTestId("job-job-1");
    expect(fetchApi).toHaveBeenCalledWith("/api/memory/jobs?state=open&limit=50");

    fireEvent.click(within(screen.getByLabelText("Filter marker")).getByText("accumulation"));
    // AnimatePresence keeps the exiting row mounted until its exit animation ends.
    await waitFor(() => expect(screen.queryByTestId("job-job-1")).not.toBeInTheDocument());
    expect(screen.getByTestId("job-job-3")).toBeInTheDocument();

    fireEvent.click(within(screen.getByLabelText("Filter role")).getByText("reflector"));
    fireEvent.click(within(screen.getByLabelText("Filter state")).getByText("all"));
    await waitFor(() =>
      expect(fetchApi).toHaveBeenCalledWith("/api/memory/jobs?state=all&limit=50&role=reflector"),
    );
  });
});

describe("memory-ops/format", () => {
  it("parses the hygiene line, defaulting absent keys to 0", () => {
    expect(
      parseHygieneLine("[hygiene] stale=2 competing=1 duplicates=0 overlong=1 unsupported=3"),
    ).toEqual({ stale: 2, competing: 1, pending: 0, duplicates: 0, overlong: 1, unsupported: 3 });
  });

  it("guards the receipt attribute structurally", () => {
    expect(parseReceiptAttribute("not json")).toBeUndefined();
    expect(parseReceiptAttribute(JSON.stringify({ requestId: "x" }))).toBeUndefined();
    const receipt = parseReceiptAttribute(
      JSON.stringify({
        schema: "marina.memory.receipt.v1",
        requestId: "req",
        entity: "Ada",
        tiers: [{ tier: "evidence", ids: [{ id: "r1", version: 2 }], bytes: 10 }],
        budgetBytes: 100,
        usedBytes: 10,
        truncated: false,
      }),
    );
    expect(receipt?.tiers[0]?.ids).toHaveLength(1);
    expect(receipt?.degraded).toEqual([]);
  });

  it("orders tiers by injection order with unknown tiers trailing", () => {
    expect(
      sortTiers([
        { tier: "pool" },
        { tier: "unverified" },
        { tier: "skill" },
        { tier: "evidence" },
      ]).map((t) => t.tier),
    ).toEqual(["skill", "evidence", "unverified", "pool"]);
  });
});

describe("MemoryOpsTab deep link", () => {
  it("focusJobId widens the filter, fetches the job by id and expands it", async () => {
    fetchApi.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/memory/overview")) return overview;
      if (url === "/api/memory/jobs/job-closed") {
        return job({
          id: "job-closed",
          state: "answered",
          workOpen: false,
          answer: "Adopt policy evidence_weighted.",
        });
      }
      if (url.startsWith("/api/memory/jobs")) return { jobs: [], nextCursor: null };
      throw new Error(`unexpected ${url}`);
    });
    renderWithProviders(<MemoryOpsTab focusJobId="job-closed" />);
    await waitFor(() => expect(screen.getByText("Adopt policy evidence_weighted.")).toBeTruthy());
    expect(fetchApi).toHaveBeenCalledWith("/api/memory/jobs/job-closed");
    expect(screen.getByRole("button", { name: /Collapse job job-closed/ })).toBeTruthy();
  });
});
