// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import type { Perception } from "../types";
import { getErrorMessage } from "./errors";

interface CommandResponse {
  connectionId: string;
  requestId: string;
  active: boolean;
  error?: string;
}

const responses = new AsyncLocalStorage<CommandResponse>();

/** An approved replay produces its own world output, not the approver's command result. */
export function withoutCommandResponse<T>(execute: () => T): T {
  return responses.exit(execute);
}

/** One handler execution: whether it declared a refusal (`failCommandResponse`). */
interface HandlerOutcome {
  failed?: string;
}

const handlerOutcomes = new AsyncLocalStorage<HandlerOutcome>();

export function failCommandResponse(error: string): void {
  const outcome = handlerOutcomes.getStore();
  if (outcome) outcome.failed ??= error;
  const response = responses.getStore();
  if (response?.active) response.error ??= error;
}

/**
 * Run one command handler and report whether it refused through
 * `failCommandResponse` — on every ingress, with or without a correlated
 * response — so usage telemetry records a refusal as a failure. A nested
 * command (batch, macro) observes its own outcome, never the outer one.
 */
export function observeHandlerOutcome(
  execute: () => unknown,
): { failed?: string } | Promise<{ failed?: string }> {
  const outcome: HandlerOutcome = {};
  // A synchronous handler stays synchronous: callers that do not await the
  // command (tests, housekeeping) still see its quest and activity effects.
  const result = handlerOutcomes.run(outcome, execute);
  return result instanceof Promise ? result.then(() => outcome) : outcome;
}

/** Only output caused by this command, addressed to its original socket, is a result. */
export function correlateCommandPerception(connectionId: string, p: Perception): Perception {
  const response = responses.getStore();
  if (!response?.active || response.connectionId !== connectionId) return p;
  if (p.kind === "error") failCommandResponse(String(p.data.text ?? "Command failed"));
  return { ...p, command_request_id: response.requestId };
}

export function commandCompletion(requestId: string, error?: string): Perception {
  return {
    kind: "system",
    timestamp: Date.now(),
    data: { command_result: { request_id: requestId, ok: !error, ...(error ? { error } : {}) } },
  };
}

/** An explicit session-ending command must acknowledge before closing its socket. */
export function completeCommandResponse(connectionId: string, send: (p: Perception) => void): void {
  const response = responses.getStore();
  if (!response?.active || response.connectionId !== connectionId) return;
  response.active = false;
  send(commandCompletion(response.requestId, response.error));
}

export async function withCommandResponse(
  connectionId: string,
  requestId: string,
  execute: () => Promise<void>,
  send: (p: Perception) => void,
): Promise<void> {
  const response: CommandResponse = { connectionId, requestId, active: true };
  await responses.run(response, async () => {
    try {
      await execute();
    } catch (error) {
      failCommandResponse(getErrorMessage(error));
    } finally {
      // Detached background work is a later world event, never part of a completed result.
      completeCommandResponse(connectionId, send);
    }
  });
}
