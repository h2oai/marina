// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

// ─── Rate Limiter (Token Bucket) ─────────────────────────────────────────────

export interface RateLimiterConfig {
  maxTokens: number; // bucket capacity (default: 30)
  refillRate: number; // tokens per refill (default: 5)
  refillInterval: number; // ms between refills (default: 1000)
  now?: () => number; // clock source for testing (default: Date.now)
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxTokens: 30,
  refillRate: 5,
  refillInterval: 1000,
};

export class RateLimiter {
  private config: RateLimiterConfig;
  private buckets = new Map<string, Bucket>();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Try to consume tokens from a key's bucket. Returns false if rate-limited. */
  consume(key: string, cost = 1): boolean {
    const now = (this.config.now ?? Date.now)();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.config.maxTokens, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    if (elapsed >= this.config.refillInterval) {
      const refills = Math.floor(elapsed / this.config.refillInterval);
      bucket.tokens = Math.min(
        this.config.maxTokens,
        bucket.tokens + refills * this.config.refillRate,
      );
      bucket.lastRefill += refills * this.config.refillInterval;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return true;
    }

    return false;
  }

  /** Reset a key's bucket to full capacity. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Get remaining tokens for a key. */
  getRemaining(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.config.maxTokens;

    // Calculate with refill
    const now = (this.config.now ?? Date.now)();
    const elapsed = now - bucket.lastRefill;
    const refills = Math.floor(elapsed / this.config.refillInterval);
    return Math.min(this.config.maxTokens, bucket.tokens + refills * this.config.refillRate);
  }

  /** Remove stale buckets that have been full for a while. */
  cleanup(): number {
    const now = (this.config.now ?? Date.now)();
    let removed = 0;
    const staleThreshold = this.config.refillInterval * 60; // 1 minute of inactivity

    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > staleThreshold) {
        this.buckets.delete(key);
        removed++;
      }
    }

    return removed;
  }
}
