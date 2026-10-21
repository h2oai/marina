// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator notification hook (`MARINA_OPS_NOTIFY`).
 *
 * Held actions (challenges) wait for a person, but an operator who is not in
 * the world when a hold opens never sees it, and the `ops inbox` item is
 * resolved when the hold expires. This hook pushes a content-free notice OUT of the world the moment
 * a hold opens (and when holds expire unanswered), to somewhere the operator
 * actually looks:
 *
 *   MARINA_OPS_NOTIFY=https://ntfy.example/marina   POST JSON to a webhook
 *   MARINA_OPS_NOTIFY=cmd:notify-send -a Marina      run a program (no shell);
 *                                                    title and detail are appended
 *                                                    as the last two arguments
 *
 * Unset or `off` (the default) sends nothing. A notice carries the class, the
 * requester's name, the reason, the token and the deadline — never the held
 * input. Fire-and-forget: a failed notice is logged and never blocks or fails
 * the hold.
 */

import { getErrorMessage } from "./errors";
import { Logger } from "./logger";

const logger = new Logger();

export const OPS_NOTIFY_ENV = "MARINA_OPS_NOTIFY";
/** A webhook or program gets this long before it is abandoned. */
export const OPS_NOTIFY_TIMEOUT_MS = 10_000;

export interface OpsNotice {
  /** `challenge.opened` | `challenge.unanswered` (stable, for routing rules). */
  event: string;
  title: string;
  detail: string;
  /** What the operator types to act on it. */
  action?: string;
  token?: string;
  class?: string;
  deadlineAt?: number;
}

export type OpsNotifyTarget =
  | { kind: "off" }
  | { kind: "webhook"; url: string }
  | { kind: "command"; argv: string[] };

/** Parse `MARINA_OPS_NOTIFY`; anything unrecognised is `off` (with a warning). */
export function parseOpsNotify(raw: string | undefined): OpsNotifyTarget {
  const value = raw?.trim() ?? "";
  if (!value || value.toLowerCase() === "off") return { kind: "off" };
  if (/^https?:\/\//i.test(value)) {
    try {
      return { kind: "webhook", url: new URL(value).toString() };
    } catch {
      logger.warn("ops", `${OPS_NOTIFY_ENV} is not a valid URL; notices are off`);
      return { kind: "off" };
    }
  }
  if (value.startsWith("cmd:")) {
    const argv = splitArgs(value.slice(4));
    if (argv.length > 0) return { kind: "command", argv };
  }
  logger.warn("ops", `${OPS_NOTIFY_ENV} must be an http(s) URL or cmd:<program>; notices are off`);
  return { kind: "off" };
}

/** Whitespace split with "double" / 'single' quoting — no shell, no expansion. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

type Sender = (
  target: Exclude<OpsNotifyTarget, { kind: "off" }>,
  notice: OpsNotice,
) => Promise<void>;

async function send(
  target: Exclude<OpsNotifyTarget, { kind: "off" }>,
  notice: OpsNotice,
): Promise<void> {
  if (target.kind === "webhook") {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "marina", ...notice }),
      signal: AbortSignal.timeout(OPS_NOTIFY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`webhook answered ${response.status}`);
    return;
  }
  const proc = Bun.spawn([...target.argv, notice.title, notice.detail], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), OPS_NOTIFY_TIMEOUT_MS);
  try {
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${target.argv[0]} exited ${code}`);
  } finally {
    clearTimeout(timer);
  }
}

let sender: Sender = send;

/** @internal test seam: capture notices instead of sending them. */
export function setOpsNotifySenderForTests(next: Sender | undefined): void {
  sender = next ?? send;
}

/**
 * Send one notice to the configured target. Returns at once; the delivery
 * runs in the background and only ever logs a failure.
 */
export function notifyOperator(
  notice: OpsNotice,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const target = parseOpsNotify(env[OPS_NOTIFY_ENV]);
  if (target.kind === "off") return Promise.resolve(false);
  return sender(target, notice).then(
    () => true,
    (error: unknown) => {
      logger.warn("ops", "Operator notice not delivered", {
        event: notice.event,
        target: target.kind,
        error: getErrorMessage(error),
      });
      return false;
    },
  );
}
