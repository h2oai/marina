// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { InvestigationTerminal } from "../scripts/inquiry-terminal";
import { MarinaInvestigationClient } from "../src/sdk/investigation-client";
import { investigationPlainText } from "../src/sdk/investigation-text";
import { investigationSnapshot } from "./fixtures/investigations";
import { until } from "./helpers";
import { InvestigationScreen } from "./investigation-screen";

it("renders a native private answer without a coding folder, preserves drafts, and detaches without cancelling", async () => {
  const screen = new InvestigationScreen();
  const snapshot = investigationSnapshot();
  snapshot.attempt.result!.summary += "\x1b]52;c;clipboard-attack\x07\u202e";
  const requests: Array<{ method: string; path: string }> = [];
  const client = new MarinaInvestigationClient({
    url: "http://fixture.test",
    token: "fixture-token",
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        const path = new URL(req.url).pathname;
        requests.push({ method: req.method, path });
        if (path.endsWith("/events"))
          return Response.json({ events: [], cursor: 3, more: false, reset: false });
        return Response.json(snapshot);
      },
      { preconnect() {} },
    ),
  });
  const terminal = new InvestigationTerminal(client, "http://fixture.test", screen);
  try {
    await terminal.start(undefined, undefined, snapshot.case.id);
    await until(() => investigationPlainText(screen.output).includes("65% chance"));
    expect(screen.output).not.toContain("clipboard-attack");
    expect(screen.output).not.toContain("\u202e");
    screen.send("keep my draft");
    await terminal.command("/sources");
    await until(() => investigationPlainText(screen.output).includes("example.org/release"));
    screen.columns = 34;
    screen.rows = 15;
    screen.resize();
    await terminal.command("/why");
    await until(() => investigationPlainText(screen.output).includes("Integration remains"));
    screen.send("\x03");
    await terminal.done;
    expect(requests.every((req) => req.method === "GET")).toBe(true);
    expect(screen.stops).toBe(1);
  } finally {
    terminal.close();
  }
});
