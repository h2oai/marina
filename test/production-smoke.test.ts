// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProductionHttp, copyProviderConfiguration } from "../scripts/smoke-production";
import { MarinaDB } from "../src/persistence/database";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function server(reply?: (path: string) => Response) {
  const seen: Request[] = [];
  const network = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(req);
      const path = new URL(req.url).pathname;
      if (reply) return reply(path);
      if (path === "/dashboard")
        return new Response("<!doctype html><html><body>Marina</body></html>");
      return Response.json(path === "/v1/models" ? { data: [{ id: "marina" }] } : { status: "ok" });
    },
    { preconnect: fetch.preconnect },
  );
  return { network, seen };
}

describe("production smoke boundaries", () => {
  it("does not report a successful provider check when none are configured", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--env-file=/dev/null",
        "run",
        new URL("../scripts/smoke-production.ts", import.meta.url).pathname,
        "--providers-only",
      ],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
    );
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const report = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(code).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({
      name: "configured-providers",
      ok: false,
      error: "no-providers-configured",
    });
    // Spawns a full `bun run` child (cold start + module graph): give it room
    // when the suite runs in parallel workers.
  }, 30_000);

  it("checks live response shapes and limits credentials to authenticated API routes", async () => {
    const { network, seen } = server();
    const checks = await checkProductionHttp(
      "http://localhost:3300",
      "test-model-key",
      false,
      network,
    );
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.ok)).toBe(true);
    for (const req of seen) {
      const api = new URL(req.url).pathname.startsWith("/v1/");
      expect(req.headers.get("Authorization")).toBe(api ? "Bearer test-model-key" : null);
      expect(req.redirect).toBe("error");
    }
  });

  it("reports HTTP 200 with invalid content as a failure", async () => {
    const { network } = server(() => Response.json({ unexpected: true }));
    const checks = await checkProductionHttp("http://localhost:3300", "key", false, network);
    expect(checks.every((c) => !c.ok)).toBe(true);
  });

  it("checks authentication refusal when no caller credential or open API is configured", async () => {
    const { network } = server((path) =>
      path.startsWith("/v1/")
        ? new Response("Unauthorized", { status: 401 })
        : path === "/dashboard"
          ? new Response("<html></html>")
          : Response.json({ status: "ok" }),
    );
    expect(
      (await checkProductionHttp("http://localhost:3300", undefined, false, network)).every(
        (c) => c.ok,
      ),
    ).toBe(true);
    const { network: incorrectlyOpen } = server();
    const checks = await checkProductionHttp(
      "http://localhost:3300",
      undefined,
      false,
      incorrectlyOpen,
    );
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["/v1/health", "/v1/models"]);
  });

  it("copies only provider configuration without changing the production database", () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-smoke-config-"));
    dirs.push(dir);
    const path = join(dir, "source.db");
    const source = new MarinaDB(path);
    const target = new MarinaDB(join(dir, "target.db"));
    try {
      source.setSetting("default_model", "openai/test-model");
      source.setSetting("unrelated_setting", "keep-private");
      source.saveApiKey({
        name: "probe-key",
        provider: "openai",
        encryptedValue: "synthetic-key",
        setBy: "operator",
      });
      copyProviderConfiguration(path, target);
      expect(target.getDefaultModel()).toBe("openai/test-model");
      expect(target.getApiKey("probe-key")?.encrypted_value).toBe("synthetic-key");
      expect(target.getSetting("unrelated_setting")).toBeUndefined();
      expect(source.getApiKey("probe-key")?.set_by).toBe("operator");
      expect(source.getSetting("unrelated_setting")).toBe("keep-private");
    } finally {
      source.close();
      target.close();
    }
  });
});
