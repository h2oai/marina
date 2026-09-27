// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Tracks admitted handler lifetimes so transport shutdown cannot race database close. */
export class RequestDrain {
  private active = new Set<Promise<void>>();

  enter(): () => void {
    let resolve!: () => void;
    const done = new Promise<void>((finish) => {
      resolve = finish;
    });
    this.active.add(done);
    return () => {
      this.active.delete(done);
      resolve();
    };
  }

  async wait(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active]);
  }
}
