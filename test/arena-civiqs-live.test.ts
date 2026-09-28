// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { forecastRound } from "../src/arena/forecast";
import {
  civiqsLiveEnabled,
  civiqsUrl,
  extractRoute,
  fetchCiviqsLive,
  parseCiviqsPage,
} from "../src/arena/research/civiqs-live";
import { civiqsNowcast, nowcastForecaster } from "../src/arena/research/civiqs-nowcast";
import type { ArenaLock, ArenaRound } from "../src/arena/types";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** A Civiqs results page: the Remix loader payload streamed inline. */
function page(payload: unknown): string {
  return `<html><script>window.__remixContext = {"state":{"loaderData":{"root":{"x":"a } brace"},"routes/_app.results_.$question":${JSON.stringify(payload)}}}};</script></html>`;
}

const approvalPayload = (last: string, approve: number, disapprove: number, filtered = false) => ({
  end_date: last,
  topline: {
    line_chart_data: [
      {
        key: "Approve",
        values: [
          { date: day("2026-09-24"), value: 0.341 },
          { date: day(last), value: approve },
        ],
      },
      {
        key: "Disapprove",
        values: [
          { date: day("2026-09-24"), value: 0.597 },
          { date: day(last), value: disapprove },
        ],
      },
    ],
    filtered_topline: filtered ? { approve: 0.2 } : { approve: 0.34 },
    unfiltered_topline: { approve: 0.34 },
  },
});

describe("live Civiqs reader", () => {
  it("builds the page URL the arena uses, percent-encoding filter values", () => {
    expect(civiqsUrl("approve_president_trump_2025")).toBe(
      "https://civiqs.com/results/approve_president_trump_2025",
    );
    expect(civiqsUrl("approve_president_trump_2025", { age: "65+" })).toBe(
      "https://civiqs.com/results/approve_president_trump_2025?age=65%2B",
    );
  });

  it("extracts the loader payload across braces inside strings", () => {
    const html = page({ note: 'a "quoted} value', n: 1 });
    expect(extractRoute(html, "routes/_app.results_.$question")).toEqual({
      note: 'a "quoted} value',
      n: 1,
    });
    expect(extractRoute("<html></html>", "routes/_app.results_.$question")).toBeUndefined();
  });

  it("parses fractions into archive-shaped points and refuses a filter that did not apply", () => {
    const snap = parseCiviqsPage(page(approvalPayload("2026-09-29", 0.34, 0.6)), "u", false);
    expect(snap.choices).toEqual(["Approve", "Disapprove"]);
    expect(snap.points.at(-1)).toEqual(["2026-09-29", 34, 60]);
    expect(snap.end_date).toBe("2026-09-29");
    // A subgroup request that came back with the national topline is the worst
    // failure available (the national series under a subgroup's name).
    expect(() =>
      parseCiviqsPage(page(approvalPayload("2026-09-29", 0.34, 0.6)), "u?party=X", true),
    ).toThrow(/did not apply/);
    expect(() =>
      parseCiviqsPage(page(approvalPayload("2026-09-29", 0.34, 0.6, true)), "u?party=X", true),
    ).not.toThrow();
    expect(() => parseCiviqsPage("<html>index</html>", "u", false)).toThrow(/no Civiqs/);
  });

  it("is on unless MARINA_ARENA_CIVIQS_LIVE=off", () => {
    expect(civiqsLiveEnabled({})).toBe(true);
    expect(civiqsLiveEnabled({ MARINA_ARENA_CIVIQS_LIVE: "off" })).toBe(false);
  });

  it("fetches through the injected fetcher and reports HTTP failures", async () => {
    const seen: string[] = [];
    const snap = await fetchCiviqsLive("approve_president_trump_2025", undefined, async (url) => {
      seen.push(url);
      return new Response(page(approvalPayload("2026-09-29", 0.34, 0.6)));
    });
    expect(seen).toEqual(["https://civiqs.com/results/approve_president_trump_2025"]);
    expect(snap.points.at(-1)?.[0]).toBe("2026-09-29");
    await expect(
      fetchCiviqsLive("x", undefined, async () => new Response("", { status: 503 })),
    ).rejects.toThrow(/503/);
  });
});

describe("nowcast with a live reading", () => {
  const emptyArchive = new ArenaData(
    "https://example.test",
    async () => new Response("", { status: 404 }),
  );
  const openRound = (lockInDays: number): ArenaRound => ({
    round_id: "civiqs-live-approval",
    tracker: "civiqs",
    series: "civiqs_net_approval",
    question: "Net approval?",
    target_type: "continuous_normal",
    lock_at: new Date(Date.now() + lockInDays * 86_400_000).toISOString(),
    release_at: new Date(Date.now() + (lockInDays + 2) * 86_400_000).toISOString(),
  });
  const live = async () =>
    parseCiviqsPage(page(approvalPayload("2026-09-29", 0.34, 0.598)), "live-url", false);

  it("uses the dashboard for an open round, never for one whose lock has passed", async () => {
    const open = await civiqsNowcast(emptyArchive, openRound(2), undefined, 6, live);
    expect(open).toMatchObject({ date: "2026-09-29", value: -25.8, snapshot: "live:live-url" });
    const closed = await civiqsNowcast(emptyArchive, openRound(-1), undefined, 6, live);
    expect(closed).toBeUndefined();
  });

  it("falls back to the archive when the live read fails", async () => {
    const failing = async () => {
      throw new Error("down");
    };
    expect(await civiqsNowcast(emptyArchive, openRound(2), undefined, 6, failing)).toBeUndefined();
  });

  it("moves the mean to a revised reading of the history's last day", async () => {
    const round = openRound(2);
    const lock: ArenaLock = {
      round_id: round.round_id,
      answer_history: Array.from({ length: 12 }, (_, i) => ({
        date: new Date(day("2026-07-10") + i * 7 * 86_400_000).toISOString().slice(0, 10),
        value: -25.3,
      })).concat([{ date: "2026-09-29", value: -25.3 }]),
    };
    const f = await nowcastForecaster(emptyArchive, forecastRound, { live })(round, lock);
    expect(f.topline?.mean).toBe(-25.8);
    expect(f.note).toContain("Civiqs daily nowcast 2026-09-29");
    // Without a live reader the same open round stays on the baseline.
    const plain = await nowcastForecaster(emptyArchive, forecastRound)(round, lock);
    expect(plain.topline?.mean).toBe(-25.3);
  });
});
