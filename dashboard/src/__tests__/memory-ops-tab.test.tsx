// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryOpsTab } from "../components/MemoryOpsTab";
import {
  parseCacheHitAttribute,
  parseHygieneLine,
  parseReceiptAttribute,
  sortTiers,
  surfaceLabel,
} from "../components/memory-ops/format";
import {
  HYGIENE_SNAPSHOT_PATH,
  hygieneHistoryUrl,
  isForbiddenError,
  TRENDS_EMPTY_TEXT,
  TRENDS_FORBIDDEN_TEXT,
} from "../components/memory-ops/HygieneTrends";
import { JOBS_EMPTY_COMMANDS } from "../components/memory-ops/JobsSection";
import {
  formatRatio,
  RATIO_SPECS,
  ratioTone,
  storageUtilizationSeries,
} from "../components/memory-ops/RatiosSection";
import { FOCUS_SPACE_EVENT, sybilSignal } from "../components/memory-ops/SpaceHealth";
import { sparklineStats } from "../components/memory-ops/Sparkline";
import { useWorldState } from "../hooks/use-world-state";
import type {
  MemoryHygieneHistory,
  MemoryHygieneSample,
  MemoryJobsResponse,
  MemoryJobView,
  MemoryOverview,
  MemorySpaceHealth,
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

const share = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator > 0 ? numerator / denominator : null,
});

const ratios: MemoryOverview["ratios"] = {
  computedAt: NOW,
  windowMs: 86_400_000,
  scope: "all",
  redundancy: share(2, 40),
  contradictionRate: share(2, 10),
  unresolvedContradictionRate: share(0, 2),
  provenanceCoverage: share(30, 40),
  stalenessRatio: share(1, 20),
  unsafeServedRate: share(1, 8),
  reflectionRepetitionRate: share(0, 0),
  consolidationRoi: { numerator: 9, denominator: 3, value: 3 },
  repairSuccess: share(3, 4),
  leakage: { crossScopeAttempts: 2, crossScopeCacheHits: 0 },
  storage: [
    {
      ownerName: "Ada",
      logicalBytes: 750 * 1024 * 1024,
      maxBytes: 1024 * 1024 * 1024,
      sources: 12,
      maxSources: 100000,
      revisions: 40,
      maxRevisions: 100000,
      spaces: 2,
      maxSpaces: 256,
      utilization: 0.73,
      overLimit: [],
    },
    {
      ownerName: "Grace",
      logicalBytes: 2048,
      maxBytes: null,
      sources: 1,
      maxSources: null,
      revisions: 1,
      maxRevisions: null,
      spaces: 1,
      maxSpaces: null,
      utilization: null,
      overLimit: ["sources"],
    },
  ],
  cost: { receipts: 8, avgInjectedBytes: 1400, cacheHitRate: share(3, 8) },
};

const overview: MemoryOverview = {
  ratios,
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
      {
        requestId: "req-2",
        entity: "Grace",
        surface: "unknown",
        tiers: [{ tier: "unverified", count: 1, bytes: 120 }],
        usedBytes: 120,
        budgetBytes: 2048,
        truncated: false,
        cacheHit: false,
        at: NOW - 5_000,
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
    shared: [
      {
        id: "guide",
        name: "guide",
        institutional: true,
        ownerName: "Sovereign",
        records: 12,
        ratified: 7,
        writers: 2,
        freshWriters: 1,
        freshWriterShare: share(1, 2),
        competing: 0,
        resolutions24h: 2,
        unresolvedContradictionRate: share(0, 0),
        lastWriteAt: NOW - 3 * 3_600_000,
      },
      {
        id: "commons",
        name: "commons",
        institutional: false,
        ownerName: "Ada",
        records: 9,
        ratified: 0,
        writers: 4,
        freshWriters: 3,
        freshWriterShare: share(3, 4),
        competing: 2,
        resolutions24h: 1,
        unresolvedContradictionRate: share(2, 3),
        lastWriteAt: null,
      },
    ] satisfies MemorySpaceHealth[],
  },
};

