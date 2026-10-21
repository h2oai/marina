// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { formatPerception } from "../net/formatter";
import { CommandError, MarinaClient, type Perception } from "../sdk/client";
import type { RelayReply } from "./resident-relay";

/** One resident's world presence, held by the supervisor for the whole run. */
export interface ResidentConnection {
  /** Use a renewed credential for later reconnects; the live connection stays. */
  setCredential(token: string): void;
  /** Run one world command as the resident on this connection (the command relay). */
  command(input: string): Promise<RelayReply>;
  close(): void;
}

export type ResidentConnector = (input: {
  name: string;
  token: string;
  room?: string;
}) => Promise<ResidentConnection>;

/** The world WebSocket URL for a routing HTTP base (`http://host:3300` → `ws://host:3300`). */
export function residentWorldUrl(httpBase: string): string {
  const url = new URL(httpBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

/**
 * Connect a resident with `MarinaClient`: its own workload credential, the
 * `agent` principal (an agent never answers a held action), automatic
 * reconnection with the current credential. Arrives in `room` when one is
 * named, through the ordinary `goto` command.
 */
export function marinaResidentConnector(worldUrl: string): ResidentConnector {
  return async ({ name, token, room }) => {
    const client = new MarinaClient(worldUrl, { internalToken: token, principal: "agent" });
    try {
      await client.connect(name);
      if (room) await client.command(`goto ${room}`);
    } catch (error) {
      client.disconnect();
      throw error;
    }
    return {
      setCredential: (next) => client.setInternalToken(next),
      command: async (input) => {
        try {
          return { ok: true, output: relayText(await client.command(input)) };
        } catch (error) {
          if (!(error instanceof CommandError)) throw error;
          return { ok: false, output: relayText(error.perceptions) || error.message };
        }
      },
      close: () => client.disconnect(),
    };
  };
}

/** A command's perceptions as the plain text `marina connect -c` prints. */
export function relayText(perceptions: Perception[]): string {
  return perceptions
    .filter((p) => !p.data?.capabilities)
    .map((p) => formatPerception(p, "plaintext"))
    .filter(Boolean)
    .join("\n");
}
