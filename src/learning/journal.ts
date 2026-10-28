// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Durable checkpoints for one lesson delivery. Values must be JSON serializable. */
export interface LearningJournal {
  /** Register before retaining plaintext or performing memory operations. */
  bindSpace(space: string): void;
  /** Stable, bounded request key for a physical memory mutation. */
  key(step: string): string;
  child(step: string): LearningJournal;
  has(step: string): boolean;
  run<T>(step: string, action: () => Promise<T>, keep?: (value: T) => boolean): Promise<T>;
}