/** Oldest → newest, one per hour. Redundancy has a 0/0 gap in the third sample. */
const sample = (
  hoursAgo: number,
  patch: Partial<Pick<MemoryOverview["ratios"], "redundancy" | "cost" | "storage">>,
): MemoryHygieneSample => ({
  at: NOW - hoursAgo * 3_600_000,
  ratios: { ...ratios, computedAt: NOW - hoursAgo * 3_600_000, ...patch },
});
const storageAt = (utilization: number) => [
  { ...ratios.storage[0]!, utilization },
  ratios.storage[1]!,
];
const history: MemoryHygieneHistory = {
  scope: "all",
  hours: 168,
  samples: [
    sample(3, {
      redundancy: share(4, 40),
      cost: { ...ratios.cost, cacheHitRate: share(1, 4) },
      storage: storageAt(0.6),
    }),
    sample(2, {
      redundancy: share(2, 40),
      cost: { ...ratios.cost, cacheHitRate: share(2, 4) },
      storage: storageAt(0.65),
    }),
    sample(1, {
      redundancy: share(0, 0),
      cost: { ...ratios.cost, cacheHitRate: share(3, 6) },
      storage: storageAt(0.7),
    }),
    sample(0, {
      redundancy: share(2, 40),
      cost: { ...ratios.cost, cacheHitRate: share(3, 8) },
      storage: storageAt(0.73),
    }),
  ],
};
const emptyHistory: MemoryHygieneHistory = { scope: "all", hours: 168, samples: [] };

const emptyOverview: MemoryOverview = {
  ...overview,
  hygiene: [],
  jobs: { open: 0, answered24h: 0, abstained24h: 0, cancelled24h: 0, byMarker: {} },
  resolutions: [],
  ratifications: [],
  credits: [],
  receipts: { recent: [], cache: { hits: 0, misses: 0, stores: 0 } },
  spaces: { institutional: [], shared: [] },
  ratios: {
    ...ratios,
    redundancy: share(0, 0),
    unsafeServedRate: share(0, 0),
    storage: [],
    cost: { receipts: 0, avgInjectedBytes: null, cacheHitRate: share(0, 0) },
  },
};

