// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import type { TerminalPanelState } from "../scripts/code-panel-form";
import { CodePanels } from "../scripts/code-panels";
import { MarinaPanelClient } from "../src/sdk/panel-client";

it("personal coding desks preserve independent drafts and captured targets without publishing or selecting a worker", async () => {
  const reads: string[] = [];
  const asks: Array<[string, string]> = [];
  let form: TerminalPanelState | undefined;
  let output = "";
  const client = new MarinaPanelClient({
    url: "http://marina.test",
    token: "test",
    fetch: (async (url, init) => {
      expect(init?.method).toBe("GET");
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path.startsWith("/api/coding/session/"))
        return Response.json({
          session: {
            id: path.split("/").at(-1),
            title: path.split("/").at(-1),
            status: "active",
            workspace_root: "/work/repository",
          },
        });
      return Response.json([]);
    }) as typeof fetch,
  });
  const panels = new CodePanels(
    client,
    (value) => {
      output = value;
    },
    async () => null,
    {
      watch: false,
      present: (value) => {
        form = value;
      },
      ask: async (id, request) => {
        asks.push([id, request]);
        return "Recorded";
      },
    },
  );
  try {
    await panels.command("desk marina");
    expect(output).toContain("Repository: /work/repository");
    panels.input({ type: "field", id: "request", value: "Improve Marina" });
    await panels.command("act ask");
    expect(form?.review?.canConfirm).toBe(true);
    await panels.command("desk external-project");
    panels.input({ type: "field", id: "request", value: "Improve another project" });
    expect(form?.review).toBeUndefined();
    expect(form?.views).toHaveLength(2);
    await panels.command("use 1");
    expect(form?.fields[0]?.value).toBe("Improve Marina");
    expect(form?.review?.canConfirm).toBe(true);
    await panels.command("field request A later unsent edit");
    await panels.command("confirm");
    expect(asks).toEqual([["marina", "Improve Marina"]]);
    await panels.command("use 2");
    expect(form?.fields[0]?.value).toBe("Improve another project");
    await panels.command("close");
    expect(form?.fields[0]?.value).toBe("A later unsent edit");
    expect(reads.some((p) => p.startsWith("/api/canvases"))).toBe(false);
    await panels.command("close");
    expect(form).toBeUndefined();
    expect(asks).toHaveLength(1);
  } finally {
    panels.dispose();
  }
});

it("a failed personal source cannot leave operational controls available", async () => {
  let denied = false;
  let form: TerminalPanelState | undefined;
  const client = new MarinaPanelClient({
    url: "http://marina.test",
    token: "test",
    fetch: (async (url) => {
      if (String(url).includes("coding/session"))
        return denied
          ? Response.json({ error: "Denied" }, { status: 403 })
          : Response.json({ session: { title: "Coding", status: "active" } });
      return Response.json([]);
    }) as typeof fetch,
  });
  const panels = new CodePanels(
    client,
    () => {},
    async () => null,
    {
      watch: false,
      present: (value) => {
        form = value;
      },
    },
  );
  try {
    await panels.command("desk marina");
    expect(form).toBeDefined();
    denied = true;
    await panels.command("refresh");
    expect(form).toBeUndefined();
  } finally {
    panels.dispose();
  }
});
