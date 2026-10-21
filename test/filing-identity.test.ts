// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Competition adapters ship no default identity: a submission is filed under
 * the organization and agent the operator names (`--org`/`--agent` or
 * MARINA_FILING_ORG / MARINA_FILING_AGENT), and every adapter refuses — before
 * it spends anything — until one is given.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertFilingIdentity,
  filingIdentity,
  IDENTITY_ENV,
  isPlaceholderIdentity,
  MissingIdentityError,
} from "../benchmarks/forecasting/identity";

const ROOT = resolve(import.meta.dir, "..");

describe("filing identity", () => {
  it("refuses with no identity, naming the flags and variables to set", () => {
    expect(IDENTITY_ENV).toEqual({
      organization: "MARINA_FILING_ORG",
      agent: "MARINA_FILING_AGENT",
    });
    let err: unknown;
    try {
      filingIdentity({ adapter: "futurex", env: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingIdentityError);
    const msg = (err as Error).message;
    for (const s of ["futurex", "--org", "--agent", "MARINA_FILING_ORG", "MARINA_FILING_AGENT"])
      expect(msg).toContain(s);
  });

  it("refuses half an identity", () => {
    expect(() => filingIdentity({ adapter: "x", org: "Acme", env: {} })).toThrow(
      /MARINA_FILING_AGENT/,
    );
    expect(() => filingIdentity({ adapter: "x", env: { MARINA_FILING_AGENT: "Bot" } })).toThrow(
      /MARINA_FILING_ORG/,
    );
  });

  it("refuses the docs' placeholders", () => {
    for (const p of ["your-org", "Your Org", "your-entrant-id", "<your-agent>", "example", "TODO"])
      expect(isPlaceholderIdentity(p)).toBe(true);
    for (const real of ["Acme", "acme.lab", "Yourway Labs", "LabBot"])
      expect(isPlaceholderIdentity(real)).toBe(false);
    expect(() => filingIdentity({ adapter: "x", org: "your-org", agent: "Bot", env: {} })).toThrow(
      /placeholder/,
    );
  });

  it("takes flags over the environment, trimmed", () => {
    const env = { MARINA_FILING_ORG: "Env Org", MARINA_FILING_AGENT: "EnvBot" };
    expect(filingIdentity({ adapter: "x", env })).toEqual({
      organization: "Env Org",
      agent: "EnvBot",
    });
    expect(filingIdentity({ adapter: "x", org: " Acme ", agent: "LabBot", env })).toEqual({
      organization: "Acme",
      agent: "LabBot",
    });
  });

  it("checks a caller-built identity without reading the environment", () => {
    expect(assertFilingIdentity("m", { organization: "Acme", agent: "LabBot" })).toEqual({
      organization: "Acme",
      agent: "LabBot",
    });
    expect(() => assertFilingIdentity("m", undefined)).toThrow(MissingIdentityError);
  });
});

describe("adapters refuse to file without an identity", () => {
  const run = (args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "filing-identity-"));
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      delete env.MARINA_FILING_ORG;
      delete env.MARINA_FILING_AGENT;
      env.DB_PATH = join(dir, "world.db");
      // No network: a refusal must come before any fetch or model call.
      env.OPENROUTER_API_KEY = "";
      const p = Bun.spawnSync([process.execPath, "--env-file=/dev/null", ...args], {
        cwd: ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("futurex run", () => {
    const r = run(["scripts/futurex.ts", "run", "--no-ledger", "--dir", tmpdir()]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("futurex: no filing identity");
    expect(r.out).toContain("MARINA_FILING_ORG");
  });

  it("forecastbench run", () => {
    const r = run(["scripts/forecastbench.ts", "run", "--dir", tmpdir()]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("forecastbench: no filing identity");
  });

  it("metaculus forecast", () => {
    const r = run(["scripts/metaculus.ts", "forecast", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("metaculus: no filing identity");
  });
});
