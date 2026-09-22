// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConnectorRuntime } from "../src/engine/connector-runtime";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_connector_reload.db";

describe("ConnectorRuntime.loadFromDB re-validates stored URLs", () => {
  let db: MarinaDB;
  let runtime: ConnectorRuntime;
  let registered: Array<{ name: string; command: { kind: string; url?: URL } }>;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    runtime = new ConnectorRuntime(db);
    registered = [];
    runtime.__setRuntimeForTest({
      registerDefinition: async (def: { name: string; command: { kind: string; url?: URL } }) => {
        registered.push(def);
      },
    });
    // Public names resolve public; the rebinding name resolves loopback.
    __setDnsResolverForTest(async (host) =>
      host === "rebind.example.com" ? ["127.0.0.1"] : ["93.184.216.34"],
    );
  });

  afterEach(() => {
    __setDnsResolverForTest(null);
    db.close();
    cleanupDb(TEST_DB);
  });

  it("registers only connectors whose URL passes the SSRF guard; skips the rest with a warning", async () => {
    db.createConnector({
      id: "c_good",
      name: "good",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      createdBy: "s",
    });
    db.createConnector({
      id: "c_private",
      name: "private",
      transport: "http",
      url: "http://10.0.0.5/mcp",
      createdBy: "s",
    });
    db.createConnector({
      id: "c_meta",
      name: "metadata",
      transport: "http",
      url: "http://169.254.169.254/latest/meta-data/",
      createdBy: "s",
    });
    db.createConnector({
      id: "c_local",
      name: "local",
      transport: "http",
      url: "http://localhost:8080/mcp",
      createdBy: "s",
    });
    db.createConnector({
      id: "c_rebind",
      name: "rebind",
      transport: "http",
      url: "https://rebind.example.com/mcp",
      createdBy: "s",
    });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let loaded: number;
    try {
      loaded = await runtime.loadFromDB();
    } finally {
      console.warn = origWarn;
    }

    expect(loaded).toBe(1);
    expect(registered.map((r) => r.name)).toEqual(["good"]);
    expect(registered[0]!.command.url?.href).toBe("https://mcp.example.com/mcp");
    // One warning per skipped connector, naming it.
    for (const name of ["private", "metadata", "local", "rebind"]) {
      expect(warnings.some((w) => w.includes(`"${name}"`))).toBe(true);
    }
    // Skipped rows are not flipped to error — they were skipped, not failed.
    expect(db.getConnectorByName("private")!.status).toBe("active");
  });

  it("stdio connectors are unaffected by the URL guard", async () => {
    db.createConnector({
      id: "c_stdio",
      name: "stdio1",
      transport: "stdio",
      command: "echo",
      args: JSON.stringify(["hi"]),
      createdBy: "s",
    });
    expect(await runtime.loadFromDB()).toBe(1);
    expect(registered[0]!.command.kind).toBe("stdio");
  });
});
