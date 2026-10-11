// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getErrorMessage } from "../engine/errors";

/** A stop or persistence failure must not become a successful partial report. */
export class ResearchInterrupted extends Error {}

export interface ResearchCheckpoint {
  run<T>(key: string, input: unknown, action: () => Promise<T>): Promise<T>;
}

export function researchFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface Journal {
  schema: "marina.research.checkpoint.v1";
  identity: string;
  entries: Record<string, { input: string; value: unknown }>;
  accounting: Record<string, number>;
}

/**
 * Task-local, opt-in journal. Only successful steps are reused, with an exact
 * input match. The enclosing identity freezes task, model and retrieval config.
 * Atomic rename preserves the preceding checkpoint if writing is interrupted.
 * It contains research content: store it alongside the task, never in memory.
 */
export class FileResearchCheckpoint implements ResearchCheckpoint {
  private journal: Journal;

  constructor(
    private readonly path: string,
    identity: unknown,
    private readonly accounting?: () => Record<string, number>,
  ) {
    const hash = researchFingerprint(identity);
    this.journal = {
      schema: "marina.research.checkpoint.v1",
      identity: hash,
      entries: {},
      accounting: {},
    };
    if (existsSync(path)) {
      try {
        const saved = JSON.parse(readFileSync(path, "utf8")) as Journal;
        if (
          saved.schema !== this.journal.schema ||
          saved.identity !== hash ||
          !saved.entries ||
          !saved.accounting
        ) {
          throw new Error("task or configuration changed; use a new run label");
        }
        this.journal = saved;
      } catch (error) {
        throw new ResearchInterrupted(
          `Cannot resume research checkpoint: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  get costs(): Readonly<Record<string, number>> {
    return { ...this.journal.accounting };
  }

  private save(): void {
    try {
      if (this.accounting) this.journal.accounting = this.accounting();
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.journal), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      throw new ResearchInterrupted(`Cannot save research checkpoint: ${getErrorMessage(error)}`);
    }
  }

  async run<T>(key: string, input: unknown, action: () => Promise<T>): Promise<T> {
    const hash = researchFingerprint(input);
    const saved = Object.hasOwn(this.journal.entries, key) ? this.journal.entries[key] : undefined;
    if (saved?.input === hash) return structuredClone(saved.value) as T;
    try {
      const value = await action();
      this.journal.entries[key] = { input: hash, value: structuredClone(value) };
      return value;
    } finally {
      // Meter completed calls even when a later operation throws. A failed step
      // never overwrites a successful cached value or masquerades as success.
      this.save();
    }
  }
}
