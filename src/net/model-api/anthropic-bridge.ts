// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Outbound Anthropic Messages proxy: OpenAI chat body → Anthropic request
// (translation lives in `../anthropic-tools`), reply → chat.completion, plus the
// system-prompt join, auto-cache switch and the stream-usage sidecar that
// `upstream.ts` reads at stream end. The INBOUND `/v1/messages` bridge is
// `../anthropic-inbound.ts`, wired from the dispatcher in `../model-api.ts`.

import { isLocalProfile } from "../../engine/trust-profile";
import {
  anthropicMessageToOpenai,
  buildAnthropicRequest,
  type OpenAIUsage,
  translateAnthropicStream,
} from "../anthropic-tools";
import { errorJson, isMarinaModel, MODEL_CORS } from "./shared";

/**
 * Final usage of a streamed Anthropic reply whose client did NOT ask for
 * `stream_options.include_usage` — the translator never emits it, so
 * `proxyToAnthropic` parks it here for `traceProxyResponse` to read at stream
 * end (keyed by the very Response object it returns).
 */
export const streamUsageSidecar = new WeakMap<Response, () => OpenAIUsage | undefined>();

/**
 * Concatenate the text blocks of an Anthropic Messages response. Thinking,
 * tool-use and any future non-text blocks are skipped; `content[0].text` is
 * NOT sufficient because the Claude 5 family emits a `thinking` block first.
 */
/**
 * Error text for a failed Anthropic response — includes the upstream reason
 * (e.g. the Claude 5 family rejecting an explicit `temperature`) instead of a
 * bare status text, so operators can see WHY passthru failed.
 */
async function anthropicErrorMessage(resp: Response): Promise<string> {
  const detail = await resp.text().catch(() => "");
  let reason = "";
  try {
    reason = String((JSON.parse(detail) as { error?: { message?: unknown } }).error?.message ?? "");
  } catch {
    reason = detail.slice(0, 200);
  }
  return `Anthropic API error: ${resp.statusText}${reason ? ` — ${reason.slice(0, 300)}` : ""}`;
}

/**
 * Anthropic takes one top-level `system` string. Concatenate every system
 * message (string content, or the text parts of an OpenAI content array) in
 * order, separated by a blank line, so nothing a client put in the system slot
 * is lost.
 */
export function anthropicSystemPrompt(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") {
      if (message.content.trim()) parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; text?: string }>) {
        if ((part.type === undefined || part.type === "text") && part.text?.trim())
          parts.push(part.text);
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * Whether the proxy adds a `cache_control: ephemeral` breakpoint to the LAST
 * system block of every Anthropic request that has none. Default: on under
 * the `local` trust profile (one operator, repeated prompts, their own bill),
 * off otherwise. `MARINA_ANTHROPIC_AUTO_CACHE=true|false` overrides. A client
 * that places its own markers (pi-ai with `cacheControlFormat: "anthropic"`,
 * an Anthropic SDK on `/v1/messages`) is never second-guessed.
 */
export function anthropicAutoCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MARINA_ANTHROPIC_AUTO_CACHE?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "off") return false;
  return isLocalProfile(env);
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/**
 * Proxy an OpenAI chat-completions body to Anthropic Messages and translate
 * the reply back. The request translation (tools, tool_choice, stop, images,
 * tool results, response_format, cache_control) lives in `anthropic-tools.ts`
 * — see its header for the full table. `native`, when given, is the client's
 * original Anthropic body (a `/v1/messages` caller) and is forwarded verbatim.
 * Throws `UnsupportedParameterError` for parameters Anthropic cannot honor;
 * `proxyToUpstream` turns that into a 400 for the client.
 */
export async function proxyToAnthropic(
  body: Record<string, unknown>,
  apiKey: string,
  defaultModel: string,
  wantStream = false,
  native?: Record<string, unknown>,
  opts: { injectedSystemTail?: boolean } = {},
): Promise<Response> {
  const requestModel = isMarinaModel(body.model as string) ? defaultModel : (body.model as string);
  const upstreamBody = buildAnthropicRequest(body, requestModel, wantStream, {
    autoCache: anthropicAutoCacheEnabled(),
    native,
    injectedSystemTail: opts.injectedSystemTail,
  });
  const includeUsage =
    !!body.stream_options &&
    typeof body.stream_options === "object" &&
    (body.stream_options as { include_usage?: unknown }).include_usage === true;

  try {
    const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!resp.ok) {
      return errorJson(resp.status, await anthropicErrorMessage(resp));
    }

    // Native streaming: Anthropic SSE → OpenAI chunk SSE on the fly, including
    // `tool_use` blocks as `delta.tool_calls` fragments.
    if (wantStream) {
      if (!resp.body) return errorJson(502, "Anthropic proxy error: empty streaming body");
      let finalUsage: OpenAIUsage | undefined;
      const out = new Response(
        translateAnthropicStream(resp.body, requestModel, includeUsage, (usage) => {
          finalUsage = usage;
        }),
        {
          headers: {
            ...MODEL_CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
      streamUsageSidecar.set(out, () => finalUsage);
      return out;
    }

    // Non-streaming: full message → chat.completion (text joined across every
    // text block, tool_use → tool_calls, cache counters surfaced in usage).
    const data = (await resp.json()) as Parameters<typeof anthropicMessageToOpenai>[0];
    return new Response(JSON.stringify(anthropicMessageToOpenai(data, requestModel)), {
      headers: { ...MODEL_CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return errorJson(502, `Anthropic proxy error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