function routeFetch(
  view: MemoryOverview,
  jobs: MemoryJobView[],
  details?: MemoryJobView,
  trend: MemoryHygieneHistory | Error = view === emptyOverview ? emptyHistory : history,
) {
  fetchApi.mockImplementation((path: string) => {
    if (path === "/api/memory/overview") return Promise.resolve(view);
    if (path.startsWith("/api/memory/jobs?"))
      return Promise.resolve({ jobs, nextCursor: null } satisfies MemoryJobsResponse);
    if (path.startsWith("/api/memory/jobs/") && details) return Promise.resolve(details);
    if (path.startsWith("/api/memory/hygiene/history"))
      return trend instanceof Error ? Promise.reject(trend) : Promise.resolve(trend);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

const historyCalls = () =>
  fetchApi.mock.calls.filter(([path]) => String(path).startsWith("/api/memory/hygiene/history"));

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
      "Spaces",
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

    // Spaces come from `spaces.shared`, in delivered order.
    const spaces = screen.getByTestId("space-health");
    expect(spaces.firstElementChild).toHaveAttribute("data-testid", "space-guide");
    expect(screen.getByTestId("space-guide")).toHaveTextContent("12 / 7");
    expect(screen.getByTestId("space-commons")).toBeInTheDocument();
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
    expect(within(receipt).getByTitle("passthru surface")).toHaveTextContent("openai");
    // An `unknown` surface renders as an em dash, never the literal word.
    const unknown = screen.getByTestId("receipt-req-2");
    expect(within(unknown).getByTitle("passthru surface")).toHaveTextContent("—");
    expect(within(unknown).queryByText("unknown")).not.toBeInTheDocument();

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
    // Empty history: the nudge, no sparklines, Snapshot still offered.
    await waitFor(() =>
      expect(screen.getByTestId("trend-status")).toHaveTextContent(TRENDS_EMPTY_TEXT),
    );
    expect(screen.queryByTestId("sparkline-redundancy")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Snapshot now" })).toBeInTheDocument();
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

  it("labels passthru surfaces and parses stringly-typed cache-hit attributes", () => {
    expect(surfaceLabel("anthropic")).toBe("anthropic");
    expect(surfaceLabel("unknown")).toBe("—");
    expect(surfaceLabel(undefined)).toBe("—");
    expect(parseCacheHitAttribute("true")).toBe(true);
    expect(parseCacheHitAttribute("false")).toBe(false);
    expect(parseCacheHitAttribute(true)).toBe(true);
    expect(parseCacheHitAttribute("yes")).toBeUndefined();
    expect(parseCacheHitAttribute(undefined)).toBeUndefined();
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

describe("continuous hygiene ratios", () => {
  it("renders every ratio with value and numerator/denominator, n/a for empty denominators, and the storage budget", async () => {
    routeFetch(overview, []);
    renderWithProviders(<MemoryOpsTab />);
    const section = await screen.findByTestId("hygiene-ratios");
    for (const spec of RATIO_SPECS) {
      const card = within(section).getByTestId(`ratio-${spec.key}`);
      const r = ratios[spec.key];
      expect(card.textContent).toContain(formatRatio(r, spec.unit));
      expect(card.textContent).toContain(`${r.numerator} / ${r.denominator}`);
    }
    // 0/0 renders n/a, never 0 %.
    expect(within(section).getByTestId("ratio-reflectionRepetitionRate").textContent).toContain(
      "n/a",
    );
    expect(within(section).getByTestId("ratio-unsafeServedRate").textContent).toContain("13%");
    expect(within(section).getByTestId("ratio-consolidationRoi").textContent).toContain("3.0×");
    expect(within(section).getByTestId("ratio-cost").textContent).toContain("8 injected");
    expect(section.textContent).toContain("leakage: 2 refused");
    const storage = within(section).getByTestId("storage-budget");
    expect(within(storage).getByTestId("storage-Ada").textContent).toContain("750.0 MB");
    expect(within(storage).getByTestId("storage-Grace").textContent).toContain("unlimited");
    expect(within(storage).getByTestId("storage-Grace").textContent).toContain("over: sources");
  });

  it("tones ratios by direction: lower-is-better warns above the threshold, higher-is-better below it", () => {
    expect(ratioTone(share(1, 8), { better: "lower", warnAt: 0.0001 })).toBe("warning");
    expect(ratioTone(share(0, 8), { better: "lower", warnAt: 0.0001 })).toBe("success");
    expect(ratioTone(share(3, 4), { better: "higher", warnAt: 0.5 })).toBe("success");
    expect(ratioTone(share(1, 4), { better: "higher", warnAt: 0.5 })).toBe("warning");
    expect(ratioTone(share(0, 0), { better: "higher", warnAt: 0.5 })).toBe("default");
    expect(formatRatio(share(1, 400), "share")).toBe("<1%");
  });
});

describe("hygiene trends", () => {
  it("draws a sparkline per ratio card: null samples are gaps, latest is highlighted, tooltip carries min/max/latest", async () => {
    routeFetch(overview, []);
    renderWithProviders(<MemoryOpsTab />);
    const section = await screen.findByTestId("hygiene-ratios");
    const spark = await within(section).findByTestId("sparkline-redundancy");
    expect(fetchApi).toHaveBeenCalledWith(hygieneHistoryUrl(168));
    // 4 samples, one 0/0 gap → two runs: a 2-point polyline and a lone point.
    expect(spark.dataset.points).toBe("3");
    expect(spark.dataset.gaps).toBe("1");
    expect(spark.querySelectorAll("polyline")).toHaveLength(1);
    expect(spark.querySelectorAll("[data-lone]")).toHaveLength(1);
    expect(spark.querySelectorAll("[data-latest]")).toHaveLength(1);
    expect(spark.querySelector("title")?.textContent).toBe(
      "redundancy: min 5% · max 10% · latest 5%",
    );
    // Every ratio card has one, plus the cost card and the top storage owner only.
    for (const spec of RATIO_SPECS) {
      expect(within(section).getByTestId(`sparkline-${spec.key}`)).toBeInTheDocument();
    }
    expect(
      within(section).getByTestId("sparkline-cacheHitRate").querySelector("title"),
    ).toHaveTextContent("cache hit rate: min 25% · max 50% · latest 38%");
    const ada = within(section).getByTestId("storage-Ada");
    expect(within(ada).getByTestId("sparkline-storage").querySelector("title")).toHaveTextContent(
      "Ada utilization: min 60% · max 73% · latest 73%",
    );
    expect(
      within(within(section).getByTestId("storage-Grace")).queryByTestId("sparkline-storage"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("trend-status")).toHaveTextContent("4 snapshots");
  });

  it("switches the range (24h / 7d / 30d, default 7d) and refetches", async () => {
    routeFetch(overview, []);
    renderWithProviders(<MemoryOpsTab />);
    await screen.findByTestId("sparkline-redundancy");
    const range = screen.getByLabelText("Trend range");
    expect(within(range).getByText("7d")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(range).getByText("24h"));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(hygieneHistoryUrl(24)));
    fireEvent.click(within(range).getByText("30d"));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(hygieneHistoryUrl(720)));
  });

  it("Snapshot now POSTs the snapshot then refetches the history", async () => {
    routeFetch(overview, []);
    postApi.mockResolvedValue({ at: NOW });
    renderWithProviders(<MemoryOpsTab />);
    await screen.findByTestId("sparkline-redundancy");
    const before = historyCalls().length;
    fireEvent.click(screen.getByRole("button", { name: "Snapshot now" }));
    await waitFor(() => expect(postApi).toHaveBeenCalledWith(HYGIENE_SNAPSHOT_PATH));
    await waitFor(() => expect(historyCalls().length).toBeGreaterThan(before));
  });

  it("hides trends behind a one-line note when the history endpoint answers 403", async () => {
    routeFetch(overview, [], undefined, new Error("API error: 403"));
    renderWithProviders(<MemoryOpsTab />);
    const section = await screen.findByTestId("hygiene-ratios");
    await waitFor(() =>
      expect(screen.getByTestId("trend-status")).toHaveTextContent(TRENDS_FORBIDDEN_TEXT),
    );
    // Live ratios still render; nothing privileged is offered.
    expect(within(section).getByTestId("ratio-redundancy")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-redundancy")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snapshot now" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Trend range")).not.toBeInTheDocument();
    expect(isForbiddenError(new Error("API error: 403"))).toBe(true);
    expect(isForbiddenError(new Error("API error: 500"))).toBe(false);
  });

  it("summarises sparkline values and pulls one owner's utilization out of the history", () => {
    expect(sparklineStats([null, null])).toBeNull();
    expect(sparklineStats([0.1, null, 0.3])).toEqual({
      min: 0.1,
      max: 0.3,
      latest: 0.3,
      points: 2,
      gaps: 1,
    });
    expect(storageUtilizationSeries(history.samples, "Ada")).toEqual([0.6, 0.65, 0.7, 0.73]);
    expect(storageUtilizationSeries(history.samples, "Grace")).toEqual([null, null, null, null]);
  });
});

describe("space health", () => {
  it("renders each shared space with owner, records/ratified, writers bar, competing, resolutions, unresolved rate and last write", async () => {
    routeFetch(overview, []);
    renderWithProviders(<MemoryOpsTab />);
    const guide = await screen.findByTestId("space-guide");
    expect(within(guide).getByText("institutional")).toBeInTheDocument();
    expect(within(guide).getByText("owner Sovereign")).toBeInTheDocument();
    expect(within(guide).getByText("records / ratified").nextElementSibling).toHaveTextContent(
      "12 / 7",
    );
    expect(within(guide).getByText("resolutions 24h").nextElementSibling).toHaveTextContent("2");
    // 0/0 unresolved is n/a, never 0 %.
    expect(within(guide).getByText("unresolved").nextElementSibling).toHaveTextContent("n/a");
    expect(within(guide).getByText(/last write 3h ago/)).toBeInTheDocument();
    // 1 of 2 fresh is 50 % but only two writers — no Sybil warning.
    expect(guide).not.toHaveAttribute("data-warn");

    const commons = screen.getByTestId("space-commons");
    expect(within(commons).queryByText("institutional")).not.toBeInTheDocument();
    expect(within(commons).getByText("owner Ada")).toBeInTheDocument();
    expect(within(commons).getByText("competing").nextElementSibling).toHaveTextContent("2");
    expect(within(commons).getByText("unresolved").nextElementSibling).toHaveTextContent("67%");
    expect(within(commons).getByText("no writes yet")).toBeInTheDocument();
    // 3 of 4 writers fresh → Sybil-shaped: warn tone + bar width = share.
    expect(commons).toHaveAttribute("data-warn", "true");
    expect(within(commons).getByTestId("space-fresh-bar-commons").style.width).toBe("75%");
    expect(within(commons).getByTestId("space-writers-commons")).toHaveAttribute(
      "title",
      expect.stringContaining("Sybil-shaped"),
    );
  });

  it("dispatches marina:focus-space with the space id when a row is clicked", async () => {
    routeFetch(overview, []);
    renderWithProviders(<MemoryOpsTab />);
    const guide = await screen.findByTestId("space-guide");
    const seen: string[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ spaceId: string }>).detail.spaceId);
    };
    window.addEventListener(FOCUS_SPACE_EVENT, listener);
    try {
      fireEvent.click(guide);
      fireEvent.click(screen.getByTestId("space-commons"));
    } finally {
      window.removeEventListener(FOCUS_SPACE_EVENT, listener);
    }
    expect(seen).toEqual(["guide", "commons"]);
  });

  it("flags the Sybil shape only when the fresh share is high AND there are several writers", () => {
    expect(sybilSignal({ writers: 4, freshWriterShare: share(3, 4) })).toBe(true);
    expect(sybilSignal({ writers: 3, freshWriterShare: share(2, 4) })).toBe(true);
    expect(sybilSignal({ writers: 2, freshWriterShare: share(2, 2) })).toBe(false);
    expect(sybilSignal({ writers: 6, freshWriterShare: share(2, 6) })).toBe(false);
    expect(sybilSignal({ writers: 0, freshWriterShare: share(0, 0) })).toBe(false);
  });
});
