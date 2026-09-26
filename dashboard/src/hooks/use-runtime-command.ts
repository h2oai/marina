// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { type MarinaRoutingClient, RoutingApiError } from "../../../src/sdk/routing-client";
import type { RuntimeControl } from "../../../src/sdk/routing-runtime-types";

/** A lost HTTP response retains the original id and payload for an explicit retry. */
export function useRuntimeCommand(client: MarinaRoutingClient, sessionId: string) {
  const pending = useRef<{ id: string; sessionId: string; control: RuntimeControl } | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function send(control: RuntimeControl): Promise<boolean> {
    if (inFlight.current) return false;
    const previous = pending.current;
    if (
      previous &&
      (previous.sessionId !== sessionId ||
        JSON.stringify(previous.control) !== JSON.stringify(control))
    ) {
      setError("Retry the pending request first so its delivery is known.");
      return false;
    }
    const request = previous ?? { id: crypto.randomUUID(), sessionId, control };
    return submit(request);
  }
  async function submit(request: {
    id: string;
    sessionId: string;
    control: RuntimeControl;
  }): Promise<boolean> {
    if (inFlight.current) return false;
    pending.current = request;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await client.control(
        request.sessionId,
        request.sessionId,
        request.id,
        request.control,
        AbortSignal.timeout(15000),
      );
      pending.current = null;
      setNotice(`Queued · ${message.id}. Delivery and execution appear in the stream.`);
      return true;
    } catch (cause) {
      if (cause instanceof RoutingApiError && [400, 401, 403, 404, 413].includes(cause.status))
        pending.current = null;
      setError(cause instanceof Error ? cause.message : "Control request failed");
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return {
    send,
    busy,
    error,
    notice,
    clearFeedback: () => {
      setNotice("");
      setError("");
    },
    pending: pending.current,
    retry: () => (pending.current ? submit(pending.current) : Promise.resolve(false)),
  };
}
