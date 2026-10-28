// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Validate the transport envelope separately from the requested answer schema. */
export function modelResponseError(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Record<string, unknown>;
  if (
    !["model_response", "model_response_chunk", "model_response_end"].includes(String(frame.type))
  )
    return undefined;
  if (typeof frame.id !== "string" || !frame.id.trim())
    return "Model response needs the exact request id.";
  if (frame.type === "model_response_end" && frame.content === undefined) return undefined;
  if (
    typeof frame.content !== "string" ||
    (frame.type === "model_response" && !frame.content.trim())
  ) {
    return 'Model response needs a nonempty string content field. Put the requested answer (including JSON, encoded as a string) inside content, not alongside type and id. Example: {"type":"model_response","id":"<request id>","content":"<answer text>"}. The request is still waiting; send the corrected response.';
  }
  return undefined;
}
