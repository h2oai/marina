// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Typed HTTP models and methods for each SDK, generated from the OpenAPI document
// (protocol/marina.http.v1.openapi.json). `bun run docs:api` writes every output and
// `--check` fails when one is stale. Each language adds its renderer here.

/** One generated file: where it goes and how to render it from the OpenAPI document. */
export interface SdkModelOutput {
  /** Path from the repository root. */
  file: string;
  render: (openapi: Record<string, unknown>) => string;
}

export const SDK_MODEL_OUTPUTS: SdkModelOutput[] = [];
