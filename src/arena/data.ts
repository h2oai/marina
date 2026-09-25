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

  /** Rounds still accepting forecasts (lock in the future), soonest first. */
  async openRounds(at = this.now()): Promise<ArenaRound[]> {
    return (await this.rounds())
      .filter((r) => Date.parse(r.lock_at) > at)
      .sort((a, b) => Date.parse(a.lock_at) - Date.parse(b.lock_at));
  }
}
