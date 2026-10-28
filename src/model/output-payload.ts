// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Inspect the final provider payload, after the SDK's budget transformations. */
export function checkOutputPayload(
  payload: unknown,
  requested: number,
  explicit: boolean,
  report?: (detail: string) => void,
): void {
  if (!Number.isSafeInteger(requested) || requested <= 0)
    throw new Error("Output token allowance must be a positive integer");
  const body = payload as Record<string, unknown> | null;
  const config = body?.config as Record<string, unknown> | undefined;
  const generation = body?.generationConfig as Record<string, unknown> | undefined;
  const inference = body?.inferenceConfig as Record<string, unknown> | undefined;
  const options = body?.options as Record<string, unknown> | undefined;
  const actual =
    body?.maxTokens ??
    options?.maxTokens ??
    body?.max_tokens ??
    body?.max_completion_tokens ??
    body?.max_output_tokens ??
    config?.maxOutputTokens ??
    generation?.maxOutputTokens ??
    inference?.maxTokens;
  if (explicit && (typeof actual !== "number" || actual > requested))
    throw new Error(
      `Provider cannot enforce explicit output token ceiling ${requested} (payload ${String(actual ?? "omitted")}); choose a supported limit or provider`,
    );
  const thinking = body?.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (
    thinking?.type === "enabled" &&
    typeof actual === "number" &&
    (typeof thinking.budget_tokens !== "number" ||
      thinking.budget_tokens < 1024 ||
      thinking.budget_tokens >= actual)
  )
    throw new Error(
      `Thinking budget ${String(thinking.budget_tokens)} cannot fit output token allowance ${actual}; increase the allowance or disable thinking`,
    );
  if (actual !== requested)
    report?.(
      `output allowance requested:${requested} sent:${String(actual ?? "provider default")}`,
    );
}
