// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dirname, resolve } from "node:path";

// Replaced by build:native; ordinary Bun sources and bundles keep filesystem loading.
declare const MARINA_COMPILED: boolean | undefined;
export const IS_COMPILED = typeof MARINA_COMPILED !== "undefined" && MARINA_COMPILED;

/** Both src/ entry points and dist/ bundles sit one level below the package root. */
export const MARINA_ROOT = IS_COMPILED ? dirname(process.execPath) : resolve(import.meta.dir, "..");
