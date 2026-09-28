// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { httpDispatchReference } from "../scripts/generate-surface-reference";

it("indexes actual route guards, regex capture branches and body fields, ignoring comments", () => {
  const entries = httpDispatchReference(`
// if (url.pathname === '/fake') should not be documented
export function handler(url: URL, method: string, body: Record<string, unknown>) {
  if (method !== "GET") return undefined;
  if (url.pathname === "/api/catalog") return body.visible;
  const detail = url.pathname.match(/^\\/api\\/entities\\/([^/]+)$/);
  if (detail && method === "POST") return body.name;
}
`);
  expect(entries).toHaveLength(2);
  expect(entries[0]!.selector).toBe('url.pathname === "/api/catalog"');
  expect(entries[0]!.guards).toContain('method !== "GET"');
  expect(entries[0]!.fields).toContain("visible");
  expect(entries[1]!.guards).toContain('detail && method === "POST"');
  expect(entries[1]!.fields).toContain("name");
});
