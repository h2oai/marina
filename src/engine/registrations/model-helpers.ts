// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getInternalModelToken } from "../../agent/agent-runtime";
import {
  ASK_SYSTEM_PROMPT,
  CODE_MODE_SYSTEM_PROMPT,
  formatUntrustedContext,
} from "../../agent/prompts/support-prompts";
import { localWsPort } from "../../net/listen-ports";
import { getErrorMessage } from "../errors";

/**
 * The local `/v1` endpoint refused a request (no provider, spend cap, route
 * limit, …). It carries the upstream's own message, which names the setting
 * that fixes it, so callers surface the refusal instead of reading it as "no
 * answer".
 */
export class LocalModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalModelError";
  }
}

/** The refusal's own message (`error.message` in an OpenAI-shaped body). */
export async function localModelFailure(resp: Response): Promise<LocalModelError> {
  let detail = "";
  try {
    const text = await resp.text();
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } | string };
      const err = body.error;
      detail =
        typeof err === "string" ? err : typeof err?.message === "string" ? err.message : text;
    } catch (err) {
      detail = text || getErrorMessage(err);
    }
  } catch (err) {
    detail = getErrorMessage(err);
  }
  detail = detail.trim().slice(0, 600);
  return new LocalModelError(
    `Model request failed (HTTP ${resp.status})${detail ? `: ${detail}` : "."} See \`readiness providers\`.`,
  );
}

export function parseExecApprovalTimeout(value: string | undefined): number | undefined {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function answerViaLocalModel(
  query: string,
  context: string,
): Promise<string | undefined> {
  const port = localWsPort();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const messages = [
      {
        role: "system",
        content: ASK_SYSTEM_PROMPT,
      },
      ...(context.trim()
        ? [
            {
              role: "user",
              content: formatUntrustedContext("Marina world context", context),
            },
          ]
        : []),
      { role: "user", content: query },
    ];

    const resp = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getInternalModelToken()}`,
      },
      body: JSON.stringify({
        model: "marina",
        messages,
        temperature: 0.2,
        max_tokens: 600,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw await localModelFailure(resp);

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export async function answerCodeViaLocalModel(request: {
  actor: string;
  profile: string;
  prompt: string;
  sessionId: string;
  workspaceRoot: string;
}): Promise<string | undefined> {
  const port = localWsPort();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const messages = [
      {
        role: "system",
        content: CODE_MODE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: formatUntrustedContext("Coding session metadata", {
          sessionId: request.sessionId,
          requester: request.actor,
          profile: request.profile,
          workspace: request.workspaceRoot,
        }),
      },
      { role: "user", content: request.prompt },
    ];

    const resp = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getInternalModelToken()}`,
      },
      body: JSON.stringify({
        model: "marina",
        messages,
        temperature: 0.2,
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw await localModelFailure(resp);

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : undefined;
  } finally {
    clearTimeout(timeout);
  }
}
