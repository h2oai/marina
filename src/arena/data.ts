// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only access to the arena's public data: the season's round definitions,
 * each round's frozen input history (`locks/`), and published resolutions. All
 * reads go through the SSRF guard and are cached briefly — the arena itself
 * refreshes every six hours.
 */

import { guardedFetch } from "../net/url-guard";
import type { ArenaLock, ArenaResolution, ArenaRound } from "./types";

export const DEFAULT_ARENA_DATA_URL =
  "https://raw.githubusercontent.com/Social-Atoms/social-sim-arena/main";
const CACHE_MS = 10 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export type ArenaFetch = (url: string) => Promise<Response>;

export class ArenaData {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly baseUrl: string = DEFAULT_ARENA_DATA_URL,
    private readonly fetcher: ArenaFetch = (url) =>
      guardedFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
    private readonly now: () => number = Date.now,
  ) {}

  private async json<T>(path: string): Promise<T> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.value as T;
    const res = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/${path}`);
    if (!res.ok) throw new Error(`arena data ${path}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(`arena data ${path}: response too large`);
    const value = JSON.parse(text) as T;
    this.cache.set(path, { at: this.now(), value });
    return value;
  }

  async rounds(): Promise<ArenaRound[]> {
    const season = await this.json<{ rounds: ArenaRound[] }>("questions/season0.json");
    return season.rounds;
  }

  async round(roundId: string): Promise<ArenaRound | undefined> {
    return (await this.rounds()).find((r) => r.round_id === roundId);
  }

  async lock(roundId: string): Promise<ArenaLock> {
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(roundId)) throw new Error(`bad round id ${roundId}`);
    return this.json<ArenaLock>(`locks/${roundId}.json`);
  }

  async resolutions(): Promise<Record<string, ArenaResolution>> {
    return this.json<Record<string, ArenaResolution>>("resolutions/resolved.json");
  }

  /**
   * One archived Civiqs snapshot (`civiqs/<dir>/<YYYY-MM-DD>.json`) — undefined
   * when the arena took none that day. Snapshots are immutable once written.
   */
  async civiqsSnapshot(
    dir: string,
    day: string,
  ): Promise<
    | {
        choices: string[];
        display_net?: { minuend?: string[] | string; subtrahend?: string[] | string };
        end_date?: string;
        fetched_at?: string;
        points: Array<[string, ...number[]]>;
      }
    | undefined
  > {
    if (!/^[A-Za-z0-9_.-]+$/.test(dir) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error("bad civiqs snapshot path");
    }
    try {
      return await this.json(`civiqs/${dir}/${day}.json`);
    } catch (err) {
      if (err instanceof Error && /HTTP 404/.test(err.message)) return undefined;
      throw err;
    }
  }

  /**
   * The arena's published site data (`site/data.json`): for resolved profile and
   * ranking rounds, the outcome and the persistence null's recorded loss —
   * resolutions/resolved.json carries scalar rounds only.
   */
  async siteRounds(): Promise<
    Array<{
      round_id: string;
      status: string;
      target_type: string;
      resolution?: { outcome?: unknown };
      scores?: Record<string, { energy?: number; loss?: number; skill?: number }>;
    }>
  > {
    const site = await this.json<{ rounds: Awaited<ReturnType<ArenaData["siteRounds"]>> }>(
      "site/data.json",
    );
    return site.rounds;
  }

  /** One archived Wikipedia daily top list (`wikitop/<project>.<access>/<day>.json`), or undefined. */
  async wikitopDay(
    dir: string,
    day: string,
  ): Promise<{ day: string; fetched_at?: string; articles: Record<string, number> } | undefined> {
    if (!/^[A-Za-z0-9_.-]+$/.test(dir) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error("bad wikitop path");
    }
    try {
      return await this.json(`wikitop/${dir}/${day}.json`);
    } catch (err) {
      if (err instanceof Error && /HTTP 404/.test(err.message)) return undefined;
      throw err;
    }
  }

  /** Google Trends basket archive directories (the arena runs one basket today). */
  async trendsBasketDirs(): Promise<string[]> {
    return ["basket.Tesla-iPhone-Samsung-Netflix-Disney.geo-US"];
  }

  /** One archived Google Trends comparison snapshot, or undefined. */
  async trendsSnapshot(
    dir: string,
    day: string,
  ): Promise<
    | {
        fetched_at?: string;
        queries: string[];
        points: Array<[string, string, number[], boolean]>;
      }
    | undefined
  > {
    if (!/^[A-Za-z0-9_.-]+$/.test(dir) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error("bad trends path");
    }
    try {
      return await this.json(`trends/${dir}/${day}.json`);
    } catch (err) {
      if (err instanceof Error && /HTTP 404/.test(err.message)) return undefined;
      throw err;
    }
  }

  /** Rounds still accepting forecasts (lock in the future), soonest first. */
  async openRounds(at = this.now()): Promise<ArenaRound[]> {
    return (await this.rounds())
      .filter((r) => Date.parse(r.lock_at) > at)
      .sort((a, b) => Date.parse(a.lock_at) - Date.parse(b.lock_at));
  }
}
