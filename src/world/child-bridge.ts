// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parent → child world: run one world command inside a running child and read
 * its reply. A child is a separate process on loopback (World Collective); its
 * pre-auth `POST /api/command` logs in by name, runs the command and returns
 * the rendered perceptions. The parent acts under the CALLER's name, so the
 * child's audit trail says who did it. Only the port recorded for a variant
 * this parent created is ever contacted.
 */

import { getErrorMessage } from "../engine/errors";

export type ChildFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function runInChild(
  port: number,
  as: string,
  command: string,
  opts: { timeoutMs?: number; fetcher?: ChildFetch } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  try {
    const res = await fetcher(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: as, command }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `child replied HTTP ${res.status}` };
    return { ok: true, text: body.text ?? "" };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}
