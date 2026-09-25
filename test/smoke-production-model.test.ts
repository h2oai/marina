// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { checkProductionModel } from "../scripts/smoke-production";

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "Content-Type": "application/json", "x-request-id": "req-abc" },
  });

/** Echo the check word from the probe's second system message. */
function nonceOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
  return /"(probe-[^"]+)"/.exec(body.messages[1]!.content)![1]!;
}

describe("production model smoke check", () => {
  it("passes on a correct reply and reports the request id", async () => {
    const check = await checkProductionModel("https://x.example", "t", (async (_u, init) =>
      reply(nonceOf(init))) as typeof fetch);
    expect(check).toMatchObject({ ok: true, attempts: 1, requestId: "req-abc" });
  });

  it("retries once, and keeps what a failing reply said", async () => {
    let calls = 0;
    const flaky = (async (_u, init) => {
      calls++;
      return reply(calls === 1 ? "" : nonceOf(init));
    }) as typeof fetch;
    expect(await checkProductionModel("https://x.example", "t", flaky)).toMatchObject({
      ok: true,
      attempts: 2,
    });
    const broken = (async () => reply("I cannot help with that")) as typeof fetch;
    expect(await checkProductionModel("https://x.example", "t", broken)).toMatchObject({
      ok: false,
      attempts: 2,
      excerpt: "I cannot help with that",
    });
    const empty = (async () => reply("")) as typeof fetch;
    expect((await checkProductionModel("https://x.example", "t", empty)).excerpt).toBe(
      "(empty reply)",
    );
  });
});
