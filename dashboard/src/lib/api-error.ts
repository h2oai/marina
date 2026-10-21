// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The server's own explanation for a refused request (`{ error }` in the JSON
 * body, e.g. a 403 ownership refusal), or `fallback` with the status when the
 * body carries none.
 */
export async function responseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  } catch {
    // Not JSON: the fallback and status describe it.
  }
  return `${fallback} (${res.status})`;
}

/** Throw an Error carrying the server's explanation when `res` is not ok. */
export async function ensureOk(res: Response, fallback: string): Promise<Response> {
  if (!res.ok) throw new Error(await responseErrorMessage(res, fallback));
  return res;
}

/** The message of a caught value, for a notice. */
export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
