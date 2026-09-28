// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal self-URLs and discovery follow the ports the listeners actually
 * bound (WS_PORT=0 or a custom WS_PORT), never a hard-coded 3300/3301.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  localHttpBase,
  localMcpPort,
  localWsPort,
  recordListenPort,
  resetListenPortsForTests,
} from "../src/net/listen-ports";

afterEach(() => resetListenPortsForTests());

describe("listen ports", () => {
  it("before binding: the configured env, then the default layout", () => {
    expect(localWsPort({})).toBe(3300);
    expect(localMcpPort({})).toBe(3301);
    expect(localWsPort({ WS_PORT: "3400" })).toBe(3400);
    expect(localMcpPort({ WS_PORT: "3400" })).toBe(3401);
    expect(localMcpPort({ WS_PORT: "3400", MCP_PORT: "9000" })).toBe(9000);
    // WS_PORT=0 means "ephemeral", never port 0 in a URL.
    expect(localWsPort({ WS_PORT: "0" })).toBe(3300);
  });

  it("after binding: the real ports win over the environment", () => {
    recordListenPort("websocket", 41234);
    expect(localWsPort({ WS_PORT: "0" })).toBe(41234);
    expect(localMcpPort({ WS_PORT: "0" })).toBe(41235);
    expect(localHttpBase({})).toBe("http://localhost:41234");
    recordListenPort("mcp", 50000);
    expect(localMcpPort({})).toBe(50000);
    recordListenPort("websocket", 0); // ignored
    expect(localWsPort({})).toBe(41234);
  });
});
