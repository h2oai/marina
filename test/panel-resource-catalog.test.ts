// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { RoutingService } from "../src/routing/service";
import { codingDesk } from "../src/sdk/coding-desk";
import { validatePanelDocument } from "../src/sdk/panel-document";
import { panelSourceAffected } from "../src/sdk/panel-events";
import {
  PANEL_RESOURCE_CATALOG,
  panelResourcePath,
  parseCatalogPanelSource,
} from "../src/sdk/panel-resource-catalog";
import { resolvePanelBindings, resolvePanelSource } from "../src/sdk/panel-resources";
import { panelText } from "../src/sdk/panel-text";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";
import { scopeProcessState } from "./process-state";

it("catalog references stay on declared read routes even for hostile path and query values", async () => {
  const neverRead = async () => {
    throw new Error("An invalid source must not reach the reader");
  };
  for (const id of [".", ".."]) {
    await expect(resolvePanelSource({ kind: "participant", id }, neverRead)).rejects.toThrow(
      "Invalid panel source reference",
    );
    await expect(
      resolvePanelSource({ kind: "canvas", canvasId: id, id: "node" }, neverRead),
    ).rejects.toThrow("Invalid panel source reference");
  }
  expect(new Set(PANEL_RESOURCE_CATALOG.map((d) => d.id)).size).toBe(PANEL_RESOURCE_CATALOG.length);
  for (const definition of PANEL_RESOURCE_CATALOG) {
    const source = {
      kind: "resource" as const,
      resource: definition.id,
      params: Object.fromEntries(definition.parameters.map((key) => [key, "x/?#&%"])),
    };
    const path = panelResourcePath(source);
    const url = new URL(path, "https://marina.test");
    expect(url.origin).toBe("https://marina.test");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(url.pathname).toBe(definition.path.replace(/:[A-Za-z]+/g, "x%2F%3F%23%26%25"));
    const seen: string[] = [];
    await resolvePanelSource(source, async (p) => {
      seen.push(p);
      return {};
    });
    expect(seen).toEqual([path]);
    expect(panelSourceAffected(source, { type: "resource_changed", resource: "coding" })).toBe(
      true,
    );
  }
  for (const value of [".", "..", "", "\u0000", "x".repeat(1001)])
    expect(
      parseCatalogPanelSource({
        kind: "resource",
        resource: "coding.session",
        params: { id: value },
      }),
    ).toBeNull();
  for (const input of [
    { resource: "https://attacker.test/api/keys" },
    { resource: "../keys" },
    { resource: "entity.canvas", params: { name: "self" } },
    { resource: "coding.session", params: Object.create({ id: "inherited" }) },
    { resource: "coding.session", params: { id: "allowed", extra: "no" } },
    { resource: "feed", query: { token: "do-not-publish" } },
    { resource: "feed", query: { limit: Number.NaN } },
    { resource: "feed", query: { limit: [] } },
  ])
    expect(parseCatalogPanelSource({ kind: "resource", ...input })).toBeNull();
  expect(
    panelResourcePath({
      kind: "resource",
      resource: "feed",
      query: { entity: "a&token=b", limit: 10 },
    }),
  ).toBe("/api/feed?entity=a%26token%3Db&limit=10");
});

it("authored panels combine coding and world sources without changing the explicit repository target", () => {
  const desk = codingDesk({ sessionId: "marina-self-development" });
  const parsed = validatePanelDocument({
    ...desk,
    sources: {
      coding: {
        kind: "resource",
        resource: "coding.session",
        params: { id: "marina-self-development" },
      },
      channels: { kind: "resource", resource: "channels" },
    },
    components: [
      ...desk.components.map((c) =>
        c.id === "root"
          ? { ...c, children: [...(c.children as string[]), "repository", "channels"] }
          : c,
      ),
      {
        id: "repository",
        component: "Text",
        bindings: { text: { source: "coding", path: ["session", "workspace_root"] } },
      },
      {
        id: "channels",
        component: "DataTable",
        columns: ["name"],
        bindings: { rows: { source: "channels", path: [] } },
      },
    ],
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  for (const root of ["/work/Marina", "/work/customer-project"]) {
    const values = {
      coding: { session: { workspace_root: root } },
      channels: [{ name: "Reviewers" }],
    };
    const bound = resolvePanelBindings(parsed.document, values);
    expect(bound.components.find((c) => c.id === "repository")!.text).toBe(root);
    expect(panelText(parsed.document, values)).toContain("Reviewers");
    expect(bound.components.find((c) => c.id === "ask")!.operation).toMatchObject({
      codingTarget: { sessionId: "marina-self-development" },
    });
  }
  expect(
    resolvePanelBindings(parsed.document, {}).components.find((c) => c.id === "channels")!.rows,
  ).toEqual([]);
});

it("catalog discovery and data reads retain caller authorization rather than the publisher's authority", async () => {
  using _state = scopeProcessState({ rateLimitBypass: true, env: { MARINA_OPEN_API: undefined } });
  const f = createTestEngine();
  const login = (name: string) => {
    const connection = new MockConnection(name);
    f.engine.addConnection(connection);
    const result = f.engine.login(connection.id, name);
    if ("error" in result) throw new Error(result.error);
    return result;
  };
  const owner = login("PanelOwner");
  const reader = login("PanelReader");
  const request = async (path: string, token: string) => {
    const url = new URL(path, "http://localhost");
    return (await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      f.engine,
      f.db,
    ))!;
  };
  try {
    f.db.createCodingSession({
      id: "private-work",
      title: "Private repo",
      workspaceRoot: "/work/Marina",
      createdBy: "PanelOwner",
    });
    const catalog = await request("/api/panel-resources", reader.token);
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).resources).toEqual(PANEL_RESOURCE_CATALOG);
    expect((await request("/api/panel-resources", "invalid")).status).toBe(401);
    const source = {
      kind: "resource" as const,
      resource: "coding.session",
      params: { id: "private-work" },
    };
    const authorized = await resolvePanelSource(source, async (path) => {
      const response = await request(path, owner.token);
      expect(response.status).toBe(200);
      return response.json();
    });
    expect(authorized).toMatchObject({ session: { workspace_root: "/work/Marina" } });
    const routing = new RoutingService(f.db, f.db.durableEntityKey(owner.entityId));
    const privateSession = routing.join({
      clientKey: "private",
      label: "Private participant",
      kind: "service",
    });
    const privateSource = {
      kind: "resource" as const,
      resource: "participant",
      params: { id: privateSession.id },
    };
    expect((await request(panelResourcePath(privateSource), owner.token)).status).toBe(200);
    const forbidden = await request(panelResourcePath(privateSource), reader.token);
    expect([403, 404]).toContain(forbidden.status);
    expect(await forbidden.text()).not.toContain("Private participant");
    const before = f.db.getCodingSession("private-work");
    await f.engine.dispatchCommand(owner.entityId, "canvas resources coding");
    expect(f.db.getCodingSession("private-work")).toEqual(before);
  } finally {
    await f.dispose();
  }
});
