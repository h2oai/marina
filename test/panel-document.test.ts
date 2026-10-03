// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { panelRevision } from "../src/engine/canvas-document";
import { validatePanelDocument } from "../src/sdk/panel-document";

describe("published panel documents", () => {
  it("normalizes historical text/table examples without mutating the author input", () => {
    const input = {
      components: [
        { id: "root", component: "Column", children: ["title", "table"] },
        { id: "title", component: "Text", value: "Build status" },
        { id: "table", component: "DataTable", columns: ["Room"], rows: [{ Room: "Workshop" }] },
      ],
    };
    const result = validatePanelDocument(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.document.components[1]?.text).toBe("Build status");
    expect(result.document.components[2]?.columns).toEqual([{ key: "Room", label: "Room" }]);
    expect(input.components[2]?.columns).toEqual(["Room"]);
  });
  it("bounds missing, cyclic, deep and branching graphs including unreachable components", () => {
    for (const components of [
      [{ id: "a", component: "Card", child: "missing" }],
      [{ id: "a", component: "Card", child: "a" }],
      [
        { id: "a", component: "Text" },
        { id: "a", component: "Text" },
      ],
      Array.from({ length: 22 }, (_, i) => ({
        id: String(i),
        component: "Card",
        ...(i < 21 ? { child: String(i + 1) } : {}),
      })),
      Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        component: "Card",
        ...(i < 11 ? { child: String(i + 1), children: [String(i + 1)] } : {}),
      })),
    ])
      expect(validatePanelDocument({ components }).ok).toBe(false);
  });
  it("refuses malformed properties, hostile JSON and unsupported schemas", () => {
    for (const value of [
      null,
      [],
      { schema: "remote", components: [] },
      { components: [{ id: "a", component: "Text", text: {} }] },
      { components: [{ id: "a", component: "Timeline", items: [null] }] },
      { components: [{ id: "a", component: "Button", action: { event: { name: [] } } }] },
      JSON.parse('{"components":[],"dataModel":{"__proto__":{"polluted":true}}}'),
      { components: [], title: "x".repeat(262145) },
    ])
      expect(validatePanelDocument(value).ok).toBe(false);
  });
  it("revisions follow operational meaning rather than interaction/geometry timestamps", () => {
    const data = {
      components: [
        { id: "b", component: "Button", label: "Save", action: { event: { name: "save" } } },
      ],
    };
    expect(panelRevision({ ...data, lastAction: { name: "save", timestamp: 1 }, x: 100 })).toBe(
      panelRevision(data),
    );
    expect(
      panelRevision({
        components: [{ ...data.components[0], action: { event: { name: "delete" } } }],
      }),
    ).not.toBe(panelRevision(data));
  });
});

it("bounds resource readers and validates typed actions and field references", () => {
  for (const components of [
    [{ id: "bad", component: "Resource", reference: { kind: "url", url: "https://example.com" } }],
    [
      {
        id: "bad",
        component: "Button",
        operation: { kind: "message", targetId: "someone", message: { field: "missing" } },
      },
    ],
    Array.from({ length: 9 }, (_, id) => ({
      id: String(id),
      component: "Resource",
      reference: { kind: "task", id: String(id) },
    })),
  ])
    expect(validatePanelDocument({ components }).ok).toBe(false);
});
