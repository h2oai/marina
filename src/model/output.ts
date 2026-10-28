// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shared defaults for generated answers, including hidden reasoning tokens. */
export const DEFAULT_OUTPUT_TOKENS = 16_384;

export function configuredOutputTokens(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.MARINA_DEFAULT_MAX_TOKENS?.trim();
  const value = Number(raw);
  return raw && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function defaultOutputTokens(env: NodeJS.ProcessEnv = process.env): number {
  return configuredOutputTokens(env) ?? DEFAULT_OUTPUT_TOKENS;
}

/** An incomplete answer must not become a successful verification, plan or lesson. */
export class IncompleteModelOutputError extends Error {
  readonly name = "IncompleteModelOutputError";
  constructor(
    readonly reason: unknown,
    label = "Model",
  ) {
    super(`${label} returned incomplete output (${String(reason ?? "missing finish reason")})`);
  }
}

export function requireFinishedOutput(reason: unknown, label?: string): void {
  if (reason !== "stop" && reason !== "end_turn" && reason !== "stop_sequence")
    throw new IncompleteModelOutputError(reason, label);
}

/** Validate the termination metadata before a raw chat response is consumed. */
export function requireFinishedChat(data: unknown, label?: string): void {
  const choice = (data as { choices?: { finish_reason?: unknown }[] } | null)?.choices?.[0];
  requireFinishedOutput(choice?.finish_reason, label);
}
