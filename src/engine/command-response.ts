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

export function failCommandResponse(error: string): void {
  const response = responses.getStore();
  if (response?.active) response.error ??= error;
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
