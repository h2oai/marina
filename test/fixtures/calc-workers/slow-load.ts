// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The real calc worker behind a simulated slow module load, as on a loaded
// machine: it reports ready only after this delay.
await Bun.sleep(400);
await import("../../../src/engine/commands/calc-worker");

export {};
