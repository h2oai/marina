// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { dossierBlock } from "../src/arena/formations";
import { buildResearchBrief } from "../src/arena/research/briefs";
import type { ArenaRound } from "../src/arena/types";
import { captureEvidence, validateEvidence } from "../src/research/evidence";
import {
  claimTextKey,
  evidenceChanges,
  indexEvidence,
  selectEvidence,
} from "../src/research/evidence-index";
import { type Measurement, measurementEligibility } from "../src/research/measurement";

const url = "https://example.org/survey";
const m: Measurement = {
  measure: "approval",
  source: "pollster",
  value: 38,
  population: "registered voters",
  response: "total approval",
  unit: "percent",
  quote: "Registered voters: total approval 38 percent.",
  url,
  observedFrom: "2026-10-01",
  observedThrough: "2026-10-03",
  publishedAt: "2026-10-04T12:00:00Z",
  availableAt: "2026-10-04T12:00:00Z",
};
const target = {
  measure: m.measure,
  source: m.source,
  population: m.population,
  response: m.response,
  unit: m.unit,
};
const window = {
  cutoff: "2026-10-05T14:00:00Z",
  since: "2026-10-01",
  text: m.quote,
  capturedAt: "2026-10-05T14:01:00Z",
  archived: false,
};

describe("measurement identity and availability", () => {
  test("exact target, other pollster and wrong population have distinct eligibility", () => {
    expect(measurementEligibility(m, target, window).eligibility).toBe("target");
    expect(measurementEligibility({ ...m, source: "other" }, target, window).eligibility).toBe(
      "change",
    );
    for (const change of [
      { population: "adults" },
      { response: "strong approval" },
      { unit: "fraction" },
    ]) {
      expect(measurementEligibility({ ...m, ...change }, target, window).eligibility).toBe(
        "background",
      );
    }
  });
  test("no invented numbers, unknown dates or future revisions become updates", () => {
    expect(measurementEligibility({ ...m, value: 42 }, target, window).eligibility).toBe(
      "rejected",
    );
    expect(
      measurementEligibility(
        { ...m, availableAt: undefined, publishedAt: undefined },
        target,
        window,
      ).eligibility,
    ).toBe("background");
    expect(
      measurementEligibility({ ...m, availableAt: "2026-10-06" }, target, window).eligibility,
    ).toBe("rejected");
    expect(
      measurementEligibility(
        { ...m, availableAt: "2026-10-05", publishedAt: undefined },
        target,
        window,
      ).eligibility,
    ).toBe("rejected");
  });
  test("observation is not publication; old releases remain background", () => {
    expect(
      measurementEligibility({ ...m, observedThrough: "2026-10-01" }, target, window).eligibility,
    ).toBe("background");
    expect(measurementEligibility(m, target, { ...window, since: "2026-10-05" }).eligibility).toBe(
      "background",
    );
    expect(
      measurementEligibility({ ...m, availableAt: undefined }, target, {
        ...window,
        cutoff: "2020-01-01",
      }).eligibility,
    ).toBe("rejected");
  });
});

test("measurement provenance survives captured replay and mirror dedupe", async () => {
  const brief = {
    roundId: "q",
    since: "2026-10-01",
    untilAt: window.cutoff,
    request: "Approval",
    target,
  };
  const source = {
    url,
    text: m.quote,
    published: m.publishedAt,
    availableAt: m.availableAt,
    measurements: [m],
  };
  const snapshot = await captureEvidence(
    brief,
    {
      report: `${m.quote} [source](${url})`,
      sources: [source],
      retriever: "fixture",
      searches: 0,
      costUsd: 0,
    },
    async () => undefined,
    { now: () => new Date(window.capturedAt) },
  );
  validateEvidence(snapshot);
  const omitted = dossierBlock({
    since: brief.since,
    verified: "",
    sources: 1,
    costUsd: 0,
    evidence: snapshot,
    researchLoop: {
      rounds: [],
      stop: "complete",
      selection: {
        mode: "on",
        fingerprint: snapshot.index!.fingerprint,
        stats: snapshot.index!.stats,
        selectedChars: 0,
      },
    },
  });
  expect(omitted).not.toContain(`${m.value} ${m.unit}`);
  expect(snapshot.index?.stats.target).toBe(1);
  const mirror = {
    ...snapshot.sources[0]!,
    url: "https://mirror.org/news",
    origin: url,
    measurements: [{ ...m, url: "https://mirror.org/news", origin: url }],
  };
  const next = indexEvidence(
    brief,
    snapshot.verified,
    [...snapshot.sources, mirror],
    window.cutoff,
  );
  expect(next.stats.duplicates).toBe(2);
  expect(next.stats.uniqueClaims).toBe(1);
  expect(evidenceChanges(snapshot.index!, next).changed).toBe(false);
  expect(next.stats.independentOrigins).toBe(1);
});

test("text novelty preserves signs and decimals", () => {
  expect(claimTextKey("- change -3.6% [a](https://a.org)")).not.toBe(
    claimTextKey("- change 36% [b](https://b.org)"),
  );
  expect(claimTextKey("Same fact [a](https://a.org)")).toBe(
    claimTextKey("Same fact [b](https://b.org)"),
  );
});

test("selection keeps whole citations and target measurements despite a long opening page", async () => {
  const brief = { roundId: "q", request: "approval", since: "2026-10-01", target };
  const source = {
    ...m,
    text: m.quote,
    textHash: "",
    capturedAt: window.capturedAt,
    temporal: "archive" as const,
    measurements: [m],
  };
  const idx = indexEvidence(
    brief,
    `${"irrelevant ".repeat(3000)} [source](${url})`,
    [source],
    window.cutoff,
  );
  const selected = selectEvidence(idx, brief, 300);
  expect(selected).toContain(m.quote);
  expect(selected.endsWith(`](${url})`)).toBe(true);
  expect(selected.length).toBeLessThanOrEqual(300);
});

test("Trends research does not spend a basket query on Wikipedia rankings", () => {
  const round: ArenaRound = {
    round_id: "trends-test",
    tracker: "google_trends",
    question: "Tesla and iPhone shares",
    cells: ["trends_share_tesla", "trends_share_iphone"],
    target_type: "profile_energy",
    lock_at: "2099-10-06T22:00:00Z",
    release_at: "2099-10-10T00:00:00Z",
  };
  const brief = buildResearchBrief(round, {
    round_id: round.round_id,
    answer_history_by_cell: Object.fromEntries(
      round.cells!.map((c) => [c, [{ date: "2099-10-01", value: 50 }]]),
    ),
  });
  expect(brief.queries?.join(" ")).not.toMatch(/wikipedia/i);
  expect(brief.request).not.toContain("For Wikipedia rankings");
  expect(brief.queries?.join(" ")).toMatch(/Tesla|tesla/);
});
