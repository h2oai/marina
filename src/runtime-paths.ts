// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";

/** Both src/ entry points and dist/ bundles sit one level below the package root. */
export const MARINA_ROOT = resolve(import.meta.dir, "..");
