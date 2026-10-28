// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** An answer allowance, including reasoning, configurable by the provider operator. */
export function providerOutputTokens(): number {
  const raw = process.env.PROVIDER_MAX_OUTPUT_TOKENS;
  if (!raw) return 16_384;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("PROVIDER_MAX_OUTPUT_TOKENS must be a positive integer");
  return value;
}

export function requireProviderAnswer(reason: unknown): void {
  if (!["stop", "end_turn", "stop_sequence"].includes(String(reason)))
    throw new Error(`Provider answer is incomplete (${String(reason ?? "missing finish reason")})`);
}

/** The OpenAI API uses the completion field; compatible services use max_tokens. */
export function providerOutputField(baseUrl: string): Record<string, number> {
  const field =
    new URL(baseUrl).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens";
  return { [field]: providerOutputTokens() };
}
