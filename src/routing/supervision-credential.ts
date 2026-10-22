// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import {
  MarinaRoutingClient,
  RoutingApiError,
  type SupervisionCredentialGrant,
} from "../sdk/routing-client";

const log = new Logger();
const RETRY_MS = 60_000;

/**
 * The supervisor's own routing credential (supervised residents). A person's
 * world session is exchanged once for a routing-only supervision credential,
 * so a later login by the same person (which replaces their world session)
 * no longer cuts the supervisor off, and the supervisor can still revoke its
 * residents. Renewed at 80 % of its lifetime; revoked on close. A server that
 * does not offer it (switch off, older server) keeps the session token.
 */
export interface SupervisionHold {
  /** Routing client for the supervisor's own traffic. */
  client: MarinaRoutingClient;
  /** Whether a supervision credential is held (false: the session token is used). */
  held: boolean;
  /** Revoke the credential and stop renewing. */
  close(): Promise<void>;
}

export async function openSupervision(options: {
  url: string;
  sessionToken: string;
  fetch?: typeof fetch;
}): Promise<SupervisionHold> {
  const sessionClient = new MarinaRoutingClient({
    url: options.url,
    token: options.sessionToken,
    fetch: options.fetch,
  });
  let grant: SupervisionCredentialGrant;
  try {
    grant = await sessionClient.issueSupervision(AbortSignal.timeout(15_000));
  } catch (error) {
    if (error instanceof RoutingApiError && error.status === 404)
      return { client: sessionClient, held: false, close: async () => {} };
    throw error;
  }
  let current = grant;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const client = new MarinaRoutingClient({
    url: options.url,
    token: () => current.token,
    fetch: options.fetch,
  });
  const schedule = (delayMs: number) => {
    clearTimeout(timer);
    if (closed) return;
    timer = setTimeout(renew, Math.max(1_000, delayMs));
    timer.unref?.();
  };
  const renew = async () => {
    if (closed) return;
    try {
      current = await client.renewSupervision(AbortSignal.timeout(15_000));
      schedule((current.expiresAt - Date.now()) * 0.8);
    } catch (error) {
      log.warn("routing", "Supervision credential renewal failed", {
        error: getErrorMessage(error),
      });
      // Retry while the current credential is still live; an expired one
      // stays refused by the server (no fallback to the person's session).
      if (current.expiresAt - Date.now() > RETRY_MS) schedule(RETRY_MS);
    }
  };
  schedule((current.expiresAt - Date.now()) * 0.8);
  return {
    client,
    held: true,
    close: async () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        await client.revokeSupervision(AbortSignal.timeout(15_000));
      } catch (error) {
        log.warn("routing", "Supervision credential revoke failed", {
          error: getErrorMessage(error),
        });
      }
    },
  };
}
