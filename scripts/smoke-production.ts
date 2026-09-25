#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Engine } from "../src/engine/engine";
import { getErrorMessage } from "../src/engine/errors";
import { Logger } from "../src/engine/logger";
import {
  buildProviderProbeBody,
  configuredUpstreamProviders,
  evaluateProviderProbe,
  probeConfiguredProviders,
} from "../src/net/model-api";
import { MarinaDB } from "../src/persistence/database";
import { auditEncryptedKeys, getAllApiKeys, getDefaultModel } from "../src/persistence/db-agents";
import { roomId } from "../src/types";

export interface SmokeCheck {
  name: string;
  ok: boolean;
  status?: number;
  error?: string;
  /** Model probe only: the start of what came back, and the id `trace show` takes. */
  excerpt?: string;
  requestId?: string;
  attempts?: number;
}

/** Exercise the running process. No world login, agent spawn, or memory writes. */
export async function checkProductionHttp(
  url: string,
  token?: string,
  openApi = false,
  network: typeof fetch = fetch,
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  for (const path of ["/health", "/dashboard", "/v1/health", "/v1/models"]) {
    try {
      const protectedRoute = path.startsWith("/v1/");
      const response = await network(new URL(path, url), {
        headers: protectedRoute ? headers : {},
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      let valid = false;
      if (protectedRoute && !token && !openApi) {
        valid = response.status === 401;
        await response.body?.cancel();
      } else if (path === "/dashboard") {
        valid = response.ok && /<html[\s>]/i.test(await response.text());
      } else {
        const body = (await response.json()) as { status?: string; data?: unknown };
        valid =
          response.ok && (path === "/v1/models" ? Array.isArray(body.data) : body.status === "ok");
      }
      checks.push({ name: path, ok: valid, status: response.status });
    } catch {
      checks.push({ name: path, ok: false, error: "request-or-response-failed" });
    }
  }
  return checks;
}

/**
 * One live model round trip through the deployed endpoint. It failed
 * intermittently in production (HTTP 200, reply without the check word) while
 * never reproducing locally, and reported nothing but `ok: false` — so it now
 * keeps the start of the reply and the request id (for `trace show` on the
 * host), and tries twice before failing a deploy: one bad model reply is a
 * model's bad day; two in a row is a broken endpoint.
 */
export async function checkProductionModel(
  url: string,
  token?: string,
  fetcher: typeof fetch = fetch,
  attempts = 2,
): Promise<SmokeCheck> {
  let last: SmokeCheck = { name: "live-model-endpoint", ok: false, error: "not attempted" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const nonce = `probe-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const response = await fetcher(new URL("/v1/chat/completions", url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(buildProviderProbeBody(nonce)),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content ?? "";
      const verdict = evaluateProviderProbe(content, nonce);
      last = {
        name: "live-model-endpoint",
        ok: response.ok && verdict.textOk && verdict.systemHonored,
        status: response.status,
        attempts: attempt,
        ...(requestId ? { requestId } : {}),
        // The probe asks only for a random check word — safe to show.
        ...(content || !response.ok
          ? { excerpt: content.slice(0, 80) }
          : { excerpt: "(empty reply)" }),
      };
    } catch {
      last = {
        name: "live-model-endpoint",
        ok: false,
        error: "request-or-response-failed",
        attempts: attempt,
      };
    }
    if (last.ok) return last;
  }
  return last;
}

/** Copy only routing settings and keys into the private probe DB. Never migrate or write the
 * production DB, and never instantiate a second engine over that live DB. */
export function copyProviderConfiguration(sourcePath: string, destination: MarinaDB): void {
  const source = new Database(sourcePath, { readonly: true, create: false });
  try {
    if (auditEncryptedKeys(source).unreadable)
      throw new Error("Production contains unreadable provider credentials");
    destination.setSetting("default_model", getDefaultModel(source));
    for (const key of getAllApiKeys(source)) {
      destination.saveApiKey({
        name: key.name,
        provider: key.provider,
        encryptedValue: key.encrypted_value,
        setBy: "production-smoke",
      });
    }
  } finally {
    source.close();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      providers: { type: "boolean", default: false },
      "providers-only": { type: "boolean", default: false },
      output: { type: "string" },
    },
  });
  const url = process.env.MARINA_SMOKE_URL ?? `http://127.0.0.1:${process.env.WS_PORT ?? 3300}`;
  const token =
    process.env.MARINA_SMOKE_TOKEN ??
    process.env.MODEL_API_KEYS?.split(",")
      .map((k) => k.trim())
      .find(Boolean)
      ?.split(":")[0];
  const openApi = process.env.MARINA_OPEN_API === "true";
  const http = values["providers-only"] ? [] : await checkProductionHttp(url, token, openApi);
  const providers: Record<string, unknown>[] = [];
  const checks = [...http];
  if (values.providers || values["providers-only"]) {
    // MarinaDB needs a separate read connection. A mode-0700 temporary directory
    // accommodates both connections and is removed with its credentials below.
    const directory = mkdtempSync(join(tmpdir(), "marina-provider-smoke-"));
    const db = new MarinaDB(join(directory, "probe.db"));
    const engine = new Engine({
      db,
      startRoom: roomId("smoke/start"),
      logger: new Logger({ level: "error" }),
    });
    const network = globalThis.fetch;
    const warn = console.warn;
    let attempts = 0;
    try {
      if (process.env.DB_PATH) copyProviderConfiguration(process.env.DB_PATH, db);
      // Bound failed-provider fallbacks as well as successful calls. Keep raw
      // upstream error bodies out of CI logs (some include credential details).
      console.warn = () => {};
      for (const target of configuredUpstreamProviders(engine)) {
        // One deadline covers this provider AND its fallback attempts.
        const deadline = AbortSignal.timeout(30_000);
        globalThis.fetch = Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            if (++attempts > 24) throw new Error("Smoke request budget exhausted");
            const request = new Request(input, init);
            return network(request, {
              redirect: "error",
              signal: AbortSignal.any([request.signal, deadline]),
            });
          },
          { preconnect: network.preconnect },
        );
        for (const result of await probeConfiguredProviders(engine, {
          providers: [target.provider],
          timeoutMs: 35_000,
        })) {
          providers.push({
            provider: result.provider,
            model: result.model,
            ok: result.ok,
            status: result.status,
            servedBy: result.servedBy,
            textOk: result.textOk,
            systemHonored: result.systemHonored,
          });
        }
      }
      globalThis.fetch = network;
      if (!providers.length)
        checks.push({ name: "configured-providers", ok: false, error: "no-providers-configured" });
      if (!values["providers-only"] && providers.length && (token || openApi))
        checks.push(await checkProductionModel(url, token));
    } catch (error) {
      // This path reports local configuration failures, never raw provider responses.
      checks.push({ name: "provider-configuration", ok: false, error: getErrorMessage(error) });
    } finally {
      console.warn = warn;
      globalThis.fetch = network;
      engine.stop();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const passed = checks.every((c) => c.ok) && providers.every((p) => p.ok);
  const report = {
    schema: "marina.production.smoke.v1",
    checked_at: new Date().toISOString(),
    passed,
    checks,
    providers,
    limits:
      "HTTP checks exercise the running process. Per-provider probes use the same proxy implementation with a private temporary copy of production routing configuration. No external load-balancer or long-running-agent qualification.",
  };
  if (values.output) writeFileSync(values.output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed,
      checks,
      providers: providers.map(({ provider, ok, servedBy }) => ({ provider, ok, servedBy })),
    }),
  );
  process.exitCode = passed ? 0 : 1;
}
