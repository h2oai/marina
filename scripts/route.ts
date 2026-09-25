#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getErrorMessage } from "../src/engine/errors";
import { MarinaRoutingClient } from "../src/sdk/routing-client";
import { httpBaseFromUrl } from "./marina";

export const ROUTE_USAGE = `marina route [--name <world-account>] <action> [session-id] [JSON or message-id]

  join <JSON>                     join/resume a generic participant
  discover                        list visible participants (first 100)
  events <session> [cursor]        replay up to 100 events after cursor
  publish <session> <JSON>         publish an event or array of events
  send <session> <JSON>            queue a directed message
  note <session> <target> <text>   send a plain-text note without JSON quoting
  channel-note <session> <channel> <text>  send plain text to a native conversation
  channels <session>              list native Marina conversations
  channel-read <session> <JSON>    {"channelId":"ch:team","after":0}
  channel-send <session> <JSON>    {"channelId":"ch:team","clientMessageId":"id","text":"hello"}
  control <session> <JSON>         owner-authorized runtime action (target defaults to session)
  runtime <session>                inspect latest runtime state
  inbox <session>                  read pending messages without acknowledging
  ack <session> <message-id>       acknowledge a message after handling it
  receipt <session> <message-id>   inspect delivery acknowledgment
  heartbeat <session>             update last-seen time
  leave <session>                 leave Marina; does not stop your process

Uses MARINA_URL (default ws://localhost:3300) and MARINA_TOKEN, or the named
account's cached token from marina connect. Joining alone does not capture
an agent's terminal or execute messages. Use marina supervise for managed agents.
`;

/** Exact account and server binding; never silently choose another cached identity. */
export function routingCachedToken(
  name: string,
  url: string,
  directory = join(homedir(), ".marina", "sessions"),
): string | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(name))
    throw new Error("Account name must contain only letters, digits, underscores or hyphens");
  try {
    const cached = JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8")) as {
      url?: string;
      token?: string;
    };
    if (
      cached.url &&
      httpBaseFromUrl(cached.url) === httpBaseFromUrl(url) &&
      typeof cached.token === "string"
    )
      return cached.token;
  } catch {
    // An absent or malformed cache is handled as missing credentials below.
  }
  return undefined;
}

export async function runRoute(args: string[]): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(ROUTE_USAGE);
    return 0;
  }
  try {
    let name: string | undefined;
    if (args[0] === "--name") {
      name = args[1];
      args = args.slice(2);
    }
    const [action, id, value] = args;
    const arities: Record<string, number[]> = {
      join: [2],
      control: [3],
      runtime: [2],
      discover: [1],
      events: [2, 3],
      publish: [3],
      send: [3],
      note: [4],
      "channel-note": [4],
      inbox: [2],
      ack: [3],
      receipt: [3],
      heartbeat: [2],
      leave: [2],
      channels: [2],
      "channel-read": [3],
      "channel-send": [3],
    };
    if (!action || !arities[action]?.includes(args.length)) throw new Error(ROUTE_USAGE);
    const url = process.env.MARINA_URL ?? "ws://localhost:3300";
    const token = process.env.MARINA_TOKEN ?? (name ? routingCachedToken(name, url) : undefined);
    if (!token)
      throw new Error(
        "Set MARINA_TOKEN or use --name with an account authenticated by marina connect <name>.",
      );
    const client = new MarinaRoutingClient({ url: httpBaseFromUrl(url), token });
    const signal = AbortSignal.timeout(15_000);
    let result: unknown;
    switch (action) {
      case "join":
        result = await client.join(JSON.parse(id!), signal);
        break;
      case "discover":
        result = await client.discover("", 100, signal);
        break;
      case "events":
        result = await client.events(id!, Number(value ?? 0), 100, signal);
        break;
      case "publish": {
        const parsed = JSON.parse(value!);
        result = await client.publish(id!, Array.isArray(parsed) ? parsed : [parsed], signal);
        break;
      }
      case "send":
        result = await client.send(id!, JSON.parse(value!), signal);
        break;
      case "note":
        result = await client.send(
          id!,
          {
            clientMessageId: crypto.randomUUID(),
            targetId: value!,
            kind: "note",
            payload: { text: args[3]! },
          },
          signal,
        );
        break;
      case "channel-note":
        result = await client.sendChannel(
          id!,
          value!,
          { clientMessageId: crypto.randomUUID(), text: args[3]! },
          signal,
        );
        break;
      case "channels":
        result = await client.channels(id!, signal);
        break;
      case "channel-read": {
        const input = JSON.parse(value!);
        result = await client.channelMessages(id!, input.channelId, input.after ?? 0, 100, signal);
        break;
      }
      case "channel-send": {
        const input = JSON.parse(value!);
        result = await client.sendChannel(
          id!,
          input.channelId,
          { clientMessageId: input.clientMessageId, text: input.text },
          signal,
        );
        break;
      }
      case "runtime":
        result = await client.runtime(id!, signal);
        break;
      case "control": {
        const input = JSON.parse(value!);
        result = await client.control(
          id!,
          input.targetId ?? id!,
          input.clientMessageId ?? crypto.randomUUID(),
          input.control ?? input,
          signal,
        );
        break;
      }
      case "inbox":
        result = await client.inbox(id!, 100, signal);
        break;
      case "ack":
        result = await client.acknowledge(id!, value!, signal);
        break;
      case "receipt":
        result = await client.receipt(id!, value!, signal);
        break;
      case "heartbeat":
        result = await client.heartbeat(id!, signal);
        break;
      case "leave":
        result = await client.leave(id!, signal);
        break;
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(getErrorMessage(error));
    return 1;
  }
}
if (import.meta.main) process.exit(await runRoute(process.argv.slice(2)));
